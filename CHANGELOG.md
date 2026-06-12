# Changelog

All notable changes to `flowmcp-cli` are documented here.

## 4.8.0 — 2026-06-09 (Memo 128)

### Added

- Lazy schema-resolution for `call <namespace>/tool/<name>` (Spec-ID): the call now
  consults the prebuilt `.flowmcp/namespace-index.json` and imports ONLY the single
  schema file that owns the tool, instead of importing every configured schema
  (~549) before matching. For a keyless pure-calculation tool this collapses the
  call from ~1.3–1.8 s to ~0.6 s (measured on `geo/tool/geoExtent`). Every other
  FlowMCP consumer that shells to `flowmcp call` benefits — there is no API change.

### Changed

- `callTool` schema resolution and wire-name matching were extracted into reusable
  helpers (`#resolveSchemasForCall`, `#matchToolInSchemas`, `#resolveSchemaByIndex`).
  A Spec-ID call that misses the index, hits a stale entry, or fails the wire-name
  re-verify falls back transparently to the full scan — behaviour is identical to
  the previous full-scan path, only the import count changes. A `<source>:` prefix
  still scopes resolution to exactly that source (no first-wins). Bare wire-names and
  `flowmcp run`/serve are unaffected (full scan as before).

## 4.7.0 — 2026-06-07 (Memo 119)

### Changed (BREAKING)

- The `validate` command was renamed to `schema-check` to make its offline,
  structure-only nature explicit (vs. `grading deterministic`, which also runs the
  live data pretest). The old `validate` name is **removed** — there is no deprecated
  alias (`flowmcp validate` now reports "Unknown command"). The sibling commands
  `validate-catalog`, `validate-lists` and `validate-agent` are unaffected.

### Added

- Version-consistency gate in structural validation: a schema declaring a 4.x version
  is now checked to be SHAPED like v4 — no populated v2 `routes` (VERSION-001), no v3
  `skills` (VERSION-002), and at most 8 tools per file (VERSION-003). Because v4 reuses
  the v2 transport, a mis-declared schema otherwise only fails at runtime.
- Perf-guard test for the O(matched) namespace resolver: the deterministic grading run
  compiles only the schema files that declare the target namespace, never the rest.

### Fixed

- A required native library that is installed but fails to load (a missing or
  ABI-mismatched `.node` binding, e.g. better-sqlite3 after a broken build) now reports a
  clear `LIB-BINDING` error that says to rebuild the native module — instead of the
  misleading `LIB-RESOLVE` "library not resolvable / install it" message.
- Empty/whitespace `.env` values for a `requiredServerParam` are now treated as MISSING
  (key-gated, DPT-007) instead of being injected as an empty credential that fired a
  live 401 recorded as a false FAIL. Consistent with how `search`/`list` flag a tool as
  `[disabled: missing KEY]`.

## 4.4.0 — 2026-06-04 (Memo 107)

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

## 4.3.0 — 2026-06-04 (Memo 102 / Memo 105)

### Changed

- Version aligned to the Schemas-Spec `4.3` line for traceability — the single-path grading consolidation (Memo 102) merged after the `v4.2.0` tag without a version bump.
- `flowmcp-grading` dependency pin moved to `v2.2.0`.

### Added

- `flowmcp grading deterministic <id>` — structural validate + live data pretest (HTTP 200 **and** non-empty); schema read live from `schemaFolders[]`.
- `flowmcp grading non-deterministic <ns|selection>` — LLM scoring via `--emit-prompts` / `--consume-scores`.
- `--no-save` dry-run for grading.

### Removed

- `flowmcp dev test` single-path command (replaced by `grading deterministic`).

## 4.2.0 — 2026-05-31 (Memo 086)

### Changed

- Version aligned to the Schemas-Spec line (`4.2.0`) for traceability — resolves the prior package.json/tag drift (`0.1.0` vs tag `v4.0.0`).
- `flowmcp-grading` dependency pin moved from a bare commit hash to the `v2.0.0` tag.
- `grading` command area marked **experimental** in the CLI help (surface may change).

## Unreleased — 2026-05-18 (Memo 036)

### Breaking Changes

- `flowmcp dev grade` Anthropic-API-Codepath entfernt
- `--mock` Flag entfernt (war buggy: destructured `prompts` statt `evalPrompts`)
- `ANTHROPIC_API_KEY` Env-Variable nicht mehr benoetigt

### Added

- `flowmcp dev grade <schema> --emit-prompts` (Phase-1: schreibt `prompts.json` + `state.json`)
- `flowmcp dev grade <schema> --consume-scores <path>` (Phase-2: berechnet Grade aus extern erzeugten Scores)
- `--workdir <path>` Option (Default: `proofs/grade-work/`)
- `--reports-dir <path>` Option (Default: `proofs/grade-reports/`)
- `--on-conflict <skip|abort>` Option (Default: `skip` — NO-OVERWRITE-Garantie)
- Atomare File-Writes (write-temp + rename) — crash-safe
- Schema-Hash (sha256) in jedem Grade-Report
- Creator + Harness Metadaten im Report (`scoringProtocol: "v1"`)
- Timestamps pro Phase (startedAt, scoredAt, gradedAt, reportedAt)
- Absolute Pfade in jedem CLI-Output

### Companion Skills

- `grade-score-single` (im memo-toolkit) — Standalone Single-Schema-Grading
- `grade-score-batch` (im memo-toolkit) — Standalone Batch-Grading mit Crash-Recovery

### Migration

`flowmcp dev grade` ist jetzt File-Mode-only. Der typische Workflow ist:

```bash
# Standalone via Skill (empfohlen)
/grade-score-single --schema schemas/mudab/marine-data.mjs

# Oder Batch
/grade-score-batch --schemas grade-list.txt

# CLI direkt (Power-User)
flowmcp dev grade <schema> --emit-prompts
# ... external grader writes scores.json ...
flowmcp dev grade <schema> --consume-scores <path>/scores.json
```

Details: Memo 036 REV-06 + `flowmcp-spec/spec/v4.0.0/22-scoring-protocol.md`.

---

## Prior Releases

Siehe Memo 029 REV-09 (Memo 029 PRD F0a-F5) fuer die initiale CLI-Implementierung.
