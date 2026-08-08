import AppKit
import Foundation
import ImageIO
import PDFKit
import Vision

private let maximumInputBytes = 25 * 1024 * 1024
private let maximumPDFPages = 50
private let maximumImagePixels = 100_000_000
private let maximumImageDimension = 4_096
private let maximumPDFRenderDimension = 2_600
private let maximumPageCharacters = 100_000
private let maximumOutputCharacters = 1_000_000

private enum OCRFailure: Error, CustomStringConvertible {
    case message(String)

    var description: String {
        switch self {
        case let .message(message):
            return message
        }
    }
}

private struct OCRPage: Codable {
    let pageNumber: Int
    let text: String
}

private struct OCRResult: Codable {
    let text: String
    let pageCount: Int
    let pages: [OCRPage]
    let warnings: [String]
}

private struct TextFragment {
    let text: String
    let bounds: CGRect
}

private struct TextRow {
    var fragments: [TextFragment]
    var midpointY: CGFloat
    var averageHeight: CGFloat

    mutating func append(_ fragment: TextFragment) {
        let count = CGFloat(fragments.count)
        midpointY = ((midpointY * count) + fragment.bounds.midY) / (count + 1)
        averageHeight = ((averageHeight * count) + fragment.bounds.height) / (count + 1)
        fragments.append(fragment)
    }
}

private func option(_ name: String, in arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
        return nil
    }
    return arguments[index + 1]
}

private func normalizedMIMEType(_ value: String) throws -> String {
    let mimeType = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    switch mimeType {
    case "image/png", "image/jpeg", "image/jpg", "image/heic", "image/heif", "application/pdf":
        return mimeType
    default:
        throw OCRFailure.message("Choose a PNG, JPEG, HEIC, HEIF, or PDF document.")
    }
}

private func decodedImage(from data: Data) throws -> CGImage {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
        throw OCRFailure.message("macOS could not decode this image.")
    }
    guard
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
        let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
        let height = properties[kCGImagePropertyPixelHeight] as? NSNumber
    else {
        throw OCRFailure.message("The image does not contain valid dimensions.")
    }
    let pixelWidth = width.intValue
    let pixelHeight = height.intValue
    guard pixelWidth > 0, pixelHeight > 0 else {
        throw OCRFailure.message("The image does not contain valid dimensions.")
    }
    guard pixelWidth <= maximumImagePixels / pixelHeight else {
        throw OCRFailure.message("That image is too large to process safely.")
    }

    // ImageIO applies the source orientation while producing a bounded bitmap.
    // Vision therefore receives an upright `.up` CGImage for EXIF and HEIC photos.
    let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: maximumImageDimension,
        kCGImageSourceShouldCacheImmediately: true,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
        throw OCRFailure.message("macOS could not render this image for text recognition.")
    }
    return image
}

private func renderedPDFPage(_ page: PDFPage) throws -> CGImage {
    let bounds = page.bounds(for: .cropBox)
    guard bounds.width.isFinite, bounds.height.isFinite, bounds.width > 0, bounds.height > 0 else {
        throw OCRFailure.message("The PDF contains a page with invalid dimensions.")
    }
    let longestEdge = max(bounds.width, bounds.height)
    let scale = min(3.0, CGFloat(maximumPDFRenderDimension) / longestEdge)
    let targetSize = NSSize(
        width: max(1, ceil(bounds.width * scale)),
        height: max(1, ceil(bounds.height * scale))
    )
    let image = page.thumbnail(of: targetSize, for: .cropBox)
    guard let rendered = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        throw OCRFailure.message("macOS could not render a PDF page for text recognition.")
    }
    return rendered
}

