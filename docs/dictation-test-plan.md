# Orion dictation test and improvement plan

14 November 2026 • Orion Preview 0.6.0

Dictation should produce useful, faithful writing on the first attempt. It should also recognise when spoken material naturally becomes tickets, a kanban, ordinary to-dos or a table, without making the user supervise every insertion.

The priority is to make returning to the original transcript rare. Keeping the original is valuable protection, but its availability does not excuse incorrect cleanup, lost qualifications, invented tasks or unreliable formatting. We should measure those failures directly and fix their causes.

This plan contains **90 test families**, 16 concrete transcript fixtures, a measurement framework and a suggested execution order. A family includes several related cases and boundary variants. It covers the current in-note dictation feature from microphone capture to saved, editable content. Space context is a separately labelled future experiment.

## What a good result means

- Words, names, numbers, uncertainty, conditions and deliberate emphasis retain their meaning.
- Separate jobs remain independently completable. A simple errands list remains simple.
- A single recording can produce mixed content, inserted automatically at the intended cursor in one Undo operation.
- When a structured element fails, Orion should preserve a usable cleaned version whenever that version can be validated independently.
- Writing remains responsive during recording and processing. The user can stop waiting and keep the original immediately.

## The current path

Microphone → bounded audio segments → local Whisper → combined transcript → durable original source → one optional AI cleanup request → validation → editor insertion → ordinary autosave.

Cleanup currently receives the transcript and captured local date, with the selected provider settings. It does not read the Space or other notes. Audio stays local. The provider cannot change existing work or choose another note.

The recoverable original is the combined Whisper transcript, not a retained audio recording. Preserving it protects against cleanup errors; it cannot correct speech that Whisper misheard. That is why this plan tests recognition and cleanup separately.

## How to use this plan

Read the evidence and fallback priorities first. Use the catalogue to choose tests for the layer being changed; extend existing tests where they already cover the contract. The final pages contain example inputs, commands, current limits and evidence locations.

**Reading guide:** evidence on page 2; measures on page 3; reduced fallback on page 4; test layers on page 5; the catalogue on pages 6–20; examples on pages 21–22; execution order on page 23; limits and references on page 24.

<!-- page -->

# Evidence already collected

The latest live run used the Preview configuration, **OpenAI gpt-6-astra with low reasoning**, through Orion's actual native cleanup transport, prompt, schema, validation and deadline. Synthetic transcripts were sent; no user notes or microphone recordings were used.

| Final live case | Boards | Board tickets | Other tickets | To-dos | Tables | AI seconds |
| --- | --- | --- | --- | --- | --- | --- |
| Explicit mixed request | 1 | 3 | 1 | 3 | 1 | 16.40 |
| Implicit launch project | 1 | 3 | 1 | 3 | 1 | 8.74 |
| Implicit exhibition project | 1 | 3 | 1 | 3 | 1 | 8.57 |
| Repeated launch input | 1 | 3 | 1 | 3 | 1 | 9.64 |
| Uncertainty and quotations | 0 | 0 | 0 | 0 | 0 | 3.28 |
| Cancelled commands | 0 | 0 | 0 | 0 | 0 | 2.80 |
| Implicit podcast project | 1 | 3 | 1 | 2 | 1 | 8.79 |
| Errands and comparison | 0 | 0 | 0 | 3 | 1 | 3.31 |

All eight final cases met their expectations. Four implicit project runs covered three distinct scenarios, including one repeated input, without naming the desired formats. Negative controls remained prose. An unknown price stayed unknown, and a clear Friday-to-Thursday correction used the captured date correctly.

## What the tests improved

Earlier outputs sometimes merged independent project jobs into one ticket or several errands into one checkbox. Prompt changes now ask for separate independently completable work items and recognise a project without requiring a formal project name.

There were **25 provider calls across development iterations**, including failures. One intermediate response failed native validation; its raw completion was not captured, so the cause remains unclassified. The subsequent eight-case run passed. Eight passes do not establish a general reliability rate.

## What else was verified

Actual responses passed nine editor replay tests covering insertion, Markdown reload, board links, Undo, Redo and original recovery. The broader renderer suite recorded 3,182 passes and one skip; native tests recorded 246 passes and one ignore; MCP tests recorded 120 passes. These are whole-suite counts, not counts of dictation-specific tests.

The local Preview bundle matched the tested cleanup source and passed strict signature verification. The live exercise did **not** measure fresh microphone capture, Whisper accuracy or complete Stop-to-visible-text latency. Mixed-output AI calls took 8.57–16.40 seconds, excluding Whisper and recording.

<!-- page -->

# Measures that reflect the user experience

Score meaning and usability separately from JSON validity. A valid table can associate a price with the wrong venue; a valid ticket can turn a tentative thought into a commitment. Neither is a successful dictation.

| Measure | Definition and use |
| --- | --- |
| Usable cleaned completion | Eligible AI sessions that produce readable, faithful cleaned content without the user returning to the original. Record structured success separately. |
| Avoidable original fallback | Eligible sessions that insert raw text because of a response, parser or integration defect. Break this down by exact failure stage. |
| Structure precision and recall | Precision asks whether created items were justified. Recall asks whether expected items were captured. Score tickets, boards, to-dos and tables separately. |
| Meaning preservation | Check each stated fact, negation, uncertainty, condition, number and relationship against the transcript. Track serious changes independently of formatting scores. |
| Independent work coverage | Expected separately completable jobs represented correctly, without merging, duplication or unsupported splitting. |
| Time to useful content | Stop-to-visible insertion, plus separate Whisper drain, original save, provider queue, provider response, validation and editor paint times. |
| Recovery and edit effort | Whether users choose the original, Undo, delete inferred structures or substantially repair the output, with an optional reason. |

An **eligible AI session** has a configured usable provider, a transcript within the current limit, a saved original and no deliberate cancellation. Still report all sessions separately: keyless local mode, user cancellation, oversize recordings and recovery-save failures must remain visible rather than disappearing from the product reliability picture.

## Proposed acceptance criteria

