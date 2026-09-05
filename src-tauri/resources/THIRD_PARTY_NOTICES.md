# Orion bundled transcription notices

Orion includes the following components so media transcription works
without separately installed software or a local server.

## React Bits visual effects

- Project: https://www.reactbits.dev/
- Component adapted in Orion: Line Waves
- License: MIT + Commons Clause (`licenses/react-bits-LICENSE`)

## Radiant visual effects

- Project: https://github.com/pbakaus/radiant
- Component adapted in Orion: Signal Decay
- License: MIT (`licenses/radiant-LICENSE`)

## whisper.cpp 1.9.1

- Project: https://github.com/ggml-org/whisper.cpp
- Artifact: official macOS XCFramework release
- Upstream archive SHA-256:
  `8c3ecbe73f48b0cb9318fc3058264f951ab336fd530e82c4ccdd2298d1311a4c`
- License: MIT (`licenses/whisper.cpp-LICENSE`)

## Whisper small multilingual model

- Project: https://huggingface.co/ggerganov/whisper.cpp
- Artifact: `ggml-small.bin`
- Size: 487,601,967 bytes
- SHA-256:
  `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`
- Model origin: OpenAI Whisper
- License: MIT (`licenses/openai-whisper-LICENSE`)

## Whisper medium multilingual model

- Project: https://huggingface.co/ggerganov/whisper.cpp
- Artifact: `ggml-medium.bin`
- Size: 1,533,763,059 bytes
- Upstream SHA-1:
  `fd9727b6e1217c2f614f9b698455c4ffd82463b4`
- SHA-256:
  `6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208`
- Model origin: OpenAI Whisper
- License: MIT (`licenses/openai-whisper-LICENSE`)

## yt-dlp 2026.07.04

- Project: https://github.com/yt-dlp/yt-dlp
- Artifact: official universal `yt-dlp_macos` standalone executable
- SHA-256:
  `498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b`
- The PyInstaller-combined executable is distributed under GPLv3+ and contains
  components under additional licenses. See `licenses/yt-dlp-LICENSE`,
  `licenses/yt-dlp-THIRD_PARTY_LICENSES.txt`, and
  `licenses/GPL-3.0.txt`.

## Deno 2.9.4

- Project: https://github.com/denoland/deno
- Artifact: official Apple Silicon standalone executable
- Upstream archive SHA-256:
  `6d17647fdbf9c587a581dba205054c4ccf732dae0a196cc1e9b44c07589db412`
- Bundled executable SHA-256:
  `433088c827fa0e39ff162ab0e475f1fd4c7690eaedec500cf678edc3865e9287`
- License: MIT (`licenses/deno-LICENSE`)

The Deno runtime is passed directly to yt-dlp for YouTube JavaScript challenge
solving. Downloaded media remains in a unique OS temporary directory and is
deleted immediately after transcription succeeds or fails.
