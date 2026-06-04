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
        'member-source': { type: 'string' },
        'grading-data': { type: 'string' },
        'export-dir': { type: 'string' },
        'max-iterations': { type: 'string' },
        'with-keys': { type: 'boolean' },
        'set-data-dir': { type: 'string' },
        'set-export-dir': { type: 'string' }
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


const runCommand = async () => {
    if( command === 'how-to' ) {
        await FlowMcpCli.howTo( { cwd } )

        return true
    }

    if( command === 'dev' && isDevHelp() ) {
        FlowMcpCli.devHelp()

        return true
    }

    if( command === 'init' ) {
        await FlowMcpCli.init( { cwd } )

        return true
    }

    if( command === 'search' ) {
        const query = positionals.slice( 1 ).join( ' ' ) || undefined
        const { result } = await FlowMcpCli.search( { query } )
        output( { result } )

        return true
    }

    // Memo 099 Kap 5 — `add`/`reload`/`remove` removed. All tools from the
    // configured schemaFolders are immediately available via search/list/call.

    if( command === 'list' ) {
        const { result } = await FlowMcpCli.list( { cwd } )
        output( { result } )

        return true
    }

    if( command === 'lists' ) {
        const subOrName = positionals[ 1 ] || null

        if( subOrName === 'add-entry' ) {
            const listName = positionals[ 2 ]
            const jsonEntry = positionals[ 3 ]
            const { result } = await FlowMcpCli.listsAddEntry( { cwd, listName, jsonEntry } )
            output( { result } )

            return true
        }

        if( subOrName === 'refs' ) {
            const alias = positionals[ 2 ]
            const { result } = await FlowMcpCli.listsRefs( { cwd, alias } )
            output( { result } )

            return true
        }

        // passthrough: 'list' shows all, 'show <name>' shows one, or bare name
        const listName = subOrName === 'list' ? null
            : subOrName === 'show' ? ( positionals[ 2 ] || null )
            : subOrName
        const { result } = await FlowMcpCli.listSharedLists( { listName } )
        output( { result } )

        return true
    }

    if( command === 'call' ) {
        const subCommand = positionals[ 1 ]

        if( subCommand === 'list-tools' ) {
            const group = values[ 'group' ]
            const { result } = await FlowMcpCli.callListTools( { group, cwd } )
            output( { result } )

            return true
        }

        const toolName = subCommand
        const jsonArgs = positionals[ 2 ] || null
        const group = values[ 'group' ]
        const noCache = values[ 'no-cache' ] || false
        const refresh = values[ 'refresh' ] || false
        const { result } = await FlowMcpCli.callTool( { toolName, jsonArgs, group, cwd, noCache, refresh } )
        output( { result } )

        return true
    }

    if( command === 'cache' ) {
        const subCommand = positionals[ 1 ]

        if( subCommand === 'status' ) {
            const { result } = await FlowMcpCli.cacheStatus()
            output( { result } )

            return true
        }

        if( subCommand === 'clear' ) {
            const namespace = positionals[ 2 ] || undefined
            const { result } = await FlowMcpCli.cacheClear( { namespace } )
            output( { result } )

            return true
        }

        const result = {
            'status': false,
            'error': `Unknown cache command "${subCommand}".`,
            'fix': `Available: ${appConfig[ 'cliCommand' ]} cache status, ${appConfig[ 'cliCommand' ]} cache clear [namespace]`
        }
        output( { result } )

        return true
    }

    if( command === 'status' ) {
        const { result } = await FlowMcpCli.status( { cwd } )
        output( { result } )

        return true
    }

    if( command === 'run' ) {
        const group = values[ 'group' ]
        const { result } = await FlowMcpCli.run( { group, cwd } )

        if( !result[ 'status' ] ) {
            output( { result } )
            process.exit( 1 )
        }

        return true
    }

    // Memo 099 Kap 7 — `import`/`import-registry` removed (no registry/internet sync).
    // Add a schema folder by editing schemaFolders[] in ~/.flowmcp/config.json;
    // clone repos yourself with `gh repo clone`.

    if( command === 'import-agent' ) {
        const agentName = positionals[ 1 ]
        const { result } = await FlowMcpCli.importAgent( { agentName, cwd } )
        output( { result } )

        return true
    }

    if( command === 'skill' ) {
        const subCommand = positionals[ 1 ]

        if( subCommand === 'generate' ) {
            const toolId = positionals[ 2 ]
            const { result } = await FlowMcpCli.generateSkill( { toolId } )
            output( { result } )

            return true
        }

        const result = {
            'status': false,
            'error': `Unknown skill command "${subCommand}".`,
            'fix': `Available: ${appConfig[ 'cliCommand' ]} skill generate <tool-name>`
        }
        output( { result } )

        return true
    }

    if( command === 'catalog' ) {
        const subCommand = positionals[ 1 ]

        if( subCommand === 'generate' ) {
            const { result } = await FlowMcpCli.generateCatalog( { cwd } )
            output( { result } )

            return true
        }

        if( subCommand === 'link' ) {
            const name = positionals[ 2 ]
            const path = positionals[ 3 ]
            const { result } = await FlowMcpCli.catalogLink( { name, path } )
            output( { result } )

            return true
        }

        if( subCommand === 'unlink' ) {
            const name = positionals[ 2 ]
            const { result } = await FlowMcpCli.catalogUnlink( { name } )
            output( { result } )

            return true
        }

        if( subCommand === 'sources' ) {
            const { result } = await FlowMcpCli.catalogSources()
            output( { result } )

            return true
        }

        const result = {
            'status': false,
            'error': `Unknown catalog command "${subCommand}".`,
            'fix': `Available: ${appConfig[ 'cliCommand' ]} catalog generate | link <name> <path> | unlink <name> | sources`
        }
        output( { result } )

        return true
    }

    if( command === 'validate-catalog' ) {
        const catalogDir = positionals[ 1 ]
        const { result } = await FlowMcpCli.validateCatalog( { catalogDir, cwd } )
        output( { result } )

        return true
    }

    // Memo 099 Kap 7 — `update` removed (no registry polling / internet sync).

    if( command === 'schemas' ) {
        const { result } = await FlowMcpCli.schemas()
        output( { result } )

        return true
    }

    // Memo 099 Kap 5 — `group` removed (it was bound to the project-local config).
    // `selection` remains for named display/filter subsets.

    if( command === 'prompt' ) {
        const subCommand = positionals[ 1 ]

        if( subCommand === 'list' ) {
            const { result } = await FlowMcpCli.promptList( { cwd } )
            output( { result } )

            return true
        }

        if( subCommand === 'search' ) {
            const query = positionals[ 2 ]
            const { result } = await FlowMcpCli.promptSearch( { query, cwd } )
            output( { result } )

            return true
        }

        if( subCommand === 'show' ) {
            const ref = positionals[ 2 ] || ''
            const slashIndex = ref.indexOf( '/' )
            const group = slashIndex > 0 ? ref.slice( 0, slashIndex ) : undefined
            const name = slashIndex > 0 ? ref.slice( slashIndex + 1 ) : undefined
            const { result } = await FlowMcpCli.promptShow( { group, name, cwd } )
            output( { result } )

            return true
        }

        if( subCommand === 'add' ) {
            const group = positionals[ 2 ]
            const name = positionals[ 3 ]
            const file = values[ 'file' ]
            const { result } = await FlowMcpCli.promptAdd( { group, name, file, cwd } )
            output( { result } )

            return true
        }

        if( subCommand === 'remove' ) {
            const group = positionals[ 2 ]
            const name = positionals[ 3 ]
            const { result } = await FlowMcpCli.promptRemove( { group, name, cwd } )
            output( { result } )

            return true
        }

        await FlowMcpCli.help( { cwd } )

        return true
    }

    if( command === 'migrate' ) {
        const targetPath = positionals[ 1 ]
        const all = values[ 'all' ] || false
        const dryRun = values[ 'dry-run' ] || false
        const { result } = await FlowMcpCli.migrate( { 'schemaPath': targetPath, cwd, all, dryRun } )
        output( { result } )

        return true
    }

    if( command === 'migrate-config' ) {
        const isGlobal = values[ 'global' ] || false
        const dryRun = values[ 'dry-run' ] || false
        const { result } = await FlowMcpCli.migrateConfig( { cwd, isGlobal, dryRun } )
        output( { result } )

        return true
    }

    if( command === 'selection' ) {
        const subCommand = positionals[ 1 ]

        if( subCommand === 'list' ) {
            const { result } = await FlowMcpCli.selectionList( { cwd } )
            output( { result } )

            return true
        }

        if( subCommand === 'show' ) {
            const name = positionals[ 2 ]
            const { result } = await FlowMcpCli.selectionShow( { cwd, name } )
            output( { result } )

            return true
        }

        if( subCommand === 'validate' ) {
            const selectionPath = positionals[ 2 ]
            const { result } = await FlowMcpCli.selectionValidate( { cwd, 'path': selectionPath } )
            output( { result } )

            return true
        }

        const result = {
            'status': false,
            'error': `Unknown selection command "${subCommand}".`,
            'fix': `Available: ${appConfig[ 'cliCommand' ]} dev selection list, ${appConfig[ 'cliCommand' ]} dev selection show <name>, ${appConfig[ 'cliCommand' ]} dev selection validate <path>`
        }
        output( { result } )

        return true
    }

    if( command === 'grading' ) {
        // PRD-001 — normalize the `det` alias to `deterministic` BEFORE the
        // allowlist check (no silent default: an unknown sub-command still errors).
        const rawSubCommand = positionals[ 1 ]
        const subCommand = rawSubCommand === 'det' ? 'deterministic' : rawSubCommand
        // Memo 102 Phase 2 / PRD-006 — `import` removed: the grading run reads the
        // schema live from schemaFolders[] (no internal importer left).
        const validSubCommands = [ 'deterministic', 'export', 'run', 'state', 'worklist', 'doctor', 'config' ]

        if( !subCommand || !validSubCommands.includes( subCommand ) ) {
            const result = {
                'status': false,
                'error': 'Missing or unknown grading sub-command.',
                'fix': `Use: ${appConfig[ 'cliCommand' ]} grading deterministic <id> | export <ns|selection> | run <ns|selection> | state <ns|selection> | worklist <ns> | doctor <ns> | config [--set-data-dir <path>] [--set-export-dir <path>]`
            }
            output( { result } )

            return true
        }

        const target = positionals[ 2 ]
        const phase = values[ 'phase' ] === undefined ? null : values[ 'phase' ]
        const emitPrompts = values[ 'emit-prompts' ] === true
        const consumeScores = values[ 'consume-scores' ] === undefined ? null : values[ 'consume-scores' ]
        const onConflict = values[ 'on-conflict' ] === undefined ? null : values[ 'on-conflict' ]
        const memberSource = values[ 'member-source' ] === undefined ? null : values[ 'member-source' ]
        const gradingDataDir = values[ 'grading-data' ] === undefined ? null : values[ 'grading-data' ]
        const gradingExportDir = values[ 'export-dir' ] === undefined ? null : values[ 'export-dir' ]
        const maxIterations = values[ 'max-iterations' ] === undefined ? null : values[ 'max-iterations' ]
        const withKeys = values[ 'with-keys' ] === true
        const only = values[ 'only' ] === undefined ? null : values[ 'only' ]
        const json = values[ 'json' ] === true

        if( subCommand === 'deterministic' ) {
            const { result } = await FlowMcpCli.gradingDeterministic( { cwd, target, gradingDataDir, withKeys, only, json } )
            output( { result } )

            return true
        }

        if( subCommand === 'export' ) {
            const { result } = await FlowMcpCli.gradingExport( { cwd, target, onConflict, gradingDataDir, gradingExportDir, json } )
            output( { result } )

            return true
        }

        if( subCommand === 'run' ) {
            const { result } = await FlowMcpCli.gradingRun( { cwd, target, phase, emitPrompts, consumeScores, onConflict, memberSource, gradingDataDir, gradingExportDir, maxIterations, withKeys, json } )
            output( { result } )

            return true
        }

        if( subCommand === 'state' ) {
            const { result } = await FlowMcpCli.gradingState( { cwd, target, gradingDataDir, json } )
            output( { result } )

            return true
        }

        if( subCommand === 'worklist' ) {
            const { result } = await FlowMcpCli.gradingWorklist( { cwd, target, gradingDataDir, json } )
            output( { result } )

            return true
        }

        if( subCommand === 'doctor' ) {
            const { result } = await FlowMcpCli.gradingDoctor( { cwd, target, gradingDataDir, json } )
            output( { result } )

            return true
        }

        if( subCommand === 'config' ) {
            const setDataDir = values[ 'set-data-dir' ] === undefined ? null : values[ 'set-data-dir' ]
            const setExportDir = values[ 'set-export-dir' ] === undefined ? null : values[ 'set-export-dir' ]
            const { result } = await FlowMcpCli.gradingConfig( { cwd, setDataDir, setExportDir, json } )
            output( { result } )

            return true
        }

        return true
    }

    if( command === 'allowlist' ) {
        const subCommand = positionals[ 1 ]
        const validSubCommands = [ 'add', 'remove', 'list' ]

        if( !subCommand || !validSubCommands.includes( subCommand ) ) {
            const result = {
                'status': false,
                'error': 'Missing or unknown allowlist sub-command.',
                'fix': `Use: ${appConfig[ 'cliCommand' ]} dev allowlist add <library>, ${appConfig[ 'cliCommand' ]} dev allowlist remove <library>, or ${appConfig[ 'cliCommand' ]} dev allowlist list`
            }
            output( { result } )

            return true
        }

        const library = ( subCommand === 'add' || subCommand === 'remove' )
            ? positionals[ 2 ]
            : null

        const { result } = await FlowMcpCli.allowlist( { cwd, 'action': subCommand, library } )
        output( { result } )

        return true
    }

    if( command === 'env' ) {
        const subCommand = positionals[ 1 ]
        const validSubCommands = [ 'doctor', 'acquire', 'backup', 'restore', 'diff' ]

        if( !subCommand || !validSubCommands.includes( subCommand ) ) {
            const result = {
                'status': false,
                'error': 'Missing or unknown env sub-command.',
                'fix': `Use: ${appConfig[ 'cliCommand' ]} dev env doctor | acquire | backup | restore <file> | diff <file>`
            }
            output( { result } )

            return true
        }

        if( subCommand === 'doctor' ) {
            const schema = values[ 'schema' ] || null
            const strict = values[ 'strict' ] || false
            const fixTemplate = values[ 'fix-template' ] || false
            const json = values[ 'json' ] || false
            const printSignups = values[ 'print-signups' ] || false
            const { result } = await FlowMcpCli.devEnvDoctor( { schema, strict, fixTemplate, json, printSignups, cwd } )
            output( { result } )

            return true
        }

        if( subCommand === 'acquire' ) {
            const key = values[ 'key' ] || null
            const mode = values[ 'mode' ] || null
            const printGuide = values[ 'print-guide' ] || false
            const json = values[ 'json' ] || false
            const { result } = await FlowMcpCli.devEnvAcquire( { key, mode, printGuide, json, cwd } )
            output( { result } )

            return true
        }

        if( subCommand === 'backup' ) {
            const { result } = await FlowMcpCli.devEnvBackup( { cwd } )
            output( { result } )

            return true
        }

        if( subCommand === 'restore' ) {
            const file = positionals[ 2 ]
            const { result } = await FlowMcpCli.devEnvRestore( { file, cwd } )
            output( { result } )

            return true
        }

        if( subCommand === 'diff' ) {
            const file = positionals[ 2 ]
            const { result } = await FlowMcpCli.devEnvDiff( { file, cwd } )
            output( { result } )

            return true
        }

        return true
    }

    if( command === 'resource' ) {
        const subCommand = positionals[ 1 ]
        const basis = values[ 'basis' ] || 'flowmcp'
        const autoConfirm = values[ 'yes' ] || false

        if( subCommand === 'create' ) {
            const targetPath = positionals[ 2 ]
            const { result } = await FlowMcpCli.resourceCreate( { 'schemaPath': targetPath, cwd, basis, autoConfirm } )
            output( { result } )

            return true
        }

        if( subCommand === 'migrate' ) {
            const dryRun = values[ 'dry-run' ] || false
            const { result } = await FlowMcpCli.resourceMigrate( { cwd, basis, dryRun, autoConfirm } )
            output( { result } )

            return true
        }

        const result = {
            'status': false,
            'error': `Unknown resource command "${subCommand}".`,
            'fix': `Available: ${appConfig[ 'cliCommand' ]} resource create <schema-path>, ${appConfig[ 'cliCommand' ]} resource migrate`
        }
        output( { result } )

        return true
    }

    if( command === 'validate' ) {
        const group = values[ 'group' ]
        const { result } = await FlowMcpCli.validate( { schemaPath, cwd, group } )
        output( { result } )

        return true
    }

    // Memo 102 / PRD-002 — `dev test` (project/user/single) removed. Its PASS
    // criterion (HTTP 200 only) is a strict subset of the deterministic grading
    // pretest (HTTP 200 + non-empty data). Use `grading deterministic <id>`
    // instead; the v4-primitive view lives on its --only flag.

    return false
}

const main = async () => {
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
