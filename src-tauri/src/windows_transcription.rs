//! Windows transcription uses Media Foundation for local audio decoding and
//! the bundled CPU build of whisper.cpp for inference.
use crate::media_jobs::{Control, TRANSCRIPTION_TIMEOUT};
use std::{
    fs::{self, File},
    io::{Seek, Write},
    os::windows::{ffi::OsStrExt, process::CommandExt},
    path::Path,
    process::{Command, Stdio},
};
use windows::{
    core::PCWSTR,
    Win32::{
        Media::MediaFoundation::*,
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
    },
};

const RATE: u32 = 16_000;
const BYTES_PER_SECOND: u32 = RATE * 2;
const MAX_PCM_BYTES: u32 = BYTES_PER_SECOND * 30 * 60;

struct ComApartment;
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

struct MediaFoundation;
impl Drop for MediaFoundation {
    fn drop(&mut self) {
        let _ = unsafe { MFShutdown() };
    }
}

fn codec_error(error: windows::core::Error) -> String {
    format!("Windows could not decode the audio ({error}). Try a WAV, MP3, M4A, or MP4 with an audio track.")
}

fn decode_wave(input: &Path, output: &Path, control: &Control) -> Result<(), String> {
    // The COM objects and their locked buffers stay on this blocking thread.
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(codec_error)?;
        let _com = ComApartment;
        MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET).map_err(codec_error)?;
        let _media_foundation = MediaFoundation;
        let path: Vec<u16> = input.as_os_str().encode_wide().chain([0]).collect();
        // Give the reader a file byte stream. The renderer cannot supply a
        // network URL or a shell argument to the decoder.
        let source = MFCreateFile(
            MF_ACCESSMODE_READ,
            MF_OPENMODE_FAIL_IF_NOT_EXIST,
            MF_FILEFLAGS_NONE,
            PCWSTR(path.as_ptr()),
        )
        .map_err(codec_error)?;
        let reader = MFCreateSourceReaderFromByteStream(&source, None).map_err(codec_error)?;
        let stream = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;
        reader
            .SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)
            .and_then(|_| reader.SetStreamSelection(stream, true))
            .map_err(codec_error)?;
        let requested = MFCreateMediaType().map_err(codec_error)?;
        requested
            .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
            .and_then(|_| requested.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM))
            .and_then(|_| requested.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16))
            .and_then(|_| requested.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 1))
            .and_then(|_| requested.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, RATE))
            .and_then(|_| requested.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 2))
            .and_then(|_| requested.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, BYTES_PER_SECOND))
            .and_then(|_| reader.SetCurrentMediaType(stream, None, &requested))
            .map_err(codec_error)?;
        let actual = reader.GetCurrentMediaType(stream).map_err(codec_error)?;
        if actual.GetGUID(&MF_MT_SUBTYPE).map_err(codec_error)? != MFAudioFormat_PCM
            || actual
                .GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS)
                .map_err(codec_error)?
                != 1
            || actual
                .GetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE)
                .map_err(codec_error)?
                != 16
            || actual
                .GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND)
                .map_err(codec_error)?
                != RATE
        {
            return Err("Windows could not convert this audio to mono PCM.".into());
        }

        let write_error = |error| format!("Orion could not stage decoded audio: {error}");
        let mut wav = File::create(output).map_err(write_error)?;
        wav.write_all(&[0; 44]).map_err(write_error)?;
        let mut written = 0u32;
        loop {
            control.check()?;
            let mut sample = None;
            let mut flags = 0;
            reader
                .ReadSample(stream, 0, None, Some(&mut flags), None, Some(&mut sample))
                .map_err(codec_error)?;
            if flags
                & (MF_SOURCE_READERF_ERROR.0 | MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0) as u32
                != 0
            {
                return Err(
                    "The audio track could not be decoded or changed format midstream.".into(),
                );
            }
            if let Some(sample) = sample {
                let buffer = sample.ConvertToContiguousBuffer().map_err(codec_error)?;
                let mut bytes = std::ptr::null_mut();
                let mut length = 0;
                buffer
                    .Lock(&mut bytes, None, Some(&mut length))
                    .map_err(codec_error)?;
                let write = if length > MAX_PCM_BYTES - written {
                    Err("Choose a recording up to 30 minutes on Windows.".into())
                } else if length == 0 {
                    Ok(())
                } else if bytes.is_null() || length % 2 != 0 {
                    Err("Windows returned an invalid audio frame.".into())
                } else {
                    // Media Foundation guarantees this range until Unlock.
                    let pcm = std::slice::from_raw_parts(bytes, length as usize);
                    wav.write_all(pcm).map_err(write_error)
                };
                let unlocked = buffer.Unlock().map_err(codec_error);
                write?;
                unlocked?;
                written += length;
            }
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                break;
            }
        }
        if written == 0 {
            return Err("No audio was found in this file.".into());
        }
        wav.rewind().map_err(write_error)?;
        wav.write_all(b"RIFF").map_err(write_error)?;
        wav.write_all(&(written + 36).to_le_bytes())
            .map_err(write_error)?;
        wav.write_all(b"WAVEfmt ").map_err(write_error)?;
        wav.write_all(&16u32.to_le_bytes()).map_err(write_error)?;
        wav.write_all(&[1, 0, 1, 0]).map_err(write_error)?; // PCM, one channel
        wav.write_all(&RATE.to_le_bytes()).map_err(write_error)?;
        wav.write_all(&BYTES_PER_SECOND.to_le_bytes())
            .map_err(write_error)?;
        wav.write_all(&[2, 0, 16, 0]).map_err(write_error)?; // Frame bytes, bits/sample
        wav.write_all(b"data").map_err(write_error)?;
        wav.write_all(&written.to_le_bytes()).map_err(write_error)?;
        wav.flush().map_err(write_error)
    }
}