In the deterministic regression suite, require zero lost transcript content, unintended writes, cross-Space insertion, invented metadata or broken recovery. All critical negative examples must remain free of unintended work items. A fixed expected mixed fixture must preserve every independently completable job and every supplied table value.

For live runs, aim for zero avoidable original fallbacks in the selected release sample, and report the numerator, denominator and categories even when the target is missed. Also report full structured success: degrading every result to prose would lower raw fallback while failing the feature.

Establish latency and correction-effort baselines before setting numerical performance targets. Compare medians and slow cases on matched recordings and hardware. A small clean run is a regression signal, not proof that failures cannot occur.

<!-- page -->

# Make the original a last resort

The highest-value reliability improvement to investigate is separating a valid cleanup from optional formatting failures. At present, malformed structured output can cause the native parser or preparation step to reject the entire response and use the original. A later editor safeguard can use faithful cleaned blocks when insertion support is unavailable, but that does not cover every earlier rejection.

## A proposed order of recovery

| Order | Result to preserve | Required proof |
| --- | --- | --- |
| 1 | Complete cleaned prose and all valid structures | Entire response, source coverage and insertion validate. |
| 2 | Cleaned prose with a failed structure represented as text | Optional future behaviour: every replaced span is known and all content remains ordered and covered exactly once. |
| 3 | Complete faithful cleaned blocks | Cleanup validates independently even though the optional structure does not. |
| 4 | Complete original transcript | No independently trustworthy cleaned result is available, or the user chooses it. |

Start by testing the third outcome. It is simpler to reason about than selectively salvaging a complex proposal. These are proposed changes to evaluate, not claims that all four levels already exist.

## Tests that would make this practical

Feed the parser valid cleaned blocks paired with an invalid date, unsupported urgency, ragged table, invented evidence, missing reference or duplicate source index. Confirm that it can reject the structure without losing valid cleaned writing. Native and renderer behaviour must agree; invalid raw JSON and invalid faithful blocks still fail safely.

Then test any selective replacement against surrounding prose, late corrections and multiple interleaved structures. If the system cannot prove which original cleaned spans a failed element replaced, use the complete faithful cleaned version. Do not silently omit a task, guess a date, invent a table cell or accept an unsupported action to improve a success metric.

## Prevent failures before recovering from them

Classify validation failures precisely, keep prompt and schema consistent, simplify fragile reference requirements where evidence supports it, and add each observed failure as a regression fixture. Use captured provider responses from synthetic tests to reproduce faults without another billable call.

Prefer deterministic fixes that add no network round trip. A second AI repair request is only an experiment if measured reliability gains justify its latency and cost; it must share a bounded overall deadline. No blanket retry or mandatory review step is proposed.

**Success means users get good cleaned output routinely.** The original remains recoverable, but ordinary successful use should not depend on opening it.

<!-- page -->

# Test layers and evaluation data

Use the least expensive layer that can expose the defect, then verify the affected user flow. A parser test cannot measure an accent; a provider test cannot prove native microphone behaviour.

| Layer | Main purpose | Suggested cadence |
| --- | --- | --- |
| Native and renderer unit tests | Limits, evidence, parsing, cancellation, date and board rules | Every relevant change |
| Editor integration and response replay | Real nodes, cursor mapping, Undo, recovery and Markdown | Every insertion change |
| Controlled native integration | Audio segmentation, persistence, network failure and window races | Relevant changes and release candidates |
| Real provider evaluation | Meaning, structure choice, granularity and model variability | Prompt, schema or model changes; opt-in |
| Microphone and human use | Recognition, acoustic conditions, perceived delay and correction effort | Each native release candidate |

## Build a useful corpus

Begin with the existing eight live cases and 16 fixtures in this plan. Add short, medium and long variants, realistic disfluency, several accents and new subject areas. Include difficult negative examples as well as successful mixed requests. Keep untouched examples for a final check so prompt changes do not merely memorise development fixtures.

For each fixture, label required facts, uncertainty and conditions; independently completable actions; permitted and forbidden structures; spoken dates and urgency; and expected relationships between table values. Accept equivalent wording and sensible alternative layouts. Do not demand all four formats when the content does not justify them.

Test recognition separately using recorded speech and a human reference transcript. Then feed both the reference and actual Whisper transcript through cleanup. This reveals whether an error came from recognition, cleanup or insertion. Recordings used for testing should be deliberately created or used with permission; existing notes should not become a provider dataset by default.

## Repeat without hiding failures

A suggested first expansion is 20 selected provider cases run three times, with a declared limit of 60 calls. This is a proposed budget, not a run authorised by this document. Start with a smaller smoke set when diagnosing a specific defect. Record every attempt, timeout and invalid response; successful retries do not replace the first result.

Retain model and reasoning settings, prompt and schema hashes, fixture version, native source hash, outcome, latency and available token usage. Use a human fidelity review for semantic claims. An automated judge can help triage, but must not be the sole authority for meaning preservation.

<!-- page -->

# Capture and speech recognition

Existing foundation: VoiceMemoButton tests and the native local transcription module. These proposals extend coverage to real microphones and audio, which the latest provider-only run did not exercise. P0 protects content or control; P1 improves common use; P2 explores broader support.

## CAP01 Microphone permission and device failure

**P0 · Native audio.** Deny permission, revoke it, start with no device and disconnect a device mid-recording. Verify that Stop stays available, resources are released and the app never claims to have captured missing speech.

**Improvement:** clearer actionable errors and reliable restart behaviour instead of silent or stuck sessions.

## CAP02 Accents and speaking styles

**P1 · Recorded audio.** Use Australian English and other relevant accents, fast speech, quiet speech and irregular pauses. Compare both Whisper editions against human transcripts, including names and action words.

**Improvement:** identify which language settings or recognition changes improve actual users rather than only clean test speech.

## CAP03 Noise and competing sound

**P1 · Recorded audio.** Repeat matched speech with a fan, keyboard noise, traffic and quiet background conversation. Measure errors by condition; check whether unrelated speech becomes tasks.

**Improvement:** choose useful microphone guidance or audio handling changes based on measured failure conditions.

## CAP04 Silence and non speech

