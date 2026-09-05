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
    let samples = try await decodeAudio(at: mediaPath)
    let context = try loadContext(modelPath: modelPath, useGPU: useGPU)
    defer { whisper_free(context) }
    let transcript = try transcribe(samples: samples, context: context, language: language)
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
