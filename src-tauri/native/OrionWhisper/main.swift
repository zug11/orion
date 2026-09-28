import AVFoundation
import Darwin
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

private struct AlignmentToken: Encodable {
    let text: String
    let startSeconds: Double
    let endSeconds: Double
}

private struct AlignmentResponse: Encodable {
    let durationSeconds: Double
    let tokens: [AlignmentToken]
}

// Only --align installs these handlers. Dispatch signal sources run outside the
// POSIX signal handler, so checking this flag from Whisper's worker is safe.
private final class AlignmentCancellation {
    private let lock = NSLock()
    private var cancelled = false

    func cancel() {
        lock.lock()
        cancelled = true
        lock.unlock()
    }

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }

    func check() throws {
        if isCancelled { throw RunnerFailure.message("Audio alignment was cancelled.") }
    }
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

private func alignAudio(modelPath: String, mediaPath: String, useGPU: Bool) async throws {
    let maximumInputBytes = 12 * 1024 * 1024
    let maximumTokens = 8_192
    let maximumOutputBytes = 256 * 1024
    let input = try URL(fileURLWithPath: mediaPath).resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
    guard input.isRegularFile == true, let inputBytes = input.fileSize,
          inputBytes > 0, inputBytes <= maximumInputBytes else {
        throw RunnerFailure.message("Audio alignment requires a regular audio file of at most 12 MiB.")
    }

    let cancellation = AlignmentCancellation()
    let previousInterrupt = signal(SIGINT, SIG_IGN)
    let previousTermination = signal(SIGTERM, SIG_IGN)
    let signalQueue = DispatchQueue(label: "app.orion.whisper-alignment-cancellation")
    let signalSources = [SIGINT, SIGTERM].map { number in
        let source = DispatchSource.makeSignalSource(signal: number, queue: signalQueue)
        source.setEventHandler { cancellation.cancel() }
        source.resume()
        return source
    }
    defer {
        for source in signalSources { source.cancel() }
        signal(SIGINT, previousInterrupt)
        signal(SIGTERM, previousTermination)
    }

    var samples: [Float] = []
    do {
        try await readAudio(at: mediaPath, maximumSamples: 600 * sampleRate) { chunk in
            try cancellation.check()
            samples.append(contentsOf: chunk)
        }
    } catch let failure as RunnerFailure {
        throw failure
    } catch {
        try cancellation.check()
        throw RunnerFailure.message("macOS could not decode this audio for alignment.")
    }
    try cancellation.check()
    let duration = Double(samples.count) / Double(sampleRate)
    let context = try loadContext(modelPath: modelPath, useGPU: useGPU)
    defer { whisper_free(context) }
    try cancellation.check()

    var parameters = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
    parameters.n_threads = Int32(min(8, max(2, ProcessInfo.processInfo.activeProcessorCount - 2)))
    parameters.translate = false
    parameters.no_context = true
    parameters.no_timestamps = false
    parameters.token_timestamps = true
    parameters.single_segment = false
    parameters.print_special = false
    parameters.print_progress = false
    parameters.print_realtime = false
    parameters.print_timestamps = false
    parameters.language = nil
    parameters.abort_callback_user_data = Unmanaged.passUnretained(cancellation).toOpaque()
    parameters.abort_callback = { pointer in
        guard let pointer else { return false }
        return Unmanaged<AlignmentCancellation>.fromOpaque(pointer).takeUnretainedValue().isCancelled
    }
    // No initial prompt or requested narration text reaches this acoustic pass.
    let result = samples.withUnsafeBufferPointer { buffer -> Int32 in
        guard let base = buffer.baseAddress else { return -1 }
        return whisper_full(context, parameters, base, Int32(buffer.count))
    }
    try cancellation.check()
    guard result == 0 else {
        throw RunnerFailure.message("The bundled Whisper engine could not align this audio.")
    }

    var tokens: [AlignmentToken] = []
    var rawTokenCount = 0
    var textBytes = 0
    var pendingBytes: [UInt8] = []
    var pendingStart: Double?
    var pendingEnd = 0.0
    let specialTokenStart = whisper_token_eot(context)
    let segmentCount = whisper_full_n_segments(context)
    guard segmentCount >= 0, segmentCount <= maximumTokens else {
        throw RunnerFailure.message("Audio alignment produced too many segments.")
    }
    for segment in 0 ..< segmentCount {
        try cancellation.check()
        let count = whisper_full_n_tokens(context, segment)
        guard count >= 0, count <= maximumTokens else {
            throw RunnerFailure.message("Audio alignment produced too many tokens.")
        }
        for index in 0 ..< count {
            let token = whisper_full_get_token_data(context, segment, index)
            guard token.id >= 0, token.id < specialTokenStart else { continue }
            rawTokenCount += 1
            guard rawTokenCount <= maximumTokens else {
                throw RunnerFailure.message("Audio alignment exceeds its 8192-token limit.")
            }
            guard token.t0 >= 0, token.t1 >= token.t0,
                  let rawText = whisper_full_get_token_text(context, segment, index) else {
                throw RunnerFailure.message("Whisper returned an invalid acoustic timestamp.")
            }
            // Whisper vocabulary entries may be incomplete UTF-8 byte pieces.
            // Combine them before constructing a String rather than replacing
            // the pieces of a multilingual character with replacement symbols.
            let byteCount = strnlen(rawText, 4_097)
            guard byteCount <= 4_096, textBytes + byteCount <= maximumOutputBytes / 2,
                  pendingBytes.count + byteCount <= 4_096 else {
                throw RunnerFailure.message("Audio alignment produced too much token text.")
            }
            textBytes += byteCount
            pendingBytes.append(contentsOf: UnsafeRawBufferPointer(start: rawText, count: byteCount))
            pendingStart = min(pendingStart ?? Double(token.t0) / 100, Double(token.t0) / 100)
            pendingEnd = max(pendingEnd, Double(token.t1) / 100)
            guard let text = String(bytes: pendingBytes, encoding: .utf8) else { continue }
            let start = min(duration, pendingStart ?? 0)
            let end = min(duration, pendingEnd)
            if !text.isEmpty, start < duration {
                tokens.append(AlignmentToken(text: text, startSeconds: start, endSeconds: end))
            }
            pendingBytes.removeAll(keepingCapacity: true)
            pendingStart = nil
            pendingEnd = 0
        }
    }
    guard pendingBytes.isEmpty else {
        throw RunnerFailure.message("Whisper returned incomplete Unicode token text.")
    }
    guard !tokens.isEmpty else {
        throw RunnerFailure.message("Whisper finished without detecting timed speech.")
    }
    try cancellation.check()
    let data = try JSONEncoder().encode(AlignmentResponse(durationSeconds: duration, tokens: tokens))
    guard data.count + 1 <= maximumOutputBytes else {
        throw RunnerFailure.message("Audio alignment exceeds its 256 KiB output limit.")
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
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
    if arguments.contains("--align") {
        guard !arguments.contains("--server"),
              let modelPath = option("--model", in: arguments),
              let mediaPath = option("--input", in: arguments) else {
            throw RunnerFailure.message("usage: orion-whisper --align --model <model.bin> --input <audio> [--cpu]")
        }
        try await alignAudio(modelPath: modelPath, mediaPath: mediaPath, useGPU: !arguments.contains("--cpu"))
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
