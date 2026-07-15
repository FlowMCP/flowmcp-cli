import { isAbsolute, resolve, join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, statSync } from 'node:fs'

import { FlowMCP, Pipeline } from 'flowmcp'

import { appConfig } from '../data/config.mjs'
import { CliOutput } from '../lib/CliOutput.mjs'
import { EnvResolver } from '../lib/EnvResolver.mjs'
import { CliBase } from '../lib/CliBase.mjs'
import { AllowlistCommand } from './AllowlistCommand.mjs'


// Memo 152 / PRD-021 (E-04, E-05) — the `flowmcp private call <schema-path> <tool> '{json}'`
// leaf. A path-addressed, ad-hoc call: the schema is NEVER registered, NEVER merged into
// the catalog, so it is structurally invisible to search/list/serve (Memo 148 F4, "A by
// construction"). This module deliberately never enumerates the configured schema folders
// nor runs the catalog merge/registration machinery, and never rebuilds the old CLI statics
// chain — the invisibility follows from that.
//
// The load runs through the core v4 Pipeline.load with the SECURITY SCAN ACTIVE (skipScan:false —
// the private path IS the scan gate; trusted schemaFolders[] loads stay scan-free) and strict
// fail-loud coded errors (LST-001/HND-001/LIB-001, F17=A). Execution is via FlowMCP.fetch on the
// v4 surface — making the private leaf the first production consumer of the v4 Pipeline (research-03
// A1). The CLI keeps only path/~ resolution, env->serverParams (core stays env-free) and output.
//
// No back-reference to FlowMcpCli. Depends only on core (FlowMCP/Pipeline) + lib
// (CliOutput/EnvResolver) + node builtins.
class PrivateCommand {
    static async call( { schemaPath, toolName, jsonArgs = null, listsDir = null, cwd } ) {
        // --- validate + resolve the schema path (the address; no config key) ---
        const { resolvedPath, error: pathError, fix: pathFix } = PrivateCommand.#resolveFilePath( { rawPath: schemaPath } )
        if( pathError !== null ) {
            const result = CliOutput.error( { 'error': pathError, 'fix': pathFix } )

            return { result }
        }

        // --- validate the tool name (no silent default) ---
        if( typeof toolName !== 'string' || toolName.length === 0 ) {
            const result = CliOutput.error( {
                'error': 'PRV-003 privateCall: Missing tool name.',
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} private call <schema-path> <tool> '{json}'`
            } )

            return { result }
        }

        // --- parse JSON args (missing == {}, invalid == fail-loud) ---
        const { userParams, error: jsonError, fix: jsonFix } = PrivateCommand.#parseJsonArgs( { jsonArgs, toolName } )
        if( jsonError !== null ) {
            const result = CliOutput.error( { 'error': jsonError, 'fix': jsonFix } )

            return { result }
        }

        // --- E-05: resolve optional --lists-dir (explicit; no silent tree-walk) ---
        const { resolvedListsDir, error: listsError, fix: listsFix } = PrivateCommand.#resolveListsDir( { rawListsDir: listsDir } )
        if( listsError !== null ) {
            const result = CliOutput.error( { 'error': listsError, 'fix': listsFix } )

            return { result }
        }

        // --- env -> the CLI stays the sole env consumer; core is env-free ---
        const { envObject } = await EnvResolver.resolveEnv( { cwd } )

        // --- E-07 (F17=A, Memo 150) — library gate: compute the ordered resolution chain
        //     CLI-side and hand it to core. Same chain the normal call path uses
        //     (HandlerResolver): allowed-libraries FIRST (user-owned, config
        //     allowedLibrariesPath), then the CLI base (ships ethers/better-sqlite3), then
        //     the schema dir. core stays env-free — it receives the bases, reads no config.
        //     An unresolvable requiredLibrary fails loud as LIB-001 (strict:true below);
        //     the silent Pipeline "default allowlist" fallback is gone (No-Silent-Defaults).
        const schemaDir = dirname( resolvedPath )
        const { allowedLibrariesBase } = await AllowlistCommand.resolveAllowedLibrariesBase()
        const { resolveBase } = CliBase.resolveBase()
        const resolveBases = [ allowedLibrariesBase, resolveBase, schemaDir ]

        // --- load through core v4 Pipeline.load: SCAN ACTIVE (skipScan:false),
        //     strict fail-loud coded errors (LST-001/HND-001/LIB-001) ---
        let loaded
        try {
            loaded = await Pipeline.load( {
                'filePath': resolvedPath,
                'listsDir': resolvedListsDir,
                'resolveBases': resolveBases,
                'skipScan': false,
                'strict': true
            } )
        } catch( err ) {
            const result = CliOutput.error( {
                'error': err.message,
                'fix': `The private schema at "${resolvedPath}" failed to load. Fix the schema (or provide --lists-dir for a standalone sharedLists schema).`
            } )

            return { result }
        }

        if( loaded[ 'status' ] !== true ) {
            const messages = Array.isArray( loaded[ 'messages' ] ) ? loaded[ 'messages' ] : []
            const detail = messages.length > 0 ? messages.join( '; ' ) : 'unknown load failure'
            const result = CliOutput.error( {
                'error': `PRV-006 privateCall: Schema load rejected — ${detail}`,
                'fix': `The private schema at "${resolvedPath}" did not pass the load gate (security scan / validation).`,
                'code': 'PRV-006'
            } )
            result[ 'messages' ] = messages

            return { result }
        }

        const { main, handlerMap, resourceHandlerMap } = loaded

        // --- resolve the requested tool against the loaded schema. Memo 157 Kap 2/3:
        //     match a `main.tools` route (wire-name / raw route name) OR a resource
        //     query `${queryName}_${namespace}` — one convention, search == call == serve.
        //     No silent guessing; a miss stays PRV-007 and lists both tools and queries. ---
        const { kind, routeName, wireToolName, resourceName, queryName, error: toolError, fix: toolFix } = PrivateCommand.#matchTool( { main, toolName } )
        if( toolError !== null ) {
            const result = CliOutput.error( { 'error': toolError, 'fix': toolFix } )

            return { result }
        }

        // --- serverParams built CLI-side; a missing required key fails loud (no
        //     empty-credential injection), consistent with the normal call path ---
        const requiredServerParams = Array.isArray( main[ 'requiredServerParams' ] ) ? main[ 'requiredServerParams' ] : []
        const missingKeys = requiredServerParams
            .filter( ( key ) => {
                const filled = EnvResolver.isKeyFilled( { 'value': envObject[ key ] } )

                return filled === false
            } )

        if( missingKeys.length > 0 ) {
            const result = CliOutput.error( {
                'error': `PRV-008 privateCall: Tool "${toolName}" is missing required key(s): ${missingKeys.join( ', ' )}.`,
                'fix': `Add the key(s) to your env file (~/.flowmcp/.env or <cwd>/.flowmcp/.env), then retry.`
            } )

            return { result }
        }

        const { serverParams } = EnvResolver.buildServerParams( { envObject, requiredServerParams } )

        // --- Memo 157 Kap 2/3: a resource-query call executes on the resource surface
        //     (initializeResourceDbs + executeResource), not FlowMCP.fetch. ---
        if( kind === 'resource' ) {
            return await PrivateCommand.#executeResourceQuery( {
                main,
                resourceHandlerMap,
                resourceName,
                queryName,
                userParams,
                schemaDir,
                wireToolName
            } )
        }

        // --- execute a tool on the v4 surface ---
        let struct
        try {
            struct = await FlowMCP.fetch( { main, handlerMap, userParams, serverParams, routeName } )
        } catch( err ) {
            const result = CliOutput.error( {
                'error': `PRV-009 privateCall: Tool execution failed: ${err.message}`,
                'fix': `Check the tool parameters and any required env keys for "${toolName}".`
            } )

            return { result }
        }

        if( struct[ 'status' ] === false ) {
            const messages = Array.isArray( struct[ 'messages' ] ) ? struct[ 'messages' ] : []
            const detail = messages.length > 0 ? messages.join( '; ' ) : 'API call failed'
            const result = {
                'status': false,
                'toolName': wireToolName,
                'error': `PRV-009 privateCall: ${detail}`,
                'code': 'PRV-009',
                messages
            }

            return { result }
        }

        const result = {
            'status': true,
            'toolName': wireToolName,
            'content': struct[ 'data' ]
        }

        return { result }
    }


    // Memo 157 Kap 2/3 — execute a resource query on the v4 resource surface. Mirrors
    // CallCommand.#callResourceQuery (the proven reference), but reuses the resourceHandlerMap
    // that Pipeline.load already returned. Custom resource handlers are honoured; a pure-SQL
    // resource (no handler) runs via the injected runSql path with an empty handler map.
    static async #executeResourceQuery( { main, resourceHandlerMap, resourceName, queryName, userParams, schemaDir, wireToolName } ) {
        const schemaRef = main[ 'namespace' ] || 'unknown'
        const resourceDefinition = main[ 'resources' ][ resourceName ]

        let struct
        try {
            await FlowMCP.initializeResourceDbs( { 'resources': main[ 'resources' ], schemaRef, schemaDir } )
            const queryHandlerMap = ( resourceHandlerMap && resourceHandlerMap[ resourceName ] ) || {}
            const executed = await FlowMCP.executeResource( {
                resourceDefinition,
                resourceName,
                queryName,
                userParams,
                'handlerMap': queryHandlerMap,
                schemaRef
            } )
            struct = executed[ 'struct' ]
        } catch( err ) {
            const result = CliOutput.error( {
                'error': `PRV-010 privateCall: Resource query "${wireToolName}" failed: ${err.message}`,
                'fix': 'Check that the resource database exists and is accessible, and that the query parameters are valid.'
            } )

            return { result }
        }

        if( struct[ 'status' ] === false ) {
            const messages = Array.isArray( struct[ 'messages' ] ) ? struct[ 'messages' ] : []
            const detail = messages.length > 0 ? messages.join( '; ' ) : 'Resource query failed'
            const result = {
                'status': false,
                'toolName': wireToolName,
                'error': `PRV-010 privateCall: ${detail}`,
                'code': 'PRV-010',
                messages
            }

            return { result }
        }

        const result = {
            'status': true,
            'toolName': wireToolName,
            'content': struct[ 'data' ]
        }

        return { result }
    }


    static #resolveFilePath( { rawPath } ) {
        if( typeof rawPath !== 'string' || rawPath.length === 0 ) {
            return {
                'resolvedPath': null,
                'error': 'PRV-001 privateCall: Missing schema path.',
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} private call <schema-path> <tool> '{json}'`
            }
        }

        const { expandedPath } = PrivateCommand.#expandHome( { rawPath } )
        const resolvedPath = isAbsolute( expandedPath ) ? expandedPath : resolve( expandedPath )

        if( existsSync( resolvedPath ) === false ) {
            return {
                'resolvedPath': null,
                'error': `PRV-002 privateCall: Schema path not found: ${resolvedPath}`,
                'fix': 'Check the path to the private schema file.'
            }
        }

        if( statSync( resolvedPath ).isFile() === false ) {
            return {
                'resolvedPath': null,
                'error': `PRV-002 privateCall: Schema path is not a file: ${resolvedPath}`,
                'fix': 'Point --lists-dir at a directory and the schema path at a single .mjs file.'
            }
        }

        return { resolvedPath, 'error': null, 'fix': null }
    }