pub(super) fn no_console(command: &mut Command) -> &mut Command {
    // CREATE_NO_WINDOW: background transcription must not flash a console.
    command.creation_flags(0x0800_0000)
}

pub(super) fn transcribe(
    whisper: &Path,
    model: &Path,
    input: &Path,
    language: Option<&str>,
    control: &Control,
) -> Result<String, String> {
    let directory = tempfile::Builder::new()
        .prefix("orion-whisper-")
        .tempdir()
        .map_err(|error| format!("Orion could not prepare local transcription: {error}"))?;
    let work = directory.path();
    decode_wave(input, &work.join("recording.wav"), control)?;

    // The upstream command's main() uses the system code page. Keep argument
    // paths ASCII even when the installation or profile folder uses Unicode.
    let model_arg = if model.to_str().is_some_and(str::is_ascii) {
        model
    } else {
        let staged = work.join("model.bin");
        if fs::hard_link(model, &staged).is_err() {
            fs::copy(model, &staged).map_err(|error| {
                format!("Orion could not stage its local speech model: {error}")
            })?;
        }
        Path::new("model.bin")
    };

    let output = control.run(
        no_console(&mut Command::new(whisper))
            .current_dir(work)
            .stdin(Stdio::null())
            .args(["--file", "recording.wav", "--model"])
            .arg(model_arg)
            .args([
                "--language",
                language.unwrap_or("auto"),
                "--no-gpu",
                "--no-prints",
                "--output-txt",
                "--output-file",
                "transcript",
            ]),
        TRANSCRIPTION_TIMEOUT,
    )?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr);
        return Err(message
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("Whisper could not finish transcribing this recording.")
            .chars()
            .take(900)
            .collect());
    }
    let transcript = work.join("transcript.txt");
    if fs::metadata(&transcript)
        .map(|file| file.len())
        .unwrap_or(0)
        > 2 * 1024 * 1024
    {
        return Err("The recording produced too much text. Try a shorter recording.".into());
    }
    fs::read_to_string(transcript)
        .map(|text| text.trim().to_string())
        .map_err(|error| format!("Orion could not read the local transcript: {error}"))
}
