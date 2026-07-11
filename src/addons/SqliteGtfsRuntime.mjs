import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import Database from 'better-sqlite3'

import { appConfig } from '../data/config.mjs'
import { ADDON_REGISTRY } from '../data/addons.mjs'
import { HttpCache } from '../lib/HttpCache.mjs'
import { CliOutput } from '../lib/CliOutput.mjs'
import { AddonLoader } from './loadAddon.mjs'


// Memo 152 / PRD-019 (D-09 cluster "sqlite-gtfs-addon", live part) — the sqlite-gtfs runtime
// read path, extracted from FlowMcpCli. Memo 051 built an add-time seal pipeline behind the
// `add` command; that producer was removed with `add` (Memo 099 / Memo 152 PRD-016). Only the
// runtime reader survives here: listSqliteGtfsCacheEntries() reads the seal cache, and
// maybeCallSqliteGtfsAutoTool() dispatches an auto-tool call against it. NOTE (honest state):
// no producer writes that cache anymore, so this runtime is DORMANT — there is currently no
// seal producer, so #maybeCallSqliteGtfsAutoTool returns null for every real install. It is
// kept as-is (not faked) pending a seal-producer decision (Memo 152 P7). CallCommand +
// ListCommand call the two public entry points. No back-reference to FlowMcpCli.
class SqliteGtfsRuntime {
    static #sqliteGtfsCacheDir( { sourceKey } ) {
        const dir = join( HttpCache.cacheDir(), sourceKey )