    static #resolveListsDir( { rawListsDir } ) {
        if( rawListsDir === null || rawListsDir === undefined ) {
            return { 'resolvedListsDir': undefined, 'error': null, 'fix': null }
        }

        if( typeof rawListsDir !== 'string' || rawListsDir.length === 0 ) {
            return {
                'resolvedListsDir': undefined,
                'error': 'PRV-005 privateCall: --lists-dir was given but is empty.',
                'fix': 'Provide a directory path: --lists-dir <dir>'
            }
        }

        const { expandedPath } = PrivateCommand.#expandHome( { 'rawPath': rawListsDir } )
        const resolvedListsDir = isAbsolute( expandedPath ) ? expandedPath : resolve( expandedPath )

        if( existsSync( resolvedListsDir ) === false ) {
            return {
                'resolvedListsDir': undefined,
                'error': `PRV-005 privateCall: --lists-dir not found: ${resolvedListsDir}`,
                'fix': 'Check the path to the shared-lists directory.'
            }
        }

        if( statSync( resolvedListsDir ).isDirectory() === false ) {
            return {
                'resolvedListsDir': undefined,
                'error': `PRV-005 privateCall: --lists-dir is not a directory: ${resolvedListsDir}`,
                'fix': 'Point --lists-dir at a directory that holds the shared-list .mjs files.'
            }
        }

