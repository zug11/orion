# Orion — Later Product Work

This document preserves the product decisions intentionally deferred from the
current reliability and navigation pass. It is not a commitment to implement
every idea unchanged; each section records the problem, the preferred direction,
and the constraints that should survive future design work.

## Large-Space context architecture

Orion should remain coherent with dozens or hundreds of sources without placing
an entire Space into every model request. The intended pipeline is:

1. Preserve the complete local source and derive bounded chunks.
2. Extract a source synopsis, concepts, aliases, claims, tasks, and citation
   anchors.
3. Maintain a canonical Space-level concept and alias index.
4. Run impact analysis to identify only the notes meaningfully affected by new
   material.
5. Build a bounded evidence packet for each affected note from relevant source
   passages, the current note, and closely related notes.
6. Integrate evidence into the natural structure of the note while preserving
   worthwhile human prose, tasks, links, uncertainty, and disagreements.
7. Update the living Space overview hierarchically from note/source summaries.

Background jobs must be idempotent, inspectable, retryable, Space-scoped, and
safe against late responses. Cache derived artifacts by content fingerprint,
prompt version, and model so unchanged material does not consume tokens again.
Long context windows may be used selectively, but they are not the architecture.

## Publish notes and Spaces

Let users publish a beautiful, read-only web snapshot with three scopes:

- the current note;
- the current note plus explicitly selected linked notes;
- the entire Space.

Only links whose targets are included in the publication may navigate. Other
links remain non-interactive and must never expose an unpublished page. Before
publishing, Orion shows the exact notes and source material that will be shared.
Source files and excerpts require separate inclusion controls because they may
be private or copyrighted.

Start with a self-contained static web export. Hosted publications can later add
stable URLs, explicit republishing, version history, revocation, and whole-Space
navigation. Publications should be snapshots by default rather than silently
changing as the private Space evolves.
