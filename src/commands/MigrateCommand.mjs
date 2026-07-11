import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

import { appConfig } from '../data/config.mjs'
import { ConfigStore } from '../lib/ConfigStore.mjs'
import { CliOutput } from '../lib/CliOutput.mjs'
import { FsUtils } from '../lib/FsUtils.mjs'
import { SchemaLoaderBridge } from '../lib/SchemaLoaderBridge.mjs'
import { ServeCommand } from './ServeCommand.mjs'


// Memo 152 / PRD-019 (D-08 cluster "validate-migrate") — `flowmcp migrate` (legacy schema file
// conversion: routes->tools, version 2.x->3.0.0, 3.x->4.0.0, strip main.skills) and
// `flowmcp migrate-config` (rewrite a config's group tool refs to v4 spec-ids), extracted from
// FlowMcpCli. migrateConfig delegates tool-ref parsing to ServeCommand.parseToolRef (F18=A move).
// FlowMcpCli.migrate / validationMigrate / migrateConfig stay public delegations (index.mjs +
// tests call them). No back-reference to FlowMcpCli.
class MigrateCommand {
    static async migrate( { schemaPath, cwd, all = false, dryRun = false } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { status: validStatus, messages: validMessages } = MigrateCommand.validationMigrate( { schemaPath, all } )
        if( !validStatus ) {
            const result = { 'status': false, 'messages': validMessages }

            return { result }
        }

        const routesKeyPattern = /(['"])routes\1(\s*:)/g
        const versionPattern = /(['"]?version['"]?)\s*:\s*['"]2\.\d+\.\d+['"]/
        const versionV3Pattern = /(['"]?version['"]?)\s*:\s*['"]3\.\d+\.\d+['"]/
        const mainSkillsStartPattern = /,?\s*['"]?skills['"]?\s*:\s*\{/
        const sharedListPathPattern = /[\/\\]_lists[\/\\]/

        const findMainSkillsBlock = ( source ) => {
            const match = source.match( mainSkillsStartPattern )
            if( match === null ) { return null }
            const start = match.index
            const openBraceIdx = source.indexOf( '{', start + match[ 0 ].length - 1 )
            let depth = 0
            let i = openBraceIdx
            while( i < source.length ) {
                const ch = source[ i ]
                if( ch === '{' ) { depth += 1 }
                else if( ch === '}' ) {
                    depth -= 1
                    if( depth === 0 ) { return { start, end: i + 1 } }
                }
                i += 1
            }
            return null
        }

        let filePaths = []

        if( all ) {
            const dirPath = schemaPath || cwd
            const resolvedDir = resolve( dirPath )

            let dirStat
            try {
                dirStat = await stat( resolvedDir )
            } catch {
                const result = CliOutput.error( { 'error': `SKL-001 findMainSkillsBlock: Path not found: ${dirPath}` } )

                return { result }
            }

            if( !dirStat.isDirectory() ) {
                const result = CliOutput.error( { 'error': `Path is not a directory: ${dirPath}. Use --all with a directory.` } )

                return { result }
            }

            const { files } = await FsUtils.findSchemaFiles( { dirPath: resolvedDir } )
            filePaths = files
        } else {
            const resolvedPath = resolve( schemaPath )

            let pathStat
            try {
                pathStat = await stat( resolvedPath )
            } catch {
                const result = CliOutput.error( { 'error': `SKL-002 findMainSkillsBlock: Path not found: ${schemaPath}` } )

                return { result }
            }

            if( pathStat.isDirectory() ) {
                const { files } = await FsUtils.findSchemaFiles( { dirPath: resolvedPath } )
                filePaths = files
            } else {
                filePaths = [ resolvedPath ]
            }
        }

        if( filePaths.length === 0 ) {
            const result = {
                'status': true,
                'total': 0,
                'migrated': 0,
                'skipped': 0,
                'failed': 0,
                dryRun,
                'results': []
            }

            return { result }
        }

        const results = []
        let migrated = 0
        let skipped = 0
        let failed = 0

        const processFile = async ( filePath ) => {
            try {
                if( sharedListPathPattern.test( filePath ) ) {
                    skipped += 1
                    results.push( { 'file': filePath, 'action': 'skipped', 'reason': 'Shared-list file (_lists/) — independent versioning, not migrated' } )

                    return
                }

                const content = await readFile( filePath, 'utf-8' )
                const hasRoutes = routesKeyPattern.test( content )
                routesKeyPattern.lastIndex = 0
                const hasV2Version = versionPattern.test( content )
                const hasV3Version = versionV3Pattern.test( content )
                const skillsBlock = findMainSkillsBlock( content )
                const hasMainSkills = skillsBlock !== null && ( hasV2Version || hasV3Version )

                if( !hasRoutes && !hasV2Version && !hasV3Version && !hasMainSkills ) {
                    skipped += 1
                    results.push( { 'file': filePath, 'action': 'skipped', 'reason': 'No migratable patterns (routes/v2/v3/skills) found' } )

                    return
                }

                if( dryRun ) {
                    migrated += 1
                    const changes = []
                    if( hasRoutes ) { changes.push( 'routes -> tools' ) }
                    if( hasV2Version ) { changes.push( 'version 2.x.x -> 3.0.0' ) }
                    if( hasV3Version ) { changes.push( 'version 3.x.x -> 4.0.0' ) }
                    if( hasMainSkills ) { changes.push( 'remove main.skills (v4 forbids)' ) }
                    results.push( { 'file': filePath, 'action': 'migrated', 'reason': `[dry-run] Would apply: ${changes.join( ', ' )}` } )

                    return
                }

                let updatedContent = content
                const warnings = []

                if( hasRoutes ) {
                    updatedContent = updatedContent.replace( routesKeyPattern, '$1tools$1$2' )
                    routesKeyPattern.lastIndex = 0
                }
                if( hasV2Version ) {
                    updatedContent = updatedContent.replace( versionPattern, `$1: '3.0.0'` )
                }
                if( hasV3Version ) {
                    updatedContent = updatedContent.replace( versionV3Pattern, `$1: '4.0.0'` )
                }
                if( hasMainSkills ) {
                    const fresh = findMainSkillsBlock( updatedContent )
                    if( fresh !== null ) {
                        updatedContent = updatedContent.slice( 0, fresh.start ) + updatedContent.slice( fresh.end )
                    }
                    warnings.push( 'main.skills removed — keep skill files in providers/<ns>/skills/*.mjs (Memo 022 REV-08)' )
                }

                await FsUtils.writeGuarded( { 'path': filePath, 'content': updatedContent, 'onExists': 'overwrite' } )
                migrated += 1
                const targetVersion = ( hasV3Version || hasMainSkills ) ? 'v4' : 'v3'
                const reasonParts = [ `Successfully migrated to ${targetVersion}` ]
                if( warnings.length > 0 ) { reasonParts.push( `Warnings: ${warnings.join( '; ' )}` ) }
                results.push( { 'file': filePath, 'action': 'migrated', 'reason': reasonParts.join( '. ' ) } )
            } catch( err ) {
                process.stderr.write( `CLI-002 migrate: file migration failed: ${err.message}\n` )
                failed += 1
                results.push( { 'file': filePath, 'action': 'failed', 'reason': err.message } )
            }
        }

        await Promise.all(
            filePaths
                .map( ( filePath ) => {
                    const promise = processFile( filePath )

                    return promise
                } )
        )

        const total = migrated + skipped + failed
        const result = {
            'status': failed === 0,
            total,
            migrated,
            skipped,
            failed,
            dryRun,
            results
        }

        return { result }
    }


    static validationMigrate( { schemaPath, all } ) {
        const struct = { 'status': false, 'messages': [] }

        if( !all && ( schemaPath === undefined || schemaPath === null ) ) {
            struct[ 'messages' ].push( 'schemaPath: Missing value. Provide a path or use --all.' )
        } else if( !all && typeof schemaPath !== 'string' ) {
            struct[ 'messages' ].push( 'schemaPath: Must be a string.' )
        }

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    static async migrateConfig( { cwd, isGlobal = false, dryRun = false } ) {
        const configPath = isGlobal
            ? join( homedir(), appConfig[ 'globalConfigDirName' ], 'config.json' )
            : join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )

        const scope = isGlobal ? 'global' : 'local'

        let rawContent
        try {
            rawContent = await readFile( configPath, 'utf-8' )
        } catch {
            const result = {
                'status': false,
                'error': `CFG-004 migrateConfig: Config not found at ${configPath}`
            }

            return { result }
        }

        let config
        try {
            config = JSON.parse( rawContent )
        } catch( parseErr ) {
            const result = {
                'status': false,
                'error': `CFG-005 migrateConfig: Invalid JSON in config at ${configPath}: ${parseErr.message}`
            }

            return { result }
        }

        const groups = config[ 'groups' ]
        if( !groups || typeof groups !== 'object' ) {
            const result = {
                'status': true,
                configPath,
                dryRun,
                scope,
                'groupsProcessed': 0,
                'entriesMigrated': 0,
                'entriesSkipped': 0,
                'entriesFailed': 0,
                'backup': null,
                'changes': []
            }

            return { result }
        }

        const schemasBaseDir = ConfigStore.schemasDir()
        const changes = []
        let entriesMigrated = 0
        let entriesSkipped = 0
        let entriesFailed = 0
        const groupsProcessed = Object.keys( groups ).length

        await Object.keys( groups )
            .reduce( ( promise, groupName ) => promise.then( async () => {
                const group = groups[ groupName ]
                const toolEntries = group[ 'tools' ] || group[ 'schemas' ]

                if( !toolEntries || !Array.isArray( toolEntries ) ) {
                    return
                }

                const newTools = []

                await toolEntries
                    .reduce( ( innerPromise, entry ) => innerPromise.then( async () => {
                        const toolRef = typeof entry === 'string' ? entry
                            : ( entry[ 'toolRef' ] || entry[ 'ref' ] || null )

                        if( !toolRef ) {
                            newTools.push( entry )
                            entriesFailed++
                            changes.push( {
                                'group': groupName,
                                'from': JSON.stringify( entry ),
                                'to': [],
                                'action': 'failed',
                                'reason': 'Entry has no parseable toolRef string'
                            } )

                            return
                        }

                        const slashCount = ( toolRef.match( /\//g ) || [] ).length
                        const hasDoubleColon = toolRef.includes( '::' )

                        if( !hasDoubleColon && slashCount >= 2 ) {
                            newTools.push( toolRef )
                            entriesSkipped++
                            changes.push( {
                                'group': groupName,
                                'from': toolRef,
                                'to': [ toolRef ],
                                'action': 'skipped'
                            } )

                            return
                        }

                        const { schemaRef, routeName } = ServeCommand.parseToolRef( { 'toolRef': toolRef } )
                        const filePath = join( schemasBaseDir, schemaRef )
                        const { main, error: loadError } = await SchemaLoaderBridge.loadSchema( { filePath } )

                        if( !main || loadError ) {
                            newTools.push( toolRef )
                            entriesFailed++
                            changes.push( {
                                'group': groupName,
                                'from': toolRef,
                                'to': [],
                                'action': 'failed',
                                'reason': loadError || `Schema not found: ${filePath}`
                            } )

                            return
                        }

                        const namespace = main[ 'namespace' ]
                        if( !namespace ) {
                            newTools.push( toolRef )
                            entriesFailed++
                            changes.push( {
                                'group': groupName,
                                'from': toolRef,
                                'to': [],
                                'action': 'failed',
                                'reason': `Schema at ${schemaRef} has no namespace`
                            } )

                            return
                        }

                        if( routeName ) {
                            const specId = `${namespace}/tool/${routeName}`
                            newTools.push( specId )
                            entriesMigrated++
                            changes.push( {
                                'group': groupName,
                                'from': toolRef,
                                'to': [ specId ],
                                'action': 'migrated'
                            } )

                            return
                        }

                        const toolEntryMap = main[ 'tools' ] || main[ 'routes' ]
                        if( !toolEntryMap || Object.keys( toolEntryMap ).length === 0 ) {
                            newTools.push( toolRef )
                            entriesFailed++
                            changes.push( {
                                'group': groupName,
                                'from': toolRef,
                                'to': [],
                                'action': 'failed',
                                'reason': `Schema at ${schemaRef} has no tools or routes to expand`
                            } )

                            return
                        }

                        const expandedIds = Object.keys( toolEntryMap )
                            .map( ( name ) => {
                                const specId = `${namespace}/tool/${name}`

                                return specId
                            } )

                        expandedIds
                            .forEach( ( specId ) => {
                                newTools.push( specId )
                            } )

                        entriesMigrated++
                        changes.push( {
                            'group': groupName,
                            'from': toolRef,
                            'to': expandedIds,
                            'action': 'migrated'
                        } )
                    } ), Promise.resolve() )

                group[ 'tools' ] = newTools
                if( group[ 'schemas' ] ) {
                    delete group[ 'schemas' ]
                }
            } ), Promise.resolve() )

        const nothingChanged = changes
            .every( ( c ) => {
                const isSkipped = c[ 'action' ] === 'skipped'

                return isSkipped
            } )

        let backup = null

        if( !dryRun && !nothingChanged ) {
            const backupPath = `${configPath}.bak`
            await FsUtils.writeGuarded( { 'path': backupPath, 'content': rawContent, 'onExists': 'overwrite' } )
            backup = backupPath

            await FsUtils.writeGuarded( { 'path': configPath, 'content': JSON.stringify( config, null, 4 ), 'onExists': 'overwrite' } )
        }

        const result = {
            'status': true,
            configPath,
            dryRun,
            scope,
            groupsProcessed,
            entriesMigrated,
            entriesSkipped,
            entriesFailed,
            backup,
            changes
        }

        return { result }
    }
}


export { MigrateCommand }
