import { FlowMCP, ZodBuilder } from 'flowmcp'

import { appConfig } from '../data/config.mjs'
import { ConfigStore } from '../lib/ConfigStore.mjs'
import { CliOutput } from '../lib/CliOutput.mjs'
import { FsUtils } from '../lib/FsUtils.mjs'
import { EnvResolver } from '../lib/EnvResolver.mjs'
import { SchemaSource } from '../lib/SchemaSource.mjs'
import { SchemaLoaderBridge } from '../lib/SchemaLoaderBridge.mjs'
import { HandlerResolver } from '../lib/HandlerResolver.mjs'


// Memo 152 / PRD-019 (D-09 cluster "serve-mcp") — `flowmcp run`, extracted from FlowMcpCli.
// Spins up an MCP stdio server exposing the tools/resources/prompts of the active schemas.
//
// Memo 152 / PRD-020 (D-12 / F18=A) — the --group concept is gone (Memo 099: one concept,
// selection replaces groups). `run` now serves the whole configured schemaFolders[] catalog
// (a schema whose required keys are missing is disabled/skipped, not a hard abort). The former
// group- and active-tool resolution helpers were removed; a legacy `--group` on the command line
// is rejected with a hint to `dev selection`. parseToolRef and disambiguateToolName stay PUBLIC
// static (MigrateCommand + the __testOnly_planServeToolNames hook consume them). FlowMcpCli.run
// stays a public delegation. No back-reference to FlowMcpCli.
class ServeCommand {
    // Memo 152 / PRD-020 (D-12) — a removed `--group` on the argv is rejected fail-loud with a
    // selection hint. Kept out of index.mjs (the dispatcher no longer knows the flag).
    static legacyGroupResult() {
        const hasGroupFlag = process.argv
            .some( ( arg ) => arg === '--group' || arg.startsWith( '--group=' ) )

        if( hasGroupFlag === false ) {
            return { 'legacy': false, 'result': null }
        }

        const result = CliOutput.error( {
            'error': 'GRP-001 run: the --group flag was removed — groups were replaced by named selections (Memo 099).',
            'fix': `Use a named selection instead: ${appConfig[ 'cliCommand' ]} dev selection list | show <name>`
        } )

        return { 'legacy': true, result }
    }


    static async run( { cwd } ) {
        const { legacy, result: legacyResult } = ServeCommand.legacyGroupResult()
        if( legacy === true ) {
            return { result: legacyResult }
        }

        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        // Memo 099 Kap 5 — serve every tool from the configured schemaFolders[] (no group,
        // no activation). A duplicate schemaFolders[] name is a hard config error.
        const { schemas: allSchemas, error: resolveError, fix: resolveFix } = await SchemaLoaderBridge.resolveAllSchemas()
        if( resolveError !== null && resolveError !== undefined ) {
            const result = CliOutput.error( { 'error': resolveError, 'fix': resolveFix } )

            return { result }
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

        // Memo 099 — a schema whose required keys are missing is DISABLED (skipped with a
        // visible stderr note), never a hard abort. Serve everything else.
        const resolvedSchemas = allSchemas
            .filter( ( { main } ) => {
                const namespace = main[ 'namespace' ] || 'unknown'
                const requiredServerParams = main[ 'requiredServerParams' ] || []
                const { valid } = ServeCommand.#validateEnvParams( { envObject, requiredServerParams, namespace, envPath } )

                if( valid === false ) {
                    const missingParams = requiredServerParams
                        .filter( ( param ) => envObject[ param ] === undefined )
                    process.stderr.write( `${appConfig[ 'appName' ]}: schema "${namespace}" disabled (missing ${missingParams.join( ', ' )}) — skipped.\n` )
                }

                return valid
            } )

        const serverName = 'default'

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

                                    // Memo 157 Kap 2 — real Zod from the query's parameters (was an
                                    // empty `{}`, leaving the MCP host with no input schema).
                                    const queryZod = ServeCommand.buildResourceQueryZod( { queryDef } )

                                    server.tool( toolName, description, queryZod, async ( args ) => {
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

        const result = { 'status': true, 'mode': 'stdio', 'server': serverName }

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


    // Memo 157 Kap 2 — build the real Zod input shape for a resource query from its
    // `parameters` (was: an empty `{}`, leaving the MCP host blind to the query inputs).
    // Reuses the same core ZodBuilder the tool path uses (FlowMCP.prepareServerTool ->
    // ZodBuilder.getZodSchema). Public because a unit test exercises it directly.
    static buildResourceQueryZod( { queryDef } ) {
        const parameters = queryDef !== undefined && queryDef !== null && Array.isArray( queryDef[ 'parameters' ] )
            ? queryDef[ 'parameters' ]
            : []

        if( parameters.length === 0 ) {
            return {}
        }

        const zod = ZodBuilder.getZodSchema( { 'route': { parameters } } )

        return zod
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