**P0 · Audio and editor.** Record silence, breathing, a click, music and a very short cancelled utterance. Expect no fabricated sentence, task or unexplained empty source proliferation.

**Improvement:** detect hallucinated recognition before cleanup turns it into convincing structured content.

## CAP05 Names and technical terminology

**P1 · Audio and provider.** Dictate project names, similar surnames, abbreviations, product versions and unfamiliar technical words. Keep recognition accuracy distinct from cleanup's preservation of the supplied transcript.

**Improvement:** reveal whether pronunciation, transcription configuration or a future bounded vocabulary hint would help.

## CAP06 Paired Small and Medium evaluation

**P1 · Native audio.** Run identical recordings through both editions with cold and warm starts. Compare word errors, key fact errors, startup time, memory and total Stop-to-insertion time.

**Improvement:** make edition guidance evidence-based and avoid treating a larger model as automatically better for every recording.

<!-- page -->

# Long recordings and segment assembly

Existing foundation: bounded segment rotation and ordered buffering tests. Small uses two-minute requests; Medium uses a persistent worker with 30-second windows and two seconds of acoustic overlap. Test both paths explicitly.

## SEG01 Words at every boundary

**P0 · Native audio.** Place names, negations, prices and task verbs immediately before and after a segment boundary. The assembled transcript must retain them in order, including the end of the final segment.

**Improvement:** correct lost syllables or missing last phrases before they become wrong tasks or numbers.

## SEG02 Duplicate overlap versus emphasis

**P0 · Audio and unit.** Compare repeated overlap text with intentional repetitions such as “very, very important” and two genuinely separate identical tasks.

**Improvement:** refine boundary matching so it removes acoustic overlap without deleting emphasis or legitimate repeated content.

## SEG03 Transcription slower than recording

**P0 · Native integration.** Delay segment completion while several new parts arrive. Verify ordering, bounded work scheduling, responsive controls and complete draining after Stop.

**Improvement:** expose queue backlogs and prevent out-of-order or prematurely inserted transcripts.

## SEG04 Empty and failed middle segments

**P0 · Fault injection.** Insert a silent segment and then a failing segment between valid ones. Silence must not end the session. A real failure must preserve successful parts and clearly identify incomplete capture.

**Improvement:** distinguish expected silence from missing speech; recovery must not falsely imply the original is complete.

## SEG05 Long session resource use

**P1 · Native soak.** Run 5-, 30- and 60-minute recordings, including pauses. Track memory, CPU, queue depth, temporary files and Stop time. Repeat sessions without restarting Orion.

**Improvement:** detect retained buffers, worker leaks and growing finalisation delays without imposing an arbitrary recording cap.

## SEG06 Worker interruption and restart

**P0 · Native integration.** Kill a Whisper worker, switch audio devices, sleep and wake the Mac, and start a new recording after each interruption.

**Improvement:** ensure interrupted sessions fail honestly and later dictation remains usable without restarting the application.

<!-- page -->

# Meaning and cleanup fidelity

Existing foundation: native instructions, size guards and live uncertainty examples. Structural validation cannot establish these semantic properties; use labelled examples and human comparisons.

## FID01 Hesitation versus meaningful repetition

**P1 · Provider.** Contrast accidental stutters and “um” with “I really, really mean this” and repeated words used for rhythm. Expect only nonsemantic hesitation to disappear.

**Improvement:** tune cleanup to preserve the user's voice instead of flattening all repetition.

## FID02 Confidence and uncertainty

**P0 · Provider.** Test “I think”, “probably”, “I don't know” and multiple alternatives within the same thought. None should become a firm claim or an unconditional task.

**Improvement:** prevent cleaner prose from silently becoming more confident than the speaker.

## FID03 Clear and ambiguous corrections

**P0 · Provider.** Contrast “Friday, actually Thursday” with “Friday or Thursday, I'm unsure”. Include corrections several sentences later and corrections to just one of two similar names.

**Improvement:** apply genuine replacements while preserving alternatives and the correct referent.

## FID04 Negation and cancellation

**P0 · Provider.** Put “don't”, “not yet”, “unless” and “actually cancel that” before and after apparent commands. Verify that cancellation affects only the intended action.

**Improvement:** reduce unwanted tickets and preserve conditional intent when formatting is automatic.

## FID05 Voice and unfinished thought

**P1 · Provider.** Use informal writing, swearing, fragments, humour and a sentence that ends midway. Expect readable punctuation without invented endings or a generic professional rewrite.

**Improvement:** retain authorship and reduce the need to restore raw text because the result sounds unlike the user.

## FID06 Contradictions and changing ideas

**P0 · Provider.** Dictate a new opinion, an internal contradiction and an explicitly revised argument. Preserve the change or unresolved contradiction unless the speaker clearly resolves it.

**Improvement:** make cleanup useful for thinking aloud, including ideas that disagree with earlier writing.

<!-- page -->

# Choosing and combining structures

Existing foundation: the eight live cases, mixed response parsing and actual editor replay. Expand to unseen domains and negative cases rather than repeatedly testing one launch example.

## MIX01 Explicit mixed creation

**P0 · Provider and replay.** Request a board, several board tickets, a separate ticket, errands and a comparison table in one recording, with prose between them. Expect all parts once and in order.

**Improvement:** catch omissions and ordering defects across the complete supported feature set.

## MIX02 Implicit mixed creation

**P1 · Provider.** Describe a concrete project, unrelated work, personal errands and comparable options without naming any format. Check appropriate structures and preserved conditions.

**Improvement:** improve useful inference while avoiding dependence on special command phrases.

## MIX03 Single actions and project breakdowns

**P1 · Provider.** Compare one action with several details against several separately finishable jobs. Include projects with no formal name and tasks spread across sentences.

**Improvement:** prevent the compound-ticket failure already seen in live testing without over-splitting ordinary sentences.

## MIX04 Quotations and hypothetical examples

**P0 · Provider.** Describe someone saying “make a ticket”, ask how boards work and dictate instructions as quoted prose. Expect literal writing, not work creation.

**Improvement:** make automatic formatting safe for research notes and discussions about the app itself.

## MIX05 Sequence that matters

