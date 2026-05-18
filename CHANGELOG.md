# Changelog

All notable changes to `flowmcp-cli` are documented here.

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
