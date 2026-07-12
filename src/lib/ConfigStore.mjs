/**
 * FlowMCP — MIT License
 *
 * ConfigStore (Memo 152 PRD-017 / D-04) — the CLI side of the CLI/core boundary:
 * config paths + I/O (~/.flowmcp/config.json), schemaFolders[] reading, the
 * init-guard and config validation. Config-I/O stays in the CLI; schema LOADING
 * moves to core (PRD-018). Depends only on FsUtils, appConfig and Node builtins.
 *
 * NOTE (G-12, PRD-020): #readLocalSources and the localSources read in
 * resolveSourceDir are the legacy fallback (Memo 099 Kap 9) — carried here
 * UNCHANGED; their removal is PRD-020.
 */

import { homedir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'

import { appConfig } from '../data/config.mjs'
import { FsUtils } from './FsUtils.mjs'


class ConfigStore {
    static globalConfigDir() {
        const dir = join( homedir(), appConfig[ 'globalConfigDirName' ] )

        return dir
    }


    static globalConfigPath() {
        const configPath = join( ConfigStore.globalConfigDir(), 'config.json' )

        return configPath
    }


    static schemasDir() {
        const dir = join( ConfigStore.globalConfigDir(), 'schemas' )

        return dir
    }


    // Memo 099 Kap 3 — resolve ~/anchor-relative schemaFolders paths (no hardcoded usernames)
    static resolvePath( { path } ) {
        if( typeof path !== 'string' || path.length === 0 ) {
            return { resolvedPath: path }
        }

        if( path === '~' ) {
            return { resolvedPath: homedir() }
        }

        if( path.startsWith( '~/' ) === true ) {
            const resolvedPath = join( homedir(), path.slice( 2 ) )

            return { resolvedPath }
        }

        if( isAbsolute( path ) === true ) {
            return { resolvedPath: path }
        }

        const resolvedPath = resolve( path )

        return { resolvedPath }
    }


    // Memo 099 Kap 3/4 — read schemaFolders[] (name + resolved path) from the global config
    static async readSchemaFolders() {
        const globalConfigPath = ConfigStore.globalConfigPath()
        const { data: globalConfig } = await FsUtils.readJson( { filePath: globalConfigPath } )
        const raw = globalConfig && globalConfig[ 'schemaFolders' ]

        if( raw === undefined || raw === null || Array.isArray( raw ) === false ) {
            return { schemaFolders: [] }
        }

        const schemaFolders = raw
            .filter( ( entry ) => entry && typeof entry === 'object' && Array.isArray( entry ) === false )
            .filter( ( entry ) => typeof entry[ 'name' ] === 'string' && entry[ 'name' ].length > 0 )
            .filter( ( entry ) => typeof entry[ 'path' ] === 'string' && entry[ 'path' ].length > 0 )
            .map( ( entry ) => {
                const { name, path } = entry
                const { resolvedPath } = ConfigStore.resolvePath( { path } )

                return { name, 'path': resolvedPath }
            } )

        // PRD-008 — the schemaFolders[] `name` is the source coordinate. It MUST be
        // unique across folders, otherwise "<source>:" cannot select a folder. Two
        // folders with the same name = hard config error (no silent first-wins).
        const seenNames = {}
        const duplicateNames = []
        schemaFolders
            .forEach( ( entry ) => {
                const { name } = entry
                if( seenNames[ name ] === true ) {
                    if( duplicateNames.includes( name ) === false ) {
                        duplicateNames.push( name )
                    }
                } else {
                    seenNames[ name ] = true
                }
            } )

        if( duplicateNames.length > 0 ) {
            return {
                schemaFolders,
                'duplicateError': {
                    'error': `Duplicate schemaFolders[] name(s): ${duplicateNames.join( ', ' )}. Each folder name must be unique (it is the "<source>:" coordinate).`,
                    'fix': `Edit ${ConfigStore.globalConfigPath()} and give every schemaFolders[] entry a distinct "name".`
                }
            }
        }

        return { schemaFolders, 'duplicateError': null }
    }


    static async readLocalSources() {
        const globalConfigPath = ConfigStore.globalConfigPath()
        const { data: globalConfig } = await FsUtils.readJson( { filePath: globalConfigPath } )
        const raw = globalConfig && globalConfig[ 'localSources' ]

        if( raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray( raw ) ) {
            return { localSources: {} }
        }

        const localSources = Object.entries( raw )
            .reduce( ( acc, [ name, entry ] ) => {
                const path = entry && typeof entry === 'object' ? entry[ 'path' ] : null
                if( typeof path === 'string' && path.length > 0 ) {
                    acc[ name ] = { path }
                }

                return acc
            }, {} )

        return { localSources }
    }


    static async resolveSourceDir( { sourceName } ) {
        // Memo 099 Kap 4 — schemaFolders[] win: source dir = <path>/providers (direct, no disk-copy)
        const { schemaFolders } = await ConfigStore.readSchemaFolders()
        const folder = schemaFolders
            .find( ( entry ) => entry[ 'name' ] === sourceName )

        if( folder !== undefined ) {
            const sourceDir = join( folder[ 'path' ], 'providers' )

            return { sourceDir, isLocal: true }
        }

        const { localSources } = await ConfigStore.readLocalSources()
        const local = localSources[ sourceName ]

        if( local !== undefined ) {
            return { sourceDir: local[ 'path' ], isLocal: true }
        }

        const sourceDir = join( ConfigStore.schemasDir(), sourceName )

        return { sourceDir, isLocal: false }
    }


    static async writeGlobalConfig( { config } ) {
        const globalConfigPath = ConfigStore.globalConfigPath()
        // Global config is updated deliberately on init — named overwrite.
        await FsUtils.writeGuarded( { 'path': globalConfigPath, 'content': JSON.stringify( config, null, 4 ), 'onExists': 'overwrite' } )

        return { status: true }
    }


    static async readConfig( { cwd } ) {
        const globalConfigPath = ConfigStore.globalConfigPath()
        const { data: globalConfig } = await FsUtils.readJson( { filePath: globalConfigPath } )

        if( !globalConfig ) {
            return { 'config': null, 'error': `Not initialized. Run: ${appConfig[ 'cliCommand' ]} init` }
        }

        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FsUtils.readJson( { filePath: localConfigPath } )

        const { envPath, flowmcpCore, initialized } = globalConfig
        const config = {
            envPath,
            flowmcpCore,
            initialized,
            'local': localConfig || null
        }

        if( localConfig && localConfig[ 'schemasDir' ] ) {
            config[ 'schemasDir' ] = localConfig[ 'schemasDir' ]
        }

        return { config, 'error': null }
    }


    static mergeConfig( { existing, updates } ) {
        const merged = { ...existing }

        Object.entries( updates )
            .forEach( ( [ key, value ] ) => {
                if( merged[ key ] === undefined ) {
                    merged[ key ] = value
                }
            } )

        return { 'config': merged }
    }


    static async requireInit() {
        const globalConfigPath = ConfigStore.globalConfigPath()
        const { data: globalConfig } = await FsUtils.readJson( { filePath: globalConfigPath } )

        if( !globalConfig || !globalConfig[ 'initialized' ] ) {
            return {
                'initialized': false,
                'error': `Not initialized. Run: ${appConfig[ 'cliCommand' ]} init`,
                'fix': `Ask the user to run: ${appConfig[ 'cliCommand' ]} init`
            }
        }

        return { 'initialized': true, 'error': null, 'fix': null }
    }


    static async loadGlobalConfig() {
        const globalConfigPath = ConfigStore.globalConfigPath()
        const { data: globalConfig } = await FsUtils.readJson( { filePath: globalConfigPath } )

        return { globalConfig: globalConfig || {} }
    }


    static validateGlobalConfig( { globalConfig } ) {
        const warnings = []

        if( globalConfig[ 'envPath' ] === undefined || typeof globalConfig[ 'envPath' ] !== 'string' || globalConfig[ 'envPath' ].length === 0 ) {
            warnings.push( 'envPath: Missing or not a non-empty string' )
        }

        if( globalConfig[ 'initialized' ] === undefined || typeof globalConfig[ 'initialized' ] !== 'string' ) {
            warnings.push( 'initialized: Missing or not a string' )
        }

        if( globalConfig[ 'flowmcpCore' ] === undefined || typeof globalConfig[ 'flowmcpCore' ] !== 'object' || globalConfig[ 'flowmcpCore' ] === null ) {
            warnings.push( 'flowmcpCore: Missing or not an object' )
        } else {
            if( globalConfig[ 'flowmcpCore' ][ 'version' ] === undefined || typeof globalConfig[ 'flowmcpCore' ][ 'version' ] !== 'string' ) {
                warnings.push( 'flowmcpCore.version: Missing or not a string' )
            }

            if( globalConfig[ 'flowmcpCore' ][ 'schemaSpec' ] === undefined || typeof globalConfig[ 'flowmcpCore' ][ 'schemaSpec' ] !== 'string' ) {
                warnings.push( 'flowmcpCore.schemaSpec: Missing or not a string' )
            }
        }

        if( globalConfig[ 'sources' ] !== undefined ) {
            if( typeof globalConfig[ 'sources' ] !== 'object' || globalConfig[ 'sources' ] === null ) {
                warnings.push( 'sources: Must be an object when present' )
            }
        }

        const valid = warnings.length === 0

        return { valid, warnings }
    }


    static validateLocalConfig( { localConfig } ) {
        const warnings = []

        if( localConfig[ 'root' ] === undefined || typeof localConfig[ 'root' ] !== 'string' || localConfig[ 'root' ].length === 0 ) {
            warnings.push( 'root: Missing or not a non-empty string' )
        }

        if( localConfig[ 'groups' ] !== undefined ) {
            if( typeof localConfig[ 'groups' ] !== 'object' || localConfig[ 'groups' ] === null ) {
                warnings.push( 'groups: Must be an object when present' )
            } else {
                Object.entries( localConfig[ 'groups' ] )
                    .forEach( ( [ groupName, groupData ] ) => {
                        if( typeof groupData !== 'object' || groupData === null ) {
                            warnings.push( `groups.${groupName}: Must be an object` )
                        } else {
                            const hasTools = Array.isArray( groupData[ 'tools' ] )
                            const hasSchemas = Array.isArray( groupData[ 'schemas' ] )

                            if( !hasTools && !hasSchemas ) {
                                warnings.push( `groups.${groupName}: Must have "tools" or "schemas" array` )
                            } else {
                                const items = groupData[ 'tools' ] || groupData[ 'schemas' ] || []
                                items
                                    .forEach( ( item, index ) => {
                                        if( typeof item !== 'string' ) {
                                            warnings.push( `groups.${groupName}.tools[${index}]: Must be a string` )
                                        }
                                    } )
                            }
                        }
                    } )
            }
        }

        if( localConfig[ 'defaultGroup' ] !== undefined ) {
            if( typeof localConfig[ 'defaultGroup' ] !== 'string' ) {
                warnings.push( 'defaultGroup: Must be a string' )
            } else if( localConfig[ 'groups' ] && typeof localConfig[ 'groups' ] === 'object' && localConfig[ 'groups' ] !== null ) {
                if( !localConfig[ 'groups' ][ localConfig[ 'defaultGroup' ] ] ) {
                    warnings.push( `defaultGroup: "${localConfig[ 'defaultGroup' ]}" does not reference an existing group` )
                }
            }
        }

        const valid = warnings.length === 0

        return { valid, warnings }
    }
}


export { ConfigStore }
