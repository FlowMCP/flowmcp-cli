/**
 * FlowMCP — MIT License
 *
 * SchemaSource (Memo 152 PRD-017 / D-04) — schemaFolders[] path resolution: turn
 * a schema ref (`<source>/<rest>`) into an on-disk file path. This is the CLI
 * side of the boundary (WHERE a schema lives); LOADING it (reading the module,
 * resolving handlers/libraries) moves to core in PRD-018. Depends on ConfigStore
 * for the source-dir resolution.
 *
 * PRD-018 (D-06) has ported the schema-LOAD leaf to core (SchemaLoader.load), so the
 * back-dependency that kept #listSources in FlowMcpCli is gone. #listSources (the
 * schemaFolders[] enumeration = "Config-Quellen") and its pure FS-scan helper
 * #listSchemaFiles now live here (PRD-019 / D-08). They read only config + disk.
 */

import { readdir, stat } from 'node:fs/promises'
import { join, extname } from 'node:path'

import { ConfigStore } from './ConfigStore.mjs'
import { FsUtils } from './FsUtils.mjs'
import { CliOutput } from './CliOutput.mjs'


class SchemaSource {
    static async resolveSchemaPath( { schemaRef } ) {
        if( typeof schemaRef !== 'string' || schemaRef.length === 0 ) {
            return { filePath: join( ConfigStore.schemasDir(), String( schemaRef ) ), isLocal: false }
        }

        const slashIndex = schemaRef.indexOf( '/' )
        if( slashIndex === -1 ) {
            return { filePath: join( ConfigStore.schemasDir(), schemaRef ), isLocal: false }
        }

        const sourceName = schemaRef.slice( 0, slashIndex )
        const rest = schemaRef.slice( slashIndex + 1 )
        const { sourceDir, isLocal } = await ConfigStore.resolveSourceDir( { sourceName } )
        const filePath = join( sourceDir, rest )

        return { filePath, isLocal }
    }


    // Memo 149 Strang B (F4=B) — single source of truth for a schema's on-disk file
    // path. callTool (param + handler path), serve and the resource-query path all
    // resolve through here.
    static async resolveSchemaFilePath( { schemaRef } ) {
        if( !schemaRef ) {
            return { filePath: '' }
        }

        const { filePath } = await SchemaSource.resolveSchemaPath( { schemaRef } )

        return { filePath }
    }


    // Memo 099 Kap 4 — schemaFolders[] is the single source of truth (the disk = the truth).
    // Enumerate every configured source and the schemas it declares (via _registry.json when
    // present, otherwise a raw FS scan). Legacy ~/.flowmcp/schemas scan + localSources are the
    // fallback until migration (Memo 099 Kap 9).
    static async listSources() {
        const schemasBaseDir = ConfigStore.schemasDir()
        const globalConfigPath = ConfigStore.globalConfigPath()
        const { data: globalConfig } = await FsUtils.readJson( { filePath: globalConfigPath } )
        const configSources = ( globalConfig && globalConfig[ 'sources' ] ) || {}

        const { schemaFolders, duplicateError } = await ConfigStore.readSchemaFolders()

        // PRD-008 — a duplicate folder name is a hard config error (the "<source>:"
        // coordinate would be ambiguous). Surface it instead of resolving sources.
        if( duplicateError !== null && duplicateError !== undefined ) {
            return { 'sources': [], 'error': duplicateError.error, 'fix': duplicateError.fix }
        }

        let allSourceNames = []

        if( schemaFolders.length > 0 ) {
            allSourceNames = schemaFolders
                .map( ( entry ) => entry[ 'name' ] )
        } else {
            const { localSources } = await ConfigStore.readLocalSources()

            let sourceDirs = []
            try {
                const entries = await readdir( schemasBaseDir )
                const dirChecks = await entries
                    .reduce( ( promise, entry ) => promise.then( async ( acc ) => {
                        const entryPath = join( schemasBaseDir, entry )
                        const entryStat = await stat( entryPath )
                        if( entryStat.isDirectory() ) {
                            acc.push( entry )
                        }

                        return acc
                    } ), Promise.resolve( [] ) )

                sourceDirs = dirChecks
            } catch( err ) {
                CliOutput.emitCoded( { 'code': 'CFG-002', 'location': 'listSources: schemas dir scan failed', err } )
                sourceDirs = []
            }

            const localSourceNames = Object.keys( localSources )
                .filter( ( name ) => sourceDirs.includes( name ) === false )
            allSourceNames = [ ...sourceDirs, ...localSourceNames ]
        }

        const sources = []

        await allSourceNames
            .reduce( ( promise, sourceDir ) => promise.then( async () => {
                const { sourceDir: sourcePath, isLocal } = await ConfigStore.resolveSourceDir( { sourceName: sourceDir } )
                const sourceConfig = configSources[ sourceDir ] || {}
                const { type, repository } = sourceConfig

                const registryPath = join( sourcePath, '_registry.json' )
                const { data: registry } = await FsUtils.readJson( { filePath: registryPath } )

                let schemas = []

                if( registry && Array.isArray( registry[ 'schemas' ] ) ) {
                    schemas = registry[ 'schemas' ]
                        .map( ( entry ) => {
                            const { file, namespace, name, requiredServerParams } = entry
                            const ref = `${sourceDir}/${file}`
                            const schemaInfo = { ref, file, namespace, name, requiredServerParams }

                            return schemaInfo
                        } )
                } else {
                    const files = await SchemaSource.#listSchemaFiles( { dirPath: sourcePath } )
                    const schemaCandidates = files
                        .filter( ( file ) => {
                            const isSkillDoc = file.includes( '/skills/' ) || file.startsWith( 'skills/' )

                            return isSkillDoc === false
                        } )

                    schemas = schemaCandidates
                        .map( ( file ) => {
                            const ref = `${sourceDir}/${file}`
                            const schemaInfo = {
                                ref,
                                file,
                                'namespace': sourceDir,
                                'name': file,
                                'requiredServerParams': []
                            }

                            return schemaInfo
                        } )
                }

                const resolvedType = isLocal === true ? 'local' : ( type || 'builtin' )

                const sourceEntry = {
                    'name': sourceDir,
                    'type': resolvedType,
                    'repository': repository || null,
                    'schemaCount': schemas.length,
                    schemas
                }

                sources.push( sourceEntry )
            } ), Promise.resolve() )

        return { sources, 'error': null, 'fix': null }
    }


    // Pure recursive FS-scan of a schema source directory: relative .mjs/.js paths,
    // skipping underscore-prefixed entries (_registry.json, _lists, _shared …).
    static async #listSchemaFiles( { dirPath, prefix = '' } ) {
        const entries = await readdir( dirPath )
        const files = []

        await entries
            .reduce( ( promise, entry ) => promise.then( async () => {
                if( entry.startsWith( '_' ) ) {
                    return
                }

                const entryPath = join( dirPath, entry )
                const entryStat = await stat( entryPath )

                if( entryStat.isDirectory() ) {
                    const subFiles = await SchemaSource.#listSchemaFiles( {
                        'dirPath': entryPath,
                        'prefix': prefix ? `${prefix}/${entry}` : entry
                    } )

                    subFiles
                        .forEach( ( subFile ) => {
                            files.push( subFile )
                        } )
                } else {
                    const ext = extname( entry )
                    if( ext === '.mjs' || ext === '.js' ) {
                        const relativePath = prefix ? `${prefix}/${entry}` : entry
                        files.push( relativePath )
                    }
                }
            } ), Promise.resolve() )

        return files
    }
}


export { SchemaSource }
