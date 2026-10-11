# Rich-editor action browser fixtures

These two captures came from the actual `RichNoteEditor` and production
`startEditorActionMailbox` adapter in the isolated browser fixture under
`outputs/validation/20261011-editor-actions/browser`. Every note and provider
response in that browser run was synthetic; no user vault, credentials or live
provider were used.

The `editor-action-rewrite.json` and `editor-action-empty-write.json` files preserve
the exact `editor_actions_capture` argument objects extracted from the archived
browser logs, with byte-identical companion capture artifacts.
Their nested `capture` objects are not reconstructed for Rust. The companion
acceptances file contains the same action's actual `editor_actions_accepted`
serialized Markdown and action specification. The provenance file records exact
source capture/report hashes and confirms each capture equals its report log.

The native integration test constructs an isolated vault from that actual
`baseNote`, registers an owner using the emitted document/selection versions,
and consumes the unchanged capture payload. Native target, request and capture
IDs are newly issued by the real Rust store; the outer IDs in these browser
fixtures came from its simulated native transport and cannot authorize anything.
The test then exercises native start, generation authorization, review, local
acceptance and exact disk-confirmed save with the browser's accepted Markdown.
It also checks that source bodies and completed-task sentinels stay out of public
receipts. This is browser/native contract parity, not a full native UI/provider
acceptance run or a claim that these fixture IDs are live.