        return dir
    }


    static async listSqliteGtfsCacheEntries() {
        const entries = []
        const sourceKeys = Object.keys( ADDON_REGISTRY )

        await sourceKeys
            .reduce( ( outer, sourceKey ) => outer.then( async () => {
                const dir = SqliteGtfsRuntime.#sqliteGtfsCacheDir( { sourceKey } )

                try {
                    const files = await readdir( dir )
                    const jsonFiles = files
                        .filter( ( name ) => {
                            const isJson = name.endsWith( '.json' )

                            return isJson
                        } )

                    await jsonFiles
                        .reduce( ( inner, name ) => inner.then( async () => {
                            try {
                                const raw = await readFile( join( dir, name ), 'utf-8' )
                                const parsed = JSON.parse( raw )
                                entries.push( parsed )
                            } catch( err ) {
                                // corrupt — skip
                                process.stderr.write( `SQL-001 listSealCache: corrupt seal cache skipped: ${err.message}\n` )
                            }
                        } ), Promise.resolve() )
                } catch( err ) {
                    // cache dir for this source doesn't exist yet
                    CliOutput.emitCoded( { 'code': 'SQL-002', 'location': 'listSealCache: cache dir read failed', err } )
                }
            } ), Promise.resolve() )

        return { entries }
    }


    static #executeSqliteGtfsSqlTemplate( { dbPath, sqlTemplate, paramDefs, userParams } ) {
        // Build named-parameter map from user params + defaults
        const merged = {}
        Object
            .entries( paramDefs )
            .forEach( ( [ key, def ] ) => {
                if( userParams[ key ] !== undefined ) {
                    merged[ key ] = userParams[ key ]
                } else if( def && Object.prototype.hasOwnProperty.call( def, 'default' ) ) {
                    merged[ key ] = def.default
                }
            } )

        // better-sqlite3 named-parameter binding uses `:name`. The sqlTemplate
        // already uses `:name` style — strip the colons for the binding object.
        const bindings = {}
        Object
            .entries( merged )
            .forEach( ( [ key, value ] ) => {
                bindings[ key ] = value
            } )

        const db = new Database( dbPath, { 'readonly': true } )
        try {
            const stmt = db.prepare( sqlTemplate )
            const rows = stmt.all( bindings )

            return rows
        } finally {
            try { db.close() } catch( err ) { process.stderr.write( `SQL-009 sqlTemplate: db close failed: ${err.message}\n` ) }
        }
    }


    static async maybeCallSqliteGtfsAutoTool( { toolName, jsonArgs, noCache, refresh } ) {
        if( typeof toolName !== 'string' || !toolName.includes( '.' ) ) { return null }

        const { entries } = await SqliteGtfsRuntime.listSqliteGtfsCacheEntries()
        if( entries.length === 0 ) { return null }

        let matched = null
        entries
            .forEach( ( entry ) => {
                if( matched ) { return }
                const toolList = entry && entry[ 'tools' ] ? entry[ 'tools' ] : []
                const hit = toolList
                    .find( ( t ) => {
                        const isAutoMatch = t && t.auto === true && t.name === toolName

                        return isAutoMatch
                    } )

                if( hit ) {
                    matched = { entry, 'tool': hit }
                }
            } )

        if( !matched ) { return null }

        const { entry, tool } = matched

        let userParams = {}
        if( jsonArgs ) {
            try {
                userParams = JSON.parse( jsonArgs )
            } catch {
                const result = CliOutput.error( {
                    'error': 'SQL-010 autoTool: Invalid JSON argument.',
                    'fix': `Provide valid JSON: ${appConfig[ 'cliCommand' ]} call ${toolName} '{"param": "value"}'`
                } )

                return { result }
            }
        }

        // Cache layer (PRD-20 — reuse standard cache helpers)
        const isCacheable = !noCache
        if( isCacheable && !refresh ) {
            const { cacheKey } = HttpCache.buildCacheKey( {
                'namespace': entry[ 'namespace' ],
                'routeName': tool[ 'localName' ],
                userParams
            } )
            const { data: cachedData, meta: cacheMeta, isExpired } = await HttpCache.readCache( { cacheKey } )
            if( cachedData && !isExpired ) {
                const result = {
                    'status': true,
                    'toolName': toolName,
                    'content': cachedData,
                    'cache': {
                        'hit': true,
                        'fetchedAt': cacheMeta[ 'fetchedAt' ],
                        'expiresAt': cacheMeta[ 'expiresAt' ]
                    }
                }

                return { result }
            }
        }

        let addonLoaded
        try {
            addonLoaded = await AddonLoader.loadAddon( { 'sourceKey': entry[ 'sourceKey' ] } )
        } catch( err ) {
            const result = CliOutput.error( {
                'error': `SQL-011 autoTool: Failed to load addon '${entry[ 'addonName' ]}': ${err.message}`,
                'fix': `Ensure '${entry[ 'addonName' ]}' is installed as a package.json dependency.`
            } )

            return { result }
        }

        const FlowMcpAdapter = addonLoaded.addonModule.FlowMcpAdapter
        if( !FlowMcpAdapter ) {
            const result = CliOutput.error( {
                'error': `Addon ${entry[ 'addonName' ]} does not export FlowMcpAdapter.`,
                'fix': `Update ${entry[ 'addonName' ]} to expose the FlowMcpAdapter consumer API.`
            } )

            return { result }
        }

        const isUrlMode = entry[ 'mode' ] === 'url'

        // URL mode (Memo 096): the in-memory store is process-local, so re-load
        // on first runtime call. The add-on caches by url with its own TTL.
        if( isUrlMode ) {
            try {
                await FlowMcpAdapter.loadFromUrl( { 'url': entry[ 'url' ], 'parseConfig': entry[ 'parseConfig' ] } )
            } catch( err ) {
                const result = CliOutput.error( {
                    'error': `SQL-012 autoTool: Failed to load url resource '${entry[ 'url' ]}' for '${toolName}': ${err.message}`,
                    'fix': `Verify the url is reachable over HTTPS and returns a valid document.`
                } )

                return { result }
            }
        }

        let methodsResult
        try {
            methodsResult = isUrlMode
                ? FlowMcpAdapter.getAvailableMethods( { 'url': entry[ 'url' ] } )
                : FlowMcpAdapter.getAvailableMethods( { 'dbPath': entry[ 'dbPath' ] } )
        } catch( err ) {
            const result = CliOutput.error( {
                'error': `SQL-013 autoTool: Failed to read addon methods for ${entry[ 'addonName' ]}: ${err.message}`,
                'fix': `Run '${appConfig[ 'cliCommand' ]} add ${entry[ 'schemaFile' ] || entry[ 'schemaName' ]}' to refresh the cache.`
            } )

            return { result }
        }

        const method = methodsResult.methods
            .find( ( m ) => {
                const isMatch = m && m.name === tool[ 'localName' ]

                return isMatch
            } )

        if( !method ) {
            const result = CliOutput.error( {
                'error': `Auto-tool '${toolName}' not provided by addon '${entry[ 'addonName' ]}'.`,
                'fix': `Run '${appConfig[ 'cliCommand' ]} add ${entry[ 'schemaFile' ] || entry[ 'schemaName' ]}' to refresh the cache after a DB change.`
            } )

            return { result }
        }

        let handlerResult
        try {
            if( isUrlMode ) {
                // URL mode: the add-on owns the method; dispatch by name over in-memory data.
                handlerResult = FlowMcpAdapter.executeMethod( {
                    'url': entry[ 'url' ],
                    'method': method.name,
                    'params': userParams
                } )
            } else if( typeof method.handler === 'function' ) {
                handlerResult = await method.handler( { 'dbPath': entry[ 'dbPath' ], 'params': userParams } )
            } else if( typeof method.sqlTemplate === 'string' && method.sqlTemplate.length > 0 ) {
                // Fallback execution path — toolkit declares sqlTemplate + params, CLI runs it
                // against the sealed sqlite-gtfs DB (Memo 051 PRD-20).
                handlerResult = SqliteGtfsRuntime.#executeSqliteGtfsSqlTemplate( {
                    'dbPath': entry[ 'dbPath' ],
                    'sqlTemplate': method.sqlTemplate,
                    'paramDefs': method.params || {},
                    'userParams': userParams
                } )
            } else {
                const result = CliOutput.error( {
                    'error': `Addon method '${method.name}' has neither a handler nor a sqlTemplate.`,
                    'fix': `Update '${entry[ 'addonName' ]}' to expose a callable handler or sqlTemplate.`
                } )

                return { result }
            }
        } catch( err ) {
            const result = CliOutput.error( {
                'error': `SQL-014 autoTool: Auto-tool '${toolName}' handler failed: ${err.message}`,
                'fix': `Verify input parameters and that the DB is readable at ${entry[ 'dbPath' ]}.`
            } )

            return { result }
        }

        if( isCacheable ) {
            const { cacheKey } = HttpCache.buildCacheKey( {
                'namespace': entry[ 'namespace' ],
                'routeName': tool[ 'localName' ],
                userParams
            } )
            const ttlSeconds = 60
            const { meta: writeMeta } = await HttpCache.writeCache( {
                cacheKey,
                'data': handlerResult,
                'ttl': ttlSeconds
            } )

            const result = {
                'status': true,
                'toolName': toolName,
                'content': handlerResult,
                'cache': {
                    'hit': false,
                    'stored': true,
                    'expiresAt': writeMeta[ 'expiresAt' ]
                }
            }

            return { result }
        }

        const result = {
            'status': true,
            'toolName': toolName,
            'content': handlerResult,
            'cache': {
                'hit': false,
                'stored': false
            }
        }

        return { result }
    }
}


export { SqliteGtfsRuntime }
