import { readFile, readdir, access } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { constants, existsSync } from 'node:fs'

import { FlowMCP } from 'flowmcp'

import { appConfig } from '../data/config.mjs'
import { ConfigStore } from '../lib/ConfigStore.mjs'
import { SchemaSource } from '../lib/SchemaSource.mjs'
import { FsUtils } from '../lib/FsUtils.mjs'
import { CliOutput } from '../lib/CliOutput.mjs'


// Memo 152 / PRD-019 (D-08) — the `flowmcp lists` commands (listSharedLists /
// listsAddEntry / listsRefs). The two shared-list helpers findListsDir and
// resolveSharedListsForSchema are exposed as public statics (like Allowlist)
// because the FlowMcpCli handler/call/serve paths reuse them. Depends only on
// lib modules + the v4 FlowMCP.resolveSharedLists — no back-reference to FlowMcpCli.
class ListsCommand {
    static async listSharedLists( { listName } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { sources } = await SchemaSource.listSources()

        if( sources.length === 0 ) {
            const result = CliOutput.error( {
                'error': 'No schema sources found.',
                'fix': `Run: ${appConfig[ 'cliCommand' ]} import <url>`
            } )

            return { result }
        }

        const schemasBaseDir = ConfigStore.schemasDir()
        const allLists = []

        await sources
            .reduce( ( promise, source ) => promise.then( async () => {
                const { name: sourceName } = source
                const listsDir = join( schemasBaseDir, sourceName, '_lists' )

                let listFiles = []
                try {
                    const entries = await readdir( listsDir )
                    listFiles = entries
                        .filter( ( f ) => f.endsWith( '.mjs' ) )
                } catch( err ) {
                    CliOutput.emitCoded( { 'code': 'LST-001', 'location': 'listSharedLists: lists dir read failed', err } )
                    return
                }

                await listFiles
                    .reduce( ( p, file ) => p.then( async () => {
                        const filePath = join( listsDir, file )

                        try {
                            const mod = await import( pathToFileURL( filePath ).href )
                            const listObj = Object.values( mod )
                                .find( ( v ) => v && typeof v === 'object' && v[ 'meta' ] && Array.isArray( v[ 'entries' ] ) )

                            if( !listObj ) { return }

                            const name = file.replace( /\.mjs$/, '' )
                            const meta = listObj[ 'meta' ] || {}
                            const entries = listObj[ 'entries' ] || []

                            allLists.push( {
                                name,
                                'description': meta[ 'description' ] || '',
                                'entryCount': entries.length,
                                'fields': ( meta[ 'fields' ] || [] )
                                    .map( ( f ) => f[ 'key' ] ),
                                'source': sourceName,
                                entries
                            } )
                        } catch( err ) {
                            // skip broken list files
                            process.stderr.write( `LST-002 listSharedLists: broken list file skipped: ${err.message}\n` )
                        }
                    } ), Promise.resolve() )
            } ), Promise.resolve() )

        if( !listName ) {
            const result = {
                'status': true,
                'listCount': allLists.length,
                'lists': allLists
                    .map( ( { name, description, entryCount, fields } ) => ( {
                        name,
                        description,
                        entryCount,
                        fields
                    } ) )
            }

            return { result }
        }

        const targetList = allLists
            .find( ( l ) => l[ 'name' ] === listName )

        if( !targetList ) {
            const availableNames = allLists
                .map( ( l ) => l[ 'name' ] )
                .join( ', ' )
            const result = CliOutput.error( {
                'error': `List "${listName}" not found.`,
                'fix': `Available lists: ${availableNames}`
            } )

            return { result }
        }

        const result = {
            'status': true,
            'name': targetList[ 'name' ],
            'description': targetList[ 'description' ],
            'entryCount': targetList[ 'entryCount' ],
            'fields': targetList[ 'fields' ],
            'data': targetList[ 'entries' ]
        }

        return { result }
    }


