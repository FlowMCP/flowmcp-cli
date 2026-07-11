import { FlowMCP, IdResolver } from 'flowmcp'

import { appConfig } from '../data/config.mjs'
import { ConfigStore } from '../lib/ConfigStore.mjs'
import { CliOutput } from '../lib/CliOutput.mjs'
import { FsUtils } from '../lib/FsUtils.mjs'
import { EnvResolver } from '../lib/EnvResolver.mjs'
import { SchemaSource } from '../lib/SchemaSource.mjs'
import { SchemaLoaderBridge } from '../lib/SchemaLoaderBridge.mjs'
import { HttpCache } from '../lib/HttpCache.mjs'
import { HandlerResolver } from '../lib/HandlerResolver.mjs'
import { NamespaceIndex } from '../lib/NamespaceIndex.mjs'
import { ListsCommand } from './ListsCommand.mjs'
import { SearchCommand } from './SearchCommand.mjs'
import { SqliteGtfsRuntime } from '../addons/SqliteGtfsRuntime.mjs'


// Memo 152 / PRD-019 (D-09 cluster "call") — `flowmcp call <tool>` + `flowmcp call list-tools`,
// extracted from FlowMcpCli. Resolves a tool by wire-name or Spec-ID (lazy via the namespace
// index, full scan on a miss / stale index), gates on missing keys and required params (Memo 099
// graceful degradation), then executes via core FLowMCP.fetch with handlers from the shared
// HandlerResolver. Spec-ID grammar parsing delegates to core IdResolver.parseSpecId (the old CLI
// #parseSpecId was a thin delegation to it; the FlowMcpCli copy stays only for grading + the
// __testOnly hook). FlowMcpCli.callTool / callListTools stay public delegations (index.mjs +
// tests call them). No back-reference to FlowMcpCli.
class CallCommand {
    static async callListTools( { group, cwd } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        // Memo 099 Kap 5 — list ALL tools from the configured schemaFolders (no group/activation).
        const { schemas: resolvedSchemas, error: resolveError, fix: resolveFix } = await SchemaLoaderBridge.resolveAllSchemas()

        // PRD-008 — a duplicate schemaFolders[] name is a hard config error.
        if( resolveError !== null && resolveError !== undefined ) {
            const result = CliOutput.error( { 'error': resolveError, 'fix': resolveFix } )

            return { result }
        }

        const tools = []

        resolvedSchemas
            .forEach( ( { main, source } ) => {
                const namespace = main[ 'namespace' ] || 'unknown'
                const routes = main[ 'routes' ] || main[ 'tools' ] || {}

                Object.keys( routes )
                    .forEach( ( routeName ) => {
                        try {
                            const { toolName } = FlowMCP.buildToolName( { routeName, namespace } )
                            const description = routes[ routeName ][ 'description' ] || ''

                            // PRD-008 — surface the source coordinate so a qualified
                            // "<source>:<namespace>/tool/<name>" call is readable from `list`.
                            tools.push( { toolName, namespace, routeName, description, 'source': source || null } )
                        } catch( err ) {
                            process.stderr.write( `CLI-004 callListTools: tool name build failed: ${err.message}\n` )
                            tools.push( {
                                'toolName': `error_${routeName}_${namespace}`,
                                namespace,
                                routeName,
                                'source': source || null,
                                'description': `Error: ${err.message}`
                            } )
                        }
                    } )
            } )

        const result = {
            'status': true,
            'group': '_all',
            'toolCount': tools.length,
            tools
        }

        return { result }
    }


