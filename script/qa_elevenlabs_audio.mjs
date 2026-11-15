// Explicit native QA child. Receives one signed URL through stdin, never disk.
// All speech is synthesized locally by its parent; no microphone or user notes.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const options = JSON.parse(fs.readFileSync(0, 'utf8'));
const started = performance.now();
let socket, done = false, timer, pump, initialTimer;
let inputRate = 0, outputRate = 0, chunks = [], currentFixture = -1, fixtureOffset = 0;
let nextDue = 0, firstAudioAt = 0, interruptionAt = 0, bargeInAt = 0;
let sentFixtures = 0, sentChunks = 0, finalTranscripts = 0, audioEvents = 0, audioBytes = 0;
let unsolicitedAudio = 0, unexpectedTools = 0, interruptions = 0, vadEvents = 0;
let firstTranscript = false, interruptTranscript = false, followupTranscript = false;
let secondReply = false, secondAudio = false, followupReply = false, followupAudio = false;
let secondResponseId = -1, thirdResponseId = -1, oldResponseId = -1, lateOldAudio = 0;
let nextTurnTimer;
const receivedAudioIds = new Set();
const events = [];
const elapsed = () => Math.round(performance.now() - started);
const record = (type, extra = {}) => { if (events.length < 80) events.push({ type, atMs: elapsed(), ...extra }); };
const normalize = value => typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim() : '';
const hasWord = value => /\b(marigold|mary gold|marie gold)\b/.test(normalize(value));

function finish(ok, reason) {
  if (done) return;
  done = true;
  clearTimeout(timer); clearTimeout(pump); clearTimeout(initialTimer); clearTimeout(nextTurnTimer);
  try { socket?.close(1000, 'Synthetic QA completed'); } catch {}
  const summary = { ok, reason, elapsedMs: elapsed(), inputRate, outputRate, sentFixtures, sentChunks,
    finalTranscripts, firstTranscript, interruptTranscript, followupTranscript, interruptions,
    interruptionDuringResponse: interruptionAt > bargeInAt && bargeInAt > firstAudioAt && firstAudioAt > 0,
    interruptionDelayMs: interruptionAt && bargeInAt ? interruptionAt - bargeInAt : null,
    secondReply, secondAudio, followupReply, followupAudio, audioEvents, audioBytes,
    silentStartup: unsolicitedAudio === 0, unexpectedTools, vadEvents, lateOldAudio, events };
  if (typeof options.outputDir === 'string') {
    fs.writeFileSync(path.join(options.outputDir, 'results.json'), JSON.stringify(summary, null, 2));
  }
  process.stdout.write(JSON.stringify(summary));
  setTimeout(() => process.exit(ok ? 0 : 1), 100);
}

function beginFixture(index) {
  if (done || currentFixture >= 0 || !chunks[index]) return;
  currentFixture = index; fixtureOffset = 0; sentFixtures++;
  if (index === 1) bargeInAt = elapsed();
  record(`spoken_fixture_${index + 1}_started`);
}

function scheduleFollowup() {
  if (!secondReply || !secondAudio || !interruptTranscript || !interruptions || nextTurnTimer) return;
  nextTurnTimer = setTimeout(() => beginFixture(2), 2_200);
}

function pumpAudio() {
  if (done || socket?.readyState !== WebSocket.OPEN) return;
  const bytesPerChunk = Math.round(inputRate * 0.025) * 2;
  let payload = Buffer.alloc(bytesPerChunk);
  if (currentFixture >= 0) {
    const source = chunks[currentFixture];
    source.copy(payload, 0, fixtureOffset, Math.min(source.length, fixtureOffset + bytesPerChunk));
    fixtureOffset += bytesPerChunk;
    if (fixtureOffset >= source.length) {
      record(`spoken_fixture_${currentFixture + 1}_finished`);
      currentFixture = -1; fixtureOffset = 0;
    }
  }
  socket.send(JSON.stringify({ user_audio_chunk: payload.toString('base64') }));
  sentChunks++;
  nextDue += 25;
  pump = setTimeout(pumpAudio, Math.max(0, nextDue - performance.now()));
}

function metadata(event) {
  if (inputRate) return;
  const config = event.conversation_initiation_metadata_event;
  const inputMatch = /^pcm_(\d+)$/.exec(config?.user_input_audio_format ?? 'pcm_16000');
  const outputMatch = /^pcm_(\d+)$/.exec(config?.agent_output_audio_format ?? '');
  if (!inputMatch || !outputMatch) return finish(false, 'unsupported_negotiated_audio_format');
  inputRate = Number(inputMatch[1]); outputRate = Number(outputMatch[1]);
  if (![8000, 16000, 22050, 24000, 44100, 48000].includes(inputRate) || outputRate < 8000 || outputRate > 96000) return finish(false, 'unsupported_audio_rate');
  for (const file of options.fixtures) {
    const converted = spawnSync(options.ffmpeg, ['-nostdin', '-v', 'error', '-i', file, '-ac', '1', '-ar', String(inputRate), '-f', 's16le', 'pipe:1'], { maxBuffer: 8 * 1024 * 1024, timeout: 15000 });
    if (converted.status !== 0 || !converted.stdout?.length || converted.stdout.length > inputRate * 2 * 35) return finish(false, 'synthetic_fixture_conversion_failed');
    chunks.push(converted.stdout);
  }
  if (chunks.length !== 3) return finish(false, 'invalid_fixture_count');
  record('metadata_received');
  nextDue = performance.now(); pumpAudio();
  initialTimer = setTimeout(() => unsolicitedAudio ? finish(false, 'unsolicited_startup_audio') : beginFixture(0), 2_000);
}

