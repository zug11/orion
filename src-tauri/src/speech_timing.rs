//! Optional audio-derived word ranges. Never estimate timings for unmatched text.
use serde::{Deserialize, Serialize};

pub(crate) const MAX_AUDIO_BYTES: usize = 12 * 1024 * 1024;
pub(crate) const MAX_ALIGNMENT_BYTES: usize = 256 * 1024;
const MAX_SECONDS: f64 = 600.0;
const MAX_TOKENS: usize = 8_192;
const MAX_WORDS: usize = 2_048;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpeechWordTiming {
    pub(crate) start_char: usize,
    pub(crate) end_char: usize,
    pub(crate) start_seconds: f64,
    pub(crate) end_seconds: f64,
}

#[derive(Deserialize)]
struct CharacterAlignment {
    characters: Vec<String>,
    character_start_times_seconds: Vec<f64>,
    character_end_times_seconds: Vec<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcousticAlignment {
    duration_seconds: f64,
    tokens: Vec<AcousticToken>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcousticToken {
    text: String,
    start_seconds: f64,
    end_seconds: f64,
}

#[derive(Debug)]
struct Word {
    key: String,
    start: usize,
    end: usize,
}

fn words(text: &str) -> Vec<Word> {
    let mut result = Vec::new();
    let mut position = 0;
    let mut start = None;
    let mut key = String::new();
    for character in text.chars().chain(std::iter::once(' ')) {
        if character.is_whitespace() {
            if let Some(first) = start.take() {
                if !key.is_empty() {
                    result.push(Word {
                        key: std::mem::take(&mut key),
                        start: first,
                        end: position,
                    });
                }
                key.clear();
            }
        } else {
            start.get_or_insert(position);
            if character.is_alphanumeric() {
                key.extend(character.to_lowercase());
            }
        }
        position += character.len_utf16();
    }
    result
}

fn valid_time(start: f64, end: f64, duration: f64) -> bool {
    start.is_finite() && end.is_finite() && start >= 0.0 && end >= start && end <= duration
}

pub(crate) fn from_character_alignment(
    text: &str,
    value: serde_json::Value,
) -> Option<Vec<SpeechWordTiming>> {
    if text.chars().count() > 4_096 {
        return None;
    }
    let alignment: CharacterAlignment = serde_json::from_value(value).ok()?;
    let count = alignment.characters.len();
    if count == 0
        || count > MAX_TOKENS
        || alignment.character_start_times_seconds.len() != count
        || alignment.character_end_times_seconds.len() != count
    {
        return None;
    }
    let mut joined = String::new();
    let mut spans = Vec::with_capacity(count);
    let mut previous = (0.0, 0.0);
    let mut position = 0;
    for ((character, start), end) in alignment
        .characters
        .into_iter()
        .zip(alignment.character_start_times_seconds)
        .zip(alignment.character_end_times_seconds)
    {
        if character.is_empty()
            || character.encode_utf16().count() > 8
            || !valid_time(start, end, MAX_SECONDS)
            || start < previous.0
            || end < previous.1
        {
            return None;
        }
        let next = position + character.encode_utf16().count();
        spans.push(SpeechWordTiming {
            start_char: position,
            end_char: next,
            start_seconds: start,
            end_seconds: end,
        });
        position = next;
        joined.push_str(&character);
        previous = (start, end);
    }
    if joined != text {
        return None;
    }
    let result: Vec<_> = words(text)
        .iter()
        .filter_map(|word| timing_for_range(word, &spans))
        .collect();
    (!result.is_empty()).then_some(result)
}

fn timing_for_range(word: &Word, spans: &[SpeechWordTiming]) -> Option<SpeechWordTiming> {
    let first = spans.iter().find(|span| span.end_char > word.start)?;
    let last = spans.iter().rev().find(|span| span.start_char < word.end)?;
    if last.end_seconds <= first.start_seconds {
        return None;
    }
    Some(SpeechWordTiming {
        start_char: word.start,
        end_char: word.end,
        start_seconds: first.start_seconds,
        end_seconds: last.end_seconds,
    })
}

pub(crate) fn from_acoustic_json(text: &str, bytes: &[u8]) -> Option<Vec<SpeechWordTiming>> {
    if bytes.len() > MAX_ALIGNMENT_BYTES || text.chars().count() > 4_096 {
        return None;
    }
    let alignment: AcousticAlignment = serde_json::from_slice(bytes).ok()?;
    if !alignment.duration_seconds.is_finite()
        || alignment.duration_seconds <= 0.0
        || alignment.duration_seconds > MAX_SECONDS
        || alignment.tokens.is_empty()
        || alignment.tokens.len() > MAX_TOKENS
    {
        return None;
    }
    let mut recognized = String::new();
    let mut spans = Vec::new();
    let mut position = 0;
    let mut previous_start = 0.0;
    for token in alignment.tokens {
        if token.text.is_empty()
            || token.text.len() > 4_096
            || !valid_time(
                token.start_seconds,
                token.end_seconds,
                alignment.duration_seconds + 0.05,
            )
            || token.start_seconds < previous_start
        {
            return None;
        }
        let next = position + token.text.encode_utf16().count();
        if next > 32_768 {
            return None;
        }
        spans.push(SpeechWordTiming {
            start_char: position,
            end_char: next,
            start_seconds: token.start_seconds,
            end_seconds: token.end_seconds,
        });
        position = next;
        previous_start = token.start_seconds;
        recognized.push_str(&token.text);
    }
    let expected = words(text);
    let heard = words(&recognized);
    if expected.is_empty()
        || expected.len() > MAX_WORDS
        || heard.is_empty()
        || heard.len() > MAX_WORDS
    {
        return None;
    }
    // Longest common subsequence retains order through repetitions and omissions.
    // At most (2049^2) u16 values (~8 MiB); no fuzzy matches or timing interpolation.
    let columns = heard.len() + 1;
    let mut lengths = vec![0_u16; (expected.len() + 1) * columns];
    for i in (0..expected.len()).rev() {
        for j in (0..heard.len()).rev() {
            lengths[i * columns + j] = if expected[i].key == heard[j].key {
                1 + lengths[(i + 1) * columns + j + 1]
            } else {
                lengths[(i + 1) * columns + j].max(lengths[i * columns + j + 1])
            };
        }
    }
    if usize::from(lengths[0]) * 100 < expected.len() * 60 {
        return None;
    }
    let optimal = lengths[0];
    let mut prefix = vec![0_u16; columns];
    let mut result = Vec::new();
    for i in 0..expected.len() {
        // If an equally good sequence can omit this original word, its occurrence
        // is ambiguous (e.g. one missing "I think" from "I think I think").
        let mandatory = (0..columns).all(|j| prefix[j] + lengths[(i + 1) * columns + j] < optimal);
        let candidates: Vec<_> = (0..heard.len())
            .filter(|&j| {
                expected[i].key == heard[j].key
                    && prefix[j] + 1 + lengths[(i + 1) * columns + j + 1] == optimal
            })
            .collect();
        if mandatory && candidates.len() == 1 {
            let j = candidates[0];
            if let Some(timing) = timing_for_range(&heard[j], &spans) {
                // A single acoustic span spanning several words cannot establish
                // an individual word boundary. Leave those words untracked.
                let first_span = spans.iter().find(|span| span.end_char > heard[j].start)?;
                let last_span = spans
                    .iter()
                    .rev()
                    .find(|span| span.start_char < heard[j].end)?;
                let shared_token = (j > 0 && first_span.start_char < heard[j - 1].end)
                    || (j + 1 < heard.len() && last_span.end_char > heard[j + 1].start);
                if !shared_token {
                    result.push(SpeechWordTiming {
                        start_char: expected[i].start,
                        end_char: expected[i].end,
                        ..timing
                    });
                }
            }
        }
        let mut diagonal = 0;
        for j in 0..heard.len() {
            let above = prefix[j + 1];
            prefix[j + 1] = if expected[i].key == heard[j].key {
                diagonal + 1
            } else {
                prefix[j].max(above)
            };
            diagonal = above;
        }
    }
    (!result.is_empty()).then_some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn character_alignment_preserves_original_utf16_offsets() {
        let text = "🙂 Hello café.";
        let characters: Vec<String> = text
            .chars()
            .map(|character| character.to_string())
            .collect();
        let starts: Vec<f64> = (0..characters.len()).map(|i| i as f64 / 10.0).collect();
        let ends: Vec<f64> = starts.iter().map(|time| time + 0.1).collect();
        let alignment = json!({"characters":characters,"character_start_times_seconds":starts,"character_end_times_seconds":ends});
        let words = from_character_alignment(text, alignment.clone()).unwrap();
        assert_eq!((words[0].start_char, words[0].end_char), (3, 8));
        assert_eq!((words[1].start_char, words[1].end_char), (9, 14));
        assert!(from_character_alignment("Different text", alignment).is_none());
    }

    #[test]
    fn acoustic_matching_keeps_repetitions_and_does_not_time_missing_words() {
        let raw = json!({"durationSeconds":5.0,"tokens":[
            {"text":" We","startSeconds":0.1,"endSeconds":0.3},
            {"text":" learn","startSeconds":0.3,"endSeconds":0.7},
            {"text":" and","startSeconds":1.0,"endSeconds":1.2},
            {"text":" we","startSeconds":1.2,"endSeconds":1.4},
            {"text":" learn.","startSeconds":1.4,"endSeconds":2.0}
        ]});
        let words = from_acoustic_json(
            "We learn carefully and we learn.",
            &serde_json::to_vec(&raw).unwrap(),
        )
        .unwrap();
        assert_eq!(words.len(), 5);
        assert_eq!(words[2].start_char, 19);
        assert_eq!(words[4].start_char, 26);
        assert_eq!(words[4].start_seconds, 1.4);
    }

    #[test]
    fn omitted_repeated_phrases_do_not_get_an_arbitrary_occurrence() {
        let tokens: Vec<_> = [" I", " think", " we", " should", " leave"].into_iter().enumerate()
            .map(|(i, text)| json!({"text":text,"startSeconds":i as f64,"endSeconds":i as f64 + 0.5})).collect();
        let raw = json!({"durationSeconds":5.0,"tokens":tokens});
        let words = from_acoustic_json(
            "I think I think we should leave",
            &serde_json::to_vec(&raw).unwrap(),
        )
        .unwrap();
        assert_eq!(words.len(), 3);
        assert_eq!(words[0].start_char, 16);
        assert_eq!(words[0].start_seconds, 2.0);
    }

    #[test]
    fn malformed_or_unrelated_alignment_never_invents_progress() {
        for raw in [
            json!({"durationSeconds":2.0,"tokens":[{"text":"hello","startSeconds":1.0,"endSeconds":0.5}]}),
            json!({"durationSeconds":2.0,"tokens":[{"text":"other","startSeconds":0.0,"endSeconds":1.0}]}),
            json!({"durationSeconds":2.0,"tokens":[{"text":"hello world","startSeconds":0.0,"endSeconds":1.0}]}),
            json!({"durationSeconds":601.0,"tokens":[]}),
        ] {
            assert!(
                from_acoustic_json("hello world", &serde_json::to_vec(&raw).unwrap()).is_none()
            );
        }
        assert!(from_acoustic_json("hello", &vec![b' '; MAX_ALIGNMENT_BYTES + 1]).is_none());
    }

    #[test]
    fn rejects_character_timing_order_and_length_mismatch() {
        assert!(from_character_alignment(
            "Hi",
            json!({"characters":["H","i"],
            "character_start_times_seconds":[0.2,0.1],"character_end_times_seconds":[0.3,0.4]})
        )
        .is_none());
        assert!(from_character_alignment(
            "Hi",
            json!({"characters":["H","i"],
            "character_start_times_seconds":[0.0],"character_end_times_seconds":[0.1]})
        )
        .is_none());
    }
}
