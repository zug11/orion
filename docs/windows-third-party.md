# Orion Windows media and OCR notices

- [whisper.cpp 1.9.1](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.1), MIT, official CPU x64 Windows build. Archive SHA-256: `7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539`.
- [OpenAI Whisper small multilingual model](https://huggingface.co/ggerganov/whisper.cpp), MIT. SHA-256: `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`.
- [Tesseract.js](https://github.com/naptha/tesseract.js), [Tesseract.js Core](https://github.com/naptha/tesseract.js-core), and [English trained data](https://github.com/tesseract-ocr/tessdata_best), Apache-2.0. Orion bundles the integer LSTM model from `@tesseract.js-data/eng`, and loads the model, worker and WebAssembly from its own packaged assets.
