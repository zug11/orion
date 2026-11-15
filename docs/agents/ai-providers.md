# AI providers and accounts

Part of the Orion agent manual. [`AGENTS.md`](../../AGENTS.md) holds the rules
that apply everywhere and the index of these manuals. This file has the same
authority for its area: ChatGPT plan sign-in, the model picker and the ElevenLabs voice studio.

Read it before changing `src-tauri/src/chatgpt.rs`, `src-tauri/src/elevenlabs_voices.rs` and the AI and Voice sections of `src/components/SettingsView.tsx`.

Related: [Chat](chat.md), [Space voice and working views](voice.md).

## Model picker

- The intelligence picker includes GPT-6 Astra (`gpt-6-astra`) through the
  existing OpenAI request path. Selecting it changes None reasoning to Low and
  disables None while selected; its visible supported depths run Low through
  Extra high. Preserve the exact selected model in persistence and requests.

## ChatGPT plan authentication and voice creation

`src-tauri/src/chatgpt.rs` implements the documented local SIWC dynamic-registration
flow for Orion. Use `agent_name_hint=Orion`, a stable installation host UUID, fresh
state/nonce/S256 PKCE and an HTTP 127.0.0.1 `/auth/callback` listener. Preserve each
issued client registration across sign-out and failed code exchange. Validate ID
signature/JWKS, issuer, audience, expiry, nonce and returning subject; require the
plan-use scope before activating. Never expose tokens or authorization URLs through
IPC, diagnostics, MCP or the vault. Credential records are atomic generations of
small base64 OS-keychain entries (Windows credential-size compatible); the root
manifest is published only after all new entries are written. Refresh is serialized
inside the single native application process. Sign-out attempts remote revocation,
clears local tokens, retains registration/host and reports unconfirmed revocation.

`chatgpt:<slug>` is an explicit text-model route. Its selected account’s OAuth token
is used only for supported public Responses requests. `text_request` owns request
preparation and content negotiation together: plan requests use
`Accept: text/event-stream`, while ordinary API-key requests retain
`Accept: application/json`. Its private `prepare` strips the plan prefix,
sets `store:false`/`stream:true`, converts text input to a user-message array and
removes unsupported preview parameters. All native text callers, including Chat,
suggestions, imports, knowledge generation, dictation cleanup and illustration
planning, use this shared builder rather than overriding its Accept header.
Loopback HTTP tests exercise the actual negotiated request for Chat and suggestion
schemas, API-key JSON compatibility and interrupted-stream rejection.
The direct ChatGPT route can omit `Content-Type` on valid SSE, as documented in
OpenAI's sign-in DevKit. A missing or empty MIME value therefore enters the same
bounded SSE parser; an explicit non-SSE MIME type still fails. Never treat a
missing header as permission to accept arbitrary JSON or partial output. The
parser requires `response.completed`; deltas, interrupted streams, failed and
incomplete responses are not successful results. Account catalogs come from
`/v1/models` with that token.
No subscription request falls back to an API key. Normal configured provider
failover remains separately opt-in. Settings may retain only non-secret connection
flags/account IDs and model selection. Credential reads do not happen on startup;
explicit settings/AI work reads credentials. Connection-change events refresh status
across windows and Spaces. API media endpoints retain API credentials. Dictation
cleanup accepts plan text access while Whisper stays local.
Fresh OAuth exchanges must explicitly grant the plan-use scope; do not inherit an
older grant when the new response omits it. Cancellation and account changes
invalidate late authorization and catalog results. Confirmed invalid/revoked
refresh credentials are cleared without deleting the registration; transient
provider failures retain the connection. All plan text callers require a terminal
SSE response through `read_for_model` or the bounded plan reader. The shared
provider HTTP client refuses redirects so credential headers cannot be forwarded;
ordinary webpage fetching keeps its separate guarded redirect handling.

`src-tauri/src/elevenlabs_voices.rs` owns native-picked sample staging per window,
cloning/editing metadata, voice catalogs, voice settings and bounded preview audio.
Never accept renderer filesystem paths or arbitrary provider URLs. Validate count,
aggregate size, audio signatures, IDs, metadata and numeric ranges. Clear sample
memory after a successful upload, component disposal or owner-window destruction.
Upload completion clears only its captured sample generation, never newer samples.
Studio voice IDs must be explicit; blank values never select narration's default.
Do not automatically replay voice-creation POSTs after ambiguous failures: tell the
user to inspect their ElevenLabs library. The clone response’s verification flag
prevents automatic selection and remains enforced after refresh, reselection and
metadata edits until the provider reports verification complete. Invalid or
missing creation-verification fields and incomplete pagination fail explicitly.
Closing the studio invalidates pending UI results and releases preview audio.
Creation is audio-based Instant Voice Cloning only;
professional training/verification is handled by ElevenLabs. Delivery controls save
remote defaults; `elevenLabsModelId` and `elevenLabsVoiceRevision` are optional,
validated non-secret settings. Their changes clear prepared speech caches. ChatGPT
plan flags must never enable OpenAI image, audio or live-session API capabilities.
Model-specific previews omit unsupported delivery controls. Preview responses must
contain bounded MP3 audio, not an arbitrary successful response body. A failed old
speech request cannot evict newly prepared audio after a model/control change.