    static async listsAddEntry( { cwd: _cwd, listName, jsonEntry } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const normalizedName = listName && !listName.endsWith( '.mjs' ) ? `${listName}.mjs` : listName

        if( !normalizedName ) {
            const result = CliOutput.error( {
                'error': 'Missing listName.',
                'fix': 'Provide a list name, e.g. evm-chains or evm-chains.mjs'
            } )

            return { result }
        }

        let parsedEntry
        try {
            parsedEntry = JSON.parse( jsonEntry )
        } catch {
            const result = CliOutput.error( {
                'error': `CLI-007 listsAddEntry: Invalid JSON entry: "${jsonEntry}"`,
                'fix': 'Provide a valid JSON object, e.g. \'{"alias":"FOO","chainId":99}\''
            } )

            return { result }
        }

        if( typeof parsedEntry !== 'object' || parsedEntry === null || Array.isArray( parsedEntry ) ) {
            const result = CliOutput.error( {
                'error': 'Entry must be a JSON object (not an array or primitive).',
                'fix': 'Provide a plain JSON object, e.g. \'{"alias":"FOO","chainId":99}\''
            } )

            return { result }
        }

        const { sources } = await SchemaSource.listSources()
        const schemasBaseDir = ConfigStore.schemasDir()

        let listFilePath = null

        await sources
            .reduce( ( promise, source ) => promise.then( async () => {
                if( listFilePath ) { return }

                const { name: sourceName } = source
                const candidate = join( schemasBaseDir, sourceName, '_lists', normalizedName )

                try {
                    await access( candidate, constants.F_OK )
                    listFilePath = candidate
                } catch( err ) {
                    // not in this source
                    process.stderr.write( `CLI-008 listsAddEntry: list not in source: ${err.message}\n` )
                }
            } ), Promise.resolve() )

        if( !listFilePath ) {
            const result = CliOutput.error( {
                'error': `List file "${normalizedName}" not found in any source.`,
                'fix': `Check available lists with: ${appConfig[ 'cliCommand' ]} dev lists list`
            } )

            return { result }
        }

        const fileUrl = pathToFileURL( listFilePath ).href
        let listObj

        try {
            const mod = await import( fileUrl )
            listObj = Object.values( mod )
                .find( ( v ) => v && typeof v === 'object' && v[ 'meta' ] && Array.isArray( v[ 'entries' ] ) )
        } catch {
            const result = CliOutput.error( {
                'error': `CLI-009 listsAddEntry: Failed to import list file "${normalizedName}".`,
                'fix': 'Check the list file for syntax errors.'
            } )

            return { result }
        }

        if( !listObj ) {
            const result = CliOutput.error( {
                'error': `List file "${normalizedName}" does not contain a valid list object with meta and entries.`,
                'fix': 'The file must export an object with { meta: { fields: [...] }, entries: [...] }'
            } )

            return { result }
        }

        const existingEntries = listObj[ 'entries' ]
        const fields = ( listObj[ 'meta' ][ 'fields' ] || [] )
            .map( ( f ) => f[ 'key' ] )

        const requiredFields = ( listObj[ 'meta' ][ 'fields' ] || [] )
            .filter( ( f ) => f[ 'optional' ] !== true )
            .map( ( f ) => f[ 'key' ] )

        const allFieldKeys = fields

        if( allFieldKeys.length > 0 ) {
            const entryKeys = Object.keys( parsedEntry )
            const missingRequired = requiredFields
                .filter( ( key ) => !entryKeys.includes( key ) )

            const unknownKeys = entryKeys
                .filter( ( key ) => !allFieldKeys.includes( key ) )

            if( missingRequired.length > 0 ) {
                const result = CliOutput.error( {
                    'error': `Entry is missing required fields: ${missingRequired.join( ', ')}`,
                    'fix': `Required fields: ${requiredFields.join( ', ' )}`
                } )

                return { result }
            }

            if( unknownKeys.length > 0 ) {
                const result = CliOutput.error( {
                    'error': `Entry contains unknown fields: ${unknownKeys.join( ', ')}`,
                    'fix': `Known fields: ${allFieldKeys.join( ', ' )}`
                } )

                return { result }
            }
        } else if( existingEntries.length > 0 ) {
            const referenceEntry = existingEntries[ 0 ]
            const referenceKeys = Object.keys( referenceEntry ).sort()
            const entryKeys = Object.keys( parsedEntry ).sort()

            const missingKeys = referenceKeys
                .filter( ( key ) => !entryKeys.includes( key ) )

            const extraKeys = entryKeys
                .filter( ( key ) => !referenceKeys.includes( key ) )

            if( missingKeys.length > 0 || extraKeys.length > 0 ) {
                const result = CliOutput.error( {
                    'error': `Entry shape mismatch. Missing: ${missingKeys.join( ', ' ) || 'none'}, extra: ${extraKeys.join( ', ' ) || 'none'}`,
                    'fix': `Entry must have the same keys as existing entries: ${referenceKeys.join( ', ' )}`
                } )

                return { result }
            }
        }

        const updatedEntries = [ ...existingEntries, parsedEntry ]
        const updatedList = {
            'meta': listObj[ 'meta' ],
            'entries': updatedEntries
        }

        const exportVarName = 'list'
        const newContent = `export const ${exportVarName} = ${JSON.stringify( updatedList, null, 4 )}\n`

        await FsUtils.writeGuarded( { 'path': listFilePath, 'content': newContent, 'onExists': 'overwrite' } )

        const result = {
            'status': true,
            'listName': normalizedName.replace( /\.mjs$/, '' ),
            'entryAdded': parsedEntry,
            'totalEntries': updatedEntries.length,
            'listFile': listFilePath
        }

        return { result }
    }


