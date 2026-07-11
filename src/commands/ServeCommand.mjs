import { join } from 'node:path'

import { FlowMCP } from 'flowmcp'

import { appConfig } from '../data/config.mjs'
import { ConfigStore } from '../lib/ConfigStore.mjs'
import { CliOutput } from '../lib/CliOutput.mjs'
import { FsUtils } from '../lib/FsUtils.mjs'
import { EnvResolver } from '../lib/EnvResolver.mjs'
import { SchemaSource } from '../lib/SchemaSource.mjs'
import { SchemaLoaderBridge } from '../lib/SchemaLoaderBridge.mjs'
import { HandlerResolver } from '../lib/HandlerResolver.mjs'


// Memo 152 / PRD-019 (D-09 cluster "serve-mcp" + "group-resolution") — `flowmcp run`, extracted
// from FlowMcpCli. Spins up an MCP stdio server exposing the tools/resources/prompts of the
// active schemas. The group-resolution helpers (resolveDefaultGroupSchemas / resolveGroupName /
// resolveGroupSchemas / resolveToolRefs / filterMainRoutes / resolveActiveToolRefs /
// resolveAgentSchemas) are moved UNCHANGED (F18=A — the --group -> selection rename is PRD-020/
// D-12). parseToolRef, resolveDefaultGroupSchemas and disambiguateToolName are PUBLIC static
// because ValidateCommand/MigrateCommand (validate uses resolveDefaultGroupSchemas, migrateConfig
// uses parseToolRef) and the __testOnly_planServeToolNames hook consume them. FlowMcpCli.run stays
// a public delegation (index.mjs + tests call it). No back-reference to FlowMcpCli.
class ServeCommand {
    static async run( { group, cwd } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        let resolvedSchemas = null
        let serverName = null

        if( !group ) {
            const { schemas: agentSchemas, error: agentError, fix: agentFix } = await ServeCommand.#resolveAgentSchemas( { cwd } )
            if( !agentSchemas ) {
                const result = CliOutput.error( { 'error': agentError, 'fix': agentFix } )

                return { result }
            }

            resolvedSchemas = agentSchemas
            serverName = 'default'
        } else {
            const { groupName, error: groupNameError, fix: groupNameFix } = await ServeCommand.#resolveGroupName( { group, cwd } )
            if( !groupName ) {
                const result = CliOutput.error( { 'error': groupNameError, 'fix': groupNameFix } )

                return { result }
            }

            const { schemas: groupSchemas, error: schemasError, fix: schemasFix } = await ServeCommand.#resolveGroupSchemas( { groupName, cwd } )
            if( !groupSchemas ) {
                const result = CliOutput.error( { 'error': schemasError, 'fix': schemasFix } )

                return { result }
            }

            resolvedSchemas = groupSchemas
            serverName = groupName
        }

        const { config } = await ConfigStore.readConfig( { cwd } )
        const { envPath } = config
        const { data: envContent } = await FsUtils.readText( { filePath: envPath } )
        if( !envContent ) {
            const result = CliOutput.error( {
                'error': `Cannot read .env file at: ${envPath}`,
                'fix': `Ensure the .env file exists at ${envPath}`
            } )

            return { result }
        }

        const { envObject } = EnvResolver.parseEnvFile( { envContent } )

        const missing = []
        resolvedSchemas
            .forEach( ( { main } ) => {
                const namespace = main[ 'namespace' ] || 'unknown'
                const requiredServerParams = main[ 'requiredServerParams' ] || []
                const { valid, error: envError } = ServeCommand.#validateEnvParams( {
                    envObject,
                    requiredServerParams,
                    namespace,
                    'envPath': envPath
                } )

                if( !valid ) {
                    const missingParams = requiredServerParams
                        .filter( ( param ) => {
                            const exists = envObject[ param ] !== undefined

                            return !exists
                        } )

                    missing.push( { namespace, 'params': missingParams } )
                }
            } )

        if( missing.length > 0 ) {
            const result = {
                'status': false,
                'error': 'Cannot start server. Missing env vars.',
                missing,
                'fix': `Add missing vars to .env at ${envPath} or remove schemas from group.`
            }

            return { result }
        }

        let McpServer, StdioServerTransport
        try {
            const sdk = await import( '@modelcontextprotocol/sdk/server/mcp.js' )
            McpServer = sdk.McpServer
            const stdioModule = await import( '@modelcontextprotocol/sdk/server/stdio.js' )
            StdioServerTransport = stdioModule.StdioServerTransport
        } catch( err ) {
            const result = CliOutput.error( {
                'error': `CLI-003 run: Failed to load MCP SDK: ${err.message}`,
                'fix': 'Run: npm install @modelcontextprotocol/sdk'
            } )

            return { result }
        }

        const server = new McpServer( {
            'name': `${appConfig[ 'cliCommand' ]}-${serverName}`,
            'version': '1.0.0'
        } )

        // PRD-008 — pre-serve dedup. Two schemaFolders carrying the same provider
        // would compute the same MCP tool name and make the SDK throw
        // "Tool ${name} is already registered". We track every registered name and,
        // on a real collision, re-derive the name with the source coordinate appended
        // (deterministic). A genuine within-config duplicate (same source, same name)
        // is skipped with a visible stderr note instead of crashing the server.
        const registeredToolNames = new Set()
        const resolveRegisterableName = ( { baseName, routeName, namespace, source } ) => {
            const plan = ServeCommand.disambiguateToolName( { baseName, routeName, namespace, source, registeredToolNames } )
            if( plan.note !== null ) {
                process.stderr.write( `${appConfig[ 'appName' ]}: ${plan.note}\n` )
            }

            return { 'finalName': plan.finalName, 'skip': plan.skip }
        }

        await resolvedSchemas
            .reduce( ( promise, { main, handlersFn, file, source } ) => promise.then( async () => {
                const requiredServerParams = main[ 'requiredServerParams' ] || []
                const { serverParams } = EnvResolver.buildServerParams( { envObject, requiredServerParams } )
                // Memo 149 Strang B — resolve via the single-source helper (was:
                // join( #schemasDir(), file ) against the dead staging dir).
                const { filePath: schemaFilePath } = await SchemaSource.resolveSchemaFilePath( { schemaRef: file } )
                const { handlerMap } = await HandlerResolver.resolve( { main, handlersFn, 'filePath': schemaFilePath } )
                const namespaceForTools = main[ 'namespace' ] || 'unknown'

                Object.keys( main[ 'tools' ] || main[ 'routes' ] || {} )
                    .forEach( ( routeName ) => {
                        const { toolName, description, zod, func } = FlowMCP.prepareServerTool( {
                            main,
                            handlerMap,
                            serverParams,
                            routeName
                        } )

                        const { finalName, skip } = resolveRegisterableName( { 'baseName': toolName, routeName, 'namespace': namespaceForTools, source } )
                        if( skip === true ) {
                            return
                        }

                        server.tool( finalName, description, zod, async ( args ) => {
                            const callResult = await func( args )
                            const content = callResult[ 'dataAsString' ] || JSON.stringify( callResult[ 'data' ] || callResult )

                            return {
                                'content': [ { 'type': 'text', 'text': content } ]
                            }
                        } )
                    } )

                if( main[ 'resources' ] ) {
                    const schemaRef = main[ 'namespace' ] || 'unknown'
                    const { resourceHandlerMap } = await HandlerResolver.resolve( { main, handlersFn, 'filePath': schemaFilePath } )

                    await FlowMCP.initializeResourceDbs( { 'resources': main[ 'resources' ], schemaRef } )

                    Object.entries( main[ 'resources' ] )
                        .forEach( ( [ resourceName, resourceDef ] ) => {
                            Object.entries( resourceDef[ 'queries' ] || {} )
                                .forEach( ( [ queryName, queryDef ] ) => {
                                    const namespace = main[ 'namespace' ] || 'unknown'
                                    const baseQueryName = `${queryName}_${namespace}`
                                    // PRD-008 — resource-query names are built here (not via
                                    // #buildToolName); apply the same pre-serve dedup so two
                                    // folders' resources can coexist.
                                    const { finalName: queryToolName, skip: skipQuery } = resolveRegisterableName( { 'baseName': baseQueryName, 'routeName': queryName, namespace, source } )
                                    const toolName = queryToolName
                                    const description = queryDef[ 'description' ] || `Query ${queryName} on ${resourceName}`

                                    if( skipQuery === true ) {
                                        return
                                    }

                                    server.tool( toolName, description, {}, async ( args ) => {
                                        const queryHandlerMap = ( resourceHandlerMap[ resourceName ] ) || {}
                                        const { struct } = await FlowMCP.executeResource( {
                                            'resourceDefinition': resourceDef,
                                            resourceName,
                                            queryName,
                                            'userParams': args,
                                            'handlerMap': queryHandlerMap,
                                            schemaRef
                                        } )

                                        const content = JSON.stringify( struct[ 'data' ] || struct )

                                        return {
                                            'content': [ { 'type': 'text', 'text': content } ]
                                        }
                                    } )
                                } )
                        } )
                }

                if( main[ 'prompts' ] ) {
                    Object.entries( main[ 'prompts' ] )
                        .forEach( ( [ promptKey, promptDef ] ) => {
                            const promptName = promptDef[ 'name' ] || promptKey
                            const promptDescription = promptDef[ 'description' ] || ''
                            const promptArgs = ( promptDef[ 'parameters' ] || [] )
                                .reduce( ( acc, param ) => {
                                    acc[ param[ 'name' ] ] = {
                                        'description': param[ 'description' ] || '',
                                        'required': param[ 'required' ] || false
                                    }

                                    return acc
                                }, {} )

                            server.prompt( promptName, promptDescription, promptArgs, async ( args ) => {
                                let content = promptDef[ 'content' ] || ''

                                Object.entries( args || {} )
                                    .forEach( ( [ key, value ] ) => {
                                        content = content.replace( `[[${key}]]`, value )
                                    } )

                                return {
                                    'messages': [ { 'role': 'user', 'content': { 'type': 'text', 'text': content } } ]
                                }
                            } )
                        } )
                }
            } ), Promise.resolve() )

        const transport = new StdioServerTransport()
        process.stderr.write( `${appConfig[ 'appName' ]} server "${serverName}" starting on stdio...\n` )

        await server.connect( transport )
        process.stderr.write( `${appConfig[ 'appName' ]} server "${serverName}" connected.\n` )

        const result = { 'status': true, 'mode': 'stdio', 'group': serverName }

        return { result }
    }


    static #parseToolRefImpl( { toolRef } ) {
        const separatorIndex = toolRef.indexOf( '::' )
        if( separatorIndex === -1 ) {
            return { 'schemaRef': toolRef, 'routeName': null }
        }

        const schemaRef = toolRef.slice( 0, separatorIndex )
        const routeName = toolRef.slice( separatorIndex + 2 )

        return { schemaRef, routeName }
    }


    // Public because migrateConfig (MigrateCommand) consumes it (F18=A move, unchanged).
    static parseToolRef( { toolRef } ) {
        return ServeCommand.#parseToolRefImpl( { toolRef } )
    }


    static #filterMainRoutes( { main, routeNames } ) {
        const { namespace, name, description, version, docs, tags, root, requiredServerParams, headers, sharedLists, requiredLibraries } = main
        const routesKey = main[ 'routes' ] ? 'routes' : ( main[ 'tools' ] ? 'tools' : 'routes' )
        const originalRoutes = main[ routesKey ] || {}
        const filteredRoutes = {}

        routeNames
            .forEach( ( routeName ) => {
                if( originalRoutes[ routeName ] ) {
                    filteredRoutes[ routeName ] = originalRoutes[ routeName ]
                }
            } )

        const filteredMain = {
            namespace,
            name,
            description,
            version,
            docs,
            tags,
            root,
            requiredServerParams,
            headers,
            [ routesKey ]: filteredRoutes
        }

        if( sharedLists ) { filteredMain[ 'sharedLists' ] = sharedLists }
        if( requiredLibraries ) { filteredMain[ 'requiredLibraries' ] = requiredLibraries }

        return { 'main': filteredMain }
    }


    // PRD-008 — stateful pre-serve dedup planner (the SDK throws on a duplicate tool
    // name). Given the already-registered names set, decide the final registerable
    // name for one base name. On a real collision it appends the source coordinate
    // (deterministic via FlowMCP.buildToolName disambiguate=true). A genuine duplicate
    // that cannot be disambiguated (no/equal source) is skipped — never a silent throw.
    // Mutates `registeredToolNames`. Returns { finalName, skip, note }. Public because
    // the __testOnly_planServeToolNames hook exercises it.
    static disambiguateToolName( { baseName, routeName, namespace, source, registeredToolNames } ) {
        if( registeredToolNames.has( baseName ) === false ) {
            registeredToolNames.add( baseName )

            return { 'finalName': baseName, 'skip': false, 'note': null }
        }

        const { toolName: qualifiedName } = FlowMCP.buildToolName( { routeName, namespace, source, 'disambiguate': true } )
        if( qualifiedName !== baseName && registeredToolNames.has( qualifiedName ) === false ) {
            registeredToolNames.add( qualifiedName )

            return { 'finalName': qualifiedName, 'skip': false, 'note': `tool name collision on "${baseName}" — registered the source-qualified name "${qualifiedName}" instead.` }
        }

        return { 'finalName': baseName, 'skip': true, 'note': `duplicate tool name "${baseName}" cannot be disambiguated (same source) — skipped.` }
    }


    // Public because validate (ValidateCommand) consumes it (F18=A move, unchanged).
    static async resolveDefaultGroupSchemas( { cwd } ) {
        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FsUtils.readJson( { filePath: localConfigPath } )

        if( !localConfig || !localConfig[ 'defaultGroup' ] ) {
            return { 'schemas': null, 'error': 'No default group set. Provide a schema path or set a default group.' }
        }

        const { defaultGroup } = localConfig
        const group = localConfig[ 'groups' ] && localConfig[ 'groups' ][ defaultGroup ]

        if( !group ) {
            return { 'schemas': null, 'error': `Default group "${defaultGroup}" not found.` }
        }

        const toolRefs = group[ 'tools' ] || group[ 'schemas' ] || []
        const { schemas } = await ServeCommand.#resolveToolRefs( { toolRefs } )

        return { schemas, 'error': null }
    }


    static async #resolveGroupName( { group, cwd } ) {
        if( group ) {
            return { 'groupName': group, 'error': null, 'fix': null }
        }

        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FsUtils.readJson( { filePath: localConfigPath } )

        if( !localConfig || !localConfig[ 'defaultGroup' ] ) {
            return {
                'groupName': null,
                'error': 'No default group set.',
                'fix': `Run ${appConfig[ 'cliCommand' ]} group set-default <name> or use --group <name>.`
            }
        }

        const { defaultGroup } = localConfig

        return { 'groupName': defaultGroup, 'error': null, 'fix': null }
    }


    static async #resolveGroupSchemas( { groupName, cwd } ) {
        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FsUtils.readJson( { filePath: localConfigPath } )

        if( !localConfig || !localConfig[ 'groups' ] || !localConfig[ 'groups' ][ groupName ] ) {
            return {
                'schemas': null,
                'error': `Group "${groupName}" not found.`,
                'fix': `Run ${appConfig[ 'cliCommand' ]} group list to see available groups.`
            }
        }

        const group = localConfig[ 'groups' ][ groupName ]
        const toolRefs = group[ 'tools' ] || group[ 'schemas' ] || []
        const { schemas } = await ServeCommand.#resolveToolRefs( { toolRefs } )

        return { schemas, 'error': null, 'fix': null }
    }


    static async #resolveToolRefs( { toolRefs } ) {
        const schemaRouteMap = {}

        toolRefs
            .forEach( ( ref ) => {
                const { schemaRef, routeName } = ServeCommand.parseToolRef( { 'toolRef': ref } )
                if( !schemaRouteMap[ schemaRef ] ) {
                    schemaRouteMap[ schemaRef ] = []
                }

                if( routeName ) {
                    schemaRouteMap[ schemaRef ].push( routeName )
                }
            } )

        const schemas = []

        await Object.entries( schemaRouteMap )
            .reduce( ( promise, [ schemaRef, routeNames ] ) => promise.then( async () => {
                const { filePath } = await SchemaSource.resolveSchemaPath( { schemaRef } )
                const { main, handlersFn, error } = await SchemaLoaderBridge.loadSchema( { filePath } )

                if( main ) {
                    if( routeNames.length > 0 ) {
                        const { main: filteredMain } = ServeCommand.#filterMainRoutes( { main, routeNames } )
                        schemas.push( { 'main': filteredMain, handlersFn, 'file': schemaRef } )
                    } else {
                        schemas.push( { main, handlersFn, 'file': schemaRef } )
                    }
                } else {
                    schemas.push( {
                        'main': { 'namespace': 'unknown' },
                        'handlersFn': null,
                        'file': schemaRef,
                        'loadError': error
                    } )
                }
            } ), Promise.resolve() )

        return { schemas }
    }


    static async #resolveActiveToolRefs( { cwd } ) {
        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FsUtils.readJson( { filePath: localConfigPath } )

        if( !localConfig ) {
            return { 'toolRefs': [], 'source': null }
        }

        if( Array.isArray( localConfig[ 'tools' ] ) && localConfig[ 'tools' ].length > 0 ) {
            return { 'toolRefs': localConfig[ 'tools' ], 'source': 'tools' }
        }

        if( localConfig[ 'defaultGroup' ] ) {
            const groupName = localConfig[ 'defaultGroup' ]
            const group = localConfig[ 'groups' ] && localConfig[ 'groups' ][ groupName ]
            if( group ) {
                const groupTools = group[ 'tools' ] || group[ 'schemas' ] || []
                if( groupTools.length > 0 ) {
                    return { 'toolRefs': groupTools, 'source': 'group', 'groupName': groupName }
                }
            }
        }

        return { 'toolRefs': [], 'source': null }
    }


    static async #resolveAgentSchemas( { cwd } ) {
        const { toolRefs } = await ServeCommand.#resolveActiveToolRefs( { cwd } )

        if( toolRefs.length === 0 ) {
            return {
                'schemas': null,
                'error': 'No active tools.',
                'fix': `Use ${appConfig[ 'cliCommand' ]} add <tool-name> to activate tools.`
            }
        }

        const { schemas } = await ServeCommand.#resolveToolRefs( { toolRefs } )

        return { schemas, 'error': null, 'fix': null }
    }


    static #validateEnvParams( { envObject, requiredServerParams, namespace, envPath } ) {
        const missing = requiredServerParams
            .filter( ( param ) => {
                const exists = envObject[ param ] !== undefined

                return !exists
            } )

        if( missing.length > 0 ) {
            const list = missing.join( ', ' )
            const error = `Schema "${namespace}": Missing env vars: ${list}`
            const fix = `Add ${list} to your .env file at ${envPath}`

            return { 'valid': false, error, fix }
        }

        return { 'valid': true, 'error': null, 'fix': null }
    }
}


export { ServeCommand }