**P1 · Provider and editor.** Dictate a recipe, a procedure and a set of independent project jobs. Preserve the order of dependent steps; do not choose a board that loses sequence.

**Improvement:** recognise when a list is the more useful structure and expose any missing ordered-list capability.

## MIX06 Creation versus existing work

**P0 · Provider and native.** Ask to complete, delete, move or rewrite an existing ticket, and mix that with an allowed new-ticket request. Existing-work instructions remain text and cannot gain write authority.

**Improvement:** keep helpful new content creation separate from unintended changes to the library.

<!-- page -->

# Ticket and board correctness

Existing foundation: Space-local exact board resolution, host-generated identities and note-backed Markdown metadata. Validate both the note and the derived dashboard after insertion.

## BRD01 Exact and ambiguous destinations

**P0 · Unit and editor.** Test one exact board name, different case and spacing, duplicate names, near matches and a missing name. Only a unique normalised exact match may receive the ticket.

**Improvement:** eliminate accidental assignment while preserving convenient spoken names.

## BRD02 Board changes while waiting

**P0 · Editor and native.** Rename or delete the destination during cleanup. Insert into the original note only; a no-longer-valid assignment becomes unassigned without losing ticket text.

**Improvement:** avoid unnecessary raw fallback when a harmless assignment change occurs.

## BRD03 New boards and linked children

**P0 · Editor and reload.** Create multiple new boards, nested tickets and a standalone ticket naming a new board. Verify unique identities, correct links and conservative handling of duplicate titles.

**Improvement:** ensure generated boards represent usable work rather than visually convincing disconnected cards.

## BRD04 Completion and attribution

**P0 · Provider and dashboard.** Dictate past completed work and future commitments. Only appropriate new work becomes unchecked tasks; dictation-created tickets retain their source note attribution.

**Improvement:** avoid reviving completed work or presenting note-derived tickets as manually created dashboard items.

## BRD05 Round trip and duplication

**P0 · Editor integration.** Save, reopen, export and paste a mixed board. Preserve identities on normal reload and Undo/Redo; pasted copies receive fresh identities with their internal assignments intact.

**Improvement:** prevent duplicate IDs, disappearing tickets and accidental links to the original board.

## BRD06 Immediate interaction

**P1 · Native UI.** After dictation, edit a title, set a date, change urgency, drag a ticket and delete it through existing controls. Verify the same updates appear on the dashboard.

**Improvement:** confirm generated work behaves like ordinary authored work from its first insertion.

<!-- page -->

# Tables and ordinary lists

Existing foundation: literal table nodes, rectangular validation, task-list insertion and Markdown round trips. Semantic relationships require additional checks beyond node counts.

## TAB01 Correct association of values

**P0 · Provider.** Compare several venues with prices, capacities and uncertain availability, deliberately switching the spoken attribute order. Check each value against its correct option and unit.

**Improvement:** catch a polished table that has silently paired facts with the wrong item.

## TAB02 Missing and uncertain values

**P0 · Provider and replay.** Omit one price, say another is approximate and give a price range. Keep missing values empty or explicitly unknown and preserve qualifications.

**Improvement:** prevent invented cells, false precision and cleanup that erases uncertainty.

## TAB03 Corrections inside a comparison

**P0 · Provider.** Correct one row's amount or unit after describing other rows. Update only the intended value while retaining all other supplied facts.

**Improvement:** make natural spoken comparisons dependable without requiring perfectly ordered dictation.

## TAB04 Lists with different purposes

**P1 · Provider and editor.** Compare a packing inventory, actionable errands, observations and dependent steps. Use bullets or tasks as appropriate; check that each independent errand has its own checkbox.

**Improvement:** avoid treating every list as work and prevent the merged-errand failure seen earlier.

## TAB05 Literal characters and editing

**P0 · Editor integration.** Put pipes, angle brackets, URLs, emoji and Markdown-like text in cells and list items. Edit and reload them without executing markup or corrupting table shape.

**Improvement:** make imported model text safe, editable and portable without sacrificing the user's literal symbols.

## TAB06 Surrounding prose and layout

**P1 · Provider and native UI.** Dictate prose before, between and after tables and lists, including wide and long cells. Preserve the prose, document order and readable scrolling at small window sizes.

**Improvement:** prevent formatting from swallowing the argument or making the note difficult to use.

<!-- page -->

# Dates numbers and language

Existing foundation: captured local reference date, strict all-day date validation and exact spoken urgency rules. Test date interpretation separately from local dashboard date recognition.

## DAT01 Relative dates and midnight

**P0 · Provider and integration.** Start before midnight and stop afterwards; dictate tomorrow and a weekday. Resolve against the date captured at recording start, then verify after reopening in another time zone.

**Improvement:** avoid moving deadlines because processing or viewing happened later.

## DAT02 Calendar edge cases

**P0 · Unit and provider.** Exercise month ends, leap days, year rollover, daylight-saving transitions and day/month numeric dates. Ambiguous dates remain uncertain rather than acquiring a guessed deadline.

**Improvement:** prevent valid-looking but wrong all-day dates and timezone conversion errors.

## DAT03 Deadline corrections and scope

**P0 · Provider.** Correct one deadline in a recording containing several tasks. Contrast a firm date with “maybe Friday or Thursday”. Preserve the latter in text with no invented firm due date.

**Improvement:** keep date metadata faithful to intent and attached to the correct work item.

## DAT04 Explicit urgency only

**P0 · Provider and editor.** Test all four urgency levels, unset urgency and “high priority, actually leave it unset”. A dramatic tone or important topic alone must not set urgency.

**Improvement:** keep prioritisation under the speaker's control.

## DAT05 Numbers units and identifiers

**P0 · Audio and provider.** Dictate decimals, negative amounts, percentages, ranges, versions and similar-sounding quantities. Score recognition and cleanup independently; preserve units and literal identifiers.

**Improvement:** reduce high-impact factual errors that word-error averages can hide.

## DAT06 Multilingual and mixed language speech

**P1 · Audio and provider.** Test supported languages, English mixed with another language, accented names and script changes. Preserve the spoken language; do not translate or normalise away names.