    static async callTool( { toolName, jsonArgs, group, cwd, noCache = false, refresh = false } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        if( !toolName ) {
            const result = CliOutput.error( {
                'error': 'Missing tool name.',
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} call <tool-name> [json]. Run ${appConfig[ 'cliCommand' ]} call list-tools to see available tools.`
            } )

            return { result }
        }

        // Memo 051 PRD-20 — route auto-injected sqlite-gtfs tools to addon handlers
        const autoToolRoute = await SqliteGtfsRuntime.maybeCallSqliteGtfsAutoTool( {
            toolName,
            jsonArgs,
            noCache,
            refresh
        } )
        if( autoToolRoute ) {
            return autoToolRoute
        }

        let resolvedToolName = toolName
        // PRD-008 — an optional "<source>:" prefix scopes the call to one
        // schemaFolders[] source (no first-wins guess on a collision).
        let sourceFilter = null
        // Memo 128 Kap 10 — for a tool Spec-ID we can resolve via the prebuilt
        // namespace-index (one import) instead of scanning all schemas.
        let lazySpec = null

        if( CallCommand.#isSpecId( { 'ref': toolName } ) ) {
            const { valid, namespace, type, name: specName, source } = IdResolver.parseSpecId( { 'specId': toolName } )

            if( !valid ) {
                const result = CliOutput.error( {
                    'error': `Invalid Spec-ID "${toolName}".`,
                    'fix': `Use format: <namespace>/tool/<name> (optional prefix "<source>:").`
                } )

                return { result }
            }

            if( type === 'schema' ) {
                const result = CliOutput.error( {
                    'error': `Cannot call a container Spec-ID "${toolName}". Specify a tool Spec-ID: <namespace>/tool/<name>`,
                    'fix': `Use format: ${namespace}/tool/<route-name>`
                } )

                return { result }
            }

            if( type !== 'tool' ) {
                const result = CliOutput.error( {
                    'error': `Spec-ID type "${type}" cannot be called directly.`,
                    'fix': `Only tool Spec-IDs are callable: <namespace>/tool/<name>`
                } )

                return { result }
            }

            sourceFilter = source
            lazySpec = { namespace, 'routeName': specName }
            const { toolName: mcpToolName } = FlowMCP.buildToolName( { 'routeName': specName, 'namespace': namespace } )
            resolvedToolName = mcpToolName
        }

        // Memo 128 Kap 10 — Lazy Schema-Resolution: for a tool Spec-ID, import only
        // the single indexed schema file. Memo 099 Kap 5 — no activation: the full
        // scan (lazy miss / bare name) resolves against ALL configured schemaFolders.
        let resolvedSchemas = null
        let lazyUsed = false

        if( lazySpec !== null ) {
            const { schemas: lazySchemas } = await CallCommand.#resolveSchemaByIndex( {
                'namespace': lazySpec[ 'namespace' ],
                'routeName': lazySpec[ 'routeName' ],
                sourceFilter,
                cwd
            } )

            if( lazySchemas !== null ) {
                resolvedSchemas = lazySchemas
                lazyUsed = true
            }
        }

        if( resolvedSchemas === null ) {
            const { resolvedSchemas: scanned, errorResult } = await CallCommand.#resolveSchemasForCall( { sourceFilter } )

            if( errorResult ) {
                return { 'result': errorResult }
            }

            resolvedSchemas = scanned
        }

        const { config } = await ConfigStore.readConfig( { cwd } )
        const { envPath } = config
        const { data: envContent } = await FsUtils.readText( { filePath: envPath } )
        const envObject = envContent
            ? EnvResolver.parseEnvFile( { envContent } ).envObject
            : {}

        let userParams = {}
        if( jsonArgs ) {
            try {
                userParams = JSON.parse( jsonArgs )
            } catch {
                const result = CliOutput.error( {
                    'error': 'CAL-001 callTool: Invalid JSON argument.',
                    'fix': `Provide valid JSON: ${appConfig[ 'cliCommand' ]} call ${toolName} '{"param": "value"}'`
                } )

                return { result }
            }
        }

        // Memo 128 Kap 10 — wire-name match (also the lazy-resolution re-verify).
        let matched = CallCommand.#matchToolInSchemas( { resolvedSchemas, resolvedToolName } )

        // Stale-index guard: a lazy single-file load that does not contain the
        // requested wire-name (index drifted) falls back to the full scan.
        if( !matched[ 'matchedMain' ] && lazyUsed ) {
            const { resolvedSchemas: scanned, errorResult } = await CallCommand.#resolveSchemasForCall( { sourceFilter } )

            if( errorResult ) {
                return { 'result': errorResult }
            }

            resolvedSchemas = scanned
            matched = CallCommand.#matchToolInSchemas( { resolvedSchemas, resolvedToolName } )
        }

        const { matchedMain, matchedHandlersFn, matchedFile, matchedToolName, matchedRouteName } = matched

        if( !matchedMain ) {
            const resourceResult = await CallCommand.#callResourceQuery( { toolName, jsonArgs, resolvedSchemas } )

            if( resourceResult ) {
                return resourceResult
            }

            const result = CliOutput.error( {
                'error': `Tool "${toolName}" not found.`,
                'fix': `Run ${appConfig[ 'cliCommand' ]} search <query> or ${appConfig[ 'cliCommand' ]} list to see available tool names.`
            } )

            return { result }
        }

        // Memo 099 Kap 6 — graceful degradation: a tool whose required keys are
        // missing is disabled, never a global abort. The other tools stay usable.
        const matchedRequiredKeys = matchedMain[ 'requiredServerParams' ] || []
        const matchedMissingKeys = matchedRequiredKeys
            .filter( ( key ) => {
                const present = envObject[ key ] !== undefined && String( envObject[ key ] ).length > 0

                return present === false
            } )

        if( matchedMissingKeys.length > 0 ) {
            const { tools: availableTools } = await SearchCommand.listAvailableTools()
            const otherCount = availableTools.length > 0 ? availableTools.length - 1 : 0
            const result = CliOutput.error( {
                'error': `Tool "${toolName}" is not available — missing key(s): ${matchedMissingKeys.join( ', ' )}.`,
                'fix': `Add the key(s) to ${envPath}. ${otherCount} other tool(s) remain callable.`
            } )

            return { result }
        }

        const matchedRouteConfig = ( matchedMain[ 'routes' ] || matchedMain[ 'tools' ] )[ matchedRouteName ]
        const matchedRouteParameters = matchedRouteConfig[ 'parameters' ] || []
        const { filePath: matchedSchemaFilePath } = matchedFile
            ? await SchemaSource.resolveSchemaFilePath( { schemaRef: matchedFile } )
            : { filePath: null }
        const { sharedLists: matchedSharedLists } = await ListsCommand.resolveSharedListsForSchema( { 'main': matchedMain, 'filePath': matchedSchemaFilePath } )
        const { parameters: expectedParameters } = SearchCommand.extractParameters( { 'routeParameters': matchedRouteParameters, 'sharedLists': matchedSharedLists } )

        const missingParams = Object.entries( expectedParameters )
            .filter( ( [ , paramDef ] ) => {
                const isMissing = paramDef[ 'required' ] === true

                return isMissing
            } )
            .filter( ( [ paramKey ] ) => {
                const isProvided = userParams[ paramKey ] !== undefined

                return !isProvided
            } )
            .map( ( [ paramKey ] ) => {
                return paramKey
            } )

        if( missingParams.length > 0 ) {
            const result = CliOutput.error( {
                'error': `Missing required parameter(s): ${missingParams.join( ', ' )}`,
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} call ${toolName} '${JSON.stringify( expectedParameters, null, 0 )}'`
            } )

            return { result }
        }