function receive(raw) {
  let event; try { event = JSON.parse(String(raw)); } catch { return finish(false, 'invalid_provider_event'); }
  if (event.type === 'ping') { socket.send(JSON.stringify({ type: 'pong', event_id: event.ping_event?.event_id })); return; }
  if (event.type === 'conversation_initiation_metadata') { metadata(event); return; }
  if (event.type === 'vad_score') { vadEvents++; return; }
  if (event.type === 'user_transcript') {
    const text = normalize(event.user_transcription_event?.user_transcript);
    finalTranscripts++;
    if (sentFixtures === 1 && hasWord(text)) firstTranscript = true;
    if (sentFixtures === 2 && /\bstop\b/.test(text)) interruptTranscript = true;
    if (sentFixtures === 3 && /\b(word|remember)\b/.test(text)) followupTranscript = true;
    record('final_user_transcript', { fixture: sentFixtures, expectedMatched: sentFixtures === 1 ? firstTranscript : sentFixtures === 2 ? interruptTranscript : followupTranscript });
    scheduleFollowup();
    return;
  }
  if (event.type === 'interruption') {
    if (sentFixtures === 2 && firstAudioAt) {
      interruptions++; interruptionAt ||= elapsed();
      record('provider_interruption');
    }
    return;
  }
  if (event.type === 'client_tool_call') {
    unexpectedTools++;
    socket.send(JSON.stringify({ type: 'client_tool_result', tool_call_id: event.client_tool_call?.tool_call_id, result: 'This is a synthetic voice transport test. No research or writes were executed.', is_error: false }));
    return;
  }
  if (event.type === 'agent_response') {
    const response = event.agent_response_event;
    if (sentFixtures === 1) oldResponseId = response?.event_id ?? -1;
    if (sentFixtures === 2 && interruptTranscript) {
      secondReply = /\b(stopped|listening)\b/.test(normalize(response?.agent_response));
      secondResponseId = response?.event_id ?? -1;
      secondAudio = receivedAudioIds.has(secondResponseId);
      record('second_agent_reply', { expectedMatched: secondReply });
    }
    if (sentFixtures === 3 && followupTranscript) {
      followupReply = hasWord(response?.agent_response); thirdResponseId = response?.event_id ?? -1;
      followupAudio = receivedAudioIds.has(thirdResponseId);
      record('followup_agent_reply', { retainedWordMatched: followupReply });
    }
    scheduleFollowup();
  }
  if (event.type === 'audio') {
    audioEvents++;
    const bytes = Buffer.from(event.audio_event?.audio_base_64 ?? '', 'base64'); audioBytes += bytes.length;
    const id = event.audio_event?.event_id;
    if (Number.isSafeInteger(id) && receivedAudioIds.size < 1000) receivedAudioIds.add(id);
    if (!sentFixtures) unsolicitedAudio++;
    if (interruptionAt && id === oldResponseId) lateOldAudio++;
    if (sentFixtures === 1 && bytes.length && firstTranscript && !firstAudioAt) {
      firstAudioAt = elapsed(); record('first_agent_audio');
      setTimeout(() => { if (currentFixture < 0) beginFixture(1); else finish(false, 'agent_spoke_before_first_fixture_finished'); }, 600);
    }
    if (sentFixtures === 2 && secondReply && id === secondResponseId && bytes.length) secondAudio = true;
    if (sentFixtures === 3 && followupReply && id === thirdResponseId && bytes.length) followupAudio = true;
    scheduleFollowup();
  }
  if (followupReply && followupAudio && followupTranscript) {
    return finish(firstTranscript && interruptTranscript && interruptions > 0 && secondReply && secondAudio && unsolicitedAudio === 0 && unexpectedTools === 0, 'spoken_interruption_and_continuity');
  }
  if (event.type === 'error' || event.type === 'client_error') finish(false, 'provider_error');
}

try {
  const url = new URL(options.signedUrl);
  if (url.protocol !== 'wss:' || url.hostname !== 'api.elevenlabs.io' || url.pathname !== '/v1/convai/conversation') throw new Error();
  timer = setTimeout(() => finish(false, 'bounded_timeout'), 100_000);
  socket = new WebSocket(options.signedUrl);
  socket.onopen = () => socket.send(JSON.stringify({ type: 'conversation_initiation_client_data', conversation_config_override: { tts: { voice_id: options.voiceId } } }));
  socket.onmessage = event => receive(event.data);
  socket.onerror = () => finish(false, 'socket_error');
  socket.onclose = () => { if (!done) finish(false, 'closed_early'); };
} catch { finish(false, 'probe_setup_failed'); }
