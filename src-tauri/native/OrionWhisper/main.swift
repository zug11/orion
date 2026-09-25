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

private struct ServerRequest: Decodable {
    let id: UInt64?
    let input: String?
    let quit: Bool?
}

private struct ServerResponse: Encodable {
    let id: UInt64?
    let ready: Bool?
    let text: String?
    let error: String?
}

private func option(_ name: String, in arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
        return nil
    }
    return arguments[index + 1]
}

private let sampleRate = 16_000
private let importWindowSamples = 5 * 60 * sampleRate
private let importOverlapSamples = 2 * sampleRate
private let maximumImportSamples = 12 * 60 * 60 * sampleRate
private let maximumTranscriptBytes = 2 * 1024 * 1024 - 1

private func readAudio(at path: String, maximumSamples: Int, consume: ([Float]) throws -> Void) async throws {
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

    defer { reader.cancelReading() }
    var totalSamples = 0
    while let sampleBuffer = output.copyNextSampleBuffer() {
        defer { CMSampleBufferInvalidate(sampleBuffer) }
        guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else {
            continue
        }
        let byteCount = CMBlockBufferGetDataLength(block)
        guard byteCount > 0, byteCount.isMultiple(of: MemoryLayout<Float>.size) else {
            continue
        }
        let count = byteCount / MemoryLayout<Float>.size
        // Check before allocation, including malformed decoder buffers and the
        // total decoded duration. Compressed file size does not bound audio RAM.
        guard count <= 30 * sampleRate, count <= maximumSamples - totalSamples else {
            throw RunnerFailure.message("The selected recording exceeds the safe decoded-audio limit.")
        }
        var chunk = [Float](
            repeating: 0,
            count: count
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
        totalSamples += count
        try consume(chunk)
    }

    if reader.status == .failed {
        throw RunnerFailure.message(
            reader.error?.localizedDescription ?? "macOS could not decode this media."
        )
    }
    guard totalSamples > 0 else {
        throw RunnerFailure.message("The selected media contains no decodable audio samples.")
    }
}

private func decodeAudio(at path: String) async throws -> [Float] {
    var samples: [Float] = []
    // This complete-buffer path is only used for bounded dictation segments.
    try await readAudio(at: path, maximumSamples: 150 * sampleRate) { samples.append(contentsOf: $0) }
    return samples
}

private func appendTranscript(_ next: String, to transcript: inout String) throws {
    guard !next.isEmpty else { return }
    let previousWords = transcript.split(separator: " ")
    let nextWords = next.split(separator: " ")
    let maximumOverlap = min(32, min(previousWords.count, nextWords.count))
    func normalized(_ word: Substring) -> String {
        String(word.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }).lowercased()
    }
    var overlap = 0
    if maximumOverlap >= 2 {
        for count in stride(from: maximumOverlap, through: 2, by: -1) {
            if zip(previousWords.suffix(count), nextWords.prefix(count)).allSatisfy({ normalized($0.0) == normalized($0.1) && !normalized($0.0).isEmpty }) {
                overlap = count
                break
            }
        }
    }
    let addition = nextWords.dropFirst(overlap).joined(separator: " ")
    guard transcript.utf8.count + addition.utf8.count + 1 <= maximumTranscriptBytes else {
        throw RunnerFailure.message("The recording produced too much text for one import. Split it into shorter recordings.")
    }
    if !addition.isEmpty { transcript += (transcript.isEmpty ? "" : " ") + addition }
}

private func loadContext(modelPath: String, useGPU: Bool) throws -> OpaquePointer {
    var contextParameters = whisper_context_default_params()
    contextParameters.use_gpu = useGPU

    if let context = modelPath.withCString({
        whisper_init_from_file_with_params($0, contextParameters)
    }) {
        return context
    }
    throw RunnerFailure.message("The bundled Whisper model could not be loaded.")
}

