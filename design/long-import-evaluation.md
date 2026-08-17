# Long-import evaluation

Orion keeps real long documents out of the ordinary test suite: fixtures can be
large or copyrighted, and a normal `npm test` must never spend provider money.
The opt-in harness accepts a local PDF path at runtime and stores neither the
path nor the document in the repository.

Run the recovery evaluation with:

```bash
npm run eval:long-import -- /path/to/document.pdf
```

The default deterministic fixture deliberately makes one reader report
incomplete coverage, returns two malformed synthesis plans, and returns one
writer's malformed result twice. A successful run proves that Orion splits the
unread range, repairs planning automatically, completes an exhausted writing
job directly from validated readings, and produces notes without a plain-text
landing or a Resume interaction.

Run an all-compliant control with:

```bash
npm run eval:long-import -- /path/to/document.pdf --compliant
```

After building the native helper, add `--vision` to either command to run the
same source through Orion's real page-selection, PDFKit rendering, Apple Vision
recognition, and conservative merge boundary. This remains entirely local and
still uses deterministic provider fixtures.

The report includes total PDF pages, selectable-text pages and characters,
logical reading ranges, adaptive child reads, observed physical width, planning
corrections, writer jobs, failed-response recovery, note count, landing state,
elapsed time, and a small extraction-normalization audit. Repeated-line and
line-end-hyphenation counts are diagnostic candidates only; the harness does
not mutate source text.
An elevated replacement-character rate is qualitatively different from ordinary
layout furniture: it suggests a damaged embedded OCR layer. Orion's page-level
quality gate sends only those damaged or textless physical pages through local
Vision recognition and conservatively merges an improved result. Removing
headers or joining hyphenated lines alone cannot recover characters that the
PDF text layer has already lost.

This evaluates Orion's real PDF parser, range planner, fixed import pipeline,
typed response validation, local synthesis-plan fallback, writer fan-out, and
final assembly. Provider responses are deterministic contract fixtures. It does
not score live-model prose quality and it never reads Keychain credentials.