        const preload = matchedRouteConfig[ 'preload' ] || null
        const isCacheable = preload && preload[ 'enabled' ] === true && !noCache
        const namespace = matchedMain[ 'namespace' ] || 'unknown'

        if( isCacheable && !refresh ) {
            const { cacheKey } = HttpCache.buildCacheKey( {
                namespace,
                'routeName': matchedRouteName,
                userParams
            } )

            const { data: cachedData, meta, isExpired } = await HttpCache.readCache( { cacheKey } )

            if( cachedData && !isExpired ) {
                const result = {
                    'status': true,
                    'toolName': matchedToolName,
                    'content': cachedData,
                    'cache': {
                        'hit': true,
                        'fetchedAt': meta[ 'fetchedAt' ],
                        'expiresAt': meta[ 'expiresAt' ]
                    }
                }

                return { result }
            }
        }

        try {
            const requiredServerParams = matchedMain[ 'requiredServerParams' ] || []
            const { serverParams } = EnvResolver.buildServerParams( { envObject, requiredServerParams } )
            // Memo 149 Strang B — reuse the already-resolved matchedSchemaFilePath (the
            // param path computed it via #resolveSchemaFilePath above). No second, dead
            // join( #schemasDir(), matchedFile ).
            const { handlerMap } = await HandlerResolver.resolve( { 'main': matchedMain, 'handlersFn': matchedHandlersFn, 'filePath': matchedSchemaFilePath } )

            const fetchResult = await FlowMCP.fetch( {
                'main': matchedMain,
                handlerMap,
                userParams,
                serverParams,
                'routeName': matchedRouteName
            } )

            if( fetchResult[ 'status' ] === false ) {
                const fetchMessages = fetchResult[ 'messages' ] || []
                const errorText = fetchMessages.join( '; ' ) || 'API call failed'

                const hasAuthError = fetchMessages
                    .some( ( msg ) => {
                        const isAuth = msg.includes( 'HTTP 401' ) || msg.includes( 'HTTP 403' )

                        return isAuth
                    } )

                let fix = null
                if( hasAuthError ) {
                    const requiredKeys = matchedMain[ 'requiredServerParams' ] || []
                    const envPath = config[ 'envPath' ] || '~/.flowmcp/.env'

                    if( requiredKeys.length > 0 ) {
                        fix = `Check API key(s) in ${envPath}: ${requiredKeys.join( ', ' )}`
                    } else {
                        fix = `Check authentication. No requiredServerParams defined in schema.`
                    }
                }

                const result = {
                    'status': false,
                    'toolName': matchedToolName,
                    'error': errorText,
                    'messages': fetchMessages
                }

                if( fix ) {
                    result[ 'fix' ] = fix
                }

                return { result }
            }

            const contentData = fetchResult[ 'data' ] !== undefined && fetchResult[ 'data' ] !== null
                ? fetchResult[ 'data' ]
                : fetchResult

            if( isCacheable ) {
                const { cacheKey } = HttpCache.buildCacheKey( {
                    namespace,
                    'routeName': matchedRouteName,
                    userParams
                } )
                const { meta: cacheMeta } = await HttpCache.writeCache( {
                    cacheKey,
                    'data': contentData,
                    'ttl': preload[ 'ttl' ]
                } )

                const result = {
                    'status': true,
                    'toolName': matchedToolName,
                    'content': contentData,
                    'cache': {
                        'hit': false,
                        'stored': true,
                        'expiresAt': cacheMeta[ 'expiresAt' ]
                    }
                }

                return { result }
            }

            const result = {
                'status': true,
                'toolName': matchedToolName,
                'content': contentData
            }

            return { result }
        } catch( err ) {
            const result = CliOutput.error( {
                'error': `CFG-001 matchedRouteConfig: Tool execution failed: ${err.message}`,
                'fix': `Check the tool parameters and env vars. Run ${appConfig[ 'cliCommand' ]} call list-tools for details.`
            } )

            return { result }
        }
    }


    static #isSpecId( { ref } ) {
        if( typeof ref !== 'string' ) {
            return false
        }

        const hasLegacySep = ref.includes( '::' )
        const hasSlash = ref.includes( '/' )
        const isMjsPath = ref.endsWith( '.mjs' )

        return !hasLegacySep && hasSlash && !isMjsPath
    }


    static async #callResourceQuery( { toolName, jsonArgs, resolvedSchemas } ) {
        let matchedMain = null
        let matchedHandlersFn = null
        let matchedFile = null
        let matchedResourceName = null
        let matchedQueryName = null

        resolvedSchemas
            .forEach( ( { main, handlersFn, file } ) => {
                if( matchedMain ) {
                    return
                }

                const namespace = main[ 'namespace' ] || 'unknown'
                const resources = main[ 'resources' ] || {}

                Object.entries( resources )
                    .forEach( ( [ resourceName, resourceDef ] ) => {
                        if( matchedMain ) {
                            return
                        }

                        Object.keys( resourceDef[ 'queries' ] || {} )
                            .forEach( ( queryName ) => {
                                if( matchedMain ) {
                                    return
                                }

                                const candidateName = `${queryName}_${namespace}`

                                if( candidateName === toolName ) {
                                    matchedMain = main
                                    matchedHandlersFn = handlersFn
                                    matchedFile = file
                                    matchedResourceName = resourceName
                                    matchedQueryName = queryName
                                }
                            } )
                    } )
            } )

        if( !matchedMain ) {
            return null
        }

        try {
            // Memo 149 Strang B — single-source helper (was: join( #schemasDir(), matchedFile )).
            const { filePath: schemaFilePath } = await SchemaSource.resolveSchemaFilePath( { schemaRef: matchedFile } )
            const { resourceHandlerMap } = await HandlerResolver.resolve( {
                'main': matchedMain,
                'handlersFn': matchedHandlersFn,
                'filePath': schemaFilePath
            } )

            const schemaRef = matchedMain[ 'namespace' ] || 'unknown'
            const resourceDef = matchedMain[ 'resources' ][ matchedResourceName ]

            await FlowMCP.initializeResourceDbs( { 'resources': matchedMain[ 'resources' ], schemaRef } )

            const queryHandlerMap = resourceHandlerMap[ matchedResourceName ] || {}
            const userParams = jsonArgs ? JSON.parse( jsonArgs ) : {}

            const { struct } = await FlowMCP.executeResource( {
                'resourceDefinition': resourceDef,
                'resourceName': matchedResourceName,
                'queryName': matchedQueryName,
                userParams,
                'handlerMap': queryHandlerMap,
                schemaRef
            } )

            const result = {
                'status': struct[ 'status' ],
                'data': struct[ 'data' ],
                'messages': struct[ 'messages' ]
            }

            return { result }
        } catch( err ) {
            const result = CliOutput.error( {
                'error': `SQL-020 callResourceQuery: Resource query failed: ${err.message}`,
                'fix': 'Check that the database file exists and is accessible.'
            } )

            return { result }
        }
    }


    // Memo 128 Kap 10 — Lazy Schema-Resolution for a tool Spec-ID call.
    // Consults the prebuilt namespace-index and imports ONLY the one schema file
    // that owns "<namespace>/tool/<routeName>", instead of importing all ~549
    // schemas via resolveAllSchemas(). Returns a single-element schemas array in
    // the exact shape resolveAllSchemas() produces, or { schemas: null } on a
    // miss (caller then falls back to the full scan). The wire-name re-verify
    // happens in callTool's match loop, so a stale index can never mis-resolve.
    static async #resolveSchemaByIndex( { namespace, routeName, sourceFilter, cwd } ) {
        const indexResult = await NamespaceIndex.tryGet( { cwd } )
        if( indexResult === null ) {
            return { 'schemas': null }
        }

        const { index } = indexResult
        const tools = index && index[ 'tools' ] ? index[ 'tools' ] : {}
        const specId = `${namespace}/tool/${routeName}`
        const entry = tools[ specId ]

        if( !entry || !entry[ 'file' ] || !entry[ 'source' ] ) {
            return { 'schemas': null }
        }

        // A "<source>:" prefix must hit exactly that source — never first-wins.
        if( ( sourceFilter !== null && sourceFilter !== undefined ) && entry[ 'source' ] !== sourceFilter ) {
            return { 'schemas': null }
        }

        const schemaRef = `${entry[ 'source' ]}/${entry[ 'file' ]}`
        const loaded = await SchemaLoaderBridge.tryLoadSingleSchema( { schemaRef } )
        if( loaded === null ) {
            return { 'schemas': null }
        }

        const { main, handlersFn } = loaded
        if( !main ) {
            return { 'schemas': null }
        }

        const schemas = [ {
            main,
            handlersFn,
            'file': schemaRef,
            'source': entry[ 'source' ],
            'requiredServerParams': main[ 'requiredServerParams' ] || []
        } ]

        return { schemas }
    }


    // Memo 099 Kap 5 — full-scan resolution against ALL configured schemaFolders[].
    // Memo 128 Kap 10 — extracted so callTool can use it as the lazy-resolution
    // fallback (lazy miss / bare name / stale index). Returns either an
    // errorResult (config error / unknown source) or the source-filtered schemas.
    static async #resolveSchemasForCall( { sourceFilter } ) {
        const { schemas: allSchemas, error: resolveError, fix: resolveFix } = await SchemaLoaderBridge.resolveAllSchemas()

        // PRD-008 — a duplicate schemaFolders[] name is a hard config error.
        if( resolveError !== null && resolveError !== undefined ) {
            const errorResult = CliOutput.error( { 'error': resolveError, 'fix': resolveFix } )

            return { 'resolvedSchemas': [], errorResult }
        }

        // PRD-008 — when a "<source>:" prefix is given, restrict resolution to that
        // source so the qualified call hits exactly that folder (no first-wins).
        const resolvedSchemas = sourceFilter === null || sourceFilter === undefined
            ? allSchemas
            : allSchemas.filter( ( entry ) => entry[ 'source' ] === sourceFilter )

        if( ( sourceFilter !== null && sourceFilter !== undefined ) && resolvedSchemas.length === 0 ) {
            const errorResult = CliOutput.error( {
                'error': `No schemaFolders[] source named "${sourceFilter}" provides the requested tool.`,
                'fix': `Check the source name (run "${appConfig[ 'cliCommand' ]} call list-tools" to see each tool's "source"), or drop the "<source>:" prefix.`
            } )

            return { 'resolvedSchemas': [], errorResult }
        }

        return { resolvedSchemas, 'errorResult': null }
    }


    // Memo 128 Kap 10 — wire-name match over a schema list (first-wins). Extracted
    // so callTool can run it twice: once over the lazy single-file result, and
    // again over the full scan if the lazy result drifted from the index.
    static #matchToolInSchemas( { resolvedSchemas, resolvedToolName } ) {
        let matchedMain = null
        let matchedHandlersFn = null
        let matchedFile = null
        let matchedToolName = null
        let matchedRouteName = null

        resolvedSchemas
            .forEach( ( { main, handlersFn, file } ) => {
                if( matchedMain ) {
                    return
                }

                const namespace = main[ 'namespace' ] || 'unknown'
                const routes = main[ 'routes' ] || main[ 'tools' ] || {}

                Object.keys( routes )
                    .forEach( ( routeName ) => {
                        if( matchedMain ) {
                            return
                        }

                        try {
                            const { toolName: candidateName } = FlowMCP.buildToolName( { routeName, namespace } )

                            if( candidateName === resolvedToolName ) {
                                matchedMain = main
                                matchedHandlersFn = handlersFn
                                matchedFile = file
                                matchedToolName = candidateName
                                matchedRouteName = routeName
                            }
                        } catch {
                            // skip
                        }
                    } )
            } )

        return { matchedMain, matchedHandlersFn, matchedFile, matchedToolName, matchedRouteName }
    }
}


export { CallCommand }
