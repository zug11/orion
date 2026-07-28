import AVFoundation
import Dispatch
import Foundation
import whisper

private enum RunnerFailure: Error, CustomStringConvertible {
    case message(String)

    var description: String {
        switch self {
        case let .message(message):
            return message
        }
    }
}

private func option(_ name: String, in arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
        return nil
    }
    return arguments[index + 1]
}

private func decodeAudio(at path: String) async throws -> [Float] {
    let url = URL(fileURLWithPath: path)
    let asset = AVURLAsset(url: url)
    guard let track = try await asset.loadTracks(withMediaType: .audio).first else {
        throw RunnerFailure.message("The selected media does not contain a readable audio track.")
    }

    let reader = try AVAssetReader(asset: asset)
    let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: 16_000,
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 32,
        AVLinearPCMIsFloatKey: true,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
    ]
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else {
        throw RunnerFailure.message("macOS could not prepare this media for offline transcription.")
    }
    reader.add(output)
    guard reader.startReading() else {
        throw RunnerFailure.message(
            reader.error?.localizedDescription ?? "macOS could not start decoding this media."
        )
    }

    var samples: [Float] = []
    while let sampleBuffer = output.copyNextSampleBuffer() {
        defer { CMSampleBufferInvalidate(sampleBuffer) }
        guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else {
            continue
        }
        let byteCount = CMBlockBufferGetDataLength(block)
        guard byteCount > 0, byteCount.isMultiple(of: MemoryLayout<Float>.size) else {
            continue
        }
        var chunk = [Float](
            repeating: 0,
            count: byteCount / MemoryLayout<Float>.size
        )
        let status = chunk.withUnsafeMutableBytes { bytes in
            CMBlockBufferCopyDataBytes(
                block,
                atOffset: 0,
                dataLength: byteCount,
                destination: bytes.baseAddress!
            )
        }
        guard status == kCMBlockBufferNoErr else {
            throw RunnerFailure.message("macOS returned malformed decoded audio.")
        }
        samples.append(contentsOf: chunk)
    }

    if reader.status == .failed {
        throw RunnerFailure.message(
            reader.error?.localizedDescription ?? "macOS could not decode this media."
        )
    }
    guard !samples.isEmpty else {
        throw RunnerFailure.message("The selected media contains no decodable audio samples.")
    }
    guard samples.count <= Int(Int32.max) else {
        throw RunnerFailure.message("The selected recording is too long to transcribe safely.")
    }
    return samples
}

private func transcribe(
    modelPath: String,
    mediaPath: String,
    language: String?
) async throws -> String {
    let samples = try await decodeAudio(at: mediaPath)
    var contextParameters = whisper_context_default_params()
    contextParameters.use_gpu = true

    let context = modelPath.withCString {
        whisper_init_from_file_with_params($0, contextParameters)
    }
    guard let context else {
        throw RunnerFailure.message("The bundled Whisper model could not be loaded.")
    }
    defer { whisper_free(context) }

    var parameters = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
    parameters.n_threads = Int32(
        min(8, max(2, ProcessInfo.processInfo.activeProcessorCount - 2))
    )
    parameters.translate = false
    parameters.no_context = false
    parameters.no_timestamps = true
    parameters.single_segment = false
    parameters.print_special = false
    parameters.print_progress = false
    parameters.print_realtime = false
    parameters.print_timestamps = false

    let normalizedLanguage = language?
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
    let result: Int32 = samples.withUnsafeBufferPointer { buffer in
        guard let baseAddress = buffer.baseAddress else {
            return -1
        }
        if let normalizedLanguage, !normalizedLanguage.isEmpty, normalizedLanguage != "auto" {
            return normalizedLanguage.withCString { languagePointer in
                parameters.language = languagePointer
                return whisper_full(
                    context,
                    parameters,
                    baseAddress,
                    Int32(buffer.count)
                )
            }
        }
        parameters.language = nil
        return whisper_full(
            context,
            parameters,
            baseAddress,
            Int32(buffer.count)
        )
    }
    guard result == 0 else {
        throw RunnerFailure.message("The bundled Whisper engine could not transcribe this media.")
    }

    let segmentCount = whisper_full_n_segments(context)
    var transcript = ""
    for index in 0 ..< segmentCount {
        guard let text = whisper_full_get_segment_text(context, index) else {
            continue
        }
        transcript.append(String(cString: text))
    }
    let normalized = transcript
        .split(whereSeparator: \.isWhitespace)
        .joined(separator: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else {
        throw RunnerFailure.message("Whisper finished without detecting any speech.")
    }
    return normalized
}

private func run() async throws {
    let arguments = Array(CommandLine.arguments.dropFirst())
    if arguments == ["--version"] {
        print("whisper.cpp \(String(cString: whisper_version())) · Orion base multilingual")
        return
    }
    guard
        let modelPath = option("--model", in: arguments),
        let mediaPath = option("--input", in: arguments)
    else {
        throw RunnerFailure.message(
            "usage: orion-whisper --model <model.bin> --input <media> [--language <code>]"
        )
    }
    let transcript = try await transcribe(
        modelPath: modelPath,
        mediaPath: mediaPath,
        language: option("--language", in: arguments)
    )
    print(transcript)
}

Task {
    do {
        try await run()
        exit(0)
    } catch {
        let message = "Orion offline transcription failed: \(error)\n"
        FileHandle.standardError.write(Data(message.utf8))
        exit(1)
    }
}
dispatchMain()
