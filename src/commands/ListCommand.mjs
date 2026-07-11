import { FlowMCP, CatalogIndex } from 'flowmcp'

import { ConfigStore } from '../lib/ConfigStore.mjs'
import { CliOutput } from '../lib/CliOutput.mjs'
import { FsUtils } from '../lib/FsUtils.mjs'
import { EnvResolver } from '../lib/EnvResolver.mjs'
import { SchemaSource } from '../lib/SchemaSource.mjs'
import { SchemaLoaderBridge } from '../lib/SchemaLoaderBridge.mjs'
import { NamespaceIndex } from '../lib/NamespaceIndex.mjs'
import { ListsCommand } from './ListsCommand.mjs'
import { SearchCommand } from './SearchCommand.mjs'
import { SqliteGtfsRuntime } from '../addons/SqliteGtfsRuntime.mjs'


// Memo 152 / PRD-019 (D-09 cluster "search-list") — `flowmcp list`, extracted from FlowMcpCli.
// Lists every tool from the configured schemaFolders[] (Memo 099), flags key-gated tools as
// disabled (visible, never hidden), appends dormant sqlite-gtfs auto-tools, and surfaces
// cross-folder spec-id collisions as non-blocking warnings. Reuses SearchCommand.extractParameters
// (shared discovery helper) and the core CatalogIndex.formatCollisionWarnings (the old CLI
// #formatCollisionWarnings was a thin delegation to it). FlowMcpCli.list stays a public
// delegation (index.mjs + tests call it). No back-reference to FlowMcpCli.
class ListCommand {
    static async list( { cwd } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        // Memo 099 Kap 5/6 — list ALL tools from the configured schemaFolders.
        // A tool whose required keys are missing from .env is flagged disabled
        // (visible, never hidden) so the user sees exactly what is unavailable.
        const { config } = await ConfigStore.readConfig( { cwd } )
        const { envPath } = config
        const { data: envContent } = await FsUtils.readText( { filePath: envPath } )
        const envObject = envContent
            ? EnvResolver.parseEnvFile( { envContent } ).envObject
            : {}

        const { schemas, error: resolveError, fix: resolveFix } = await SchemaLoaderBridge.resolveAllSchemas()

        // PRD-008 — a duplicate schemaFolders[] name is a hard config error.
        if( resolveError !== null && resolveError !== undefined ) {
            const result = CliOutput.error( { 'error': resolveError, 'fix': resolveFix } )

            return { result }
        }

        const tools = []
        let disabledCount = 0

        const sharedListsMap = {}
        await schemas
            .reduce( ( promise, { main, file } ) => promise.then( async () => {
                if( main && main[ 'sharedLists' ] && main[ 'sharedLists' ].length > 0 && file ) {
                    const { filePath } = await SchemaSource.resolveSchemaPath( { schemaRef: file } )
                    const { sharedLists: resolved } = await ListsCommand.resolveSharedListsForSchema( { main, filePath } )
                    sharedListsMap[ file ] = resolved
                }
            } ), Promise.resolve() )

        schemas
            .forEach( ( { main, file } ) => {
                if( !main || !( main[ 'routes' ] || main[ 'tools' ] ) ) {
                    return
                }

                const namespace = main[ 'namespace' ] || 'unknown'
                const routes = main[ 'routes' ] || main[ 'tools' ]
                const schemaTags = main[ 'tags' ] || []
                const sharedLists = sharedListsMap[ file ] || {}

                const requiredKeys = main[ 'requiredServerParams' ] || []
                const missingKeys = requiredKeys
                    .filter( ( key ) => {
                        const present = envObject[ key ] !== undefined && String( envObject[ key ] ).length > 0

                        return present === false
                    } )
                const disabled = missingKeys.length > 0

                Object.keys( routes )
                    .forEach( ( routeName ) => {
                        try {
                            const { toolName: name } = FlowMCP.buildToolName( { routeName, namespace } )
                            const description = routes[ routeName ][ 'description' ] || ''

                            const routeConfig = routes[ routeName ]
                            const routeParameters = routeConfig[ 'parameters' ] || []
                            const { parameters } = SearchCommand.extractParameters( { routeParameters, sharedLists } )

                            const entry = { name, description, 'tags': schemaTags, parameters }
                            if( disabled === true ) {
                                entry[ 'disabled' ] = true
                                entry[ 'disabledReason' ] = `missing ${missingKeys.join( ', ' )}`
                                disabledCount += 1
                            }

                            tools.push( entry )
                        } catch( err ) {
                            // skip broken tools
                            process.stderr.write( `CLI-006 list: broken tool skipped: ${err.message}\n` )
                        }
                    } )
            } )

        // Memo 051 PRD-19 — include auto-injected tools from cached sqlite-gtfs schemas
        const { entries: sealCacheEntries } = await SqliteGtfsRuntime.listSqliteGtfsCacheEntries()
        sealCacheEntries
            .forEach( ( entry ) => {
                const entryTools = entry && entry[ 'tools' ] ? entry[ 'tools' ] : []
                entryTools
                    .forEach( ( tool ) => {
                        tools.push( {
                            'name': tool.name,
                            'description': tool.description || '',
                            'tags': [],
                            'parameters': {},
                            'auto': tool.auto === true,
                            'schema': entry[ 'schemaName' ]
                        } )
                    } )
            } )

        // PRD-009 — surface collisions across schemaFolders[] (all four primitives)
        // as visible, non-blocking warnings with the copyable "<source>:<spec-id>"
        // fix. Never blocks `list`; the unqualified call still uses the first match.
        const { index } = await NamespaceIndex.get( { cwd } )
        const { warnings: collisionWarnings } = CatalogIndex.formatCollisionWarnings( { 'collisions': index ? index[ 'collisions' ] : [] } )

        const result = {
            'status': true,
            'toolCount': tools.length,
            disabledCount,
            tools,
            collisionWarnings
        }

        return { result }
    }
}


export { ListCommand }
