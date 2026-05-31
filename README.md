[![Test](https://img.shields.io/github/actions/workflow/status/FlowMCP/flowmcp-cli/test-on-push.yml)]() ![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)

# FlowMCP CLI

Command-line tool for developing, validating, and managing FlowMCP schemas.

## Description

FlowMCP CLI is a developer tool for working with FlowMCP schemas — structured API definitions that enable AI agents to interact with external services. The CLI provides schema validation, live API testing, repository imports, delta-based updates, and an MCP server mode for integration with AI agent frameworks like Claude Code.

## Architecture

```mermaid
flowchart LR
    A[Global: ~/.flowmcp/] --> B[Config + .env + Schemas]
    B --> C[flowmcp init]
    C --> D[Local: project/.flowmcp/]
    D --> E[Groups with Selected Tools]
    E --> F[flowmcp call / run]
```

| Level | Path | Content |
|-------|------|---------|
| **Global** | `~/.flowmcp/` | Config, .env with API keys, all imported schemas |
| **Local** | `{project}/.flowmcp/` | Project config, groups with selected tools |

## Quickstart

```bash
git clone https://github.com/FlowMCP/flowmcp-cli.git
cd flowmcp-cli
npm i
npx flowmcp init
```

## Commands

### Setup

| Command | Description |
|---------|-------------|
| `flowmcp init` | Interactive setup — creates global and local config |
| `flowmcp status` | Show config, sources, groups, and health info |
| `flowmcp --help` | Show help with health warnings |

### Tool Discovery (Agent Mode)

| Command | Description |
|---------|-------------|
| `flowmcp search <query>` | Find available tools by keyword |
| `flowmcp add <tool-name>` | Activate a tool for this project |
| `flowmcp remove <tool-name>` | Deactivate a tool |
| `flowmcp reload <tool-name>` | Remove and re-add a tool (force refresh) |
| `flowmcp list` | Show active tools |

### Schema Management

| Command | Description |
|---------|-------------|
| `flowmcp schemas` | List all available schemas and their tools |
| `flowmcp import <url> [--branch name]` | Import schemas from a GitHub repository |
| `flowmcp import-registry <url>` | Import schemas from a registry URL |
| `flowmcp update [source-name]` | Update schemas from remote registries (hash-based delta) |

### Group Management

| Command | Description |
|---------|-------------|
| `flowmcp group list` | List all groups and their tool counts |
| `flowmcp group append <name> --tools "refs"` | Add tools to a group (creates group if new) |
| `flowmcp group remove <name> --tools "refs"` | Remove tools from a group |
| `flowmcp group set-default <name>` | Set the default group |

### Prompt Management

| Command | Description |
|---------|-------------|
| `flowmcp prompt list` | List all prompts across groups |
| `flowmcp prompt search <query>` | Search prompts by keyword |
| `flowmcp prompt show <group/name>` | Show a specific prompt with content |
| `flowmcp prompt add <group> <name> --file <path>` | Add a prompt from a file |
| `flowmcp prompt remove <group> <name>` | Remove a prompt |

### Validation & Testing

| Command | Description |
|---------|-------------|
| `flowmcp validate [path]` | Validate schema structure against FlowMCP spec |
| `flowmcp validate` (no path) | Validate all schemas in the default group |
| `flowmcp validate-catalog <dir>` | Validate a catalog directory (registry, schemas, agents) |
| `flowmcp test project [--route name] [--group name]` | Test default group with live API calls |
| `flowmcp test user [--route name]` | Test all user schemas with live API calls |
| `flowmcp test single <path> [--route name]` | Test a single schema file |

### Schema Grade Report

`flowmcp dev grade` follows a 2-phase file-mode workflow (no API key required — harness produces scores).

| Command | Description |
|---------|-------------|
| `flowmcp dev grade <path> --emit-prompts [--workdir D]` | **Phase 1**: write `prompts.json` + `state.json` |
| `flowmcp dev grade <path> --consume-scores <scores.json>` | **Phase 2**: compute grade, write report |
| `--reports-dir <path>` | Override reports directory (default: `proofs/grade-reports/`) |
| `--on-conflict <skip\|abort>` | NO-OVERWRITE strategy (default: `skip`) |

For end-to-end grading (wraps both phases + Subagent scoring), use the workbench skills:

```bash
/grade-score-single --schema schemas/mudab/marine-data.mjs
/grade-score-batch --schemas grade-list.txt
```

Spec: `flowmcp-spec/spec/v4.0.0/22-scoring-protocol.md`.

### Grading

The `grading` commands run the production grading system (v2) against a local
workbench island under `grading-data/`. They are reachable both as
`flowmcp grading ...` and `flowmcp dev grading ...` (the `dev` prefix is optional).

| Command | Description |
|---------|-------------|
| `flowmcp grading import <provider-path>` | Import a provider folder into the island (Stage 0) |
| `flowmcp grading run <ns\|selection> --emit-prompts` | Stage 1: deterministic pretest + emit grading prompts (handoff) |
| `flowmcp grading run <ns\|selection> --consume-scores <path>` | Stage 3: consume harness scores, rebuild index, finalize |
| `flowmcp grading export <ns\|selection>` | Export the graded state (`index.json`) back to the source |
| `flowmcp grading state <ns\|selection>` | Show the current rollup status (read-only) |

Flags for `run`: `--phase <area>` restricts grading to a single area/skill;
`--on-conflict <abort\|skip\|overwrite>` sets the write-conflict policy
(default: no overwrite).

#### Stage model

Grading runs in four stages. The CLI owns Stages 0, 1 and 3; the **harness**
(your Claude Code agent loop) owns Stage 2.

| Stage | Owner | What happens |
|-------|-------|--------------|
| 0 — Intake | CLI | `grading import` validates the provider schemas, snapshots them into the island and normalizes resources/skills |
| 1 — Deterministic | CLI | `grading run --emit-prompts` runs the deterministic pretest (live HTTP checks — the request is never persisted) and the deterministic graders, then emits `prompts.json` + `state.json` for the handoff |
| 2 — Non-deterministic | Harness | The agent loop reads `prompts.json`/`state.json` and grades each area (`start-grade → evaluate → apply-improvement`) — this is the only stage outside the CLI |
| 3 — Finalize | CLI | `grading run --consume-scores <path>` reads the harness scores, computes grades, rebuilds `index.json` (5-status rollup) and finalizes the state for `export` |

#### Flow auto-detection

The target's path decides the test flow, the tier, and the maximum reachable grade:

- `providers/<target>/` → **provider test** — tier `autonomous`, max **grade B**.
- `selections/<target>/` → **selection test** — tier `group-bound`, **grade A** reachable.
- A target that exists under both `providers/` and `selections/` is rejected with
  an error and a fix hint; pass an explicit path to disambiguate.

#### Handoff to the harness

`grading run --emit-prompts` does not grade non-deterministically itself. It
writes:

- `prompts.json` — one grading prompt per area, each carrying a Goal-Block.
- `state.json` — the run baton (which areas are pending/done), updated atomically
  and never overwritten.

The harness then drives the non-deterministic loop: an `Agent()` runs each
area's grading prompt against the goal. A small fast evaluator (Haiku) reads
**only the transcript** — it calls no tools — to decide when the goal is met.
For this to work, the loop surfaces its progress into the transcript with
`[GRADING]` lines, for example:

```
[GRADING] area=single-test/getFirstPrice schema-valid=ok status=graded written=ok
[GRADING] PROGRESS 7/12
[GRADING] DONE
```

When the goal is reached, hand the scores back to the CLI:

```bash
# Stage 1 — deterministic pretest + emit prompts (provider test)
flowmcp grading run providers/defillama --emit-prompts

# Stage 2 — harness grades each area (outside the CLI), writing scores

# Stage 3 — consume the harness scores, rebuild the index, finalize
flowmcp grading run providers/defillama --consume-scores scores.json

# Inspect the rollup, then export the graded state back to the source
flowmcp grading state providers/defillama
flowmcp grading export providers/defillama
```

### Agent Management

| Command | Description |
|---------|-------------|
| `flowmcp import-agent <agent-name>` | Import an agent definition from the registry |

### Schema Migration

| Command | Description |
|---------|-------------|
| `flowmcp migrate <path>` | Migrate a schema file from v2 to v3 (routes -> tools, version bump) |
| `flowmcp migrate <dir>` | Migrate all schema files in a directory |
| `flowmcp migrate --all [dir]` | Migrate all schemas recursively (defaults to cwd) |
| `flowmcp migrate <path> --dry-run` | Preview migration changes without writing |

### Resource Management (SQLite)

| Command | Description |
|---------|-------------|
| `flowmcp resource create <schema-path> [--basis name] [-y]` | Create SQLite databases for file-based resources in a schema |
| `flowmcp resource migrate [--basis name] [--dry-run] [-y]` | Migrate old-format database paths to new convention |

### Cache Management

| Command | Description |
|---------|-------------|
| `flowmcp cache status` | Show cached entries, sizes, and namespaces |
| `flowmcp cache clear [namespace]` | Clear all cache or a specific namespace |

### Execution

| Command | Description |
|---------|-------------|
| `flowmcp call list-tools [--group name]` | List available tools in default/specified group |
| `flowmcp call <tool-name> [json] [--group name]` | Call a tool with optional JSON input |
| `flowmcp call <tool-name> [json] --no-cache` | Call a tool bypassing cache |
| `flowmcp call <tool-name> [json] --refresh` | Call a tool and refresh cache |
| `flowmcp run [--group name]` | Start MCP server (stdio transport) |

## Tool Reference Format

```
source/file.mjs              # All tools from a schema
source/file.mjs::routeName   # Single tool from a schema
```

## Add-ons

### Konzept

Add-ons sind formatspezifische Adapter, die FlowMCP-CLI bei Bedarf laedt, wenn ein Schema eine Resource mit einem nicht-trivialen Datenformat deklariert. Sie kapseln Wissen, das nicht in die Schema-Definition gehoert — etwa wie eine bestimmte SQLite-DB aufgebaut sein muss, welche Auto-Tools daraus ableitbar sind, oder wie eine Qualitaets-Garantie (Seal) zu pruefen ist.

Add-ons leben als eigenstaendige GitHub-Repos, nicht als Teil der CLI. Das trennt Schema-Logik (Was wird abgefragt?) von Format-Logik (Wie ist das Format aufgebaut?) und erlaubt parallele Weiterentwicklung. Die CLI laedt Add-ons via `github:`-Shorthand on-demand, sobald ein Schema sie referenziert.

Das Versprechen: ein Schema, das auf ein Add-on zeigt, bekommt automatisch generierte Tools auf einer Datenquelle, die der Add-on als spec-konform und qualitaetsgesichert verifiziert hat. Der Schema-Autor schreibt keinen SQL-Code, der Add-on-Autor keinen Schema-Boilerplate.

### Beispiel: sqlite-gtfs

Der erste Add-on ist [`gtfs-sqlite-toolkit`](https://github.com/FlowMCP/gtfs-sqlite-toolkit). Er konvertiert GTFS-Schedule-Feeds (CSV in ZIP) in spec-konforme SQLite-Datenbanken und liefert dazu eine Capability-basierte Auto-Tool-Generierung. Ein Schema referenziert ihn so:

```javascript
export const schema = {
    namespace: 'gtfsde',
    name: 'gtfsde-transit-v2',
    version: '2.0.0',
    main: {
        resources: [
            {
                source:      'sqlite-gtfs',
                mode:        'file-based',
                path:        '${FLOWMCP_RESOURCES}/gtfs-de.db',
                addon:       'gtfs-sqlite-toolkit',
                addonSource: 'github:FlowMCP/gtfs-sqlite-toolkit'
            }
        ]
    }
}
```

`source: 'sqlite-gtfs'` signalisiert der CLI, dass ein Add-on noetig ist. `addon` benennt das Repo, `addonSource` zeigt auf den Bezugsort (immer `github:<org>/<repo>` — keine npm-Registry). `${FLOWMCP_RESOURCES}` ist eine Pfad-Variable (siehe naechsten Abschnitt) und entspricht dem Default `~/.flowmcp/resources/`.

### Discovery: ADDON_REGISTRY

Die CLI haelt einen kleinen, in `src/data/addons.mjs` **hardcoded** in V1 gepflegten Registry-Eintrag pro bekanntem `source`-Typ. Ein Eintrag besteht aus drei Feldern:

```javascript
export const ADDON_REGISTRY = {
    'sqlite-gtfs': {
        name:           'gtfs-sqlite-toolkit',
        source:         'github:FlowMCP/gtfs-sqlite-toolkit',
        defaultVersion: 'main'
    }
}
```

`name` ist der Add-on-Bezeichner (muss mit `addon` im Schema uebereinstimmen), `source` ist der `github:`-Bezugsort, `defaultVersion` ist der Git-Ref, der genutzt wird, wenn das Schema keinen `addonVersion` setzt. In V1 ist die Registry hardcoded; spaetere Versionen koennen sie ueber externe Quellen erweitern.

Spec-Referenz: [`flowmcp-spec/spec/v4.0.0/13-resources.md`](../flowmcp-spec/spec/v4.0.0/13-resources.md) Abschnitt "SQLite-GTFS Resources".

Verwandte Abschnitte: [Pfad-Variablen](#pfad-variablen) (`${FLOWMCP_RESOURCES}`), [FlowMCP-Verzeichnis-Struktur](#flowmcp-verzeichnis-struktur) (Default-Ort `~/.flowmcp/resources/`), [Datenquellen — User-Verantwortung](#datenquellen--user-verantwortung) (DBs werden vom User selbst angelegt).

## Pfad-Variablen

Pfad-Variablen erlauben User-Konfigurierbarkeit, ohne dass ein Schema fuer jeden Setup neu geschrieben werden muss. Sie tauchen typischerweise im `path`-Feld einer Schema-Resource auf — etwa um auf eine lokal abgelegte SQLite-DB zu zeigen, deren Ort der User selbst bestimmt.

Die CLI loest folgende Variablen auf:

| Variable | Aufloesung | Default | Spec-Bezug |
|----------|------------|---------|------------|
| `${FLOWMCP_RESOURCES}` | Env-Var `FLOWMCP_RESOURCES` | `~/.flowmcp/resources/` | Spec-Primitive `main.resources` |
| `${HOME}` | Env-Var `HOME` | obligatorisch (OS) | — |
| `~` | Tilde-Expansion auf `$HOME` | obligatorisch (OS) | — |

Die Aufloesung erfolgt in zwei Stufen: zuerst pruefen, ob die Env-Var gesetzt ist; wenn nicht, den dokumentierten Default einsetzen. Variablen ohne Default (wie `${HOME}`) muessen vom Betriebssystem bereitgestellt sein, sonst greift der Fehlerfall.

### Fehler `RES035`

Wenn die CLI eine Variable nicht aufloesen kann — etwa weil eine unbekannte Variable im `path` steht oder eine Env-Var ohne Default leer ist — bricht `flowmcp add` mit `RES035` ab. User beheben das, indem sie die Env-Var explizit setzen (`export FLOWMCP_RESOURCES=/path/to/dir`) oder die DB an den Default-Ort verschieben.

### Namens-Familie `FLOWMCP_*`

Pfad-Variablen folgen dem Pattern Spec-Primitive-Name → Variablen-Name. `${FLOWMCP_RESOURCES}` bindet direkt an das Spec-Primitive `main.resources` und etabliert die `FLOWMCP_*`-Namensfamilie. Zukuenftige Erweiterungen sind absehbar — etwa `${FLOWMCP_LOGS}` fuer Log-Verzeichnisse oder `${FLOWMCP_CACHE}` als expliziter Cache-Hook. In V1 ist nur `${FLOWMCP_RESOURCES}` implementiert.

Beispiel fuer einen alternativen Ort:

```bash
export FLOWMCP_RESOURCES=/Volumes/MyData/flowmcp
flowmcp add gtfsde-transit-v2
```

Verwandte Abschnitte: [Add-ons](#add-ons) (Schema-Beispiele mit `${FLOWMCP_RESOURCES}`), [FlowMCP-Verzeichnis-Struktur](#flowmcp-verzeichnis-struktur) (Default-Aufloesung).

## Datenquellen — User-Verantwortung

FlowMCP verteilt **keine** Provider-Daten in seinen oeffentlichen Repos. Das hat drei Gruende, die alle gleichzeitig gelten.

**Lizenz.** GTFS-Feeds und vergleichbare Provider-Datensaetze unterliegen jeweils eigenen Lizenz-Bedingungen — von CC BY 4.0 ueber custom EULAs bis zu Provider-spezifischen Klauseln. Wer die Daten in ein Public-Repo legt, verschiebt diese Konformitaets-Pflicht ungewollt auf das Repo und alle Forks. FlowMCP vermeidet das, indem die Daten beim User bleiben.

**Skalierung.** Reale Provider-Feeds erreichen 40 MB und mehr (DB Bahn FV-Schedule liegt bei ~50 MB, regionale VBB-Feeds darueber). Solche Datenmengen im Git-History blaehen jedes Clone-Setup auf und machen den Repo schwerfaellig. Code und Daten gehoeren in unterschiedliche Lebenszyklen.

**Aktualitaet.** Feeds werden taeglich oder woechentlich aktualisiert. Ein Repo-State waere immer veraltet — der User muesste regelmaessig pruefen, ob die im Repo enthaltene Version noch der Realitaet entspricht. Sauberer ist es, wenn der User direkt vom Provider zieht und konvertiert.

### User-Workflow

Der Weg von einem Provider-Feed zu einer von FlowMCP nutzbaren DB hat vier Schritte:

1. **Download** des GTFS-Feeds vom Provider (Beispiele: `gtfs.de/de/feeds/`, regionale Open-Data-Portale, Provider-eigene Download-Seiten)
2. **Konvertierung** via Add-on `gtfs-sqlite-toolkit` (siehe Add-on-README fuer den genauen Aufruf)
3. **Ablage** der DB unter `${FLOWMCP_RESOURCES}/<name>.db` (Default `~/.flowmcp/resources/<name>.db`)
4. **Aktivierung** via `flowmcp add <schema>`

Konkrete Befehlsbeispiele:

```bash
# 1. GTFS-Feed laden (Beispiel)
curl -O https://download.gtfs.de/germany/free/latest.zip

# 2. Konvertieren via Add-on (siehe gtfs-sqlite-toolkit README)
cd ~/code/gtfs-sqlite-toolkit
node convert.mjs --input=~/Downloads/latest.zip --output=~/.flowmcp/resources/gtfs-de.db

# 3. Optional: DB an anderen Ort verschieben
#    (wenn ${FLOWMCP_RESOURCES} nicht auf den Default zeigt)

# 4. Schema aktivieren
flowmcp add gtfsde-transit-v2
```

### Pre-Push-Schutz

Das Add-on-Repo (`gtfs-sqlite-toolkit`) liefert ein Verifikations-Skript `scripts/check-no-provider-data.sh`, das vor jedem Commit bzw. Push grosse oder provider-spezifische Dateien erkennt und den Push abbricht. Diese Policy gilt auch fuer User-Forks — wer mitarbeitet, sollte das Skript in eigene Pre-Push-Hooks einbinden.

Wer ein Schema fuer einen neuen Provider beitragen moechte, liefert **nur das Schema und die Pfad-Variable** — niemals den Feed selbst.

Verwandte Abschnitte: [Pfad-Variablen](#pfad-variablen) (Schritt 3 nutzt `${FLOWMCP_RESOURCES}`), [FlowMCP-Verzeichnis-Struktur](#flowmcp-verzeichnis-struktur) (Default-Ablage-Ort), [Add-ons](#add-ons) (Schritt 2 erfordert ein Add-on).

## FlowMCP-Verzeichnis-Struktur

FlowMCP nutzt ein zentrales User-Verzeichnis `~/.flowmcp/`, das ueber alle Projekte hinweg konsistent ist. Es haelt API-Keys, Cache und User-Resources an einem Ort — projekt-lokal koennen einzelne Werte ueberschrieben werden, der Default-Lookup bleibt zentral.

```
~/.flowmcp/
├── .env             ← API Keys (Single Source of Truth)
├── cache/           ← Schema cache (CLI-managed)
└── resources/       ← User DBs (NEW — Default fuer ${FLOWMCP_RESOURCES}, ab Memo 051)
```

| Pfad | Zweck | Verwaltung | Quer-Verweis |
|------|-------|------------|--------------|
| `~/.flowmcp/.env` | API Keys, Provider-Credentials | User (manuell) | Memo 032 Credentials Management |
| `~/.flowmcp/cache/` | Schema-Cache, Add-on-Cache | CLI (automatisch) | — |
| `~/.flowmcp/resources/` | User-DBs (z.B. konvertierte GTFS) | User (manuell oder via Add-on) | `${FLOWMCP_RESOURCES}` Default |

### `.env` — Single Source of Truth

Die globale `~/.flowmcp/.env` ist die Single Source of Truth fuer API-Keys aller FlowMCP-Tools. Sie wird vom User manuell gepflegt; die CLI legt sie nie automatisch an und ueberschreibt nie. Projekt-lokal kann ein Override unter `projects/<name>/.flowmcp/.env` abgelegt werden — der Lookup-Pfad ist erst projekt-lokal, dann global (siehe Memo 032 fuer das Credential-Modell).

### `resources/` — Default fuer `${FLOWMCP_RESOURCES}`

Das Verzeichnis `~/.flowmcp/resources/` ist mit Memo 051 hinzugekommen und dient als Default-Aufloesung fuer die Pfad-Variable `${FLOWMCP_RESOURCES}`. User koennen die Env-Var auf einen anderen Ort setzen — etwa eine externe Festplatte oder ein zentrales Datenlaufwerk — die CLI loest dann dynamisch dorthin auf.

```bash
export FLOWMCP_RESOURCES=/Volumes/MyData/flowmcp
```

Verwandte Abschnitte: [Pfad-Variablen](#pfad-variablen) (Aufloesungs-Logik), [Datenquellen — User-Verantwortung](#datenquellen--user-verantwortung) (warum die DBs hier landen, nicht im Repo).

## Global Flags

| Flag | Short | Description |
|------|-------|-------------|
| `--help` | `-h` | Show help |
| `--group <name>` | | Target a specific group |
| `--route <name>` | | Filter by route name (for test commands) |
| `--branch <name>` | | Git branch for import |
| `--tools "refs"` | | Comma-separated tool references (for group commands) |
| `--force` | | Force overwrite (for add) |
| `--no-cache` | | Bypass cache (for call) |
| `--refresh` | | Refresh cached result (for call) |
| `--all` | | Apply to all schemas (for migrate) |
| `--dry-run` | | Preview changes without writing (for migrate, resource migrate) |
| `--file <path>` | | File path (for prompt add) |
| `--basis <name>` | | Resource basis directory name (default: flowmcp) |
| `--yes` | `-y` | Auto-confirm prompts |

## Workflow Examples

### Basic Setup and Usage

```bash
# 1. Setup (quick install imports schemas and creates default group)
flowmcp init

# 2. Or: Manual import and group creation
flowmcp import https://github.com/FlowMCP/flowmcp-schemas
flowmcp group append crypto --tools "flowmcp-schemas/coingecko/simplePrice.mjs,flowmcp-schemas/etherscan/getBalance.mjs"
flowmcp group set-default crypto

# 3. Validate and test
flowmcp validate
flowmcp test project

# 4. Use tools
flowmcp call list-tools
flowmcp call coingecko_simplePrice '{"ids":"bitcoin","vs_currencies":"usd"}'

# 5. Update schemas from remote
flowmcp update

# 6. Run as MCP server
flowmcp run
```

### Schema Development

```bash
# Validate a single schema file
flowmcp validate ./my-schema.mjs

# Validate an entire directory
flowmcp validate ./schemas/my-provider/

# Test with live API calls
flowmcp test single ./my-schema.mjs

# Test a specific route only
flowmcp test single ./my-schema.mjs --route getBalance
```

## Testing

`flowmcp dev test single <path>` validates all five v4 primitives declared in a
single schema file and prints a consolidated summary:

| Primitive  | Source in Schema                       | Test Strategy                                  |
|------------|-----------------------------------------|------------------------------------------------|
| Tools      | `main.tools[*].tests`                   | HTTP fetch via `FlowMCP.fetch`                 |
| Resources  | `main.resources[*].queries[*].tests`    | `FlowMCP.executeResource` (SQLite readonly)    |
| Skills     | `main.skills[*].tests`                  | Structural (placeholder + prefill resolution)  |
| Prompts    | `main.prompts[*].tests`                 | Placeholder resolution                          |
| Selections | Selection file (transitive)             | Member iteration + aggregate                   |

Example output:

```
Tools:       0/0 (none declared)
Resources:   6/6 PASS (3 queries × 2 tests each)
Skills:      1/1 PASS (structural)
Prompts:     none
Selections:  4/4 Members PASS

Overall: PASS
```

### Filtering with `--only`

Use `--only=<csv>` to restrict a run to selected primitives. Allowed values:
`tools`, `resources`, `skills`, `prompts`, `selections` (comma-separated for
multiple).

```bash
# Only run Resource tests
flowmcp dev test single ./schema.mjs --only=resources

# Run Resources and Skills only
flowmcp dev test single ./schema.mjs --only=resources,skills
```

### Structured Output with `--json`

Add `--json` to emit a machine-readable summary. The JSON object contains
`overall`, `primitives` (per-primitive counts), and `tests` (per-test detail).
This format is consumed by downstream tooling such as conformance and grade
reports.

```bash
flowmcp dev test single ./schema.mjs --json
```

One-shot LLM tests for Skills are intentionally not a CLI feature; they run in
the Harness (see Spec v4.0.0 §10).


### Schema Migration (v2 to v3)

```bash
# Preview what would change
flowmcp migrate ./schemas/ --dry-run

# Migrate a single file
flowmcp migrate ./schemas/provider/schema.mjs

# Migrate all schemas in a directory
flowmcp migrate --all ./schemas/
```

### Agent Import

```bash
# Import an agent from the registry
flowmcp import-agent my-agent

# Validate a catalog directory
flowmcp validate-catalog ./my-catalog/
```

### Catalog Validation

The `validate-catalog` command checks a catalog directory for structural correctness:

- `registry.json` must exist and match the directory name
- All referenced schema files must exist
- All referenced shared files must exist
- All agent manifest files must exist
- Schema spec version must be valid (2.0.0 or 3.0.0)

```bash
flowmcp validate-catalog ./catalogs/my-catalog/
```

```json
{
    "status": true,
    "catalog": "my-catalog",
    "schemaSpec": "3.0.0",
    "counts": {
        "shared": 2,
        "schemas": 15,
        "agents": 1
    },
    "errors": [],
    "warnings": []
}
```

### Resource Management

For schemas with SQLite-based resources:

```bash
# Create databases defined in a schema
flowmcp resource create ./schemas/provider/schema.mjs -y

# Preview database path migrations
flowmcp resource migrate --dry-run

# Execute migrations
flowmcp resource migrate -y
```

### Cache Management

```bash
# Check cache size and entries
flowmcp cache status

# Clear everything
flowmcp cache clear

# Clear a specific namespace
flowmcp cache clear etherscan
```

### Prompt Management

```bash
# List all prompts
flowmcp prompt list

# Search for prompts
flowmcp prompt search "blockchain"

# View a specific prompt
flowmcp prompt show analysis/token-report

# Add a prompt from a markdown file
flowmcp prompt add analysis token-report --file ./prompts/token-report.md

# Remove a prompt
flowmcp prompt remove analysis token-report
```

## Documentation

Full documentation at [flowmcp.github.io](https://flowmcp.github.io). See the [CLI Reference](https://flowmcp.github.io/docs/reference/cli-reference/) for detailed command documentation.

## License & Terms of Services

FlowMCP CLI is **MIT-licensed**. The MIT license covers the CLI tooling (develop, validate, grade, deploy, env helpers) in this repository.

**Schemas accessed via the CLI** call third-party APIs, each with their own Terms of Services. Schemas may include an optional `meta.termsOfService` field with the provider's ToS URL and the date last verified. **We do not classify or interpret these Terms of Services.** Users are solely responsible for reviewing each API provider's terms before use.

FlowMCP makes no representation about ToS compliance, data licensing, or fitness for any purpose. See [DISCLAIMER.md](./DISCLAIMER.md) for details.

## License

MIT