**Improvement:** expose language-detection and Unicode defects while keeping cleanup faithful across writing styles.

<!-- page -->

# Validation and response boundaries

Existing foundation: strict Rust and TypeScript validators. These tests should be cheap and deterministic, using captured or generated response objects without calling the provider.

## VAL01 Cleaned text independent of structure

**P0 · Native and renderer.** Pair valid faithful blocks with one malformed optional structure. First document current whole-response rejection, then test a proposed validated-cleaned-text outcome without another AI call.

**Improvement:** directly reduce avoidable original fallback when useful cleaned writing already exists.

## VAL02 Complete source coverage

**P0 · Native property tests.** Generate missing, duplicated, out-of-order, nonconsecutive and out-of-range source references. Reject faulty proposals; a future recovery path must retain the full validated faithful version.

**Improvement:** prevent hidden omissions and duplication while making recovery more useful.

## VAL03 Exact evidence and forbidden fields

**P0 · Native and renderer.** Test invented quotes, empty evidence, IDs, status fields, note targets and unsupported actions. Keep the structured result inert until every relevant field validates.

**Improvement:** stop fabricated support or new write authority from being treated as acceptable formatting.

## VAL04 Every size boundary

**P0 · Unit.** Test just below, exactly at and just above each input, block, ticket, board, table, cell, evidence and output limit. Include nested tickets and Unicode outside the basic plane.

**Improvement:** prevent silent truncation and inconsistent Rust versus JavaScript character counting.

## VAL05 Envelope and transport corruption

**P0 · Native integration.** Return malformed JSON, a truncated body, a missing field, wrong types, unknown fields and an oversized response. Confirm a bounded, classified failure with no partial insertion.

**Improvement:** explain failures like the previously unclassified validation rejection and avoid guessed repairs to incomplete data.

## VAL06 Guard false positives

**P1 · Unit and provider.** Test legitimate long corrections, repeated speech and command-to-title shrinkage against size-loss and inflation guards. Compare rejected output with a human judgement.

**Improvement:** tune over-aggressive rejection only where evidence shows faithful cleanup was discarded; retain protection against genuine loss.

<!-- page -->

# Provider failure and useful recovery

Existing foundation: a 45-second cleanup deadline, original preservation before cleanup, cancellation and no-key local operation. Measure recovery type rather than recording every fallback as equivalent.

## NET01 Keyless local dictation

**P0 · Native integration.** Remove the key for the selected provider while another provider still has one. Expect local Whisper only, no hidden provider switch and complete inserted text.

**Improvement:** preserve the promised local mode and avoid counting deliberate local use as an AI reliability failure.

## NET02 Authentication and service errors

**P0 · Controlled transport.** Simulate rejected credentials, rate limits and server failures. Verify prompt release of resources, preserved text and a classified outcome without an endless retry loop.

**Improvement:** make service problems recover predictably and distinguish them from parser defects.

## NET03 Deadline across the whole request

**P0 · Fake timers and native.** Stall in the provider queue, connection and response body. Confirm the bounded overall deadline and that a late answer cannot insert a second result.

**Improvement:** stop latency from accumulating outside the measured API response phase.

## NET04 User chooses the original while waiting

**P0 · Editor integration.** Activate Use original during cleanup, including just before completion. Expect one insertion, cancellation of owned work and an immediately usable microphone control.

**Improvement:** give the user a dependable escape from delay without duplicate content.

## NET05 Valid prose and invalid table

**P0 · Native to editor.** Replay a complete response with faithful cleanup but a ragged table or bad ticket date. Evaluate retaining cleaned text, then optional span-local structure recovery with proven coverage.

**Improvement:** verify the proposed fallback improvement through the whole pipeline, beyond a parser unit test.

## NET06 Error diagnosis without another call

**P1 · Diagnostics.** Make each known failure produce a stable category and stage. For synthetic QA only, retain the response and replay it locally; avoid saving real transcript payloads in routine logs.

**Improvement:** turn an unexplained failure into a reproducible fix, reducing repeated paid calls and guesswork.

<!-- page -->

# Editor insertion and session lifecycle

Existing foundation: real RichNoteEditor tests cover mapped cursors, automatic insertion, one Undo, late responses and guarded recovery. Expand the combinations and verify in the native app.

## EDT01 Cursor movement and continued writing

**P0 · Editor.** Start mid-paragraph, move the visible caret and type before and after the captured insertion point during processing. Insert at the correctly mapped original point without replacing later writing.

**Improvement:** preserve writing flow and prevent a completed recording from appearing wherever the user happens to click.

## EDT02 Selection and complex document locations

**P0 · Editor.** Start with selected prose, inside lists, headings and table cells, and beside a board. Verify literal insertion, valid document structure and unchanged surrounding content.

**Improvement:** expose insertion rules that work in plain paragraphs but fail in real notes.

## EDT03 Undo Redo and recovery

**P0 · Editor.** Insert all four formats, Undo once, Redo, then Use original and Undo that replacement. Check IDs, assignments, order and neighbouring prose at every step.

**Improvement:** make correction cheap without fragmenting one spoken action into many Undo steps.

## EDT04 Note and Space navigation

**P0 · Integration.** Leave the note, switch Space, close its view and reopen it while cleanup is pending. No late result may enter another note; the saved original remains in its originating Space.

**Improvement:** prevent the most damaging destination errors while retaining recoverable work.

## EDT05 Concurrent replacement and stale recovery

**P0 · Editor and windows.** Replace the note externally or type after insertion, then invoke a previously captured recovery action. It must refuse stale replacement and preserve the newer document.

**Improvement:** keep original recovery from becoming a way to overwrite subsequent writing.

## EDT06 Rapid controls and competing tools

**P0 · Native UI.** Double-click Stop, immediately start again, use an IME, and invoke another editor AI workflow while finishing. Enforce one completion and valid control availability without blocking ordinary typing.

**Improvement:** remove race conditions and stuck states in normal impatient interaction.

<!-- page -->

# Saving windows and original ownership

Existing foundation: original source attachment, shared save queue, note deletion and window merging. Run destructive fault tests against isolated test vaults, never the working library.

## SAV01 Save the original before cleanup

