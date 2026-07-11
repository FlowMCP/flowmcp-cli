import { mkdir, rename } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'

import Database from 'better-sqlite3'
import inquirer from 'inquirer'

import { ConfigStore } from '../lib/ConfigStore.mjs'
import { FsUtils } from '../lib/FsUtils.mjs'
import { CliOutput } from '../lib/CliOutput.mjs'


// Memo 152 / PRD-019 (D-08) — the `flowmcp dev resource create/migrate` commands.
// Creates / migrates file-based SQLite resource databases declared in a schema's
// resources[]. Depends only on lib modules (ConfigStore/FsUtils/CliOutput) +
// better-sqlite3 + inquirer — no back-reference to FlowMcpCli. validationResourceCreate
// stays public here (tests call it directly via the FlowMcpCli facade delegation).
class ResourceCommand {
    static async resourceCreate( { schemaPath, cwd, basis = 'flowmcp', autoConfirm = false } ) {
        const { status: validStatus, messages: validMessages } = ResourceCommand.validationResourceCreate( { schemaPath } )
        if( !validStatus ) {
            const result = { 'status': false, 'messages': validMessages }

            return { result }
        }

        const resolvedPath = resolve( schemaPath )

        let schemaModule
        try {
            const fileUrl = pathToFileURL( resolvedPath ).href
            schemaModule = await import( fileUrl )
        } catch( err ) {
            const result = CliOutput.error( {
                'error': `SQL-015 resourceCreate: Failed to load schema: ${err.message}`,
                'fix': 'Ensure the schema file exports a valid "main" object.'
            } )

            return { result }
        }

        const main = schemaModule[ 'main' ]
        if( !main ) {
            const result = CliOutput.error( {
                'error': 'Schema does not export "main".',
                'fix': 'The schema file must export const main = { ... }'
            } )

            return { result }
        }

        const resources = main[ 'resources' ] || {}
        const entries = Object.entries( resources )

        const fileBasedResources = entries
            .filter( ( [ , resourceDef ] ) => {
                const isFileBased = resourceDef[ 'source' ] === 'sqlite' && resourceDef[ 'mode' ] === 'file-based'

                return isFileBased
            } )

        if( fileBasedResources.length === 0 ) {
            const result = {
                'status': true,
                'message': 'No file-based SQLite resources found in this schema.',
                'created': 0
            }

            return { result }
        }

        const results = []
        let created = 0
        let skipped = 0
        let failed = 0

        await fileBasedResources
            .reduce( ( promise, [ resourceName, resourceDef ] ) => promise.then( async () => {
                const { dbPath } = ResourceCommand.#resolveResourcePath( {
                    'origin': resourceDef[ 'origin' ],
                    'name': resourceDef[ 'name' ],
                    basis,
                    cwd
                } )

                if( existsSync( dbPath ) ) {
                    skipped += 1
                    results.push( { resourceName, dbPath, 'action': 'skipped', 'reason': 'Database already exists' } )

                    return
                }

                if( !autoConfirm ) {
                    const { confirm } = await inquirer.prompt( [
                        {
                            'type': 'confirm',
                            'name': 'confirm',
                            'message': `Create database "${resourceName}" at ${dbPath}?`,
                            'default': true
                        }
                    ] )

                    if( !confirm ) {
                        skipped += 1
                        results.push( { resourceName, dbPath, 'action': 'skipped', 'reason': 'User declined' } )

                        return
                    }
                }

                try {
                    const dbDir = dirname( dbPath )
                    await mkdir( dbDir, { recursive: true } )

                    const { tableStatements } = ResourceCommand.#deriveCreateStatements( { resourceDef } )

                    const db = new Database( dbPath )
                    db.pragma( 'journal_mode = WAL' )

                    tableStatements
                        .forEach( ( sql ) => {
                            db.exec( sql )
                        } )

                    db.close()

                    created += 1
                    results.push( {
                        resourceName,
                        dbPath,
                        'action': 'created',
                        'tables': tableStatements.length
                    } )
                } catch( err ) {
                    CliOutput.emitCoded( { 'code': 'SQL-016', 'location': 'resourceCreate: db creation failed', err } )
                    failed += 1
                    results.push( { resourceName, dbPath, 'action': 'failed', 'reason': err.message } )
                }
            } ), Promise.resolve() )

        const result = {
            'status': failed === 0,
            created,
            skipped,
            failed,
            results
        }

        return { result }
    }


    static validationResourceCreate( { schemaPath } ) {
        const struct = { 'status': false, 'messages': [] }

        if( schemaPath === undefined || schemaPath === null ) {
            struct[ 'messages' ].push( 'schemaPath: Missing value. Provide a path to a schema file.' )
        } else if( typeof schemaPath !== 'string' ) {
            struct[ 'messages' ].push( 'schemaPath: Must be a string.' )
        }

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    static async resourceMigrate( { cwd, basis = 'flowmcp', dryRun = false, autoConfirm = false } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const schemasDir = ConfigStore.schemasDir()
        let schemaFiles = []

        try {
            const { files } = await FsUtils.findSchemaFiles( { 'dirPath': schemasDir } )
            schemaFiles = files
        } catch( err ) {
            CliOutput.emitCoded( { 'code': 'SQL-017', 'location': 'resourceMigrate: schema files scan failed', err } )
            schemaFiles = []
        }

        const migrations = []

        await schemaFiles
            .reduce( ( promise, filePath ) => promise.then( async () => {
                try {
                    const fileUrl = pathToFileURL( filePath ).href
                    const schemaModule = await import( fileUrl )
                    const main = schemaModule[ 'main' ]

                    if( !main || !main[ 'resources' ] ) {
                        return
                    }

                    const namespace = main[ 'namespace' ] || 'unknown'

                    Object.entries( main[ 'resources' ] )
                        .forEach( ( [ resourceName, resourceDef ] ) => {
                            const { database } = resourceDef

                            if( !database || resourceDef[ 'origin' ] ) {
                                return
                            }

                            const oldPath = database.startsWith( '~/' )
                                ? database.replace( '~', homedir() )
                                : database

                            const newName = `${namespace}-${resourceName}.db`
                            const newPath = join( homedir(), `.${basis}`, 'resources', newName )

                            migrations.push( {
                                'schemaFile': filePath,
                                namespace,
                                resourceName,
                                oldPath,
                                newPath,
                                'oldExists': existsSync( oldPath )
                            } )
                        } )
                } catch( err ) {
                    // Skip schemas that fail to load
                    CliOutput.emitCoded( { 'code': 'SQL-018', 'location': 'resourceMigrate: schema module load failed', err } )
                }
            } ), Promise.resolve() )

        if( migrations.length === 0 ) {
            const result = {
                'status': true,
                'message': 'No schemas with old-format database paths found.',
                'migrated': 0,
                'skipped': 0,
                'results': []
            }

            return { result }
        }

        if( dryRun ) {
            const results = migrations
                .map( ( entry ) => {
                    const { schemaFile, namespace, resourceName, oldPath, newPath, oldExists } = entry
                    const dryRunResult = {
                        schemaFile,
                        namespace,
                        resourceName,
                        oldPath,
                        newPath,
                        'action': 'dry-run',
                        'oldExists': oldExists
                    }

                    return dryRunResult
                } )

            const result = {
                'status': true,
                'dryRun': true,
                'total': migrations.length,
                'migrated': 0,
                'skipped': 0,
                results
            }

            return { result }
        }

        if( !autoConfirm ) {
            const preview = migrations
                .map( ( { namespace, resourceName, oldPath, newPath, oldExists } ) => {
                    const existsLabel = oldExists ? '' : ' (file not found)'
                    const previewLine = `  ${namespace}/${resourceName}: ${oldPath}${existsLabel} -> ${newPath}`

                    return previewLine
                } )
                .join( '\n' )

            console.log( `\nFound ${migrations.length} schema(s) with old-format paths:\n` )
            console.log( preview )
            console.log( '' )

            const { confirm } = await inquirer.prompt( [
                {
                    'type': 'confirm',
                    'name': 'confirm',
                    'message': 'Migrate all?',
                    'default': true
                }
            ] )

            if( !confirm ) {
                const result = {
                    'status': true,
                    'message': 'Migration cancelled by user.',
                    'migrated': 0,
                    'skipped': migrations.length,
                    'results': []
                }

                return { result }
            }
        }

        const results = []
        let migrated = 0
        let migrateSkipped = 0
        let migrateFailed = 0

        await migrations
            .reduce( ( promise, entry ) => promise.then( async () => {
                const { schemaFile, namespace, resourceName, oldPath, newPath, oldExists } = entry

                if( !oldExists ) {
                    migrateSkipped += 1
                    results.push( {
                        schemaFile,
                        namespace,
                        resourceName,
                        oldPath,
                        newPath,
                        'action': 'skipped',
                        'reason': 'Source database file not found'
                    } )

                    return
                }

                try {
                    const newDir = dirname( newPath )
                    await mkdir( newDir, { recursive: true } )
                    await rename( oldPath, newPath )

                    migrated += 1
                    results.push( {
                        schemaFile,
                        namespace,
                        resourceName,
                        oldPath,
                        newPath,
                        'action': 'migrated'
                    } )
                } catch( err ) {
                    CliOutput.emitCoded( { 'code': 'SQL-019', 'location': 'resourceMigrate: rename failed', err } )
                    migrateFailed += 1
                    results.push( {
                        schemaFile,
                        namespace,
                        resourceName,
                        oldPath,
                        newPath,
                        'action': 'failed',
                        'reason': err.message
                    } )
                }
            } ), Promise.resolve() )

        const result = {
            'status': migrateFailed === 0,
            'total': migrations.length,
            migrated,
            'skipped': migrateSkipped,
            'failed': migrateFailed,
            results
        }

        return { result }
    }


    static #resolveResourcePath( { origin, name, basis, cwd } ) {
        const resolvers = {
            'inline': () => {
                const dbPath = join( cwd || '.', 'resources', name )

                return dbPath
            },
            'project': () => {
                const dbPath = join( cwd || process.cwd(), `.${basis}`, 'resources', name )

                return dbPath
            },
            'global': () => {
                const dbPath = join( homedir(), `.${basis}`, 'resources', name )

                return dbPath
            }
        }

        const resolver = resolvers[ origin ]

        if( !resolver ) {
            return { 'dbPath': name || '' }
        }

        const dbPath = resolver()

        return { dbPath }
    }


    static #deriveCreateStatements( { resourceDef } ) {
        const queries = resourceDef[ 'queries' ] || {}
        const tableStatements = []

        const getSchemaQuery = queries[ 'getSchema' ]

        if( getSchemaQuery && getSchemaQuery[ 'sql' ] ) {
            return { tableStatements }
        }

        const parameterKeys = new Set()

        Object.values( queries )
            .forEach( ( queryDef ) => {
                const { sql, parameters } = queryDef

                if( !sql ) {
                    return
                }

                const tableMatch = sql.match( /FROM\s+(\w+)/i )

                if( tableMatch ) {
                    const tableName = tableMatch[ 1 ]

                    if( !parameterKeys.has( tableName ) ) {
                        parameterKeys.add( tableName )

                        const columns = ( parameters || [] )
                            .filter( ( param ) => {
                                const hasPosition = param[ 'position' ] && param[ 'position' ][ 'key' ]

                                return hasPosition
                            } )
                            .map( ( param ) => {
                                const key = param[ 'position' ][ 'key' ]
                                const zPrimitive = param[ 'z' ] ? param[ 'z' ][ 'primitive' ] : 'string()'
                                const sqlType = zPrimitive.startsWith( 'number' ) ? 'INTEGER' : 'TEXT'
                                const columnDef = `${key} ${sqlType}`

                                return columnDef
                            } )

                        if( columns.length > 0 ) {
                            const createSql = `CREATE TABLE IF NOT EXISTS ${tableName} (${columns.join( ', ' )})`
                            tableStatements.push( createSql )
                        }
                    }
                }
            } )

        return { tableStatements }
    }
}


export { ResourceCommand }
