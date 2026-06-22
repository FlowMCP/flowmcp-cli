# Changelog

All notable changes to `flowmcp-cli` are documented here.

## 4.7.0 — 2026-06-20

### Added

- **Schema-Persona threading into grading emit** — the emit path now resolves the
  per-namespace Schema-Persona (base + lens) and threads it into the emit substitution
  context, so the persona-required Schema-Areas (`about-namespace`, `namespace-skills`)
  compose instead of deferring. Adds `#resolveSchemaPersona`, `#resolveSchemaPersonaPaths`,
  `#resolveFirstSkill`, and the extended `#buildEmitSubstitutions`.
- **Consume-side writer for namespace-area gradings** — `--consume-scores` now persists the
  persona-required namespace areas (`about-namespace`/`namespace-skills`) under
  `<ns>/<schema>/resources/about/_gradings/`. This was the missing writer behind the
  "0 About graded" symptom; the About-Persona path now works end-to-end (`about:graded`).

### Changed

- Re-pinned `flowmcp-grading` to `2.5.0` (`2974ae8`) for the persona-area emit composition,
  and `geo-dzt-toolkit` to its `getTrails` build.

## 4.4.0 — 2026-06-04

### Added

- `grading deterministic <namespace>` (bare namespace) — runs the deterministic grade
  over every schema of the namespace ("one command per namespace") and produces one
  namespace `index.json` rollup + the committable provider-proof `grade.json`.
- The deterministic path is no longer a summary-only sweep: after the data-pretest it
  now writes the full spec structure — the deterministic Area `_gradings/` (via the new
  `DeterministicAreaMapper` + `AreaScorer.writeEntry`, timestamped-additive / NO-OVERWRITE),
  rebuilds the namespace `index.json` (`RebuildIndex`), and projects the provider-proof
  `grade.json` (`ProviderProof`). `--no-save` skips all island writes.
- A tool-addressed grade (`<namespace>/tool/<name>`) writes only that tool's `_gradings/`
  entry; sibling tools are left untouched. Stale `test-N.json` from a higher-count run is
  moved to a reversible `.trash/` (never hard-deleted).

### Dependency

- Pins `flowmcp-grading#v2.3.0` (DeterministicAreaMapper / AreaScorer export, stale-test
  cleanup). Requires the grading tag `v2.3.0` to be published.

## 4.3.0 — 2026-06-04

### Changed

- Version aligned to the Schemas-Spec `4.3` line for traceability — the single-path grading consolidation merged after the `v4.2.0` tag without a version bump.
- `flowmcp-grading` dependency pin moved to `v2.2.0`.

### Added

- `flowmcp grading deterministic <id>` — structural validate + live data pretest (HTTP 200 **and** non-empty); schema read live from `schemaFolders[]`.
- `flowmcp grading non-deterministic <ns|selection>` — LLM scoring via `--emit-prompts` / `--consume-scores`.
- `--no-save` dry-run for grading.

### Removed

- `flowmcp dev test` single-path command (replaced by `grading deterministic`).

## 4.2.0 — 2026-05-31

### Changed

- Version aligned to the Schemas-Spec line (`4.2.0`) for traceability — resolves the prior package.json/tag drift (`0.1.0` vs tag `v4.0.0`).
- `flowmcp-grading` dependency pin moved from a bare commit hash to the `v2.0.0` tag.
- `grading` command area marked **experimental** in the CLI help (surface may change).

## Unreleased — 2026-05-18

### Breaking Changes

- `flowmcp dev grade` Anthropic API codepath removed
- `--mock` flag removed (was buggy: destructured `prompts` instead of `evalPrompts`)
- `ANTHROPIC_API_KEY` env variable no longer required

### Added

- `flowmcp dev grade <schema> --emit-prompts` (Phase 1: writes `prompts.json` + `state.json`)
- `flowmcp dev grade <schema> --consume-scores <path>` (Phase 2: computes the grade from externally produced scores)
- `--workdir <path>` option (default: `proofs/grade-work/`)
- `--reports-dir <path>` option (default: `proofs/grade-reports/`)
- `--on-conflict <skip|abort>` option (default: `skip` — NO-OVERWRITE guarantee)
- Atomic file writes (write-temp + rename) — crash-safe
- Schema hash (sha256) in every grade report
- Creator + harness metadata in the report (`scoringProtocol: "v1"`)
- Timestamps per phase (startedAt, scoredAt, gradedAt, reportedAt)
- Absolute paths in every CLI output

### Companion Skills

- `grade-score-single` (in the memo-toolkit) — standalone single-schema grading
- `grade-score-batch` (in the memo-toolkit) — standalone batch grading with crash recovery

### Migration

`flowmcp dev grade` is now file-mode only. The typical workflow is:

```bash
# Standalone via skill (recommended)
/grade-score-single --schema schemas/mudab/marine-data.mjs

# Or batch
/grade-score-batch --schemas grade-list.txt

# CLI directly (power user)
flowmcp dev grade <schema> --emit-prompts
# ... external grader writes scores.json ...
flowmcp dev grade <schema> --consume-scores <path>/scores.json
```

Details: see `flowmcp-spec/spec/v4.0.0/22-scoring-protocol.md`.

---

## Prior Releases

Earlier releases cover the initial CLI implementation.