    static async listsRefs( { cwd: _cwd, alias } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        if( !alias ) {
            const result = CliOutput.error( {
                'error': 'Missing alias.',
                'fix': 'Provide an alias to look up, e.g. ETHEREUM_MAINNET'
            } )

            return { result }
        }

        const { sources } = await SchemaSource.listSources()
        const schemasBaseDir = ConfigStore.schemasDir()
        const matchingSchemas = []

        await sources
            .reduce( ( promise, source ) => promise.then( async () => {
                const { name: sourceName, schemas } = source

                await schemas
                    .reduce( ( innerPromise, schemaInfo ) => innerPromise.then( async () => {
                        const { file } = schemaInfo
                        const filePath = join( schemasBaseDir, sourceName, file )

                        let fileContent
                        try {
                            fileContent = await readFile( filePath, 'utf-8' )
                        } catch( err ) {
                            process.stderr.write( `CLI-010 listsRefs: schema read failed: ${err.message}\n` )
                            return
                        }

                        if( !fileContent.includes( alias ) ) {
                            return
                        }

                        let schemaMain
                        try {
                            const mod = await import( pathToFileURL( filePath ).href )
                            schemaMain = mod[ 'main' ] || null
                        } catch( err ) {
                            process.stderr.write( `CLI-011 listsRefs: schema import failed: ${err.message}\n` )
                            return
                        }

                        if( !schemaMain ) { return }

                        const references = []
                        const tools = schemaMain[ 'routes' ] || schemaMain[ 'tools' ] || {}

                        Object.entries( tools )
                            .forEach( ( [ toolName, toolDef ] ) => {
                                const parameters = toolDef[ 'parameters' ] || []

                                parameters
                                    .forEach( ( param ) => {
                                        const positionValue = param[ 'position' ] && param[ 'position' ][ 'value' ] || ''
                                        const zPrimitive = param[ 'z' ] && param[ 'z' ][ 'primitive' ] || ''
                                        const zOptions = param[ 'z' ] && param[ 'z' ][ 'options' ] || []

                                        const inPosition = positionValue.includes( alias )
                                        const inPrimitive = zPrimitive.includes( alias )
                                        const inOptions = Array.isArray( zOptions ) && zOptions
                                            .some( ( opt ) => {
                                                const isMatch = typeof opt === 'string' && opt.includes( alias )

                                                return isMatch
                                            } )

                                        if( inPosition || inPrimitive || inOptions ) {
                                            references.push( {
                                                'tool': toolName,
                                                'parameter': param[ 'position' ] && param[ 'position' ][ 'key' ] || 'unknown'
                                            } )
                                        }
                                    } )
                            } )

                        matchingSchemas.push( {
                            file,
                            'namespace': schemaMain[ 'namespace' ] || '',
                            'schemaName': schemaMain[ 'name' ] || file,
                            references
                        } )
                    } ), Promise.resolve() )
            } ), Promise.resolve() )

        const result = {
            'status': true,
            alias,
            'schemaCount': matchingSchemas.length,
            'schemas': matchingSchemas
        }

        return { result }
    }


    // Public helper — shared with the FlowMcpCli handler/call/serve paths.
    static findListsDir( { filePath } ) {
        const resolved = resolve( filePath )
        const startDir = dirname( resolved )
        const maxLevels = 10
        const listDirNames = [ '_lists', '_shared' ]

        const result = Array.from( { 'length': maxLevels } )
            .reduce( ( acc, _, idx ) => {
                if( acc['found'] ) {
                    return acc
                }

                const hit = listDirNames
                    .map( ( name ) => join( acc['current'], name ) )
                    .find( ( candidate ) => existsSync( candidate ) )

                if( hit ) {
                    return { 'found': true, 'listsDir': hit, 'current': acc['current'] }
                }

                const parent = dirname( acc['current'] )

                if( parent === acc['current'] ) {
                    return { 'found': false, 'listsDir': null, 'current': acc['current'] }
                }

                return { 'found': false, 'listsDir': null, 'current': parent }
            }, { 'found': false, 'listsDir': null, 'current': startDir } )

        return { 'listsDir': result['listsDir'] }
    }


    // Public helper — shared with the FlowMcpCli handler/call/serve paths.
    static async resolveSharedListsForSchema( { main, filePath } ) {
        const sharedListRefs = main?.[ 'sharedLists' ] || []
        let sharedLists = {}

        if( sharedListRefs.length > 0 && filePath ) {
            try {
                const { listsDir } = ListsCommand.findListsDir( { filePath } )
                if( listsDir ) {
                    const resolved = await FlowMCP.resolveSharedLists( { sharedListRefs, listsDir } )
                    sharedLists = resolved[ 'sharedLists' ] || {}
                }
            } catch( err ) {
                CliOutput.emitCoded( { 'code': 'LST-003', 'location': 'resolveSharedListsForSchema: shared list resolution failed', err } )
                sharedLists = {}
            }
        }

        return { sharedLists }
    }
}


export { ListsCommand }
