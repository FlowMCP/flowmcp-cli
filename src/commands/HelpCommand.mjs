import { appConfig } from '../data/config.mjs'


// Memo 152 / PRD-019 (D-08) — the standalone help text commands `how-to` and
// `dev --help`. Pure text output, self-contained (only appConfig) — no
// back-reference to FlowMcpCli. The interactive `help` / `version` commands stay
// in the facade for now: `help` is coupled to the init-install health check and
// `version` to the handler-libraries base resolver (both not yet extracted).
class HelpCommand {
    static async howTo( { cwd: _cwd } = {} ) {
        const cmd = appConfig[ 'cliCommand' ]
        const text = `# ${cmd} — How to use

700+ data tools. Search, then call directly (no activation — Memo 099).

## Workflow

1. \`${cmd} search <topic>\`                Find tools
2. \`${cmd} call <id> [args]\`              Get data

Tools come straight from the folders listed in \`schemaFolders[]\` — there
is no add/activate step. Missing a key? The tool shows \`[disabled: missing KEY]\`.

## ID Format

  namespace/tool/name                      Single tool  (2 slashes)
  namespace/schema-name                    All tools from a schema  (1 slash)

## Examples

\`\`\`
${cmd} search ethereum blocks
${cmd} call etherscan/tool/getContractAbi '{"address":"0x...","chain":"ETHEREUM_MAINNET"}'
${cmd} list
\`\`\`

## Development Commands

Run \`${cmd} dev --help\` for development commands (schema-check,
allowlist, migrate-config, etc.).
`

        process.stdout.write( text )

        return { result: { status: true } }
    }


    static devHelp() {
        HelpCommand.#printDevHelpText()

        return { result: { status: true } }
    }


