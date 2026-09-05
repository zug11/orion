# Orion desktop intelligence through MCP

Implementation scope for the Codex and Claude Desktop connectors. See also the
[20 additional local library tools](mcp-library-tools.md), bringing the shared
connector to 41 tools. This extends
the existing local vault tools with the running app's context engine and native
AI execution. The MCP executable never receives provider credentials or calls a
provider itself. There is no hosted endpoint or background daemon.

## Capabilities

- Discover app availability, configured capabilities, permissions, and jobs.
- Retrieve task-specific, versioned context locally with exact evidence and
  explicitly bounded coverage.
- Research, compare supplied material, identify research gaps, review an
  argument, and prepare a working brief through one evidence-bearing research
  contract. Follow-ups may reference a prior result, with freshness rechecked.
- Import text, supported local documents/images/media, public webpages, and
  YouTube sources through the existing extraction and knowledge-import flow.
  Preserve sources, provenance, canonical reuse, recovery diagnostics, and the
  atomic apply boundary. Local mode remains keyless.
- Reprocess exact preserved sources under new guidance without duplicating
  their provenance records or overwriting later edits.
- Generate ordinary notes, podcast scripts, slide decks, and narrated decks
  through the existing generation pipeline and configured image capabilities.
- Develop a canonical concept article, enrich affected knowledge, and refresh
  the persistent Space overview using the existing scoped workflows.
- Inspect, cancel, and retrieve bounded jobs without blocking the stdio loop.

## Boundaries

- A per-user authenticated Unix-domain connection joins the bundled MCP server
  to the running Orion app. Advanced vault overrides must match that app's
  exact vault; they cannot redirect a workflow to a different library.
- Connections settings explicitly allow Spaces and independently enable API
  use and workflow writes. Older vaults default to disabled. Existing local
  read/write MCP tools retain their existing contract.
- Every new workflow captures an explicit exact Space, configured model,
  reasoning effort, and immutable context. The existing-note privacy preference
  remains authoritative; a tool argument cannot enable it.
- All network requests and Keychain reads remain in the native app. Source
  fetching, OCR, and transcription retain their existing native validation.
- Jobs share the renderer's provider scheduler. Requests, queues, results,
  retained evidence, elapsed work, and retries are bounded. Cancellation stops
  queued stages and prevents late mutation; physical calls retain their slots
  until they actually finish.
- Research/context jobs never write notes or Chat history. Creation/revision
  workflows persist ordinary notes, without agent attribution or a new lifecycle.
- Writes use the existing advisory lock, revision check, and atomic replacement.
  Recheck both the live renderer and persisted Space before committing. Results
  advertise saved notes only after persistence succeeds.
- Evidence distinguishes exact text from orientation and model interpretation.
  Returned citations use exact IDs. Coverage and stale results are explicit;
  no historical body is inferred from a timestamp or fingerprint.

## Verification

- Protocol and native tests for validation, permissions, vault identity,
  cancellation, idempotency, queue bounds, stale writes, and Space isolation.
- Renderer tests for evidence selection/validation, preference-off payloads,
  import/reprocessing provenance, generation, canonical reuse, and live edits.
- MCP harness against the exact packaged binary, including the local bridge.
- Renderer checks, native/MCP tests and formatting, and Tauri integration build.
- Actual UI verification for connection settings and job activity at normal and
  narrow desktop sizes. Runtime verification uses isolated fixture libraries.

Verified on 5 September 2026:

- `npm run check`: 879 renderer tests passed, one pre-existing test skipped;
  TypeScript and the production renderer build passed.
- All 65 native tests and 45 independent MCP tests passed. They cover the real local socket,
  authentication, revoked access, cancellation, atomic revision writes,
  idempotency, and Space boundaries. Packaged connector harnesses run against
  the exact extracted Claude extension and Codex plugin executables.
- The Connections UI was inspected in the isolated browser preview at 1280 and
  960 pixels wide, with no console errors or horizontal overflow. Native-only
  controls remain disabled in browser preview; interaction and job execution
  are covered by component, executor, and native tests.
- `npm run tauri build` produces the app and DMG. The native release profile
  avoids the documented Rust 1.96/macOS 27 debug-stripping defect; dependencies
  and release signature checks are unchanged.
- The existing Deno input had an invalid signature. Its copy in the generated
  app was signed ad hoc, the app resealed, and strict verification passed for
  all nested code. Deno's version command also passed. The development DMG is
  repacked from that verified app on APFS, following the release script's
  metadata-safe staging layout. The canonical production release script already
  signs every helper before sealing the app.

No real library was changed, and no paid provider request was made during
verification. Live provider quality, billing, and an end-to-end run in an
installed Codex or Claude Desktop client remain unverified. That initial pass
used local development bundles. Current distribution and signing status are
recorded in the [Orion 0.4.5 release notes](../releases/0.4.5.md).

The numerical phrase “100x” expresses the requested breadth; no performance or
quality multiplier is claimed without measurement.