**P0 · Integration.** Pause the original-source save and watch provider dispatch. Cleanup must wait for confirmed durable preservation; retries must not create duplicate source records.

**Improvement:** preserve recovery guarantees while locating any unnecessary waiting in the save path.

## SAV02 Disk and permission failures

**P0 · Fault injection.** Deny writes or exhaust test-disk space before archive and after insertion. Keep available text, show the relevant save failure and never claim unsaved content survived a restart.

**Improvement:** distinguish in-memory rescue from durable recovery and make persistence errors actionable.

## SAV03 Crashes at each transition

**P0 · Native integration.** Terminate after original archive, during cleanup and after insertion before autosave completion. Reopen and inspect exactly what survived; do not infer durability from UI appearance.

**Improvement:** identify recovery gaps and strengthen transaction ordering where users could lose work.

## SAV04 Two windows editing one note

**P0 · Native integration.** Dictate in one window while the other edits, saves or navigates. Preserve revision guards and unrelated edits without false conflict notices or duplicate insertions.

**Improvement:** verify dictation cooperates with the multi-window save path the user already relies on.

## SAV05 Delete a note or shared source

**P0 · Unit and native.** Delete a note with original dictations, including one source referenced by another surviving note. Remove orphaned originals and preserve genuinely shared or ordinary imported sources.

**Improvement:** prevent deleted dictation notes from leaving clutter or deleting another note's recovery material.

## SAV06 Reopen and retrieve the original

**P0 · Native UI.** Quit normally after successful and failed cleanup, reopen, and retrieve the exact transcript from the note footer or Sources. Check Space boundaries and source linkage.

**Improvement:** prove last-resort recovery works beyond the current editor session, without making it the normal workflow.

<!-- page -->

# Latency responsiveness and resource use

Existing baseline: mixed-output AI calls took 8.57–16.40 seconds in the final sample. This is not an end-to-end benchmark. Begin with the user's approximately 13.6 MB library and representative notes before large synthetic libraries.

## PER01 Measure each stage

**P1 · Native instrumentation.** Timestamp Stop, final Whisper completion, archive flush, provider queue exit, request completion, validation, insertion and first paint. Record cold and warm runs with matched inputs.

**Improvement:** direct optimisation at the actual delay rather than blaming autosave or the model without evidence.

## PER02 Typing during all phases

**P0 · Native profiling.** Type in short and long notes during recording, Whisper processing, original saving and AI cleanup. Measure keystroke-to-paint latency and visible freezes against an idle baseline.

**Improvement:** catch renderer work, indexing or save contention that makes the core writing surface feel slow.

## PER03 Library and note size separately

**P1 · Profiling.** Compare the current library with a small test vault using equivalent notes, then vary note length. Keep provider inputs identical and avoid uploading the library.

**Improvement:** distinguish vault-related costs from document size and network latency before changing storage architecture.

## PER04 Structured output complexity

**P1 · Benchmark.** Compare prose-only, one ticket and a mixed board/list/table recording of similar transcript length. Measure output tokens, validation and insertion time separately.

**Improvement:** reveal whether a larger response, a schema choice or rendering work explains slower mixed dictation.

## PER05 Model and reasoning comparisons

**P2 · Opt-in provider benchmark.** Compare configured alternatives on the same labelled corpus, using multiple repeats and both fidelity and latency scores. Include fallback and user repair rates.

**Improvement:** identify faster configurations only when quality holds; a shorter request is not a win if users must fix it.

## PER06 Sustained load and cancellation

**P1 · Native soak.** Repeat recording and cancellation with several windows, chat activity and battery operation. Measure CPU, memory, thermal effects and worker cleanup after sessions end.

**Improvement:** prevent a feature that feels fast once from slowing the app during a working day.

<!-- page -->

# Privacy authority and local operation

Existing foundation: transcript-only cleanup, local audio, Keychain credentials and strict creation-only data. Use payload inspection in an isolated harness rather than recording private requests in production logs.

## SEC01 Inspect the actual payload

**P0 · Native transport.** Capture a synthetic request and verify its transcript, local date and provider settings. Ensure it excludes note bodies, Space summaries, chat history, source material and audio.

**Improvement:** catch accidental context growth and preserve both privacy and predictable request size.

## SEC02 Spoken prompt injection

**P0 · Provider and parser.** Dictate “ignore the rules”, fabricated system text, tool instructions and claims of approval as quoted and unquoted content. No output gains tool or existing-note authority.

**Improvement:** preserve useful dictation of instructions without allowing those words to control the application.

## SEC03 Literal markup and links

**P0 · Editor and export.** Insert scripts, HTML, ticket-like comments and special URL schemes as spoken literal text. They must remain text rather than active markup or forged durable identities.

**Improvement:** prevent formatting shortcuts from creating executable content or hidden work items.

## SEC04 Temporary audio lifetime

**P0 · Native fault tests.** Inspect staged audio after success, failure, cancellation and worker termination. Verify cleanup on supported paths and identify any crash residue requiring bounded startup cleanup.

**Improvement:** keep local speech processing from leaving untracked recordings on disk.

## SEC05 Credentials and diagnostics

**P0 · Integration.** Trigger provider failures and inspect logs, errors, recovery sources and exported files. No secret, authorization header or private response body should be included accidentally.

**Improvement:** enable useful failure diagnostics without making logs a second store of private dictation.

## SEC06 Offline restart and continued writing

**P0 · Native UI.** Start Orion offline, dictate locally, reconnect, and repeat. Check source access, ordinary editing and model selection without a successful network call.

**Improvement:** ensure the local-first experience survives realistic connectivity changes rather than only a mocked missing key.

<!-- page -->

# Accessibility and everyday interaction

Existing foundation: microphone controls, quiet processing and original recovery actions. Automated DOM checks need native keyboard, VoiceOver and visual verification.

## UX01 Keyboard access and focus

**P1 · Native UI.** Start and stop from the toolbar, choose Use original and edit generated content using only the keyboard. Focus should remain understandable after insertion, cancellation and errors.

**Improvement:** make the feature usable without precise pointer control and reduce accidental repeated actions.