        return { resolvedListsDir, 'error': null, 'fix': null }
    }


    static #parseJsonArgs( { jsonArgs, toolName } ) {
        if( jsonArgs === null || jsonArgs === undefined ) {
            return { 'userParams': {}, 'error': null, 'fix': null }
        }

        try {
            const userParams = JSON.parse( jsonArgs )

            return { userParams, 'error': null, 'fix': null }
        } catch {
            return {
                'userParams': null,
                'error': 'PRV-004 privateCall: Invalid JSON argument.',
                'fix': `Provide valid JSON: ${appConfig[ 'cliCommand' ]} private call <schema-path> ${toolName} '{"param": "value"}'`
            }
        }
    }


    static #matchTool( { main, toolName } ) {
        const namespace = main[ 'namespace' ] || 'unknown'
        const routes = main[ 'tools' ] || {}
        const routeNames = Object.keys( routes )

        const toolCandidates = routeNames
            .map( ( routeName ) => {
                const { toolName: wireToolName } = FlowMCP.buildToolName( { routeName, namespace } )

                return { routeName, wireToolName }
            } )

        // Match a tool on the wire-name (public v4 buildToolName), or the raw route
        // name as a convenience — both are explicit, no silent guessing.
        const matchedTool = toolCandidates
            .find( ( entry ) => entry[ 'wireToolName' ] === toolName || entry[ 'routeName' ] === toolName )

        if( matchedTool !== undefined ) {
            return {
                'kind': 'tool',
                'routeName': matchedTool[ 'routeName' ],
                'wireToolName': matchedTool[ 'wireToolName' ],
                'resourceName': null,
                'queryName': null,
                'error': null,
                'fix': null
            }
        }

        // Memo 157 Kap 2 — resource-query resolution. Mirrors CallCommand.#callResourceQuery
        // and ServeCommand: the advertised, call-resolvable AND serve-registered name is
        // `${queryName}_${namespace}` (search == call == serve). The raw query name is also
        // accepted as a convenience.
        const resources = main[ 'resources' ] || {}
        const resourceCandidates = Object.entries( resources )
            .reduce( ( acc, [ resourceName, resourceDef ] ) => {
                Object.keys( resourceDef[ 'queries' ] || {} )
                    .forEach( ( queryName ) => {
                        acc.push( { resourceName, queryName, 'wireToolName': `${queryName}_${namespace}` } )
                    } )

                return acc
            }, [] )

        const matchedResource = resourceCandidates
            .find( ( entry ) => entry[ 'wireToolName' ] === toolName || entry[ 'queryName' ] === toolName )

        if( matchedResource !== undefined ) {
            return {
                'kind': 'resource',
                'routeName': null,
                'wireToolName': matchedResource[ 'wireToolName' ],
                'resourceName': matchedResource[ 'resourceName' ],
                'queryName': matchedResource[ 'queryName' ],
                'error': null,
                'fix': null
            }
        }

        const available = [ ...toolCandidates, ...resourceCandidates ]
            .map( ( entry ) => entry[ 'wireToolName' ] )
            .join( ', ' )

        return {
            'kind': null,
            'routeName': null,
            'wireToolName': null,
            'resourceName': null,
            'queryName': null,
            'error': `PRV-007 privateCall: Tool "${toolName}" not found in schema "${namespace}".`,
            'fix': available.length > 0 ? `Available tool(s)/quer(y|ies): ${available}` : 'The schema declares no tools or resource queries.'
        }
    }


    static #expandHome( { rawPath } ) {
        if( rawPath === '~' ) {
            return { 'expandedPath': homedir() }
        }

        if( rawPath.startsWith( '~/' ) === true ) {
            const expandedPath = join( homedir(), rawPath.slice( 2 ) )

            return { expandedPath }
        }

        return { 'expandedPath': rawPath }
    }
}


export { PrivateCommand }