private func transcribe(
    samples: [Float],
    context: OpaquePointer,
    language: String?
) throws -> String {
    var parameters = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
    parameters.n_threads = Int32(
        min(8, max(2, ProcessInfo.processInfo.activeProcessorCount - 2))
    )
    parameters.translate = false
    parameters.no_context = true
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
    return normalized
}

private func transcribe(
    modelPath: String,
    mediaPath: String,
    language: String?,
    useGPU: Bool
) async throws -> String {
    let context = try loadContext(modelPath: modelPath, useGPU: useGPU)
    defer { whisper_free(context) }
    var pending: [Float] = []
    pending.reserveCapacity(importWindowSamples + 30 * sampleRate)
    var transcript = ""
    var completedWindows = 0
    try await readAudio(at: mediaPath, maximumSamples: maximumImportSamples) { chunk in
        pending.append(contentsOf: chunk)
        while pending.count >= importWindowSamples {
            let text = try transcribe(samples: Array(pending.prefix(importWindowSamples)), context: context, language: language)
            try appendTranscript(text, to: &transcript)
            pending.removeFirst(importWindowSamples - importOverlapSamples)
            completedWindows += 1
        }
    }
    if pending.count > (completedWindows > 0 ? importOverlapSamples : 0) {
        let text = try transcribe(samples: pending, context: context, language: language)
        try appendTranscript(text, to: &transcript)
    }
    guard !transcript.isEmpty else {
        throw RunnerFailure.message("Whisper finished without detecting any speech.")
    }
    return transcript
}

private func writeServerResponse(_ response: ServerResponse) throws {
    let data = try JSONEncoder().encode(response)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

private func runServer(modelPath: String, language: String?, useGPU: Bool) async throws {
    let context = try loadContext(modelPath: modelPath, useGPU: useGPU)
    defer { whisper_free(context) }
    try writeServerResponse(
        ServerResponse(id: nil, ready: true, text: nil, error: nil)
    )

    // Each renderer recording is an independent 30-second M4A. Retaining the
    // final two seconds supplies acoustic continuity across recorder rotation;
    // the renderer removes the repeated words when it assembles the hidden
    // transcript after Stop.
    let overlapSampleCount = 2 * 16_000
    var trailingSamples: [Float] = []
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8) else { continue }
        let request: ServerRequest
        do {
            request = try JSONDecoder().decode(ServerRequest.self, from: data)
        } catch {
            try writeServerResponse(
                ServerResponse(
                    id: nil,
                    ready: nil,
                    text: nil,
                    error: "The transcription worker received an invalid request."
                )
            )
            continue
        }
        if request.quit == true { break }
        guard let id = request.id, let input = request.input, !input.isEmpty else {
            try writeServerResponse(
                ServerResponse(
                    id: request.id,
                    ready: nil,
                    text: nil,
                    error: "The transcription worker request is incomplete."
                )
            )
            continue
        }

        do {
            let currentSamples = try await decodeAudio(at: input)
            let samples = trailingSamples + currentSamples
            trailingSamples = Array(currentSamples.suffix(overlapSampleCount))
            let transcript = try transcribe(
                samples: samples,
                context: context,
                language: language
            )
            try writeServerResponse(
                ServerResponse(id: id, ready: nil, text: transcript, error: nil)
            )
        } catch {
            try writeServerResponse(
                ServerResponse(id: id, ready: nil, text: nil, error: String(describing: error))
            )
        }
    }
}

private func run() async throws {
    let arguments = Array(CommandLine.arguments.dropFirst())
    if arguments == ["--version"] {
        print("whisper.cpp \(String(cString: whisper_version())) · Orion multilingual worker")
        return
    }
    if arguments.contains("--server") {
        guard let modelPath = option("--model", in: arguments) else {
            throw RunnerFailure.message(
                "usage: orion-whisper --server --model <model.bin> [--language <code>]"
            )
        }
        try await runServer(
            modelPath: modelPath,
            language: option("--language", in: arguments),
            useGPU: !arguments.contains("--cpu")
        )
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
        language: option("--language", in: arguments),
        useGPU: !arguments.contains("--cpu")
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