## UX02 VoiceOver state changes

**P1 · Native accessibility.** Read control names in recording, processing and recovery states. Stop and Use original must be distinguishable, with concise updates rather than continuous announcements.

**Improvement:** expose state and available actions without overwhelming a screen-reader user.

## UX03 Quiet but actionable feedback

**P1 · Native UI.** Test long cleanup, successful insertion, permission failure and save failure. Keep the timer and useful errors visible; avoid adding routine progress or success bubbles.

**Improvement:** provide confidence and an escape from delay while preserving the minimal interface.

## UX04 Small windows and accessibility settings

**P1 · Native UI.** Use narrow windows, larger text, high contrast and reduced transparency. Check the toolbar, recovery action, tables and generated ticket controls for clipping or obstruction.

**Improvement:** prevent new content types from making essential controls unreachable.

## UX05 Word count and editing mode

**P1 · Editor and native UI.** Verify counts after mixed insertion and selection, excluding metadata and control labels. Done removes edit-only presentation and returning to edit mode remains responsive.

**Improvement:** catch hidden per-keystroke work and inaccurate counts introduced by new structures.

## UX06 Practical correction effort

**P1 · Observed use.** Have the author dictate normal work and record corrections, removed structures and original recovery choices. Ask what was wrong only when useful; inspect the resulting note.

**Improvement:** prioritise irritations that schema tests miss, especially excessive inference and output that does not sound like the speaker.

<!-- page -->

# Regressions model changes and future context

Use these tests to preserve improvements over time. Context-assisted cleanup remains a proposed extension; the present implementation does not read the current Space.

## EVAL01 Same input across repeated calls

**P1 · Provider.** Repeat selected explicit, implicit and negative inputs with fixed settings. Record all variations, including invalid responses, merged jobs and conservative prose-only outcomes.

**Improvement:** reveal stochastic failures hidden by one successful demonstration.

## EVAL02 Paraphrases and new domains

**P1 · Provider.** Reword fixtures without changing intent and test a project domain absent from prompt examples. Judge facts and work units, not exact board titles or punctuation.

**Improvement:** avoid tuning Orion to a handful of memorised phrasings.

## EVAL03 Prompt schema and model drift

**P0 · Regression suite.** Associate results with exact prompt, schema, model, reasoning and code versions. Before switching one, replay prior failures and rerun a held-out live sample.

**Improvement:** make improvements attributable and catch a provider change that weakens fidelity or fallback rates.

## EVAL04 Context helps names without adding ideas

**P2 · Future experiment.** Compare transcript-only cleanup with a small local vocabulary hint. Include a deliberately misleading related note and a new idea contradicting older material.

**Improvement:** establish whether context improves names while preserving the present argument. Do not add whole-Space retrieval by default.

## EVAL05 Context size freshness and isolation

**P2 · Future experiment.** Vary a bounded hint list, duplicate names, stale terminology and a Space switch. Measure lookup time, request size and wrong corrections with and without hints.

**Improvement:** identify whether cached local hints can help without introducing noticeable delay or cross-Space influence.

## EVAL06 Differential replay and failure minimisation

**P1 · Local automation.** Replay identical captured outputs through old and candidate validators, then shrink failing objects or transcripts to the smallest reproducer while retaining the fault.

**Improvement:** expose unintended regressions and produce small, stable tests instead of rerunning long paid experiments.

<!-- page -->

# Example transcripts for positive cases

These fixtures are proposed additions. Labels describe expected behaviour, not exact wording. Use 14 November 2026 as the reference date where a relative date is tested. Test every fixture first as text, then selected cases as real speech.

## EX01 Explicit mixed recording

“Make a Release board with tickets to test updates, finish the screenshots and check installation. Separately make a high urgency ticket to call Jo on Friday, actually Thursday. My errands are buy milk and charge the camera. Make a table: Studio A is 80 dollars and seats 20; Studio B is 120 dollars and seats 35.”

**Expect:** one board with three tickets, one separate high-urgency ticket due 19 November, two ordinary to-dos and a two-row table.

## EX02 Implicit mixed recording

“For the next podcast season, book guests, edit the trailer and prepare the artwork. Separately I need to renew the recorder warranty. Before leaving, buy batteries and charge the laptop. The small room costs 40 dollars and seats four; the large room costs 70 dollars and seats eight.”

**Expect:** a project board, three linked jobs, a separate work item, two errands and a factual comparison table without special format words.

## EX03 Personal errands

“Before I head out I need to buy milk, pick up my prescription and charge the camera.”

**Expect:** three separate unchecked to-dos, with the shared timing retained. No project board.

## EX04 Unknown comparison value

“River Hall seats 80 and costs about 400 dollars. Garden Studio seats 30, but I don't know the price.”

**Expect:** correctly associated capacity and price values, including approximation and an unknown price.

## EX05 A single detailed action

“Make a ticket to email Sam the draft and the reference images together, once Jo approves it.”

**Expect:** one ticket. Keep both attachments and the approval condition; do not split one email into multiple jobs.

## EX06 A correction with another task nearby

“Make a ticket to call Alex on Friday. Make another to email Casey on Monday. Actually, Alex should be Thursday.”

**Expect:** only Alex's deadline changes. Casey's action and date remain intact.

## EX07 Deliberate emphasis

“Um, this is very, very important. I think the ending should feel unfinished.”

**Expect:** remove the filler, retain emphasis, uncertainty and the intended unfinished quality.

## EX08 Literal symbols

“Write this literally: less than script greater than. The comparison contains A pipe B.”

**Expect:** literal, editable text. No executable markup or accidental table parsing.

<!-- page -->

# Example transcripts for restraint and failure

These inputs protect automatic insertion from over-interpreting speech. A useful negative control is as important as a successful mixed-output example.

## EX09 Tentative work

“Maybe we could make a launch board one day. I should probably call Jo, but I'm not sure that would help.”

**Expect:** uncertain prose. No new board, ticket, deadline or implied commitment.

## EX10 Quoted instruction

“Jo said, make a ticket for everything, but I disagree. I'm writing about why that approach is tiring.”

**Expect:** preserve the quotation and argument. No ticket creation.

