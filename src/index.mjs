#!/usr/bin/env node
/**
 * FlowMCP — MIT License
 *
 * DISCLAIMER: This code orchestrates calls to third-party APIs. Each API has
 * its own Terms of Services. FlowMCP makes no representation about TOS
 * compliance, data licensing, or fitness for any purpose. Users are solely
 * responsible for reviewing and adhering to each API provider's terms.
 *
 * For more information, see LICENSE.md and DISCLAIMER.md in the repo root.
 */

import { parseArgs } from 'node:util'

import { FlowMcpCli } from './task/FlowMcpCli.mjs'
import { appConfig } from './data/config.mjs'


const args = parseArgs( {
    args: process.argv.slice( 2 ),
    allowPositionals: true,
    strict: false,
    options: {
        'route': { type: 'string' },
        'branch': { type: 'string' },
        'group': { type: 'string' },
        'tools': { type: 'string' },
        'force': { type: 'boolean' },
        'no-cache': { type: 'boolean' },
        'refresh': { type: 'boolean' },
        'file': { type: 'string' },
        'all': { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        'global': { type: 'boolean' },
        'basis': { type: 'string' },
        'yes': { type: 'boolean', short: 'y' },
        'output': { type: 'string' },
        'emit-prompts': { type: 'boolean' },
        'consume-scores': { type: 'string' },
        'on-conflict': { type: 'string' },
        'no-save': { type: 'boolean' },
        'quiet': { type: 'boolean' },
        'help': { type: 'boolean', short: 'h' },
        'strict': { type: 'boolean' },
        'fix-template': { type: 'boolean' },
        'json': { type: 'boolean' },
        'print-signups': { type: 'boolean' },
        'print-guide': { type: 'boolean' },
        'key': { type: 'string' },
        'mode': { type: 'string' },
        'schema': { type: 'string' },
        'only': { type: 'string' },
        'phase': { type: 'string' },
        'run': { type: 'string' },
        'member-source': { type: 'string' },
        'grading-data': { type: 'string' },
        'export-dir': { type: 'string' },
        'max-iterations': { type: 'string' },
        'max-turns': { type: 'string' },
        'with-keys': { type: 'boolean' },
        'set-data-dir': { type: 'string' },
        'set-export-dir': { type: 'string' },
        'target': { type: 'string' },
        'throttle': { type: 'string' },
        'version': { type: 'boolean' }
    }
} )

const { positionals: rawPositionals, values } = args
const isDevPrefix = rawPositionals[ 0 ] === 'dev' && rawPositionals.length >= 2 && rawPositionals[ 1 ] !== '--help'
const positionals = isDevPrefix ? rawPositionals.slice( 1 ) : rawPositionals
const command = positionals[ 0 ]
const schemaPath = positionals[ 1 ]
const cwd = process.cwd()

const output = ( { result } ) => {
    process.stdout.write( JSON.stringify( result, null, 4 ) + '\n' )
}

const isDevHelp = () => {
    return command === 'dev' && ( positionals.length === 1 || positionals[ 1 ] === '--help' || values[ 'help' ] )
}


// ---------------------------------------------------------------------------
// Tree-Literal (Branch/Leaf) — Spec-Kap 22 / context/01.
//
// A leaf does something: { description, execute }. The execute closures
// reproduce the exact args-mapping of the former flat if-chain — business
// logic stays in FlowMcpCli.mjs (no duplication).
//
// A branch is a bag of tools: { description, children, fallback }. The
// fallback runs when no child key matches the sub-command (it reproduces the
// former "Unknown <x> command" / passthrough / allowlist-error behaviour, per
// branch, identically).
//
// isBranch / isLeaf distinguish the node kinds structurally.
// ---------------------------------------------------------------------------

const isBranch = ( node ) => node !== undefined && node[ 'children' ] !== undefined
const isLeaf = ( node ) => node !== undefined && node[ 'execute' ] !== undefined


const cacheBranch = {
    'description': 'Inspect or clear the response cache.',
    'children': {
        'status': {
            'description': 'Show cache namespaces, entry counts and sizes.',
            'execute': async () => {
                const { result } = await FlowMcpCli.cacheStatus()
                output( { result } )
            }
        },
        'clear': {
            'description': 'Clear the cache (optionally a single namespace).',
            'execute': async () => {
                const namespace = positionals[ 2 ] || undefined
                const { result } = await FlowMcpCli.cacheClear( { namespace } )
                output( { result } )
            }
        }
    },
    'fallback': async () => {
        const subCommand = positionals[ 1 ]
        const result = {
            'status': false,
            'error': `Unknown cache command "${subCommand}".`,
            'fix': `Available: ${appConfig[ 'cliCommand' ]} cache status, ${appConfig[ 'cliCommand' ]} cache clear [namespace]`
        }
        output( { result } )
    }
}


const callBranch = {
    'description': 'Call a tool by name, or list the callable tools.',
    'children': {
        'list-tools': {
            'description': 'List all callable tools (optionally filtered by --group).',
            'execute': async () => {
                const group = values[ 'group' ]
                const { result } = await FlowMcpCli.callListTools( { group, cwd } )
                output( { result } )
            }
        }
    },
    'fallback': async () => {
        // passthrough: any non-`list-tools` sub-command is a tool name.
        const toolName = positionals[ 1 ]
        const jsonArgs = positionals[ 2 ] || null
        const group = values[ 'group' ]
        const noCache = values[ 'no-cache' ] || false
        const refresh = values[ 'refresh' ] || false
        const { result } = await FlowMcpCli.callTool( { toolName, jsonArgs, group, cwd, noCache, refresh } )
        output( { result } )
    }
}


const listsBranch = {
    'description': 'Inspect the shared lists and their entries.',
    'children': {
        'add-entry': {
            'description': 'Append a JSON entry to a named shared list.',
            'execute': async () => {
                const listName = positionals[ 2 ]
                const jsonEntry = positionals[ 3 ]
                const { result } = await FlowMcpCli.listsAddEntry( { cwd, listName, jsonEntry } )
                output( { result } )
            }
        },
        'refs': {
            'description': 'Resolve and show the references of an alias.',
            'execute': async () => {
                const alias = positionals[ 2 ]
                const { result } = await FlowMcpCli.listsRefs( { cwd, alias } )
                output( { result } )
            }
        }
    },
    'fallback': async () => {
        const subOrName = positionals[ 1 ] || null
        // passthrough: 'list' shows all, 'show <name>' shows one, or bare name.
        const listName = subOrName === 'list' ? null
            : subOrName === 'show' ? ( positionals[ 2 ] || null )
            : subOrName
        const { result } = await FlowMcpCli.listSharedLists( { listName } )
        output( { result } )
    }
}


const skillBranch = {
    'description': 'Generate an agent skill from a tool definition.',
    'children': {
        'generate': {
            'description': 'Generate a skill for a tool id.',
            'execute': async () => {
                const toolId = positionals[ 2 ]
                const { result } = await FlowMcpCli.generateSkill( { toolId } )
                output( { result } )
            }
        }
    },
    'fallback': async () => {
        const subCommand = positionals[ 1 ]
        const result = {
            'status': false,
            'error': `Unknown skill command "${subCommand}".`,
            'fix': `Available: ${appConfig[ 'cliCommand' ]} skill generate <tool-name>`
        }
        output( { result } )
    }
}


const catalogBranch = {
    'description': 'Build and manage the local tool catalog.',
    'children': {
        'generate': {
            'description': 'Generate the catalog from the configured schema folders.',
            'execute': async () => {
                const { result } = await FlowMcpCli.generateCatalog( { cwd } )
                output( { result } )
            }
        },
        'link': {
            'description': 'Link a named catalog source to a path.',
            'execute': async () => {
                const name = positionals[ 2 ]
                const path = positionals[ 3 ]
                const { result } = await FlowMcpCli.catalogLink( { name, path } )
                output( { result } )
            }
        },
        'unlink': {
            'description': 'Unlink a named catalog source.',
            'execute': async () => {
                const name = positionals[ 2 ]
                const { result } = await FlowMcpCli.catalogUnlink( { name } )
                output( { result } )
            }
        },
        'sources': {
            'description': 'List the linked catalog sources.',
            'execute': async () => {
                const { result } = await FlowMcpCli.catalogSources()
                output( { result } )
            }
        }
    },
    'fallback': async () => {
        const subCommand = positionals[ 1 ]
        const result = {
            'status': false,
            'error': `Unknown catalog command "${subCommand}".`,
            'fix': `Available: ${appConfig[ 'cliCommand' ]} catalog generate | link <name> <path> | unlink <name> | sources`
        }
        output( { result } )
    }
}


const promptBranch = {
    'description': 'Manage and inspect shared prompts.',
    'children': {
        'list': {
            'description': 'List all available prompts.',
            'execute': async () => {
                const { result } = await FlowMcpCli.promptList( { cwd } )
                output( { result } )
            }
        },
        'search': {
            'description': 'Search prompts by query.',
            'execute': async () => {
                const query = positionals[ 2 ]
                const { result } = await FlowMcpCli.promptSearch( { query, cwd } )
                output( { result } )
            }
        },
        'show': {
            'description': 'Show a single prompt by group/name reference.',
            'execute': async () => {
                const ref = positionals[ 2 ] || ''
                const slashIndex = ref.indexOf( '/' )
                const group = slashIndex > 0 ? ref.slice( 0, slashIndex ) : undefined
                const name = slashIndex > 0 ? ref.slice( slashIndex + 1 ) : undefined
                const { result } = await FlowMcpCli.promptShow( { group, name, cwd } )
                output( { result } )
            }
        },
        'add': {
            'description': 'Add a prompt from a --file into a group.',
            'execute': async () => {
                const group = positionals[ 2 ]
                const name = positionals[ 3 ]
                const file = values[ 'file' ]
                const { result } = await FlowMcpCli.promptAdd( { group, name, file, cwd } )
                output( { result } )
            }
        },
        'remove': {
            'description': 'Remove a prompt from a group.',
            'execute': async () => {
                const group = positionals[ 2 ]
                const name = positionals[ 3 ]
                const { result } = await FlowMcpCli.promptRemove( { group, name, cwd } )
                output( { result } )
            }
        }
    },
    'fallback': async () => {
        // bare `prompt` (or unknown sub-command) prints the general help.
        await FlowMcpCli.help( { cwd } )
    }
}


const selectionBranch = {
    'description': 'Inspect named selection subsets.',
    'children': {
        'list': {
            'description': 'List all selections.',
            'execute': async () => {
                const { result } = await FlowMcpCli.selectionList( { cwd } )
                output( { result } )
            }
        },
        'show': {
            'description': 'Show a single selection by name.',
            'execute': async () => {
                const name = positionals[ 2 ]
                const { result } = await FlowMcpCli.selectionShow( { cwd, name } )
                output( { result } )
            }
        },
        'validate': {
            'description': 'Validate a selection file at a path.',
            'execute': async () => {
                const selectionPath = positionals[ 2 ]
                const { result } = await FlowMcpCli.selectionValidate( { cwd, 'path': selectionPath } )
                output( { result } )
            }
        }
    },
    'fallback': async () => {
        const subCommand = positionals[ 1 ]
        const result = {
            'status': false,
            'error': `Unknown selection command "${subCommand}".`,
            'fix': `Available: ${appConfig[ 'cliCommand' ]} dev selection list, ${appConfig[ 'cliCommand' ]} dev selection show <name>, ${appConfig[ 'cliCommand' ]} dev selection validate <path>`
        }
        output( { result } )
    }
}


const allowlistBranch = {
    'description': 'Manage the npm-install allowlist.',
    'children': {
        'add': {
            'description': 'Add a library to the allowlist.',
            'execute': async () => {
                const library = positionals[ 2 ]
                const { result } = await FlowMcpCli.allowlist( { cwd, 'action': 'add', library } )
                output( { result } )
            }
        },
        'remove': {
            'description': 'Remove a library from the allowlist.',
            'execute': async () => {
                const library = positionals[ 2 ]
                const { result } = await FlowMcpCli.allowlist( { cwd, 'action': 'remove', library } )
                output( { result } )
            }
        },
        'list': {
            'description': 'List the allowlisted libraries.',
            'execute': async () => {
                const { result } = await FlowMcpCli.allowlist( { cwd, 'action': 'list', 'library': null } )
                output( { result } )
            }
        }
    },
    'fallback': async () => {
        const result = {
            'status': false,
            'error': 'Missing or unknown allowlist sub-command.',
            'fix': `Use: ${appConfig[ 'cliCommand' ]} dev allowlist add <library>, ${appConfig[ 'cliCommand' ]} dev allowlist remove <library>, or ${appConfig[ 'cliCommand' ]} dev allowlist list`
        }
        output( { result } )
    }
}


const envBranch = {
    'description': 'Diagnose and manage the environment-variable keys.',
    'children': {
        'doctor': {
            'description': 'Coverage check — which keys are missing.',
            'execute': async () => {
                const schema = values[ 'schema' ] || null
                const strict = values[ 'strict' ] || false
                const fixTemplate = values[ 'fix-template' ] || false
                const json = values[ 'json' ] || false
                const printSignups = values[ 'print-signups' ] || false
                const { result } = await FlowMcpCli.devEnvDoctor( { schema, strict, fixTemplate, json, printSignups, cwd } )
                output( { result } )
            }
        },
        'acquire': {
            'description': 'Sign-up help (step-by-step per provider).',
            'execute': async () => {
                const key = values[ 'key' ] || null
                const mode = values[ 'mode' ] || null
                const printGuide = values[ 'print-guide' ] || false
                const json = values[ 'json' ] || false
                const { result } = await FlowMcpCli.devEnvAcquire( { key, mode, printGuide, json, cwd } )
                output( { result } )
            }
        },
        'backup': {
            'description': 'Snapshot the current env keys.',
            'execute': async () => {
                const { result } = await FlowMcpCli.devEnvBackup( { cwd } )
                output( { result } )
            }
        },
        'restore': {
            'description': 'Restore env keys from a backup file.',
            'execute': async () => {
                const file = positionals[ 2 ]
                const { result } = await FlowMcpCli.devEnvRestore( { file, cwd } )
                output( { result } )
            }
        },
        'diff': {
            'description': 'Diff the current env against a backup file.',
            'execute': async () => {
                const file = positionals[ 2 ]
                const { result } = await FlowMcpCli.devEnvDiff( { file, cwd } )
                output( { result } )
            }
        }
    },
    'fallback': async () => {
        const result = {
            'status': false,
            'error': 'Missing or unknown env sub-command.',
            'fix': `Use: ${appConfig[ 'cliCommand' ]} dev env doctor | acquire | backup | restore <file> | diff <file>`
        }
        output( { result } )
    }
}


const resourceBranch = {
    'description': 'Create or migrate MCP resource schemas.',
    'children': {
        'create': {
            'description': 'Create a resource schema at a path.',
            'execute': async () => {
                const basis = values[ 'basis' ] || 'flowmcp'
                const autoConfirm = values[ 'yes' ] || false
                const targetPath = positionals[ 2 ]
                const { result } = await FlowMcpCli.resourceCreate( { 'schemaPath': targetPath, cwd, basis, autoConfirm } )
                output( { result } )
            }
        },
        'migrate': {
            'description': 'Migrate existing resource schemas.',
            'execute': async () => {
                const basis = values[ 'basis' ] || 'flowmcp'
                const autoConfirm = values[ 'yes' ] || false
                const dryRun = values[ 'dry-run' ] || false
                const { result } = await FlowMcpCli.resourceMigrate( { cwd, basis, dryRun, autoConfirm } )
                output( { result } )
            }
        }
    },
    'fallback': async () => {
        const subCommand = positionals[ 1 ]
        const result = {
            'status': false,
            'error': `Unknown resource command "${subCommand}".`,
            'fix': `Available: ${appConfig[ 'cliCommand' ]} resource create <schema-path>, ${appConfig[ 'cliCommand' ]} resource migrate`
        }
        output( { result } )
    }
}


// `grading` keeps its own dispatch as a single leaf-style execute: the
// sub-command set is allowlist-guarded (alias-normalized BEFORE the check),
// the arg-extraction is shared across all sub-commands, and a few sub-commands
// have bespoke stdout handling. Reproducing that block verbatim preserves
// behavior 1:1; splitting it into children would duplicate the shared
// arg-extraction and risk drift.
const gradingBranch = {
    'description': 'Run the deterministic + non-deterministic grading flow.',
    'execute': async () => {
        // PRD-001 / PRD-010 — normalize the short aliases to their full command
        // names BEFORE the allowlist check (no silent default: an unknown
        // sub-command still errors). `det` -> deterministic, `nondet` ->
        // non-deterministic.
        const rawSubCommand = positionals[ 1 ]
        const aliasMap = { 'det': 'deterministic', 'nondet': 'non-deterministic' }
        const subCommand = aliasMap[ rawSubCommand ] !== undefined ? aliasMap[ rawSubCommand ] : rawSubCommand
        // Memo 102 Phase 2 / PRD-006 — `import` removed: the grading run reads the
        // schema live from schemaFolders[] (no internal importer left).
        // Memo 102 Phase 3 / PRD-010 — `non-deterministic` (alias `nondet`) is the
        // non-deterministic LLM-scoring path (emit + consume), formerly only reached
        // via `run --emit-prompts` / `run --consume-scores`. `run` is kept as the
        // internal mechanic (Never-delete-legacy).
        // Memo 112 Phase 6 — `finalize` (P6.1) is the Austritts-Rollup (RebuildIndex
        // -> ProviderProof) + Recommendation; `plan` (P6.2) is the read-only
        // Eintritts-Worklist (Staleness via schemaHash). Both report the SAME worklist.
        const validSubCommands = [ 'deterministic', 'non-deterministic', 'reload', 'skill', 'export', 'run', 'state', 'worklist', 'doctor', 'config', 'finalize', 'plan' ]

        if( !subCommand || !validSubCommands.includes( subCommand ) ) {
            const result = {
                'status': false,
                'error': 'Missing or unknown grading sub-command.',
                'fix': `Use: ${appConfig[ 'cliCommand' ]} grading deterministic <id> [--force] | non-deterministic <ns|selection> --emit-prompts | --consume-scores <path> | reload <ns|ns/schema> | skill <ns|selection> | export <ns|selection> | state <ns|selection> | worklist <ns> | doctor <ns> | plan <ns> [--target <grade>] | finalize <ns> [--target <grade>] | config [--set-data-dir <path>] [--set-export-dir <path>]`
            }
            output( { result } )

            return
        }

        const target = positionals[ 2 ]
        const phase = values[ 'phase' ] === undefined ? null : values[ 'phase' ]
        const runId = values[ 'run' ] === undefined ? null : values[ 'run' ]
        const emitPrompts = values[ 'emit-prompts' ] === true
        const consumeScores = values[ 'consume-scores' ] === undefined ? null : values[ 'consume-scores' ]
        const onConflict = values[ 'on-conflict' ] === undefined ? null : values[ 'on-conflict' ]
        const memberSource = values[ 'member-source' ] === undefined ? null : values[ 'member-source' ]
        const gradingDataDir = values[ 'grading-data' ] === undefined ? null : values[ 'grading-data' ]
        const gradingExportDir = values[ 'export-dir' ] === undefined ? null : values[ 'export-dir' ]
        const maxIterations = values[ 'max-iterations' ] === undefined ? null : values[ 'max-iterations' ]
        const maxTurns = values[ 'max-turns' ] === undefined ? null : values[ 'max-turns' ]
        const withKeys = values[ 'with-keys' ] === true
        const only = values[ 'only' ] === undefined ? null : values[ 'only' ]
        const json = values[ 'json' ] === true
        // PRD-012 (Memo 102 Phase 4): the single opt-out flag --no-save maps to the
        // single internal switch dryRun. When set, grading performs but writes
        // NOTHING to the island (no pretest persist, no index/grade/state).
        const dryRun = values[ 'no-save' ] === true
        // PRD-2.2 — --force bypasses the read-cache (PRD-2.1): re-fetch the test
        // data instead of reusing the persisted test-N.json.
        const force = values[ 'force' ] === true
        // PRD-4.1 — --quiet silences the stderr progress; stdout JSON is unaffected.
        const quiet = values[ 'quiet' ] === true
        // Memo 112 Phase 6 / P6.5 — optional quality lens for plan/finalize. Default
        // null = pure coverage/staleness. Does NOT lower the quality bar.
        const targetGrade = values[ 'target' ] === undefined ? null : values[ 'target' ]
        // Memo 115 follow-up — --throttle <ms> spaces live data-pretest fetches
        // (opt-in, default 0 = no throttle). Lets rate-limited multi-tool schemas
        // (e.g. taapi/coreac/footballdata) clear the per-burst provider limit.
        const throttleMs = values[ 'throttle' ] === undefined ? 0 : Number( values[ 'throttle' ] )

        if( subCommand === 'deterministic' ) {
            const { result } = await FlowMcpCli.gradingDeterministic( { cwd, target, gradingDataDir, gradingExportDir, withKeys, only, dryRun, force, quiet, json, throttleMs } )
            output( { result } )
            // PRD-4.2 — a concise human summary to STDERR (not on stdout, so a piped
            // `... | jq` stays pure machine JSON). Suppressed by --quiet and by --json
            // (pure machine mode).
            FlowMcpCli.printDeterministicSummary( { result, quiet, json } )

            return
        }

        if( subCommand === 'reload' ) {
            // PRD-2.3 — re-fetch + rewrite the persisted test-N.json only (force),
            // decoupled from grading: no _gradings/grade.json writes.
            const { result } = await FlowMcpCli.gradingReload( { cwd, target, gradingDataDir, withKeys, quiet, json } )
            output( { result } )

            return
        }

        if( subCommand === 'skill' ) {
            // Print the emitted Emit-Skill TEXT directly. Default: raw text to stdout
            // (pipe/redirect ready). --json: the structured envelope. An error always
            // prints the JSON envelope so failures stay machine-readable.
            const { result } = await FlowMcpCli.gradingSkill( { cwd, target, gradingDataDir } )
            if( result.status === true && json !== true ) {
                process.stdout.write( result.skill + '\n' )
            } else {
                output( { result } )
            }

            return
        }

        if( subCommand === 'export' ) {
            const { result } = await FlowMcpCli.gradingExport( { cwd, target, onConflict, gradingDataDir, gradingExportDir, json } )
            output( { result } )

            return
        }

        if( subCommand === 'run' || subCommand === 'non-deterministic' ) {
            // PRD-010 — `non-deterministic` (alias `nondet`) is the user-facing name
            // for the non-deterministic LLM-scoring path; `run` stays as the internal
            // mechanic. Both share the exact same gradingRun() implementation (no
            // code drift). The mode (--emit-prompts | --consume-scores) is still
            // explicit — no silent default.
            const { result } = await FlowMcpCli.gradingRun( { cwd, target, phase, runId, emitPrompts, consumeScores, onConflict, memberSource, gradingDataDir, gradingExportDir, maxIterations, maxTurns, withKeys, dryRun, quiet, json } )
            // The planned round-trip: `--emit-prompts` (without --json) RETURNS the
            // self-contained Emit-Skill TEXT directly — the thing you hand to a
            // subagent — so no jq/field-digging is needed. The machine envelope stays
            // available via --json (the harness already passes it). --consume-scores
            // and every error keep the JSON envelope so failures stay machine-readable.
            if( emitPrompts === true && json !== true && result.status === true && typeof result.emitSkill === 'string' ) {
                process.stdout.write( result.emitSkill + '\n' )
            } else {
                output( { result } )
            }

            return
        }

        if( subCommand === 'state' ) {
            const { result } = await FlowMcpCli.gradingState( { cwd, target, gradingDataDir, json } )
            output( { result } )

            return
        }

        if( subCommand === 'worklist' ) {
            const { result } = await FlowMcpCli.gradingWorklist( { cwd, target, gradingDataDir, json } )
            output( { result } )

            return
        }

        if( subCommand === 'doctor' ) {
            const { result } = await FlowMcpCli.gradingDoctor( { cwd, target, gradingDataDir, json } )
            output( { result } )

            return
        }

        if( subCommand === 'config' ) {
            const setDataDir = values[ 'set-data-dir' ] === undefined ? null : values[ 'set-data-dir' ]
            const setExportDir = values[ 'set-export-dir' ] === undefined ? null : values[ 'set-export-dir' ]
            const { result } = await FlowMcpCli.gradingConfig( { cwd, setDataDir, setExportDir, json } )
            output( { result } )

            return
        }

        if( subCommand === 'finalize' ) {
            // Memo 112 P6.1 — Austritts-Rollup + Recommendation (same worklist as `plan`).
            const { result } = await FlowMcpCli.gradingFinalize( { cwd, target, gradingDataDir, gradingExportDir, targetGrade, json } )
            output( { result } )

            return
        }

        if( subCommand === 'plan' ) {
            // Memo 112 P6.2 — read-only Eintritts-Worklist via Staleness (schemaHash).
            const { result } = await FlowMcpCli.gradingPlan( { cwd, target, gradingDataDir, targetGrade, json } )
            output( { result } )

            return
        }
    }
}


// Root branch — every top-level command is a child. Leaves wrap a single
// FlowMcpCli method; branches group sub-commands.
const tree = {
    'description': `${appConfig[ 'cliCommand' ]} — agent-facing CLI (JSON I/O, non-interactive).`,
    'children': {
        'how-to': {
            'description': 'Print the getting-started guide.',
            'execute': async () => {
                await FlowMcpCli.howTo( { cwd } )
            }
        },
        'init': {
            'description': 'Interactive first-run setup (the only interactive command).',
            'execute': async () => {
                await FlowMcpCli.init( { cwd } )
            }
        },
        'search': {
            'description': 'Search the available tools by free-text query.',
            'execute': async () => {
                const query = positionals.slice( 1 ).join( ' ' ) || undefined
                const { result } = await FlowMcpCli.search( { query } )
                output( { result } )
            }
        },
        // Memo 099 Kap 5 — `add`/`reload`/`remove` removed. All tools from the
        // configured schemaFolders are immediately available via search/list/call.
        'list': {
            'description': 'List all available tools.',
            'execute': async () => {
                const { result } = await FlowMcpCli.list( { cwd } )
                output( { result } )
            }
        },
        'lists': listsBranch,
        'call': callBranch,
        'cache': cacheBranch,
        'status': {
            'description': 'Show the CLI / config status.',
            'execute': async () => {
                const { result } = await FlowMcpCli.status( { cwd } )
                output( { result } )
            }
        },
        // Memo 149 Strang D — `flowmcp doctor`: structural health check over
        // schemaFolders[], reported by error code (exits 1 on error). `flowmcp version`
        // (also `flowmcp --version`) prints the CLI name + version.
        'doctor': {
            'description': 'Structural health check over schemaFolders[], reported by error code (exits 1 on error).',
            'execute': async () => {
                const json = values[ 'json' ] === true
                const { result } = await FlowMcpCli.doctor( { cwd } )
                output( { result } )
                FlowMcpCli.printDoctorSummary( { result, json } )

                if( result[ 'status' ] !== true ) {
                    process.exit( 1 )
                }
            }
        },
        'version': {
            'description': 'Print the CLI name and version.',
            'execute': async () => {
                const { result } = await FlowMcpCli.version()
                output( { result } )
            }
        },
        'run': {
            'description': 'Run the configured group (exits 1 on failure).',
            'execute': async () => {
                const group = values[ 'group' ]
                const { result } = await FlowMcpCli.run( { group, cwd } )

                if( !result[ 'status' ] ) {
                    output( { result } )
                    process.exit( 1 )
                }
            }
        },
        // Memo 099 Kap 7 — `import`/`import-registry` removed (no registry/internet sync).
        // Add a schema folder by editing schemaFolders[] in ~/.flowmcp/config.json;
        // clone repos yourself with `gh repo clone`.
        'import-agent': {
            'description': 'Import an agent definition by name.',
            'execute': async () => {
                const agentName = positionals[ 1 ]
                const { result } = await FlowMcpCli.importAgent( { agentName, cwd } )
                output( { result } )
            }
        },
        'skill': skillBranch,
        'catalog': catalogBranch,
        'validate-catalog': {
            'description': 'Validate a catalog directory.',
            'execute': async () => {
                const catalogDir = positionals[ 1 ]
                const { result } = await FlowMcpCli.validateCatalog( { catalogDir, cwd } )
                output( { result } )
            }
        },
        // Memo 099 Kap 7 — `update` removed (no registry polling / internet sync).
        'schemas': {
            'description': 'List the configured schema namespaces.',
            'execute': async () => {
                const { result } = await FlowMcpCli.schemas()
                output( { result } )
            }
        },
        // Memo 099 Kap 5 — `group` removed (it was bound to the project-local config).
        // `selection` remains for named display/filter subsets.
        'prompt': promptBranch,
        'migrate': {
            'description': 'Migrate schema(s) to the current format.',
            'execute': async () => {
                const targetPath = positionals[ 1 ]
                const all = values[ 'all' ] || false
                const dryRun = values[ 'dry-run' ] || false
                const { result } = await FlowMcpCli.migrate( { 'schemaPath': targetPath, cwd, all, dryRun } )
                output( { result } )
            }
        },
        'migrate-config': {
            'description': 'Migrate the config file to the current format.',
            'execute': async () => {
                const isGlobal = values[ 'global' ] || false
                const dryRun = values[ 'dry-run' ] || false
                const { result } = await FlowMcpCli.migrateConfig( { cwd, isGlobal, dryRun } )
                output( { result } )
            }
        },
        'selection': selectionBranch,
        'grading': gradingBranch,
        'allowlist': allowlistBranch,
        'env': envBranch,
        'resource': resourceBranch,
        // Memo 119 Kap 7 (F3) — `validate` was renamed to `schema-check` to make the
        // offline structural-only nature explicit (vs. `grading deterministic`, which
        // also runs the live data pretest). The old `validate` name is REMOVED, no
        // deprecated alias (deliberate breaking change).
        'schema-check': {
            'description': 'Offline structural-only schema check.',
            'execute': async () => {
                const group = values[ 'group' ]
                const { result } = await FlowMcpCli.validate( { schemaPath, cwd, group } )
                output( { result } )
            }
        }
        // Memo 102 / PRD-002 — `dev test` (project/user/single) removed. Its PASS
        // criterion (HTTP 200 only) is a strict subset of the deterministic grading
        // pretest (HTTP 200 + non-empty data). Use `grading deterministic <id>`
        // instead; the v4-primitive view lives on its --only flag.
    }
}


// ---------------------------------------------------------------------------
// describe() — tree-derived help tree (Spec-Kap 22). Renders the root branch
// and, one level down, every child with its description. Used by --describe.
// ---------------------------------------------------------------------------

const describeNode = ( { name, node, depth } ) => {
    const indent = '  '.repeat( depth )
    const kind = isBranch( node ) ? ( isLeaf( node ) ? 'leaf+branch' : 'branch' ) : 'leaf'
    const head = `${indent}${name} [${kind}] — ${node[ 'description' ]}`
    const childLines = isBranch( node )
        ? Object.keys( node[ 'children' ] )
            .map( ( childName ) => describeNode( { 'name': childName, 'node': node[ 'children' ][ childName ], 'depth': depth + 1 } ) )
        : []

    return [ head, ...childLines ].join( '\n' )
}

const describe = () => {
    return describeNode( { 'name': appConfig[ 'cliCommand' ], 'node': tree, 'depth': 0 } )
}


// ---------------------------------------------------------------------------
// Generic dispatcher — walks the tree by command/subCommand positionals and
// calls the matched leaf execute. A node that is both branch and leaf (its
// sub-command set is allowlist-guarded internally, e.g. `grading`) runs its
// own execute. A branch with a matching child runs that child; otherwise it
// runs its fallback. Returns true if the path was handled, false otherwise.
// No for/while — array methods / direct indexing only.
// ---------------------------------------------------------------------------

const dispatch = async ( { node, depth } ) => {
    if( node === undefined ) {
        return false
    }

    // A branch+leaf hybrid (own execute AND children) handles its own
    // sub-command allowlist internally — run its execute.
    if( isBranch( node ) && isLeaf( node ) ) {
        await node[ 'execute' ]()

        return true
    }

    if( isBranch( node ) ) {
        const subCommand = positionals[ depth + 1 ]
        const child = subCommand !== undefined ? node[ 'children' ][ subCommand ] : undefined

        if( child !== undefined ) {
            return await dispatch( { 'node': child, 'depth': depth + 1 } )
        }

        // No matching child: run the branch fallback (passthrough / error).
        await node[ 'fallback' ]()

        return true
    }

    if( isLeaf( node ) ) {
        await node[ 'execute' ]()

        return true
    }

    return false
}


const runCommand = async () => {
    if( command === 'dev' && isDevHelp() ) {
        FlowMcpCli.devHelp()

        return true
    }

    const node = tree[ 'children' ][ command ]

    return await dispatch( { node, 'depth': 0 } )
}

const main = async () => {
    // Memo 149 Strang D (F5=A) — `flowmcp --version` with no command prints the stamp.
    if( values[ 'version' ] === true && !command ) {
        const { result } = await FlowMcpCli.version()
        output( { result } )

        return
    }

    if( values[ 'help' ] || !command ) {
        await FlowMcpCli.help( { cwd } )

        return
    }

    const handled = await runCommand()
    if( handled ) {
        return
    }

    const result = {
        'status': false,
        'error': `Unknown command "${command}".`,
        'fix': `Run: ${appConfig[ 'cliCommand' ]} --help`
    }

    output( { result } )
}

main()
    .catch( ( error ) => {
        if( error.name === 'ExitPromptError' ) {
            process.exit( 0 )
        }

        const result = { 'status': false, 'error': error.message }
        process.stdout.write( JSON.stringify( result, null, 4 ) + '\n' )
        process.exit( 1 )
    } )