private func readingOrder(_ observations: [VNRecognizedTextObservation]) -> String {
    let fragments = observations.compactMap { observation -> TextFragment? in
        guard let candidate = observation.topCandidates(1).first else {
            return nil
        }
        let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            return nil
        }
        return TextFragment(text: text, bounds: observation.boundingBox)
    }.sorted { left, right in
        if left.bounds.midY != right.bounds.midY {
            return left.bounds.midY > right.bounds.midY
        }
        return left.bounds.minX < right.bounds.minX
    }

    var rows: [TextRow] = []
    for fragment in fragments {
        let candidate = rows.enumerated()
            .map { index, row in
                (index, abs(row.midpointY - fragment.bounds.midY))
            }
            .filter { index, distance in
                let row = rows[index]
                let tolerance = max(0.008, min(row.averageHeight, fragment.bounds.height) * 0.45)
                return distance <= tolerance
            }
            .min { left, right in
                if left.1 != right.1 {
                    return left.1 < right.1
                }
                return left.0 < right.0
            }
        if let (rowIndex, _) = candidate {
            rows[rowIndex].append(fragment)
        } else {
            rows.append(TextRow(
                fragments: [fragment],
                midpointY: fragment.bounds.midY,
                averageHeight: fragment.bounds.height
            ))
        }
    }

    rows.sort { left, right in
        if left.midpointY != right.midpointY {
            return left.midpointY > right.midpointY
        }
        return left.fragments.map(\.bounds.minX).min() ?? 0
            < right.fragments.map(\.bounds.minX).min() ?? 0
    }
    return rows.map { row in
        row.fragments
            .sorted { left, right in left.bounds.minX < right.bounds.minX }
            .map(\.text)
            .joined(separator: " ")
    }
    .joined(separator: "\n")
    .trimmingCharacters(in: .whitespacesAndNewlines)
}

private func recognize(_ image: CGImage) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.automaticallyDetectsLanguage = true

    // CGImageSource has already normalized image orientation, while PDFKit
    // supplies upright page thumbnails.
    let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
    try handler.perform([request])
    return readingOrder(request.results ?? [])
}

private func validatedPage(_ page: OCRPage) throws -> OCRPage {
    guard page.text.count <= maximumPageCharacters else {
        throw OCRFailure.message("One page contains too much recognized text.")
    }
    return page
}

private func recognizeDocument(at path: String, mimeType: String) throws -> OCRResult {
    let url = URL(fileURLWithPath: path)
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    guard let fileSize = attributes[.size] as? NSNumber, fileSize.intValue > 0 else {
        throw OCRFailure.message("The selected document is empty.")
    }
    guard fileSize.intValue <= maximumInputBytes else {
        throw OCRFailure.message("OCR documents must be 25 MB or smaller.")
    }
    let data = try Data(contentsOf: url, options: [.mappedIfSafe])
    let normalizedMIME = try normalizedMIMEType(mimeType)

    var pages: [OCRPage] = []
    var warnings: [String] = []
    if normalizedMIME == "application/pdf" {
        guard let document = PDFDocument(data: data), document.pageCount > 0 else {
            throw OCRFailure.message("macOS could not open this PDF.")
        }
        guard document.pageCount <= maximumPDFPages else {
            throw OCRFailure.message("OCR supports PDFs of up to 50 pages.")
        }
        pages.reserveCapacity(document.pageCount)
        for index in 0 ..< document.pageCount {
            guard let page = document.page(at: index) else {
                throw OCRFailure.message("macOS could not open page \(index + 1) of this PDF.")
            }
            let text = try recognize(renderedPDFPage(page))
            if text.isEmpty {
                warnings.append("No text was recognized on page \(index + 1).")
            }
            pages.append(try validatedPage(OCRPage(pageNumber: index + 1, text: text)))
        }
    } else {
        let text = try recognize(decodedImage(from: data))
        pages = [try validatedPage(OCRPage(pageNumber: 1, text: text))]
    }

    let text = pages.map(\.text)
        .filter { !$0.isEmpty }
        .joined(separator: "\n\n")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else {
        throw OCRFailure.message("No readable text was found in this document.")
    }
    guard text.count <= maximumOutputCharacters else {
        throw OCRFailure.message("This document contains too much recognized text.")
    }
    return OCRResult(text: text, pageCount: pages.count, pages: pages, warnings: warnings)
}

private func run() throws {
    let arguments = Array(CommandLine.arguments.dropFirst())
    if arguments == ["--version"] {
        print("Orion OCR 1 · Apple Vision")
        return
    }
    guard
        let inputPath = option("--input", in: arguments),
        let mimeType = option("--mime-type", in: arguments)
    else {
        throw OCRFailure.message(
            "usage: orion-ocr --input <document> --mime-type <content-type>"
        )
    }

    let result = try recognizeDocument(at: inputPath, mimeType: mimeType)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    let output = try encoder.encode(result)
    FileHandle.standardOutput.write(output)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

do {
    try run()
    exit(0)
} catch {
    let message = "Orion OCR failed: \(error)\n"
    FileHandle.standardError.write(Data(message.utf8))
    exit(1)
}