    static #printDevHelpText() {
        const cmd = appConfig[ 'cliCommand' ]
        const helpText = `Usage: ${cmd} dev <subcommand> [options]

Development & Schema Maintenance commands. Tier 2 — used by schema authors
and maintainers. AI agents typically use Tier 1 commands (${cmd} --help).

Validation & Testing:
  ${cmd} schema-check [path]          Structure-only check (OFFLINE). Verifies the
                                      schema shape against the v4 spec. It does NOT
                                      call any API or check liveness — run
                                      "grading deterministic" before shipping.
  (Memo 119: "validate" was renamed to "schema-check" — old name removed, no alias.
   Memo 102: "dev test project/user/single" removed — its PASS criterion was a
   strict subset of the deterministic grading pretest. Use:
     grading deterministic <namespace>/<schema>        structural validate + data pretest
     grading deterministic <namespace>/tool/<name>     restrict to one tool
       --only=<csv>                   v4-primitive view: tools | resources | skills | prompts | selections)

Configuration:
  dev allowlist list                  List libraries installed in allowed-libraries (installed = allowed)
  dev allowlist add <library>         (deprecated) prints: npm install --prefix <allowedLibrariesPath> <lib>
  dev allowlist remove <library>      (deprecated) prints the manual uninstall command
  dev migrate-config                  Migrate config from v3 path::route format to v4 spec-IDs

Libraries (allowed-libraries):
  External requiredLibraries load from allowed-libraries (config "allowedLibrariesPath",
  default ~/.flowmcp/allowed-libraries). The CLI never installs — folder presence is the gate.
  Install a missing lib:   npm install --prefix <allowedLibrariesPath> <lib>
  See what is missing:     flowmcp doctor
  Native libs after a Node major upgrade (talib, canvas, better-sqlite3) break until rebuilt:
  Rebuild native bindings: npm rebuild --prefix <allowedLibrariesPath>

Schema Management:
  dev schemas                         List all schemas from the configured schemaFolders
  dev import-agent <url>              Import an agent manifest
  dev status                          Show config, schemaFolders and health info
  (Memo 099: import/import-registry/update removed — add a folder by editing
   schemaFolders[] in ~/.flowmcp/config.json; clone repos with "gh repo clone")

Prompt Management:
  dev prompt list                            List all prompts across all groups
  dev prompt search <query>                  Search prompts by title/description
  dev prompt show <group>/<name>             Display prompt file content
  dev prompt add <group> <name> --file <p>   Add a prompt to a group
  dev prompt remove <group> <name>           Remove a prompt from a group

Resource Management:
  dev resource create <schema-path>          Create SQLite DBs for file-based resources
  dev resource migrate                       Migrate old DB paths to new origin system

Selection Management (v4):
  dev selection list                         List all selections
  dev selection show <name>                  Show selection details
  dev selection validate <path>              Validate a selection file

Grading (v2 — experimental; CLI surface may change):
  grading deterministic <id>                 Structural validate + deterministic data pretest, no scoring (alias: "det"). <id> = <namespace>/<schema> or <namespace>/tool/<name>
    --only=<csv>                             Restrict to v4 primitives. Allowed: tools | resources | skills | prompts | selections
  grading non-deterministic <ns|selection> --emit-prompts
                                             Stage 1 (alias: "nondet"): deterministic pretest + emit ONE self-contained handoff (area-set + Task-ID) for a grading sub-agent (schema read live from schemaFolders[]; the island is built on first run — no separate import step)
  grading non-deterministic <ns|selection> --consume-scores <path>
                                             Stage 3: consume ONE scores payload back; verifies the Task-ID + area-set + per-area question-count (partial-set supported), rebuilds the index, finalizes
    --phase <area[,area...]>                 Restrict grading to an area set: no flag = all applicable areas; one area = single mode; comma-set = subset mode (named-but-not-emittable areas are reported, never silently dropped)
    --on-conflict <abort|skip|overwrite>     Write-conflict policy (default: no-overwrite)
    --no-save                                Run grading without writing to the island (no index.json/grade.json/state.json, no pretest persist); orthogonal to --on-conflict
    --grading-data <path>                    Override the island location for this call
    --export-dir <path>                      Override the export destination root for this call
  grading export <ns|selection>              Export graded state (index.json) back to the source
  grading state <ns|selection>               Show current rollup status (read-only); carries the nextAction split (deterministic-now CLI work vs ONE non-deterministic area-set + Task-ID preview, plus gated areas with reasons)
  grading worklist <ns>                      Deterministic defect list only (subsumed into "doctor"; kept for back-compat)
  grading doctor <ns>                        Local, read-only "defects + last tips + next step": merges the deterministic defects, the last LLM improvement tips, a next re-entry loop, and the same nextAction split as "state" (never online, never writes grade.json)
  grading plan <ns> [--target <grade>]       Read-only Eintritts-Worklist (Memo 112): which schemas need (re-)grading — ungraded, schemaHash-stale, or below --target — and which are fresh/skipped. Writes nothing.
  grading finalize <ns> [--target <grade>]   Austritts-Rollup (Memo 112): rebuild the namespace index.json + grade.json from the per-schema gradings, then print the same recommendation (worklist) as "plan".
  (also available as "${cmd} grading ..." — the "dev" prefix is optional)
  Two-level handover: the CLI emits ONE self-contained artifact for a sub-agent
    and consumes ONE payload back — one area-set, one Task-ID, one round-trip.
  Island default: ~/.flowmcp/grading (override via --grading-data,
    FLOWMCP_GRADING_DATA, or "gradingDataDir" in ~/.flowmcp/config.json)
  Export default: <island>/_exports (override via --export-dir,
    FLOWMCP_GRADING_EXPORT, or "gradingExportDir" in ~/.flowmcp/config.json)
  Target <id> forms:
    namespace                 whole provider           (no slash),  e.g. etherscan
    namespace/schema-name     all tools from a schema  (1 slash),   e.g. etherscan/balance
    namespace/tool/name       a single tool            (2 slashes), e.g. etherscan/tool/getBalance
    namespace/selection/name  a named selection                     e.g. core/selection/mvp
    optional prefix source:   pick one schemaFolders[] source       e.g. Production:etherscan/tool/getBalance
      (CLI feature; the source coordinate is not part of the Spec-ID itself)

Shared Lists (v4):
  dev lists list                             List all shared lists
  dev lists show <name>                      Show shared list details
  dev lists add-entry <name> <jsonEntry>     Add an entry to a shared list
  dev lists refs <alias>                     Backward-lookup: who references this alias?

Environment (.env):
  dev env doctor                             Coverage check: which required keys are missing?
  dev env acquire                            Sign-up help for missing providers
  dev env backup                             Snapshot the current .env
  dev env restore <file>                     Restore .env from a backup
  dev env diff <file>                        Compare current .env against a backup (key names only)

Other:
  dev cache <subcommand>                     Manage tool cache
  dev validate-catalog                       Validate a catalog file
  dev skill <subcommand>                     Skill management
  dev catalog <subcommand>                   Catalog management

Run "${cmd} --help" for Tier 1 commands (agent-facing).
`

        process.stdout.write( helpText )
    }
}


export { HelpCommand }