## EX11 Cancelled creation

“Make a board for the exhibition with a ticket for lighting. Actually, don't create that board or ticket; I'm only considering it.”

**Expect:** no work items. Retain the final intent as writing.

## EX12 Ambiguous deadline

“Make a ticket to send the draft, maybe Friday or Thursday. I haven't decided which.”

**Expect:** a ticket may be created because the request is explicit, but its due date stays unset and the uncertainty remains in the content.

## EX13 Ordered procedure

“First export the audio, then check the file, and only after that upload it.”

**Expect:** retain sequence and dependency. Do not produce a board that makes the steps appear interchangeable.

## EX14 Completed work

“I already booked the room and sent the invitations. The only remaining job is to test the projector.”

**Expect:** completed work stays descriptive; only the remaining job is eligible for new work representation.

## EX15 Unsupported command

“Delete the old launch ticket and move everything to another Space. Also make a new ticket to check the microphone.”

**Expect:** no existing-work or cross-Space mutation. Only the supported new-ticket request may become structured content; retain other words as text.

## EX16 A valid cleanup with a bad structure

Use a complete synthetic provider response whose faithful text says “Send the draft on Thursday”, but whose optional ticket date is “2026-02-30”.

**Expect today:** strict rejection may return the original. **Target improvement:** retain independently validated cleaned text, discard the invalid metadata and make no second AI call. Never reinterpret the impossible date as a different deadline.

<!-- page -->

# Suggested order of work

## First make failure measurable

Add stable outcome categories for successful structure, cleaned-text degradation, original fallback, local-only mode, cancellation, oversize input and failed original preservation. Capture stage timings without transcript payloads in routine logs. Reproduce the known grouping failures and preserve the unclassified response failure as an unresolved diagnostic gap.

## Then reduce avoidable original fallback

Implement and test independent validation of faithful cleaned blocks and optional structure if the proposed design passes VAL01 and NET05. Keep exact evidence, field and coverage guards. Update native and renderer tests together, then replay all recorded provider outputs. Consider selective structure recovery only after complete cleaned-text recovery is dependable.

## Then improve inference and recognition

Expand positive and negative provider fixtures, especially task granularity, cancelled commands and unknown table values. Add real microphone comparisons and segment-boundary recordings. Run a bounded repeat sample with actual provider settings, followed by real editor replay and a native smoke test.

## Finally optimise measured delay

Use stage timings to identify whether Whisper drain, original saving, provider queueing, output length or editor work dominates. Compare alternatives on the same fidelity corpus. Evaluate a bounded Space vocabulary experiment only after its name accuracy benefit and delay are measurable.

## Existing checks that can be run

Run from `/Users/zzz/Developer/orion`. These commands are documented here; creating this plan does not run them again.

```bash
# Focused renderer and editor coverage
npm test -- src/lib/dictationCleanup.test.ts \
  src/lib/dictationStorage.test.ts \
  src/components/VoiceMemoButton.test.tsx \
  src/components/RichNoteEditor.dictation.test.tsx \
  src/components/editor/voiceDictation.test.ts

# Native cleanup and broader integration checks
cargo test --manifest-path src-tauri/Cargo.toml dictation_cleanup
npm run check
cargo test --manifest-path src-tauri/Cargo.toml

# Separate local Preview after an implementation change
bash script/build_and_run.sh --build-only
```

The live provider harness under the evidence directory is an opt-in QA tool, not part of ordinary `npm test`. Confirm the selected fixture set and call budget before executing it. Reuse stored responses for editor and parser changes whenever possible.

<!-- page -->

# Current limits and evidence locations

## Current cleanup boundaries

| Boundary | Current limit |
| --- | --- |
| Transcript sent for cleanup | 24,000 Unicode characters; oversize remains complete local text |
| Cleanup deadline | 45 seconds |
| Faithful or structured alternative | 256 blocks and 32,000 visible characters, with additional size-change guards |
| Tickets across all structures | 32, including nested board tickets |
| New boards and tables | Four boards and four tables |
| Each table | 1–12 columns, 1–20 data rows, at most 500 Unicode characters per cell |
| Ticket title and board name | At most 140 Unicode characters |
| Supporting evidence | An exact original excerpt of 1–2,000 Unicode characters |
| Native response body | At most 512 KiB |

These are cleanup limits, not a recording-duration cap. Long recordings can still be inserted completely through the local path. Future support beyond the cleanup cap would need its own coverage, correction and latency design; silently truncating a transcript is not acceptable.

## Code and existing test owners

- `src/components/VoiceMemoButton.tsx` and its test: capture controls, segmentation and lifecycle.
- `src-tauri/src/local_transcription.rs`: native Whisper processing, audio validation and worker lifetime.
- `src-tauri/src/dictation_cleanup.rs`: provider instructions, schema, native parser and deadline.
- `src/lib/dictationCleanup.ts` and `dictationStorage.test.ts`: original preservation, response validation, request scope and fallback.
- `src/components/editor/voiceDictation.ts` and its test: literal nodes, board assignments and undoable insertion.
- `src/components/RichNoteEditor.dictation.test.tsx`: actual editor integration, mapping and guarded original recovery.
- `src/lib/noteDeletion.ts`, `windowVault.ts` and their tests: source ownership, deletion and multi-window persistence.

## Completed evidence

Repository paths below are relative to `/Users/zzz/Developer/orion`.

- `outputs/qa/live-dictation-20261114/REPORT.md`: completed live findings and their limitations.
- `outputs/qa/live-dictation-20261114/cases.json` and `results.json`: actual fixtures, validated outputs and measured times.
- `outputs/qa/live-dictation-20261114/editor-results.json`: actual-output insertion and recovery assertions.
- `outputs/qa/live-dictation-20261114/probe-manifest.json`: exact native probe configuration and source identity.
- `outputs/qa/live-dictation-20261114/native-preview-verification.json`: build match and verification results.

For each future result, record the test ID, input version, build and provider settings, expected and actual outcome, stage timings, recovery level, evidence location and proposed fix. After a fix, rerun the failing case, a neighbouring negative case and an untouched example before claiming improvement.
