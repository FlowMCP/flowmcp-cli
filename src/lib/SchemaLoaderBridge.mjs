import { readdir, stat } from 'node:fs/promises'
import { resolve, join, basename, extname } from 'node:path'

import { SchemaLoader } from 'flowmcp'

import { SchemaSource } from './SchemaSource.mjs'


// Memo 152 / PRD-019 (D-08 foundation cluster "schema-loading-bridge") — the schema
// resolution helpers extracted from FlowMcpCli. `loadSchema` delegates the raw module
// import to the core v4 SchemaLoader.load and keeps only the CLI's { main, handlersFn,
// error } error-adapter contract (SchemaLoader throws on a bad import and returns
// main:null on a module without a main export). The higher helpers (loadSchemasFromPath /
// resolveAllSchemas / loadAllSchemas / tryLoadSingleSchema) are the callable surface used
// across the search/list/call/serve/validate/doctor paths. Return shapes are preserved
// byte-for-byte — these are pure move-and-facade with no behaviour change. Depends only on
// core SchemaLoader + lib SchemaSource + node builtins; no back-reference to FlowMcpCli.
class SchemaLoaderBridge {
    static async loadSchema( { filePath, bustCache = false } ) {
        try {
            const resolvedPath = resolve( filePath )
            const { main, handlersFn } = await SchemaLoader.load( { 'filePath': resolvedPath, bustCache } )

            if( !main ) {
                return { 'main': null, 'handlersFn': null, 'error': `No main export in: ${filePath}` }
            }

            return { main, handlersFn, 'error': null }
        } catch( err ) {
            return { 'main': null, 'handlersFn': null, 'error': `SCH-003 loadSchema: Failed to load schema: ${filePath} - ${err.message}` }
        }
    }


    static async loadSchemasFromPath( { schemaPath } ) {
        const resolvedPath = resolve( schemaPath )

        let pathStat
        try {
            pathStat = await stat( resolvedPath )
        } catch {
            return { 'schemas': null, 'error': `SCH-004 loadSchemasFromPath: Path not found: ${schemaPath}` }
        }

        if( pathStat.isFile() ) {
            const { main, handlersFn, error } = await SchemaLoaderBridge.loadSchema( { filePath: resolvedPath } )
            if( !main ) {
                return { 'schemas': null, error }
            }

            const file = basename( resolvedPath )
            const schemas = [ { main, handlersFn, file } ]

            return { schemas, 'error': null }
        }

        if( pathStat.isDirectory() ) {
            const files = await readdir( resolvedPath )
            const schemaFiles = files
                .filter( ( file ) => {
                    const ext = extname( file )
                    const isSchema = ext === '.mjs' || ext === '.js'

                    return isSchema
                } )
                .sort()

            if( schemaFiles.length === 0 ) {
                return { 'schemas': null, 'error': `No schema files (.mjs, .js) found in: ${schemaPath}` }
            }

            const schemas = []

            await schemaFiles
                .reduce( ( promise, file ) => promise.then( async () => {
                    const filePath = join( resolvedPath, file )
                    const { main, handlersFn, error } = await SchemaLoaderBridge.loadSchema( { filePath } )

                    if( main ) {
                        schemas.push( { main, handlersFn, file } )
                    } else {
                        schemas.push( {
                            'main': { 'namespace': file },
                            'handlersFn': null,
                            file,
                            'loadError': error
                        } )
                    }
                } ), Promise.resolve() )

            return { schemas, 'error': null }
        }

        return { 'schemas': null, 'error': `Path is neither a file nor a directory: ${schemaPath}` }
    }


    // Memo 099 Kap 5 — load ALL schemas from the configured schemaFolders[].
    // No activation: every tool in every folder is immediately resolvable.
    static async resolveAllSchemas() {
        const { sources, error: sourcesError, fix: sourcesFix } = await SchemaSource.listSources()

        // PRD-008 — a duplicate schemaFolders[] name is a hard config error; surface
        // it instead of silently resolving an empty / ambiguous schema list.
        if( sourcesError !== null && sourcesError !== undefined ) {
            return { 'schemas': [], 'error': sourcesError, 'fix': sourcesFix }
        }

        const schemas = []

        await sources
            .reduce( ( promise, source ) => promise.then( async () => {
                const { name: sourceName, schemas: sourceSchemas } = source

                await sourceSchemas
                    .reduce( ( schemaPromise, schemaEntry ) => schemaPromise.then( async () => {
                        const { file, requiredServerParams } = schemaEntry
                        const schemaRef = `${sourceName}/${file}`
                        const { filePath } = await SchemaSource.resolveSchemaPath( { schemaRef } )
                        const { main, handlersFn } = await SchemaLoaderBridge.loadSchema( { filePath } )

                        if( main ) {
                            schemas.push( {
                                main,
                                handlersFn,
                                'file': schemaRef,
                                // PRD-008 — carry the source coordinate (folder name) so the
                                // serve/list/call layers can disambiguate identical providers.
                                'source': sourceName,
                                'requiredServerParams': Array.isArray( requiredServerParams ) ? requiredServerParams : ( main[ 'requiredServerParams' ] || [] )
                            } )
                        }
                    } ), Promise.resolve() )
            } ), Promise.resolve() )

        return { schemas, 'error': null, 'fix': null }
    }


    static async loadAllSchemas() {
        const { sources, error: sourcesError, fix: sourcesFix } = await SchemaSource.listSources()

        // PRD-008 — duplicate schemaFolders[] name is a hard config error.
        if( sourcesError !== null && sourcesError !== undefined ) {
            return { 'schemas': [], 'error': sourcesError, 'fix': sourcesFix }
        }

        const allSchemas = []

        await sources
            .reduce( ( promise, source ) => promise.then( async () => {
                await source[ 'schemas' ]
                    .reduce( ( innerPromise, schemaInfo ) => innerPromise.then( async () => {
                        const { file } = schemaInfo
                        const { filePath } = await SchemaSource.resolveSchemaPath( { schemaRef: `${source[ 'name' ]}/${file}` } )
                        const { main, handlersFn, error } = await SchemaLoaderBridge.loadSchema( { filePath } )

                        if( main ) {
                            allSchemas.push( { main, handlersFn, file, 'source': source[ 'name' ] } )
                        } else {
                            allSchemas.push( {
                                'main': null,
                                'handlersFn': null,
                                file,
                                'source': source[ 'name' ],
                                'loadError': error
                            } )
                        }
                    } ), Promise.resolve() )
            } ), Promise.resolve() )

        return { 'schemas': allSchemas }
    }


    static async tryLoadSingleSchema( { schemaRef } ) {
        try {
            const { filePath } = await SchemaSource.resolveSchemaPath( { schemaRef } )
            const { main, handlersFn } = await SchemaLoaderBridge.loadSchema( { filePath } )

            return { main, handlersFn }
        } catch {
            return null
        }
    }
}


export { SchemaLoaderBridge }
