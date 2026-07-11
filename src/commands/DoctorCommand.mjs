import { createRequire } from 'node:module'
import { join, basename } from 'node:path'
import { existsSync } from 'node:fs'

import { FlowMCP } from 'flowmcp'

import { ConfigStore } from '../lib/ConfigStore.mjs'
import { CliOutput } from '../lib/CliOutput.mjs'
import { FsUtils } from '../lib/FsUtils.mjs'
import { SchemaSource } from '../lib/SchemaSource.mjs'
import { SchemaLoaderBridge } from '../lib/SchemaLoaderBridge.mjs'
import { CliBase } from '../lib/CliBase.mjs'
import { EnvResolver } from '../lib/EnvResolver.mjs'
import { AllowlistCommand } from './AllowlistCommand.mjs'
import { ListsCommand } from './ListsCommand.mjs'


// Memo 152 / PRD-019 (D-08 cluster "doctor") — `flowmcp doctor`, extracted from FlowMcpCli.
// Structural health check over the configured schemaFolders[] (NOT the legacy
// ~/.flowmcp/schemas staging dir): are the lists, modules, refs and config present and
// consistent with each other? Reports by error code, offline by default (no per-schema live
// probe). FlowMcpCli.doctor / printDoctorSummary stay as public delegations (tests + index.mjs
// call them). No back-reference to FlowMcpCli — depends only on lib + sibling command modules.
class DoctorCommand {
    // Memo 149 Strang D (F3=A). Builds on the same pieces as #healthCheck but generalized to
    // the single-source config model (Memo 099).
    static async run( { cwd } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix, 'code': 'CFG-001' } )

            return { result }
        }

        const { name: cliName, version: cliVersion } = CliBase.cliVersion()
        const checks = []

        // Check 1 — config single-source: every schemaFolders[] path must exist on disk.
        const { schemaFolders, error: foldersError } = await ConfigStore.readSchemaFolders()
        if( foldersError !== undefined && foldersError !== null ) {
            checks.push( { 'check': 'config-single-source', 'severity': 'ERROR', 'ok': false, 'code': 'CFG-002', 'detail': foldersError } )
        } else if( schemaFolders.length === 0 ) {
            checks.push( { 'check': 'config-single-source', 'severity': 'ERROR', 'ok': false, 'code': 'CFG-001', 'detail': 'No schemaFolders[] configured in ~/.flowmcp/config.json.' } )
        } else {
            const missingFolders = schemaFolders
                .filter( ( folder ) => existsSync( folder[ 'path' ] ) === false )
                .map( ( folder ) => `${folder[ 'name' ]} -> ${folder[ 'path' ]}` )

            checks.push( {
                'check': 'config-single-source',
                'severity': 'ERROR',
                'ok': missingFolders.length === 0,
                'code': missingFolders.length === 0 ? null : 'CFG-001',
                'detail': missingFolders.length === 0
                    ? `${schemaFolders.length} schemaFolder(s), all present`
                    : `missing path(s): ${missingFolders.join( ', ' )}`
            } )
        }

        // Load all schemas once (structural — no network).
        const { schemas, error: resolveError, fix: resolveFix } = await SchemaLoaderBridge.resolveAllSchemas()
        if( resolveError !== null && resolveError !== undefined ) {
            checks.push( { 'check': 'schema-load', 'severity': 'ERROR', 'ok': false, 'code': 'SCH-001', 'detail': resolveError } )
            const result = DoctorCommand.#result( { cliName, cliVersion, checks, 'fix': resolveFix } )

            return { result }
        }

        // Check 2 — schema-load.
        checks.push( { 'check': 'schema-load', 'severity': 'ERROR', 'ok': schemas.length > 0, 'code': schemas.length > 0 ? null : 'SCH-001', 'detail': `${schemas.length} schema(s) loaded from ${schemaFolders.length} folder(s)` } )

        // Checks 3-5 — per schema: shared-list resolve (list-present + ref/version), module-present.
        const sharedListFailures = []
        const libraryFailures = []
        const missingLibs = new Set()
        const envKeysNeeded = new Set()
        // Memo 150 — measure the SAME resolution chain the real load path uses (allowed-libraries
        // first, then the CLI base), so doctor reflects runtime reality and its install hint points
        // at the user-owned folder.
        const { allowedLibrariesBase } = await AllowlistCommand.resolveAllowedLibrariesBase()
        const { resolveBase } = CliBase.resolveBase()
        const allowedRequire = createRequire( join( allowedLibrariesBase, 'noop.cjs' ) )
        const baseRequire = createRequire( join( resolveBase, 'index.js' ) )

        await schemas
            .reduce( ( promise, entry ) => promise.then( async () => {
                const { main, file } = entry
                const namespace = main[ 'namespace' ] || file
                const sharedListRefs = main[ 'sharedLists' ] || []
                const requiredLibraries = main[ 'requiredLibraries' ] || []
                const requiredServerParams = main[ 'requiredServerParams' ] || []

                requiredServerParams
                    .forEach( ( key ) => envKeysNeeded.add( key ) )

                if( sharedListRefs.length > 0 ) {
                    const { filePath } = await SchemaSource.resolveSchemaFilePath( { schemaRef: file } )
                    const { listsDir } = ListsCommand.findListsDir( { filePath } )

                    if( !listsDir ) {
                        sharedListFailures.push( `${namespace}: LST-001 no _lists dir` )
                    } else {
                        try {
                            const resolved = await FlowMCP.resolveSharedLists( { sharedListRefs, listsDir } )
                            const lists = resolved[ 'sharedLists' ] || {}

                            if( Object.keys( lists ).length === 0 ) {
                                sharedListFailures.push( `${namespace}: HND-001 resolved empty` )
                            }
                        } catch( err ) {
                            const rawMessage = err && err.message ? err.message : String( err )
                            const moduleMatch = rawMessage.match( /Cannot find module '([^']+)'/ )
                            const shortReason = moduleMatch ? `missing list ${basename( moduleMatch[ 1 ] )}` : rawMessage
                            sharedListFailures.push( `${namespace}: LST-006 ${shortReason}` )
                        }
                    }
                }

                if( requiredLibraries.length > 0 ) {
                    requiredLibraries
                        .forEach( ( lib ) => {
                            const resolvable = [ allowedRequire, baseRequire ]
                                .some( ( req ) => {
                                    try {
                                        req.resolve( lib )

                                        return true
                                    } catch( err ) {
                                        return false
                                    }
                                } )

                            if( resolvable === false ) {
                                // LIB-001 — requiredLibrary not resolvable from allowed-libraries nor
                                // the CLI base (aggregated into module-present + the install hint below).
                                libraryFailures.push( `${namespace}: LIB-001 ${lib}` )
                                missingLibs.add( lib )
                            }
                        } )
                }
            } ), Promise.resolve() )

        checks.push( {
            'check': 'shared-list-resolve',
            'severity': 'ERROR',
            'ok': sharedListFailures.length === 0,
            'code': sharedListFailures.length === 0 ? null : 'LST-001',
            'detail': sharedListFailures.length === 0
                ? 'all declared shared lists resolve non-empty'
                : `${sharedListFailures.length} issue(s): ${sharedListFailures.slice( 0, 8 ).join( '; ' )}`
        } )

        checks.push( {
            'check': 'module-present',
            'severity': 'ERROR',
            'ok': libraryFailures.length === 0,
            'code': libraryFailures.length === 0 ? null : 'LIB-001',
            'detail': libraryFailures.length === 0
                ? 'all requiredLibraries resolvable from allowed-libraries or the CLI base'
                : `${libraryFailures.length} unresolvable: ${libraryFailures.slice( 0, 8 ).join( '; ' )}`
        } )

        // Check 6 — key-coverage (INFO: missing keys disable individual tools, they are
        // not a structural failure of the install).
        const { config } = await ConfigStore.readConfig( { cwd } )
        const { envPath } = config
        const { data: envContent } = await FsUtils.readText( { filePath: envPath } )
        const envObject = envContent
            ? EnvResolver.parseEnvFile( { envContent } ).envObject
            : {}
        const missingKeys = Array.from( envKeysNeeded )
            .filter( ( key ) => {
                const value = envObject[ key ]

                return value === undefined || String( value ).length === 0
            } )

        checks.push( {
            'check': 'key-coverage',
            'severity': 'INFO',
            'ok': missingKeys.length === 0,
            'code': missingKeys.length === 0 ? null : 'ENV-001',
            'detail': missingKeys.length === 0
                ? `${envKeysNeeded.size} required key(s), all present`
                : `${missingKeys.length}/${envKeysNeeded.size} key(s) missing (tools needing them are disabled): ${missingKeys.slice( 0, 8 ).join( ', ' )}${missingKeys.length > 8 ? ', …' : ''}`
        } )

        // Check 7 — cli-version stamp.
        checks.push( { 'check': 'cli-version', 'severity': 'INFO', 'ok': cliVersion !== 'unknown', 'code': cliVersion !== 'unknown' ? null : 'CLI-028', 'detail': `${cliName}@${cliVersion}` } )

        // Memo 150 P2 (F3=B) — SHOW the exact, copy-pasteable install command for missing libraries.
        // The CLI never installs itself; it points at allowed-libraries so the user (or the AI on
        // request) can run it. `npm install --prefix <path>` also scaffolds the folder on first use.
        const libFix = missingLibs.size > 0
            ? `Install missing librar${missingLibs.size === 1 ? 'y' : 'ies'} into allowed-libraries: npm install --prefix ${allowedLibrariesBase} ${Array.from( missingLibs ).join( ' ' )}`
            : null

        const result = DoctorCommand.#result( { cliName, cliVersion, checks, 'fix': libFix } )

        return { result }
    }


    // Memo 149 Strang D — assemble the doctor result. Overall status is healthy when no
    // ERROR-severity check failed (INFO failures — e.g. missing API keys — do not flip it).
    static #result( { cliName, cliVersion, checks, fix = null } ) {
        const errorFailures = checks
            .filter( ( check ) => check[ 'ok' ] === false && check[ 'severity' ] === 'ERROR' )
        const infoFailures = checks
            .filter( ( check ) => check[ 'ok' ] === false && check[ 'severity' ] !== 'ERROR' )

        const result = {
            'status': errorFailures.length === 0,
            'cli': `${cliName}@${cliVersion}`,
            'summary': {
                'checks': checks.length,
                'passed': checks.filter( ( check ) => check[ 'ok' ] === true ).length,
                'errors': errorFailures.length,
                'info': infoFailures.length
            },
            checks
        }

        if( fix ) {
            result[ 'fix' ] = fix
        }

        return result
    }


    // Memo 149 Strang D — concise human header for `flowmcp doctor`, to STDERR (stdout
    // stays pure JSON so a piped `... | jq` is never polluted). Suppressed by --json.
    static printSummary( { result, json } ) {
        if( json === true ) {
            return
        }

        const cli = result[ 'cli' ] || 'unknown'
        const summary = result[ 'summary' ] || {}
        const verdict = result[ 'status' ] === true ? 'healthy' : 'has errors'
        process.stderr.write( `\nflowmcp doctor — ${cli} — ${verdict}\n` )

        ;( result[ 'checks' ] || [] )
            .forEach( ( check ) => {
                const mark = check[ 'ok' ] === true ? '✓' : ( check[ 'severity' ] === 'ERROR' ? '✗' : '–' )
                const code = check[ 'code' ] ? ` [${check[ 'code' ]}]` : ''
                process.stderr.write( `  ${mark} ${check[ 'check' ]}${code}: ${check[ 'detail' ]}\n` )
            } )

        process.stderr.write( `  ${summary[ 'passed' ]}/${summary[ 'checks' ]} passed · ${summary[ 'errors' ] || 0} error(s) · ${summary[ 'info' ] || 0} info\n` )

        // Memo 150 P2 — surface the install hint for missing libraries (F3=B: show, never install).
        if( result[ 'fix' ] ) {
            process.stderr.write( `  → ${result[ 'fix' ]}\n` )
        }

        process.stderr.write( `\n` )
    }
}


export { DoctorCommand }
