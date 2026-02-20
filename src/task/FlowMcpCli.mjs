import { readFile, writeFile, mkdir, readdir, stat, access, unlink, rename } from 'node:fs/promises'
import { join, resolve, basename, extname, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { constants, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

import chalk from 'chalk'
import figlet from 'figlet'
import inquirer from 'inquirer'
import { FlowMCP } from 'flowmcp/v2'

import { ZodBuilder } from './ZodBuilder.mjs'

import { appConfig } from '../data/config.mjs'


class FlowMcpCli {
    static async init( { cwd } ) {
        FlowMcpCli.#printHeadline()

        const { version, commit, schemaSpec } = FlowMcpCli.#detectCoreInfo()
        const shortCommit = commit.length > 7 ? commit.slice( 0, 7 ) : commit
        console.log( `  ${chalk.gray( 'Core:' )} v${version} ${chalk.gray( `(${shortCommit})` )}  ${chalk.gray( 'Spec:' )} ${schemaSpec}` )
        console.log( '' )

        // Step 1: Health Check - show current state
        const { checks, healthy } = await FlowMcpCli.#healthCheck( { cwd } )
        console.log( chalk.cyan( '  Health Status' ) )

        checks
            .forEach( ( check ) => {
                const { name, ok, path, detail } = check
                const checkWarnings = check[ 'warnings' ]
                const icon = ok ? chalk.green( '\u2713' ) : chalk.yellow( '\u26A0' )
                const label = name === 'globalConfig' ? 'Global config'
                    : name === 'envFile' ? '.env file'
                    : name === 'schemas' ? 'Schemas'
                    : name === 'localConfig' ? 'Local config'
                    : name === 'groups' ? 'Groups'
                    : name

                const paddedLabel = label.padEnd( 16 )
                const info = detail ? chalk.gray( `(${detail})` )
                    : path ? chalk.gray( path )
                    : ''

                console.log( `  ${icon} ${paddedLabel}${info}` )

                if( checkWarnings && checkWarnings.length > 0 ) {
                    checkWarnings
                        .forEach( ( w ) => {
                            console.log( `      ${chalk.yellow( '\u2192' )} ${chalk.gray( w )}` )
                        } )
                }
            } )

        console.log( '' )

        if( !healthy ) {
            const { setupMode } = await inquirer.prompt( [
                {
                    'type': 'list',
                    'name': 'setupMode',
                    'message': 'How would you like to set up?',
                    'choices': [
                        { 'name': 'Quick install (recommended)', 'value': 'quick' },
                        { 'name': 'Manual setup', 'value': 'manual' }
                    ]
                }
            ] )

            if( setupMode === 'quick' ) {
                await FlowMcpCli.#quickInstall( { cwd, version, commit, schemaSpec } )
            } else {
                await FlowMcpCli.#manualInstall( { cwd, version, commit, schemaSpec } )
            }
        } else {
            console.log( `  ${chalk.green( '\u2713' )} All checks passed. Run '${appConfig[ 'cliCommand' ]} update' to check for schema updates.` )
            console.log( '' )
        }

        // Final health check
        const { checks: finalChecks, healthy: finalHealthy } = await FlowMcpCli.#healthCheck( { cwd } )

        if( finalHealthy ) {
            console.log( `  ${chalk.green( '\u2713' )} Setup complete. All checks passed.` )
        } else {
            const remainingSteps = finalChecks
                .filter( ( { ok } ) => {
                    const isFailing = !ok

                    return isFailing
                } )

            console.log( `  ${chalk.cyan( 'Remaining steps:' )}` )
            remainingSteps
                .forEach( ( { fix } ) => {
                    console.log( `  ${chalk.gray( '\u2192' )} ${fix}` )
                } )
        }
        console.log( '' )

        const { data: finalGlobalConfig } = await FlowMcpCli.#readJson( { filePath: FlowMcpCli.#globalConfigPath() } )
        const result = {
            'status': true,
            'healthy': finalHealthy,
            'config': {
                'envPath': finalGlobalConfig[ 'envPath' ],
                'flowmcpCore': { version, commit, schemaSpec },
                'initialized': finalGlobalConfig[ 'initialized' ]
            }
        }

        return { result }
    }


    static async help( { cwd } ) {
        FlowMcpCli.#printHeadline()
        console.log( '' )

        const { checks } = await FlowMcpCli.#healthCheck( { cwd } )
        const { warnings } = FlowMcpCli.#formatHealthWarnings( { checks } )

        if( warnings.length > 0 ) {
            warnings
                .forEach( ( warning ) => {
                    console.log( `  ${chalk.yellow( '\u26A0' )} ${warning}` )
                } )
            console.log( '' )
        }

        FlowMcpCli.#printHelpText()

        const result = { 'status': true }

        return { result }
    }


    static async import( { url, branch = 'main' } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { status: validStatus, messages: validMessages } = FlowMcpCli.validationImport( { url } )
        if( !validStatus ) {
            const result = {
                'status': false,
                'messages': validMessages,
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} import <github-url>`
            }

            return { result }
        }

        const { owner, repo } = FlowMcpCli.#parseGithubUrl( { url } )

        const registryUrl = FlowMcpCli.#buildRawUrl( {
            owner,
            repo,
            branch,
            'path': appConfig[ 'registryFileName' ]
        } )

        const { data: registryText, error: fetchError } = await FlowMcpCli.#fetchUrl( { url: registryUrl } )
        if( !registryText ) {
            const result = FlowMcpCli.#error( {
                'error': `Failed to fetch registry: ${fetchError}`,
                'fix': `Verify the URL points to a repo with a ${appConfig[ 'registryFileName' ]} in its root.`
            } )

            return { result }
        }

        let registry
        try {
            registry = JSON.parse( registryText )
        } catch {
            const result = FlowMcpCli.#error( {
                'error': `Invalid JSON in ${appConfig[ 'registryFileName' ]}`,
                'fix': `The remote ${appConfig[ 'registryFileName' ]} contains invalid JSON. Check the repository.`
            } )

            return { result }
        }

        const { name: sourceName, baseDir, schemas: registrySchemas, description, schemaSpec } = registry

        if( !sourceName || !Array.isArray( registrySchemas ) ) {
            const result = FlowMcpCli.#error( {
                'error': 'Registry missing required fields: name, schemas',
                'fix': `The ${appConfig[ 'registryFileName' ]} must contain "name" (string) and "schemas" (array).`
            } )

            return { result }
        }

        const sourceDir = join( FlowMcpCli.#schemasDir(), sourceName )
        await mkdir( sourceDir, { recursive: true } )

        const registryShared = registry[ 'shared' ]
        if( Array.isArray( registryShared ) && registryShared.length > 0 ) {
            await registryShared
                .reduce( ( promise, sharedEntry, index ) => promise.then( async () => {
                    const { file } = sharedEntry
                    const remotePath = baseDir
                        ? `${baseDir}/${file}`
                        : file

                    const fileUrl = FlowMcpCli.#buildRawUrl( { owner, repo, branch, 'path': remotePath } )
                    const targetPath = join( sourceDir, file )

                    process.stdout.write( `  Shared ${index + 1}/${registryShared.length}: ${file}\r` )

                    await FlowMcpCli.#downloadSchema( { url: fileUrl, targetPath } )
                } ), Promise.resolve() )

            process.stdout.write( ' '.repeat( 80 ) + '\r' )
        }

        let downloaded = 0
        let skipped = 0
        let failed = 0
        const localHashes = {}
        const errors = []
        const total = registrySchemas.length

        await registrySchemas
            .reduce( ( promise, schemaEntry, index ) => promise.then( async () => {
                const { file } = schemaEntry
                const remotePath = baseDir
                    ? `${baseDir}/${file}`
                    : file

                const fileUrl = FlowMcpCli.#buildRawUrl( { owner, repo, branch, 'path': remotePath } )
                const targetPath = join( sourceDir, file )

                process.stdout.write( `  Downloading ${index + 1}/${total}: ${file}\r` )

                const { success, downloadStatus, hash, error: dlError } = await FlowMcpCli.#downloadSchema( { url: fileUrl, targetPath } )
                if( success ) {
                    if( downloadStatus === 'skipped' ) {
                        skipped = skipped + 1
                    } else {
                        downloaded = downloaded + 1
                    }

                    if( hash ) {
                        localHashes[ file ] = hash
                    }
                } else {
                    failed = failed + 1
                    errors.push( `${file}: ${dlError}` )
                }
            } ), Promise.resolve() )

        process.stdout.write( ' '.repeat( 80 ) + '\r' )

        const registryCopy = {
            'name': registry[ 'name' ],
            'description': registry[ 'description' ],
            'schemaSpec': registry[ 'schemaSpec' ],
            'baseDir': registry[ 'baseDir' ],
            'shared': registry[ 'shared' ],
            'schemas': registry[ 'schemas' ],
            localHashes
        }

        await writeFile(
            join( sourceDir, '_registry.json' ),
            JSON.stringify( registryCopy, null, 4 ),
            'utf-8'
        )

        const globalConfigPath = FlowMcpCli.#globalConfigPath()
        const { data: existingConfig } = await FlowMcpCli.#readJson( { filePath: globalConfigPath } )
        const globalConfig = existingConfig || {}

        if( !globalConfig[ 'sources' ] ) {
            globalConfig[ 'sources' ] = {}
        }

        globalConfig[ 'sources' ][ sourceName ] = {
            'type': 'github',
            'repository': url,
            branch,
            registryUrl,
            'schemaCount': downloaded + skipped,
            'importedAt': new Date().toISOString()
        }

        await FlowMcpCli.#writeGlobalConfig( { config: globalConfig } )

        const result = {
            'status': failed === 0,
            'source': sourceName,
            'schemasImported': downloaded + skipped,
            downloaded,
            skipped,
            failed,
            'summary': `${downloaded} downloaded, ${skipped} up to date, ${failed} failed`,
            'errors': errors.length > 0 ? errors : undefined
        }

        return { result }
    }


    static async importRegistry( { registryUrl } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { status: validStatus, messages: validMessages } = FlowMcpCli.validationImportRegistry( { registryUrl } )
        if( !validStatus ) {
            const result = {
                'status': false,
                'messages': validMessages,
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} import-registry <url-to-${appConfig[ 'registryFileName' ]}>`
            }

            return { result }
        }

        const { data: registryText, error: fetchError } = await FlowMcpCli.#fetchUrl( { 'url': registryUrl } )
        if( !registryText ) {
            const result = FlowMcpCli.#error( {
                'error': `Failed to fetch registry: ${fetchError}`,
                'fix': `Verify the URL points to a valid ${appConfig[ 'registryFileName' ]} file.`
            } )

            return { result }
        }

        let registry
        try {
            registry = JSON.parse( registryText )
        } catch {
            const result = FlowMcpCli.#error( {
                'error': 'Invalid JSON in registry file',
                'fix': 'The remote registry file contains invalid JSON.'
            } )

            return { result }
        }

        const { name: sourceName, baseDir, schemas: registrySchemas } = registry

        if( !sourceName || !Array.isArray( registrySchemas ) ) {
            const result = FlowMcpCli.#error( {
                'error': 'Registry missing required fields: name, schemas',
                'fix': 'The registry must contain "name" (string) and "schemas" (array).'
            } )

            return { result }
        }

        const registryBaseUrl = FlowMcpCli.#resolveRegistryBaseUrl( { registryUrl } )
        const baseDirAlreadyInUrl = baseDir && registryBaseUrl.endsWith( baseDir )

        const sourceDir = join( FlowMcpCli.#schemasDir(), sourceName )
        await mkdir( sourceDir, { recursive: true } )

        const registryShared = registry[ 'shared' ]
        if( Array.isArray( registryShared ) && registryShared.length > 0 ) {
            await registryShared
                .reduce( ( promise, sharedEntry, index ) => promise.then( async () => {
                    const { file } = sharedEntry
                    const remotePath = ( baseDir && !baseDirAlreadyInUrl )
                        ? `${baseDir}/${file}`
                        : file

                    const fileUrl = `${registryBaseUrl}/${remotePath}`
                    const targetPath = join( sourceDir, file )

                    process.stdout.write( `  Shared ${index + 1}/${registryShared.length}: ${file}\r` )

                    await FlowMcpCli.#downloadSchema( { 'url': fileUrl, targetPath } )
                } ), Promise.resolve() )

            process.stdout.write( ' '.repeat( 80 ) + '\r' )
        }

        let downloaded = 0
        let skipped = 0
        let failed = 0
        const localHashes = {}
        const errors = []
        const total = registrySchemas.length

        await registrySchemas
            .reduce( ( promise, schemaEntry, index ) => promise.then( async () => {
                const { file } = schemaEntry
                const remotePath = ( baseDir && !baseDirAlreadyInUrl )
                    ? `${baseDir}/${file}`
                    : file

                const fileUrl = `${registryBaseUrl}/${remotePath}`
                const targetPath = join( sourceDir, file )

                process.stdout.write( `  Downloading ${index + 1}/${total}: ${file}\r` )

                const { success, downloadStatus, hash, error: dlError } = await FlowMcpCli.#downloadSchema( { 'url': fileUrl, targetPath } )
                if( success ) {
                    if( downloadStatus === 'skipped' ) {
                        skipped = skipped + 1
                    } else {
                        downloaded = downloaded + 1
                    }

                    if( hash ) {
                        localHashes[ file ] = hash
                    }
                } else {
                    failed = failed + 1
                    errors.push( `${file}: ${dlError}` )
                }
            } ), Promise.resolve() )

        process.stdout.write( ' '.repeat( 80 ) + '\r' )

        const registryCopy = {
            'name': registry[ 'name' ],
            'description': registry[ 'description' ],
            'schemaSpec': registry[ 'schemaSpec' ],
            'baseDir': registry[ 'baseDir' ],
            'shared': registry[ 'shared' ],
            'schemas': registry[ 'schemas' ],
            localHashes
        }

        await writeFile(
            join( sourceDir, '_registry.json' ),
            JSON.stringify( registryCopy, null, 4 ),
            'utf-8'
        )

        const schemasImported = downloaded + skipped

        console.log( '' )
        console.log( `  ${chalk.green( 'Import complete.' )} ${downloaded} downloaded, ${skipped} up to date.` )

        const { modules } = FlowMcpCli.#collectRequiredModules( { registrySchemas } )
        let allInstalled = true

        if( modules.length > 0 ) {
            console.log( '' )
            console.log( `  ${chalk.cyan( `${modules.length} schemas require npm modules:` )}` )

            modules
                .forEach( ( mod ) => {
                    const usedByNames = mod[ 'usedBy' ]
                        .map( ( f ) => {
                            const name = f.replace( /\.json$/, '' )

                            return name
                        } )
                        .join( ', ' )

                    console.log( `    ${chalk.white( mod[ 'name' ] )} ${chalk.gray( `(${mod[ 'version' ]})` )}  ${chalk.gray( '—' )} ${chalk.gray( usedByNames )}` )
                } )

            const { command } = FlowMcpCli.#buildInstallCommand( { sourceDir, modules } )

            console.log( '' )
            console.log( `  ${chalk.yellow( 'Open a new terminal and run:' )}` )
            console.log( '' )
            console.log( `    ${chalk.white( command )}` )
            console.log( '' )

            await inquirer.prompt( [
                {
                    'type': 'input',
                    'name': 'verify',
                    'message': 'Press Enter to verify installation...'
                }
            ] )

            console.log( `  ${chalk.cyan( 'Verifying modules...' )}` )

            const { allInstalled: verified, installed, missing } = FlowMcpCli.#verifyModules( { sourceDir, modules } )
            allInstalled = verified

            installed
                .forEach( ( name ) => {
                    console.log( `    ${chalk.green( '\u2713' )} ${name}` )
                } )

            missing
                .forEach( ( name ) => {
                    console.log( `    ${chalk.red( '\u2717' )} ${name} ${chalk.gray( '— not found' )}` )
                } )

            console.log( '' )

            if( allInstalled ) {
                console.log( `  ${chalk.green( 'All modules installed successfully.' )}` )
            } else {
                console.log( `  ${chalk.yellow( `${missing.length} module${missing.length > 1 ? 's' : ''} missing.` )} Schemas using ${missing.join( ', ' )} will not work.` )
                console.log( `  ${chalk.gray( 'Run the install command again or install manually.' )}` )
            }

            console.log( '' )
        }

        const globalConfigPath = FlowMcpCli.#globalConfigPath()
        const { data: existingConfig } = await FlowMcpCli.#readJson( { filePath: globalConfigPath } )
        const globalConfig = existingConfig || {}

        if( !globalConfig[ 'sources' ] ) {
            globalConfig[ 'sources' ] = {}
        }

        globalConfig[ 'sources' ][ sourceName ] = {
            'type': 'registry',
            registryUrl,
            'schemaCount': schemasImported,
            'importedAt': new Date().toISOString(),
            'modulesInstalled': allInstalled
        }

        await FlowMcpCli.#writeGlobalConfig( { 'config': globalConfig } )

        const result = {
            'status': failed === 0,
            'source': sourceName,
            schemasImported,
            downloaded,
            skipped,
            failed,
            'summary': `${downloaded} downloaded, ${skipped} up to date, ${failed} failed`,
            'requiredModules': modules,
            'modulesVerified': allInstalled,
            'errors': errors.length > 0 ? errors : undefined
        }

        return { result }
    }


    static async update( { sourceName } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { status: validStatus, messages: validMessages } = FlowMcpCli.validationUpdate( { sourceName } )
        if( !validStatus ) {
            const result = {
                'status': false,
                'messages': validMessages,
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} update [source-name]`
            }

            return { result }
        }

        const globalConfigPath = FlowMcpCli.#globalConfigPath()
        const { data: globalConfig } = await FlowMcpCli.#readJson( { filePath: globalConfigPath } )
        const configSources = ( globalConfig && globalConfig[ 'sources' ] ) || {}

        const sourceEntries = Object.entries( configSources )
            .filter( ( [ name, sourceConfig ] ) => {
                const hasRegistryUrl = sourceConfig[ 'registryUrl' ] !== undefined
                const matchesName = sourceName ? name === sourceName : true

                return hasRegistryUrl && matchesName
            } )

        console.log( '' )
        console.log( `  ${chalk.cyan( 'Checking for updates...' )}` )

        if( sourceEntries.length === 0 ) {
            const errorMessage = sourceName
                ? `Source "${sourceName}" not found or has no registry URL.`
                : 'No sources with registry URLs found.'
            const result = FlowMcpCli.#error( {
                'error': errorMessage,
                'fix': `Run ${appConfig[ 'cliCommand' ]} status to see available sources.`
            } )

            return { result }
        }

        const results = []

        await sourceEntries
            .reduce( ( promise, [ name, sourceConfig ] ) => promise.then( async () => {
                const { registryUrl } = sourceConfig
                console.log( '' )
                console.log( `  ${chalk.white( name )} ${chalk.gray( `(${registryUrl})` )}` )
                const { updateResult } = await FlowMcpCli.#updateSource( { 'sourceName': name, registryUrl } )
                results.push( updateResult )
            } ), Promise.resolve() )

        const totalDownloaded = results
            .reduce( ( sum, r ) => {
                const count = sum + r[ 'downloaded' ]

                return count
            }, 0 )

        const totalUpdated = results
            .reduce( ( sum, r ) => {
                const count = sum + r[ 'updated' ]

                return count
            }, 0 )

        const totalSkipped = results
            .reduce( ( sum, r ) => {
                const count = sum + r[ 'skipped' ]

                return count
            }, 0 )

        const totalFailed = results
            .reduce( ( sum, r ) => {
                const count = sum + r[ 'failed' ]

                return count
            }, 0 )

        const updatedGlobalConfig = globalConfig || {}
        updatedGlobalConfig[ 'updatedAt' ] = new Date().toISOString()

        await FlowMcpCli.#writeGlobalConfig( { 'config': updatedGlobalConfig } )

        console.log( '' )
        console.log( `  ${chalk.green( 'Update complete.' )} ${totalDownloaded} new, ${totalUpdated} updated, ${totalSkipped} up to date${totalFailed > 0 ? chalk.red( `, ${totalFailed} failed` ) : ''}` )

        const result = {
            'status': totalFailed === 0,
            'sources': results,
            'summary': `${totalDownloaded} new, ${totalUpdated} updated, ${totalSkipped} up to date, ${totalFailed} failed`
        }

        return { result }
    }


    static async schemas() {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { sources } = await FlowMcpCli.#listSources()

        const result = {
            'status': true,
            sources
        }

        return { result }
    }


    static async groupAppend( { name, tools, cwd } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { status: validStatus, messages } = FlowMcpCli.validationGroupAppend( { name, tools } )
        if( !validStatus ) {
            const result = {
                'status': false,
                messages,
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} group append <name> --tools "source/file.mjs::route1,source/file.mjs::route2"`
            }

            return { result }
        }

        const toolRefs = tools
            .split( ',' )
            .map( ( s ) => {
                const trimmed = s.trim()

                return trimmed
            } )
            .filter( ( s ) => {
                const hasLength = s.length > 0

                return hasLength
            } )

        const schemasBaseDir = FlowMcpCli.#schemasDir()
        const invalidRefs = []

        await toolRefs
            .reduce( ( promise, ref ) => promise.then( async () => {
                const { schemaRef, routeName } = FlowMcpCli.#parseToolRef( { 'toolRef': ref } )
                const filePath = join( schemasBaseDir, schemaRef )

                try {
                    await access( filePath, constants.F_OK )

                    if( routeName ) {
                        const { main } = await FlowMcpCli.#loadSchema( { filePath } )
                        if( !main || !main[ 'routes' ] || !main[ 'routes' ][ routeName ] ) {
                            invalidRefs.push( ref )
                        }
                    }
                } catch {
                    invalidRefs.push( ref )
                }
            } ), Promise.resolve() )

        if( invalidRefs.length > 0 ) {
            const result = FlowMcpCli.#error( {
                'error': `Tools not found: ${invalidRefs.join( ', ' )}`,
                'fix': `Run ${appConfig[ 'cliCommand' ]} call list-tools to see available tool references.`
            } )

            return { result }
        }

        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )
        const config = localConfig || { 'root': `~/${appConfig[ 'globalConfigDirName' ]}` }

        if( !config[ 'groups' ] ) {
            config[ 'groups' ] = {}
        }

        const existingTools = config[ 'groups' ][ name ]
            ? ( config[ 'groups' ][ name ][ 'tools' ] || config[ 'groups' ][ name ][ 'schemas' ] || [] )
            : []

        const merged = [ ...new Set( [ ...existingTools, ...toolRefs ] ) ]
        const added = toolRefs
            .filter( ( ref ) => {
                const isNew = !existingTools.includes( ref )

                return isNew
            } )

        const existingDescription = config[ 'groups' ][ name ]
            ? ( config[ 'groups' ][ name ][ 'description' ] || '' )
            : ''

        config[ 'groups' ][ name ] = {
            'description': existingDescription,
            'tools': merged
        }

        if( !config[ 'defaultGroup' ] ) {
            config[ 'defaultGroup' ] = name
        }

        await mkdir( join( cwd, appConfig[ 'localConfigDirName' ] ), { recursive: true } )
        await writeFile( localConfigPath, JSON.stringify( config, null, 4 ), 'utf-8' )

        const result = {
            'status': true,
            'group': name,
            'toolCount': merged.length,
            'tools': merged,
            'added': added,
            'isDefault': config[ 'defaultGroup' ] === name
        }

        return { result }
    }


    static async groupRemove( { name, tools, cwd } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { status: validStatus, messages } = FlowMcpCli.validationGroupRemove( { name, tools } )
        if( !validStatus ) {
            const result = {
                'status': false,
                messages,
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} group remove <name> --tools "source/file.mjs::route1,source/file.mjs::route2"`
            }

            return { result }
        }

        const toolRefs = tools
            .split( ',' )
            .map( ( s ) => {
                const trimmed = s.trim()

                return trimmed
            } )
            .filter( ( s ) => {
                const hasLength = s.length > 0

                return hasLength
            } )

        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )

        if( !localConfig ) {
            const result = FlowMcpCli.#error( {
                'error': 'No local config found.',
                'fix': `Run ${appConfig[ 'cliCommand' ]} init first.`
            } )

            return { result }
        }

        if( !localConfig[ 'groups' ] || !localConfig[ 'groups' ][ name ] ) {
            const result = FlowMcpCli.#error( {
                'error': `Group "${name}" not found.`,
                'fix': `Run ${appConfig[ 'cliCommand' ]} group list to see available groups.`
            } )

            return { result }
        }

        const existingTools = localConfig[ 'groups' ][ name ][ 'tools' ] || localConfig[ 'groups' ][ name ][ 'schemas' ] || []
        const removeSet = new Set( toolRefs )
        const remaining = existingTools
            .filter( ( ref ) => {
                const keep = !removeSet.has( ref )

                return keep
            } )

        const removed = toolRefs
            .filter( ( ref ) => {
                const wasPresent = existingTools.includes( ref )

                return wasPresent
            } )

        localConfig[ 'groups' ][ name ][ 'tools' ] = remaining

        if( localConfig[ 'groups' ][ name ][ 'schemas' ] ) {
            delete localConfig[ 'groups' ][ name ][ 'schemas' ]
        }

        await writeFile( localConfigPath, JSON.stringify( localConfig, null, 4 ), 'utf-8' )

        const result = {
            'status': true,
            'group': name,
            'toolCount': remaining.length,
            'tools': remaining,
            'removed': removed
        }

        return { result }
    }


    static async groupList( { cwd } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )

        if( !localConfig || !localConfig[ 'groups' ] ) {
            const result = {
                'status': true,
                'defaultGroup': null,
                'groups': {}
            }

            return { result }
        }

        const { defaultGroup } = localConfig
        const groups = {}

        Object.entries( localConfig[ 'groups' ] )
            .forEach( ( [ groupName, groupData ] ) => {
                const { description } = groupData
                const toolRefs = groupData[ 'tools' ] || groupData[ 'schemas' ] || []
                groups[ groupName ] = {
                    description,
                    'toolCount': toolRefs.length
                }
            } )

        const result = {
            'status': true,
            'defaultGroup': defaultGroup || null,
            groups
        }

        return { result }
    }


    static async groupSetDefault( { name, cwd } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { status: validStatus, messages: validMessages } = FlowMcpCli.validationGroupSetDefault( { name } )
        if( !validStatus ) {
            const result = {
                'status': false,
                'messages': validMessages,
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} group set-default <name>`
            }

            return { result }
        }

        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )

        if( !localConfig ) {
            const result = FlowMcpCli.#error( {
                'error': 'No local config found.',
                'fix': `Ask the user to run: ${appConfig[ 'cliCommand' ]} init`
            } )

            return { result }
        }

        if( !localConfig[ 'groups' ] || !localConfig[ 'groups' ][ name ] ) {
            const result = FlowMcpCli.#error( {
                'error': `Group "${name}" not found.`,
                'fix': `Run ${appConfig[ 'cliCommand' ]} group list to see available groups.`
            } )

            return { result }
        }

        localConfig[ 'defaultGroup' ] = name
        await writeFile( localConfigPath, JSON.stringify( localConfig, null, 4 ), 'utf-8' )

        const result = {
            'status': true,
            'defaultGroup': name
        }

        return { result }
    }


    static async promptList( { cwd } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )

        if( !localConfig || !localConfig[ 'groups' ] ) {
            const result = {
                'status': true,
                'prompts': []
            }

            return { result }
        }

        const prompts = []

        Object.entries( localConfig[ 'groups' ] )
            .forEach( ( [ groupName, groupData ] ) => {
                const groupPrompts = groupData[ 'prompts' ] || {}
                const toolCount = ( groupData[ 'tools' ] || groupData[ 'schemas' ] || [] ).length

                Object.entries( groupPrompts )
                    .forEach( ( [ promptName, promptData ] ) => {
                        const { title, description } = promptData
                        prompts.push( {
                            'group': groupName,
                            'name': promptName,
                            title,
                            description,
                            toolCount
                        } )
                    } )
            } )

        const result = {
            'status': true,
            prompts
        }

        return { result }
    }


    static async promptSearch( { query, cwd } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { status: validStatus, messages } = FlowMcpCli.validationPromptSearch( { query } )
        if( !validStatus ) {
            const result = {
                'status': false,
                messages,
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} prompt search <query>`
            }

            return { result }
        }

        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )

        if( !localConfig || !localConfig[ 'groups' ] ) {
            const result = {
                'status': true,
                'matches': []
            }

            return { result }
        }

        const lowerQuery = query.toLowerCase()
        const matches = []

        Object.entries( localConfig[ 'groups' ] )
            .forEach( ( [ groupName, groupData ] ) => {
                const groupPrompts = groupData[ 'prompts' ] || {}

                Object.entries( groupPrompts )
                    .forEach( ( [ promptName, promptData ] ) => {
                        const { title, description } = promptData
                        const titleMatch = ( title || '' ).toLowerCase().includes( lowerQuery )
                        const descMatch = ( description || '' ).toLowerCase().includes( lowerQuery )
                        const nameMatch = promptName.toLowerCase().includes( lowerQuery )

                        if( titleMatch || descMatch || nameMatch ) {
                            matches.push( {
                                'group': groupName,
                                'name': promptName,
                                title,
                                description
                            } )
                        }
                    } )
            } )

        const result = {
            'status': true,
            matches
        }

        return { result }
    }


    static async promptShow( { group, name, cwd } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { status: validStatus, messages } = FlowMcpCli.validationPromptShow( { group, name } )
        if( !validStatus ) {
            const result = {
                'status': false,
                messages,
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} prompt show <group>/<name>`
            }

            return { result }
        }

        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )

        if( !localConfig || !localConfig[ 'groups' ] || !localConfig[ 'groups' ][ group ] ) {
            const result = FlowMcpCli.#error( {
                'error': `Group "${group}" not found.`,
                'fix': `Run ${appConfig[ 'cliCommand' ]} group list to see available groups.`
            } )

            return { result }
        }

        const groupData = localConfig[ 'groups' ][ group ]
        const groupPrompts = groupData[ 'prompts' ] || {}

        if( !groupPrompts[ name ] ) {
            const result = FlowMcpCli.#error( {
                'error': `Prompt "${name}" not found in group "${group}".`,
                'fix': `Run ${appConfig[ 'cliCommand' ]} prompt list to see available prompts.`
            } )

            return { result }
        }

        const { file, title, description } = groupPrompts[ name ]
        const filePath = resolve( cwd, file )
        const { data: content, error: readError } = await FlowMcpCli.#readText( { filePath } )

        if( !content ) {
            const result = FlowMcpCli.#error( {
                'error': `Cannot read prompt file: ${readError}`,
                'fix': `Check that the file exists at ${file}`
            } )

            return { result }
        }

        const result = {
            'status': true,
            'group': group,
            'name': name,
            title,
            description,
            file,
            content
        }

        return { result }
    }


    static async promptAdd( { group, name, file, cwd } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { status: validStatus, messages } = FlowMcpCli.validationPromptAdd( { group, name, file } )
        if( !validStatus ) {
            const result = {
                'status': false,
                messages,
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} prompt add <group> <name> --file <path>`
            }

            return { result }
        }

        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )

        if( !localConfig || !localConfig[ 'groups' ] || !localConfig[ 'groups' ][ group ] ) {
            const result = FlowMcpCli.#error( {
                'error': `Group "${group}" not found.`,
                'fix': `Run ${appConfig[ 'cliCommand' ]} group list to see available groups. Create one with: ${appConfig[ 'cliCommand' ]} group append <name> --tools <list>`
            } )

            return { result }
        }

        const groupData = localConfig[ 'groups' ][ group ]
        const toolRefs = groupData[ 'tools' ] || groupData[ 'schemas' ] || []

        if( toolRefs.length === 0 ) {
            const result = FlowMcpCli.#error( {
                'error': `PRM006 "${group}": Group must have at least one tool to have prompts.`,
                'fix': `Add tools first: ${appConfig[ 'cliCommand' ]} group append ${group} --tools <list>`
            } )

            return { result }
        }

        const namePattern = /^[a-z][a-z0-9-]*$/
        if( !namePattern.test( name ) ) {
            const result = FlowMcpCli.#error( {
                'error': `PRM001 "${name}": Name must match ^[a-z][a-z0-9-]*$`,
                'fix': `Use lowercase letters, numbers, and hyphens. Must start with a letter.`
            } )

            return { result }
        }

        const expectedFilename = `${name}.md`
        const actualFilename = basename( file )
        if( actualFilename !== expectedFilename ) {
            const result = FlowMcpCli.#error( {
                'error': `PRM008 "${name}": File must be named ${expectedFilename}, got ${actualFilename}`,
                'fix': `Rename the file to ${expectedFilename} or use a matching prompt name.`
            } )

            return { result }
        }

        const filePath = resolve( cwd, file )
        const { data: content, error: readError } = await FlowMcpCli.#readText( { filePath } )

        if( !content ) {
            const result = FlowMcpCli.#error( {
                'error': `PRM002 "${name}": File not found at ${file}`,
                'fix': `Create the prompt file first, then add it.`
            } )

            return { result }
        }

        const lines = content.split( '\n' )
        const firstLine = lines[ 0 ] || ''

        if( !firstLine.startsWith( '# ' ) ) {
            const result = FlowMcpCli.#error( {
                'error': `PRM003 "${name}": Missing required section # Title (first line)`,
                'fix': `The first line of the prompt file must be a level-1 heading: # Your Title`
            } )

            return { result }
        }

        const title = firstLine.slice( 2 ).trim()

        const hasWorkflow = lines
            .some( ( line ) => {
                const isWorkflow = line.trim().startsWith( '## Workflow' )

                return isWorkflow
            } )

        if( !hasWorkflow ) {
            const result = FlowMcpCli.#error( {
                'error': `PRM004 "${name}": Missing required section ## Workflow`,
                'fix': `Add a ## Workflow section to the prompt file.`
            } )

            return { result }
        }

        const description = FlowMcpCli.#extractPromptDescription( { lines } )

        const { resolved, unresolved } = FlowMcpCli.#detectToolReferences( { lines, toolRefs } )

        const warnings = unresolved
            .map( ( ref ) => {
                const warning = `PRM005 "${name}": Tool "${ref}" not found in group "${group}"`

                return warning
            } )

        if( !groupData[ 'prompts' ] ) {
            groupData[ 'prompts' ] = {}
        }

        groupData[ 'prompts' ][ name ] = {
            title,
            description,
            'file': file
        }

        await writeFile( localConfigPath, JSON.stringify( localConfig, null, 4 ), 'utf-8' )

        const result = {
            'status': true,
            'group': group,
            'name': name,
            title,
            description,
            'file': file,
            'resolvedTools': resolved,
            warnings
        }

        return { result }
    }


    static async promptRemove( { group, name, cwd } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { status: validStatus, messages } = FlowMcpCli.validationPromptRemove( { group, name } )
        if( !validStatus ) {
            const result = {
                'status': false,
                messages,
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} prompt remove <group> <name>`
            }

            return { result }
        }

        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )

        if( !localConfig || !localConfig[ 'groups' ] || !localConfig[ 'groups' ][ group ] ) {
            const result = FlowMcpCli.#error( {
                'error': `Group "${group}" not found.`,
                'fix': `Run ${appConfig[ 'cliCommand' ]} group list to see available groups.`
            } )

            return { result }
        }

        const groupData = localConfig[ 'groups' ][ group ]
        const groupPrompts = groupData[ 'prompts' ] || {}

        if( !groupPrompts[ name ] ) {
            const result = FlowMcpCli.#error( {
                'error': `Prompt "${name}" not found in group "${group}".`,
                'fix': `Run ${appConfig[ 'cliCommand' ]} prompt list to see available prompts.`
            } )

            return { result }
        }

        const { file } = groupPrompts[ name ]
        delete groupPrompts[ name ]

        if( Object.keys( groupPrompts ).length === 0 ) {
            delete groupData[ 'prompts' ]
        }

        await writeFile( localConfigPath, JSON.stringify( localConfig, null, 4 ), 'utf-8' )

        const result = {
            'status': true,
            'group': group,
            'name': name,
            'removed': true,
            'fileNotDeleted': file
        }

        return { result }
    }


    static async validate( { schemaPath, cwd } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        if( !schemaPath && cwd ) {
            const { schemas: groupSchemas, error: groupError } = await FlowMcpCli.#resolveDefaultGroupSchemas( { cwd } )
            if( groupError ) {
                const result = FlowMcpCli.#error( { error: groupError } )

                return { result }
            }

            const results = groupSchemas
                .map( ( { main, file } ) => {
                    try {
                        const { status, messages } = FlowMCP.validateMain( { main } )
                        const namespace = main[ 'namespace' ] || 'unknown'
                        const entry = { file, namespace, status, messages }

                        return entry
                    } catch( err ) {
                        const entry = {
                            file,
                            'namespace': main[ 'namespace' ] || 'unknown',
                            'status': false,
                            'messages': [ err.message ]
                        }

                        return entry
                    }
                } )

            const passed = results
                .filter( ( { status } ) => {
                    const isPassed = status === true

                    return isPassed
                } )
                .length

            const failed = results.length - passed

            const result = {
                'status': failed === 0,
                'total': results.length,
                passed,
                failed,
                results
            }

            return { result }
        }

        const { status: validStatus, messages: validMessages } = FlowMcpCli.validationValidate( { schemaPath } )
        if( !validStatus ) {
            const result = { 'status': false, 'messages': validMessages }

            return { result }
        }

        const { schemas, error: loadError } = await FlowMcpCli.#loadSchemasFromPath( { schemaPath } )
        if( !schemas ) {
            const result = FlowMcpCli.#error( { error: loadError } )

            return { result }
        }

        const results = schemas
            .map( ( { main, file } ) => {
                try {
                    const { status, messages } = FlowMCP.validateMain( { main } )
                    const namespace = main[ 'namespace' ] || 'unknown'
                    const entry = { file, namespace, status, messages }

                    return entry
                } catch( err ) {
                    const entry = {
                        file,
                        'namespace': main[ 'namespace' ] || 'unknown',
                        'status': false,
                        'messages': [ err.message ]
                    }

                    return entry
                }
            } )

        const passed = results
            .filter( ( { status } ) => {
                const isPassed = status === true

                return isPassed
            } )
            .length

        const failed = results.length - passed

        const result = {
            'status': failed === 0,
            'total': results.length,
            passed,
            failed,
            results
        }

        return { result }
    }


    static async test( { schemaPath, route, cwd, group, all } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        if( all ) {
            const { schemas: allSchemas } = await FlowMcpCli.#loadAllSchemas()

            const { config } = await FlowMcpCli.#readConfig( { cwd } )
            const { envPath } = config || {}
            let envObject = {}
            if( envPath ) {
                const { data: envContent } = await FlowMcpCli.#readText( { filePath: envPath } )
                if( envContent ) {
                    const parsed = FlowMcpCli.#parseEnvFile( { envContent } )
                    envObject = parsed[ 'envObject' ]
                }
            }

            console.log( '' )
            console.log( `  ${chalk.cyan( `Testing all schemas (${allSchemas.length} total)...` )}` )
            console.log( '' )

            const allResults = []
            let skippedCount = 0

            await allSchemas
                .reduce( ( promise, entry ) => promise.then( async () => {
                    const { main, handlersFn, file, source, loadError } = entry

                    if( !main ) {
                        console.log( `  ${chalk.red( '✗' )} ${chalk.gray( source + '/' )}${file}` )
                        console.log( `    ${chalk.gray( loadError )}` )
                        allResults.push( { 'namespace': 'unknown', file, source, 'status': false, 'messages': [ loadError ], 'skipped': false } )

                        return
                    }

                    const namespace = main[ 'namespace' ] || 'unknown'
                    const requiredServerParams = main[ 'requiredServerParams' ] || []

                    if( requiredServerParams.length > 0 ) {
                        const { valid } = FlowMcpCli.#validateEnvParams( { envObject, requiredServerParams, namespace, 'envPath': envPath || '' } )
                        if( !valid ) {
                            const missingParams = requiredServerParams
                                .filter( ( p ) => {
                                    const isMissing = envObject[ p ] === undefined

                                    return isMissing
                                } )

                            console.log( `  ${chalk.yellow( '⚠' )} ${chalk.gray( source + '/' )}${file}` )
                            console.log( `    ${chalk.gray( `skipped — missing env: ${missingParams.join( ', ' )}` )}` )
                            allResults.push( { namespace, file, source, 'status': true, 'messages': [], 'skipped': true, 'skipReason': `Missing env: ${missingParams.join( ', ' )}` } )
                            skippedCount = skippedCount + 1

                            return
                        }
                    }

                    const { serverParams } = FlowMcpCli.#buildServerParams( { envObject, requiredServerParams } )

                    let tests = []
                    try {
                        tests = FlowMcpCli.#getAllTests( { main } )
                    } catch( err ) {
                        console.log( `  ${chalk.red( '✗' )} ${chalk.gray( source + '/' )}${file}` )
                        console.log( `    ${chalk.gray( err.message )}` )
                        allResults.push( { namespace, file, source, 'status': false, 'messages': [ err.message ], 'skipped': false } )

                        return
                    }

                    if( tests.length === 0 ) {
                        console.log( `  ${chalk.yellow( '⚠' )} ${chalk.gray( source + '/' )}${file}` )
                        console.log( `    ${chalk.gray( 'no tests defined' )}` )
                        allResults.push( { namespace, file, source, 'status': true, 'messages': [], 'skipped': true, 'skipReason': 'No tests defined' } )
                        skippedCount = skippedCount + 1

                        return
                    }

                    const schemasBaseDir = FlowMcpCli.#schemasDir()
                    const schemaFilePath = join( schemasBaseDir, source, file )
                    const { handlerMap } = await FlowMcpCli.#resolveHandlers( { main, handlersFn, 'filePath': schemaFilePath } )

                    console.log( `  ${chalk.white( source + '/' )}${chalk.white( file )}` )

                    await tests
                        .reduce( ( testPromise, test ) => testPromise.then( async () => {
                            const { routeName, userParams } = test
                            try {
                                const fetchResult = await FlowMCP
                                    .fetch( { main, handlerMap, userParams, serverParams, routeName } )
                                const { status, messages, dataAsString } = fetchResult
                                const icon = status ? chalk.green( '✓' ) : chalk.red( '✗' )
                                const msgText = messages.length > 0 ? chalk.gray( ` — ${messages[ 0 ]}` ) : ''
                                console.log( `    ${icon} ${routeName}${msgText}` )
                                const preview = dataAsString ? dataAsString.slice( 0, 200 ) : null
                                allResults.push( { namespace, file, source, routeName, status, messages, 'dataPreview': preview, 'skipped': false } )
                            } catch( err ) {
                                console.log( `    ${chalk.red( '✗' )} ${routeName} ${chalk.gray( `— ${err.message}` )}` )
                                allResults.push( { namespace, file, source, routeName, 'status': false, 'messages': [ err.message ], 'dataPreview': null, 'skipped': false } )
                            }

                            await new Promise( ( r ) => {
                                setTimeout( r, 1000 )
                            } )
                        } ), Promise.resolve() )
                } ), Promise.resolve() )

            const testResults = allResults
                .filter( ( r ) => {
                    const isNotSkipped = !r[ 'skipped' ]

                    return isNotSkipped
                } )

            const passed = testResults
                .filter( ( r ) => {
                    const isPassed = r[ 'status' ] === true

                    return isPassed
                } )
                .length

            const failed = testResults
                .filter( ( r ) => {
                    const isFailed = r[ 'status' ] === false

                    return isFailed
                } )
                .length

            console.log( '' )
            console.log( `  ${chalk.cyan( 'Summary:' )}` )
            console.log( `    Total schemas: ${allSchemas.length}  Tests executed: ${testResults.length}` )
            console.log( `    ${chalk.green( `Passed: ${passed}` )}  ${chalk.red( `Failed: ${failed}` )}  ${chalk.yellow( `Skipped: ${skippedCount}` )}` )
            console.log( '' )

            const result = {
                'status': failed === 0,
                'total': allSchemas.length,
                'testsExecuted': testResults.length,
                passed,
                failed,
                'skipped': skippedCount,
                'results': allResults
            }

            return { result }
        }

        if( !schemaPath && !all && cwd ) {
            let groupSchemas, groupError
            if( group ) {
                const resolved = await FlowMcpCli.#resolveGroupSchemas( { 'groupName': group, cwd } )
                groupSchemas = resolved[ 'schemas' ]
                groupError = resolved[ 'error' ]
            } else {
                const resolved = await FlowMcpCli.#resolveDefaultGroupSchemas( { cwd } )
                groupSchemas = resolved[ 'schemas' ]
                groupError = resolved[ 'error' ]
            }

            if( !groupError && groupSchemas ) {
                const { config } = await FlowMcpCli.#readConfig( { cwd } )
                if( !config ) {
                    const result = FlowMcpCli.#error( { error: `Not initialized. Run: ${appConfig[ 'cliCommand' ]} init` } )

                    return { result }
                }

                const { envPath } = config
                const { data: envContent } = await FlowMcpCli.#readText( { filePath: envPath } )
                if( !envContent ) {
                    const result = FlowMcpCli.#error( {
                        'error': `Cannot read .env file at: ${envPath}`,
                        'fix': `Ensure the .env file exists at ${envPath}`
                    } )

                    return { result }
                }

                const { envObject } = FlowMcpCli.#parseEnvFile( { envContent } )

                const envErrors = []
                groupSchemas
                    .forEach( ( { main } ) => {
                        const namespace = main[ 'namespace' ] || 'unknown'
                        const requiredServerParams = main[ 'requiredServerParams' ] || []
                        const { valid, error: envError, fix: envFix } = FlowMcpCli.#validateEnvParams( {
                            envObject,
                            requiredServerParams,
                            namespace,
                            'envPath': envPath
                        } )

                        if( !valid ) {
                            envErrors.push( { 'error': envError, 'fix': envFix } )
                        }
                    } )

                if( envErrors.length > 0 ) {
                    const errorMessages = envErrors
                        .map( ( { error: e } ) => {
                            return e
                        } )

                    const result = FlowMcpCli.#error( {
                        'error': `Missing env vars: ${errorMessages.join( '; ' )}`,
                        'fix': envErrors[ 0 ][ 'fix' ]
                    } )

                    return { result }
                }

                const allResults = []

                await groupSchemas
                    .reduce( ( promise, { main, handlersFn, file } ) => promise.then( async () => {
                        const namespace = main[ 'namespace' ] || 'unknown'
                        const requiredServerParams = main[ 'requiredServerParams' ] || []
                        const { serverParams } = FlowMcpCli.#buildServerParams( { envObject, requiredServerParams } )

                        let tests = []
                        try {
                            tests = FlowMcpCli.#getAllTests( { main } )
                        } catch( err ) {
                            allResults.push( {
                                namespace,
                                'routeName': '*',
                                'status': false,
                                'messages': [ err.message ],
                                'dataPreview': null
                            } )

                            return
                        }

                        if( route ) {
                            tests = tests
                                .filter( ( { routeName } ) => {
                                    const matches = routeName === route

                                    return matches
                                } )
                        }

                        const schemasBaseDir = FlowMcpCli.#schemasDir()
                        const schemaFilePath = join( schemasBaseDir, file )
                        const { handlerMap } = await FlowMcpCli.#resolveHandlers( { main, handlersFn, 'filePath': schemaFilePath } )

                        await tests
                            .reduce( ( testPromise, test ) => testPromise.then( async () => {
                                const { routeName, userParams } = test

                                try {
                                    const fetchResult = await FlowMCP
                                        .fetch( { main, handlerMap, userParams, serverParams, routeName } )
                                    const { status, messages, dataAsString } = fetchResult

                                    const preview = dataAsString
                                        ? dataAsString.slice( 0, 200 )
                                        : null

                                    allResults.push( {
                                        namespace,
                                        routeName,
                                        status,
                                        messages,
                                        'dataPreview': preview
                                    } )
                                } catch( err ) {
                                    allResults.push( {
                                        namespace,
                                        routeName,
                                        'status': false,
                                        'messages': [ err.message ],
                                        'dataPreview': null
                                    } )
                                }

                                await new Promise( ( r ) => {
                                    setTimeout( r, 1000 )
                                } )
                            } ), Promise.resolve() )
                    } ), Promise.resolve() )

                const passed = allResults
                    .filter( ( { status } ) => {
                        const isPassed = status === true

                        return isPassed
                    } )
                    .length

                const failed = allResults.length - passed

                const result = {
                    'status': failed === 0,
                    'total': allResults.length,
                    passed,
                    failed,
                    'results': allResults
                }

                return { result }
            }
        }

        const { status: validStatus, messages: validMessages } = FlowMcpCli.validationTest( { schemaPath } )
        if( !validStatus ) {
            const result = { 'status': false, 'messages': validMessages }

            return { result }
        }

        const { config, error: configError } = await FlowMcpCli.#readConfig( { cwd } )
        if( !config ) {
            const result = FlowMcpCli.#error( { error: configError } )

            return { result }
        }

        const { envPath } = config
        const { data: envContent, error: envError } = await FlowMcpCli.#readText( { filePath: envPath } )
        if( !envContent ) {
            const result = FlowMcpCli.#error( {
                'error': `Cannot read .env file at: ${envPath}`,
                'fix': `Ensure the .env file exists at ${envPath}`
            } )

            return { result }
        }

        const { envObject } = FlowMcpCli.#parseEnvFile( { envContent } )

        const { schemas, error: loadError } = await FlowMcpCli.#loadSchemasFromPath( { schemaPath } )
        if( !schemas ) {
            const result = FlowMcpCli.#error( {
                'error': loadError,
                'fix': 'Provide a valid path to a .mjs schema file or directory.'
            } )

            return { result }
        }

        const schemaEnvErrors = []
        schemas
            .forEach( ( { main } ) => {
                const namespace = main[ 'namespace' ] || 'unknown'
                const requiredServerParams = main[ 'requiredServerParams' ] || []
                const { valid, error: envValidError, fix: envValidFix } = FlowMcpCli.#validateEnvParams( {
                    envObject,
                    requiredServerParams,
                    namespace,
                    'envPath': envPath
                } )

                if( !valid ) {
                    schemaEnvErrors.push( { 'error': envValidError, 'fix': envValidFix } )
                }
            } )

        if( schemaEnvErrors.length > 0 ) {
            const errorMessages = schemaEnvErrors
                .map( ( { error: e } ) => {
                    return e
                } )

            const result = FlowMcpCli.#error( {
                'error': `Missing env vars: ${errorMessages.join( '; ' )}`,
                'fix': schemaEnvErrors[ 0 ][ 'fix' ]
            } )

            return { result }
        }

        const allResults = []

        await schemas
            .reduce( ( promise, { main, handlersFn, file } ) => promise.then( async () => {
                const namespace = main[ 'namespace' ] || 'unknown'
                const requiredServerParams = main[ 'requiredServerParams' ] || []
                const { serverParams } = FlowMcpCli.#buildServerParams( { envObject, requiredServerParams } )

                let tests = []
                try {
                    tests = FlowMcpCli.#getAllTests( { main } )
                } catch( err ) {
                    allResults.push( {
                        namespace,
                        'routeName': '*',
                        'status': false,
                        'messages': [ err.message ],
                        'dataPreview': null
                    } )

                    return
                }

                if( route ) {
                    tests = tests
                        .filter( ( { routeName } ) => {
                            const matches = routeName === route

                            return matches
                        } )
                }

                const resolvedPath = resolve( schemaPath )
                const schemaFilePath = ( await stat( resolvedPath ) ).isFile()
                    ? resolvedPath
                    : join( resolvedPath, file )
                const { handlerMap } = await FlowMcpCli.#resolveHandlers( { main, handlersFn, 'filePath': schemaFilePath } )

                await tests
                    .reduce( ( testPromise, test ) => testPromise.then( async () => {
                        const { routeName, userParams } = test

                        try {
                            const fetchResult = await FlowMCP
                                .fetch( { main, handlerMap, userParams, serverParams, routeName } )
                            const { status, messages, dataAsString } = fetchResult

                            const preview = dataAsString
                                ? dataAsString.slice( 0, 200 )
                                : null

                            allResults.push( {
                                namespace,
                                routeName,
                                status,
                                messages,
                                'dataPreview': preview
                            } )
                        } catch( err ) {
                            allResults.push( {
                                namespace,
                                routeName,
                                'status': false,
                                'messages': [ err.message ],
                                'dataPreview': null
                            } )
                        }

                        await new Promise( ( r ) => {
                            setTimeout( r, 1000 )
                        } )
                    } ), Promise.resolve() )
            } ), Promise.resolve() )

        const passed = allResults
            .filter( ( { status } ) => {
                const isPassed = status === true

                return isPassed
            } )
            .length

        const failed = allResults.length - passed

        const result = {
            'status': failed === 0,
            'total': allResults.length,
            passed,
            failed,
            'results': allResults
        }

        return { result }
    }


    static async status( { cwd } ) {
        const { checks, healthy } = await FlowMcpCli.#healthCheck( { cwd } )

        const { config } = await FlowMcpCli.#readConfig( { cwd } )

        const globalConfigPath = FlowMcpCli.#globalConfigPath()
        const { data: globalConfig } = await FlowMcpCli.#readJson( { filePath: globalConfigPath } )
        const sourcesInfo = {}

        if( globalConfig && globalConfig[ 'sources' ] ) {
            Object.entries( globalConfig[ 'sources' ] )
                .forEach( ( [ sourceName, sourceData ] ) => {
                    const { schemaCount } = sourceData
                    sourcesInfo[ sourceName ] = { schemaCount }
                } )
        }

        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )
        const groupsInfo = {}
        let defaultGroup = null

        if( localConfig && localConfig[ 'groups' ] ) {
            Object.entries( localConfig[ 'groups' ] )
                .forEach( ( [ groupName, groupData ] ) => {
                    const toolRefs = groupData[ 'tools' ] || groupData[ 'schemas' ] || []
                    groupsInfo[ groupName ] = { 'toolCount': toolRefs.length }
                } )
        }

        if( localConfig && localConfig[ 'defaultGroup' ] ) {
            defaultGroup = localConfig[ 'defaultGroup' ]
        }

        const result = {
            'status': true,
            healthy,
            checks,
            'config': config
                ? {
                    'envPath': config[ 'envPath' ],
                    'envExists': checks
                        .filter( ( { name } ) => {
                            const isEnv = name === 'envFile'

                            return isEnv
                        } )
                        .map( ( { ok } ) => {
                            return ok
                        } )[ 0 ] || false,
                    'flowmcpCore': config[ 'flowmcpCore' ],
                    'initialized': config[ 'initialized' ]
                }
                : null,
            'sources': sourcesInfo,
            'groups': groupsInfo,
            defaultGroup
        }

        return { result }
    }


    static async run( { group, cwd } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        let resolvedSchemas = null
        let serverName = null

        if( !group ) {
            const { schemas: agentSchemas, error: agentError, fix: agentFix } = await FlowMcpCli.#resolveAgentSchemas( { cwd } )
            if( !agentSchemas ) {
                const result = FlowMcpCli.#error( { 'error': agentError, 'fix': agentFix } )

                return { result }
            }

            resolvedSchemas = agentSchemas
            serverName = 'default'
        } else {
            const { groupName, error: groupNameError, fix: groupNameFix } = await FlowMcpCli.#resolveGroupName( { group, cwd } )
            if( !groupName ) {
                const result = FlowMcpCli.#error( { 'error': groupNameError, 'fix': groupNameFix } )

                return { result }
            }

            const { schemas: groupSchemas, error: schemasError, fix: schemasFix } = await FlowMcpCli.#resolveGroupSchemas( { groupName, cwd } )
            if( !groupSchemas ) {
                const result = FlowMcpCli.#error( { 'error': schemasError, 'fix': schemasFix } )

                return { result }
            }

            resolvedSchemas = groupSchemas
            serverName = groupName
        }

        const { config } = await FlowMcpCli.#readConfig( { cwd } )
        const { envPath } = config
        const { data: envContent } = await FlowMcpCli.#readText( { filePath: envPath } )
        if( !envContent ) {
            const result = FlowMcpCli.#error( {
                'error': `Cannot read .env file at: ${envPath}`,
                'fix': `Ensure the .env file exists at ${envPath}`
            } )

            return { result }
        }

        const { envObject } = FlowMcpCli.#parseEnvFile( { envContent } )

        const missing = []
        resolvedSchemas
            .forEach( ( { main } ) => {
                const namespace = main[ 'namespace' ] || 'unknown'
                const requiredServerParams = main[ 'requiredServerParams' ] || []
                const { valid, error: envError } = FlowMcpCli.#validateEnvParams( {
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
            const result = FlowMcpCli.#error( {
                'error': `Failed to load MCP SDK: ${err.message}`,
                'fix': 'Run: npm install @modelcontextprotocol/sdk'
            } )

            return { result }
        }

        const server = new McpServer( {
            'name': `${appConfig[ 'cliCommand' ]}-${serverName}`,
            'version': '1.0.0'
        } )

        await resolvedSchemas
            .reduce( ( promise, { main, handlersFn, file } ) => promise.then( async () => {
                const requiredServerParams = main[ 'requiredServerParams' ] || []
                const { serverParams } = FlowMcpCli.#buildServerParams( { envObject, requiredServerParams } )
                const schemasBaseDir = FlowMcpCli.#schemasDir()
                const schemaFilePath = join( schemasBaseDir, file )
                const { handlerMap } = await FlowMcpCli.#resolveHandlers( { main, handlersFn, 'filePath': schemaFilePath } )

                Object.keys( main[ 'routes' ] || {} )
                    .forEach( ( routeName ) => {
                        const { toolName, description, zod, func } = FlowMcpCli.#prepareServerTool( {
                            main,
                            handlerMap,
                            serverParams,
                            routeName
                        } )

                        server.tool( toolName, description, zod, async ( args ) => {
                            const callResult = await func( args )
                            const content = callResult[ 'dataAsString' ] || JSON.stringify( callResult[ 'data' ] || callResult )

                            return {
                                'content': [ { 'type': 'text', 'text': content } ]
                            }
                        } )
                    } )
            } ), Promise.resolve() )

        const transport = new StdioServerTransport()
        process.stderr.write( `${appConfig[ 'appName' ]} server "${serverName}" starting on stdio...\n` )

        await server.connect( transport )
        process.stderr.write( `${appConfig[ 'appName' ]} server "${serverName}" connected.\n` )

        const result = { 'status': true, 'mode': 'stdio', 'group': serverName }

        return { result }
    }


    static async callListTools( { group, cwd } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        let resolvedSchemas = null
        let groupName = null

        if( !group ) {
            const { schemas: agentSchemas, error: agentError, fix: agentFix } = await FlowMcpCli.#resolveAgentSchemas( { cwd } )
            if( !agentSchemas ) {
                const result = FlowMcpCli.#error( { 'error': agentError, 'fix': agentFix } )

                return { result }
            }

            resolvedSchemas = agentSchemas
            groupName = '_default'
        } else {
            const { groupName: resolvedGroupName, error: groupNameError, fix: groupNameFix } = await FlowMcpCli.#resolveGroupName( { group, cwd } )
            if( !resolvedGroupName ) {
                const result = FlowMcpCli.#error( { 'error': groupNameError, 'fix': groupNameFix } )

                return { result }
            }

            groupName = resolvedGroupName

            const { schemas: groupSchemas, error: schemasError, fix: schemasFix } = await FlowMcpCli.#resolveGroupSchemas( { 'groupName': resolvedGroupName, cwd } )
            if( !groupSchemas ) {
                const result = FlowMcpCli.#error( { 'error': schemasError, 'fix': schemasFix } )

                return { result }
            }

            resolvedSchemas = groupSchemas
        }

        const { config } = await FlowMcpCli.#readConfig( { cwd } )
        const { envPath } = config
        const { data: envContent } = await FlowMcpCli.#readText( { filePath: envPath } )
        if( !envContent ) {
            const result = FlowMcpCli.#error( {
                'error': `Cannot read .env file at: ${envPath}`,
                'fix': `Ensure the .env file exists at ${envPath}`
            } )

            return { result }
        }

        const { envObject } = FlowMcpCli.#parseEnvFile( { envContent } )

        const tools = []

        resolvedSchemas
            .forEach( ( { main } ) => {
                const namespace = main[ 'namespace' ] || 'unknown'
                const routes = main[ 'routes' ] || {}

                Object.keys( routes )
                    .forEach( ( routeName ) => {
                        try {
                            const { toolName } = FlowMcpCli.#buildToolName( { routeName, namespace } )
                            const description = routes[ routeName ][ 'description' ] || ''

                            tools.push( { toolName, namespace, routeName, description } )
                        } catch( err ) {
                            tools.push( {
                                'toolName': `error_${routeName}_${namespace}`,
                                namespace,
                                routeName,
                                'description': `Error: ${err.message}`
                            } )
                        }
                    } )
            } )

        const result = {
            'status': true,
            'group': groupName,
            'toolCount': tools.length,
            tools
        }

        return { result }
    }


    static async callTool( { toolName, jsonArgs, group, cwd, noCache = false, refresh = false } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        if( !toolName ) {
            const result = FlowMcpCli.#error( {
                'error': 'Missing tool name.',
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} call <tool-name> [json]. Run ${appConfig[ 'cliCommand' ]} call list-tools to see available tools.`
            } )

            return { result }
        }

        let resolvedSchemas = null

        if( !group ) {
            const { schemas: agentSchemas, error: agentError, fix: agentFix } = await FlowMcpCli.#resolveAgentSchemas( { cwd } )
            if( !agentSchemas ) {
                const result = FlowMcpCli.#error( { 'error': agentError, 'fix': agentFix } )

                return { result }
            }

            resolvedSchemas = agentSchemas
        } else {
            const { groupName, error: groupNameError, fix: groupNameFix } = await FlowMcpCli.#resolveGroupName( { group, cwd } )
            if( !groupName ) {
                const result = FlowMcpCli.#error( { 'error': groupNameError, 'fix': groupNameFix } )

                return { result }
            }

            const { schemas: groupSchemas, error: schemasError, fix: schemasFix } = await FlowMcpCli.#resolveGroupSchemas( { groupName, cwd } )
            if( !groupSchemas ) {
                const result = FlowMcpCli.#error( { 'error': schemasError, 'fix': schemasFix } )

                return { result }
            }

            resolvedSchemas = groupSchemas
        }

        const { config } = await FlowMcpCli.#readConfig( { cwd } )
        const { envPath } = config
        const { data: envContent } = await FlowMcpCli.#readText( { filePath: envPath } )
        if( !envContent ) {
            const result = FlowMcpCli.#error( {
                'error': `Cannot read .env file at: ${envPath}`,
                'fix': `Ensure the .env file exists at ${envPath}`
            } )

            return { result }
        }

        const { envObject } = FlowMcpCli.#parseEnvFile( { envContent } )

        let userParams = {}
        if( jsonArgs ) {
            try {
                userParams = JSON.parse( jsonArgs )
            } catch {
                const result = FlowMcpCli.#error( {
                    'error': 'Invalid JSON argument.',
                    'fix': `Provide valid JSON: ${appConfig[ 'cliCommand' ]} call ${toolName} '{"param": "value"}'`
                } )

                return { result }
            }
        }

        let matchedMain = null
        let matchedHandlersFn = null
        let matchedFile = null
        let matchedToolName = null
        let matchedRouteName = null

        resolvedSchemas
            .forEach( ( { main, handlersFn, file } ) => {
                if( matchedMain ) {
                    return
                }

                const namespace = main[ 'namespace' ] || 'unknown'
                const routes = main[ 'routes' ] || {}

                Object.keys( routes )
                    .forEach( ( routeName ) => {
                        if( matchedMain ) {
                            return
                        }

                        try {
                            const { toolName: candidateName } = FlowMcpCli.#buildToolName( { routeName, namespace } )

                            if( candidateName === toolName ) {
                                matchedMain = main
                                matchedHandlersFn = handlersFn
                                matchedFile = file
                                matchedToolName = candidateName
                                matchedRouteName = routeName
                            }
                        } catch {
                            // skip
                        }
                    } )
            } )

        if( !matchedMain ) {
            const result = FlowMcpCli.#error( {
                'error': `Tool "${toolName}" not found in active tools.`,
                'fix': `Run ${appConfig[ 'cliCommand' ]} call list-tools to see available tool names.`
            } )

            return { result }
        }

        const matchedRouteConfig = matchedMain[ 'routes' ][ matchedRouteName ]
        const matchedRouteParameters = matchedRouteConfig[ 'parameters' ] || []
        const matchedSchemaFilePath = matchedFile ? join( FlowMcpCli.#schemasDir(), matchedFile ) : null
        const { sharedLists: matchedSharedLists } = await FlowMcpCli.#resolveSharedListsForSchema( { 'main': matchedMain, 'filePath': matchedSchemaFilePath } )
        const { parameters: expectedParameters } = FlowMcpCli.#extractParameters( { 'routeParameters': matchedRouteParameters, 'sharedLists': matchedSharedLists } )

        const missingParams = Object.entries( expectedParameters )
            .filter( ( [ , paramDef ] ) => {
                const isMissing = paramDef[ 'required' ] === true

                return isMissing
            } )
            .filter( ( [ paramKey ] ) => {
                const isProvided = userParams[ paramKey ] !== undefined

                return !isProvided
            } )
            .map( ( [ paramKey ] ) => {
                return paramKey
            } )

        if( missingParams.length > 0 ) {
            const result = FlowMcpCli.#error( {
                'error': `Missing required parameter(s): ${missingParams.join( ', ' )}`,
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} call ${toolName} '${JSON.stringify( expectedParameters, null, 0 )}'`
            } )

            return { result }
        }

        const preload = matchedRouteConfig[ 'preload' ] || null
        const isCacheable = preload && preload[ 'enabled' ] === true && !noCache
        const namespace = matchedMain[ 'namespace' ] || 'unknown'

        if( isCacheable && !refresh ) {
            const { cacheKey } = FlowMcpCli.#buildCacheKey( {
                namespace,
                'routeName': matchedRouteName,
                userParams
            } )

            const { data: cachedData, meta, isExpired } = await FlowMcpCli.#readCache( { cacheKey } )

            if( cachedData && !isExpired ) {
                const result = {
                    'status': true,
                    'toolName': matchedToolName,
                    'content': cachedData,
                    'cache': {
                        'hit': true,
                        'fetchedAt': meta[ 'fetchedAt' ],
                        'expiresAt': meta[ 'expiresAt' ]
                    }
                }

                return { result }
            }
        }

        try {
            const requiredServerParams = matchedMain[ 'requiredServerParams' ] || []
            const { serverParams } = FlowMcpCli.#buildServerParams( { envObject, requiredServerParams } )
            const schemasBaseDir = FlowMcpCli.#schemasDir()
            const schemaFilePath = matchedFile ? join( schemasBaseDir, matchedFile ) : ''
            const { handlerMap } = await FlowMcpCli.#resolveHandlers( { 'main': matchedMain, 'handlersFn': matchedHandlersFn, 'filePath': schemaFilePath } )

            const fetchResult = await FlowMCP.fetch( {
                'main': matchedMain,
                handlerMap,
                userParams,
                serverParams,
                'routeName': matchedRouteName
            } )

            if( fetchResult[ 'status' ] === false ) {
                const fetchMessages = fetchResult[ 'messages' ] || []
                const errorText = fetchMessages.join( '; ' ) || 'API call failed'

                const hasAuthError = fetchMessages
                    .some( ( msg ) => {
                        const isAuth = msg.includes( 'HTTP 401' ) || msg.includes( 'HTTP 403' )

                        return isAuth
                    } )

                let fix = null
                if( hasAuthError ) {
                    const requiredKeys = matchedMain[ 'requiredServerParams' ] || []
                    const envPath = config[ 'envPath' ] || '~/.flowmcp/.env'

                    if( requiredKeys.length > 0 ) {
                        fix = `Check API key(s) in ${envPath}: ${requiredKeys.join( ', ' )}`
                    } else {
                        fix = `Check authentication. No requiredServerParams defined in schema.`
                    }
                }

                const result = {
                    'status': false,
                    'toolName': matchedToolName,
                    'error': errorText,
                    'messages': fetchMessages
                }

                if( fix ) {
                    result[ 'fix' ] = fix
                }

                return { result }
            }

            const contentData = fetchResult[ 'data' ] !== undefined && fetchResult[ 'data' ] !== null
                ? fetchResult[ 'data' ]
                : fetchResult

            if( isCacheable ) {
                const { cacheKey } = FlowMcpCli.#buildCacheKey( {
                    namespace,
                    'routeName': matchedRouteName,
                    userParams
                } )
                const { meta: cacheMeta } = await FlowMcpCli.#writeCache( {
                    cacheKey,
                    'data': contentData,
                    'ttl': preload[ 'ttl' ]
                } )

                const result = {
                    'status': true,
                    'toolName': matchedToolName,
                    'content': contentData,
                    'cache': {
                        'hit': false,
                        'stored': true,
                        'expiresAt': cacheMeta[ 'expiresAt' ]
                    }
                }

                return { result }
            }

            const result = {
                'status': true,
                'toolName': matchedToolName,
                'content': contentData
            }

            return { result }
        } catch( err ) {
            const result = FlowMcpCli.#error( {
                'error': `Tool execution failed: ${err.message}`,
                'fix': `Check the tool parameters and env vars. Run ${appConfig[ 'cliCommand' ]} call list-tools for details.`
            } )

            return { result }
        }
    }


    static async search( { query } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        if( !query || typeof query !== 'string' || query.trim().length === 0 ) {
            const result = FlowMcpCli.#error( {
                'error': 'Missing search query.',
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} search <query>`
            } )

            return { result }
        }

        const { tools: allTools } = await FlowMcpCli.#listAvailableTools()
        const queryTokens = query.toLowerCase().trim().split( /\s+/ )

        const { aliasIndex } = await FlowMcpCli.#loadSharedAliases()
        const sharedMatchRefs = new Set()
        aliasIndex
            .forEach( ( { searchTerms, schemaRefs } ) => {
                const hasMatch = queryTokens
                    .some( ( token ) => {
                        const found = searchTerms
                            .some( ( term ) => term.includes( token ) )

                        return found
                    } )

                if( hasMatch ) {
                    schemaRefs
                        .forEach( ( ref ) => { sharedMatchRefs.add( ref ) } )
                }
            } )

        const scoredTools = allTools
            .map( ( tool ) => {
                const { score } = FlowMcpCli.#scoreToolMatch( { tool, queryTokens, sharedMatchRefs } )
                const { toolName, description, namespace, tags } = tool
                const entry = {
                    'name': toolName,
                    description,
                    namespace,
                    tags,
                    score,
                    'add': `${appConfig[ 'cliCommand' ]} add ${toolName}`
                }

                return entry
            } )
            .filter( ( tool ) => {
                const { score } = tool

                return score > 0
            } )
            .sort( ( a, b ) => {
                const result = b[ 'score' ] - a[ 'score' ]

                return result
            } )

        const maxResults = 10
        const matchCount = scoredTools.length
        const showing = Math.min( matchCount, maxResults )
        const limitedTools = scoredTools.slice( 0, maxResults )

        let hint = ''
        if( matchCount === 0 ) {
            hint = 'No matches. Try broader terms or single keywords.'
        } else if( matchCount > maxResults ) {
            hint = `${matchCount} matches found, showing top ${maxResults} by relevance. Refine with: ${appConfig[ 'cliCommand' ]} search "more specific query"`
        }

        const result = {
            'status': true,
            query,
            matchCount,
            showing,
            'tools': limitedTools
        }

        if( hint.length > 0 ) { result[ 'hint' ] = hint }

        return { result }
    }


    static async add( { toolName, cwd, force = false } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        if( !toolName || typeof toolName !== 'string' || toolName.trim().length === 0 ) {
            const result = FlowMcpCli.#error( {
                'error': 'Missing tool name.',
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} add <tool-name>. Use ${appConfig[ 'cliCommand' ]} search <query> to find tools.`
            } )

            return { result }
        }

        const { tools: allTools } = await FlowMcpCli.#listAvailableTools()
        const matched = allTools
            .find( ( tool ) => {
                const isMatch = tool[ 'toolName' ] === toolName

                return isMatch
            } )

        if( !matched ) {
            const result = FlowMcpCli.#error( {
                'error': `Tool "${toolName}" not found in available schemas.`,
                'fix': `Use ${appConfig[ 'cliCommand' ]} search <query> to find available tools.`
            } )

            return { result }
        }

        const { toolRef, schemaRef, routeName, description: toolDescription } = matched

        const schemasBaseDir = FlowMcpCli.#schemasDir()
        const schemaFilePath = join( schemasBaseDir, schemaRef )
        const { main } = await FlowMcpCli.#loadSchema( { filePath: schemaFilePath, 'bustCache': force } )

        let extractedParameters = {}
        if( main && main[ 'routes' ] && main[ 'routes' ][ routeName ] ) {
            const routeConfig = main[ 'routes' ][ routeName ]
            const routeParameters = routeConfig[ 'parameters' ] || []
            const { sharedLists: resolvedLists } = await FlowMcpCli.#resolveSharedListsForSchema( { main, 'filePath': schemaFilePath } )
            const { parameters: transformed } = FlowMcpCli.#extractParameters( { routeParameters, 'sharedLists': resolvedLists } )
            extractedParameters = transformed
        }

        const localConfigDir = join( cwd, appConfig[ 'localConfigDirName' ] )
        const localConfigPath = join( localConfigDir, 'config.json' )
        const { data: localConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )

        let updatedConfig
        if( !localConfig ) {
            await mkdir( localConfigDir, { recursive: true } )
            updatedConfig = {
                'root': `~/${appConfig[ 'globalConfigDirName' ]}`,
                'tools': [ toolRef ]
            }
        } else {
            updatedConfig = localConfig

            if( !updatedConfig[ 'tools' ] ) {
                updatedConfig[ 'tools' ] = []
            }

            const alreadyExists = updatedConfig[ 'tools' ]
                .find( ( ref ) => {
                    const isDuplicate = ref === toolRef

                    return isDuplicate
                } )

            if( alreadyExists && !force ) {
                const result = {
                    'status': true,
                    'added': toolName,
                    'message': 'Tool was already active.',
                    'parameters': extractedParameters
                }

                return { result }
            }

            if( !alreadyExists ) {
                updatedConfig[ 'tools' ].push( toolRef )
            }
        }

        await writeFile( localConfigPath, JSON.stringify( updatedConfig, null, 4 ), 'utf-8' )
        await FlowMcpCli.#saveToolSchema( {
            toolName,
            'description': toolDescription,
            'parameters': extractedParameters,
            cwd
        } )

        const result = {
            'status': true,
            'added': toolName,
            'parameters': extractedParameters
        }

        if( force ) {
            result[ 'message' ] = 'Schema reloaded from source.'
        }

        return { result }
    }


    static async remove( { toolName, cwd } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        if( !toolName || typeof toolName !== 'string' || toolName.trim().length === 0 ) {
            const result = FlowMcpCli.#error( {
                'error': 'Missing tool name.',
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} remove <tool-name>. Use ${appConfig[ 'cliCommand' ]} list to see active tools.`
            } )

            return { result }
        }

        const { toolRefs, source, groupName } = await FlowMcpCli.#resolveActiveToolRefs( { cwd } )

        if( toolRefs.length === 0 ) {
            const result = FlowMcpCli.#error( {
                'error': 'No active tools found.',
                'fix': `Use ${appConfig[ 'cliCommand' ]} add <tool-name> to activate tools first.`
            } )

            return { result }
        }

        const { tools: allTools } = await FlowMcpCli.#listAvailableTools()
        const matched = allTools
            .find( ( tool ) => {
                const isMatch = tool[ 'toolName' ] === toolName

                return isMatch
            } )

        if( !matched ) {
            const result = FlowMcpCli.#error( {
                'error': `Tool "${toolName}" not recognized.`,
                'fix': `Use ${appConfig[ 'cliCommand' ]} list to see active tools.`
            } )

            return { result }
        }

        const { toolRef } = matched

        if( !toolRefs.includes( toolRef ) ) {
            const result = FlowMcpCli.#error( {
                'error': `Tool "${toolName}" is not in active tools list.`,
                'fix': `Use ${appConfig[ 'cliCommand' ]} list to see active tools.`
            } )

            return { result }
        }

        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )

        if( source === 'group' ) {
            const group = localConfig[ 'groups' ][ groupName ]
            const toolsKey = Array.isArray( group[ 'tools' ] ) ? 'tools' : 'schemas'
            group[ toolsKey ] = group[ toolsKey ]
                .filter( ( ref ) => {
                    const shouldKeep = ref !== toolRef

                    return shouldKeep
                } )
        } else {
            localConfig[ 'tools' ] = localConfig[ 'tools' ]
                .filter( ( ref ) => {
                    const shouldKeep = ref !== toolRef

                    return shouldKeep
                } )
        }

        await writeFile( localConfigPath, JSON.stringify( localConfig, null, 4 ), 'utf-8' )
        await FlowMcpCli.#removeToolSchema( { toolName, cwd } )

        const result = {
            'status': true,
            'removed': toolName
        }

        return { result }
    }


    static async list( { cwd } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { toolRefs } = await FlowMcpCli.#resolveActiveToolRefs( { cwd } )

        if( toolRefs.length === 0 ) {
            const result = {
                'status': true,
                'toolCount': 0,
                'tools': []
            }

            return { result }
        }

        const { schemas } = await FlowMcpCli.#resolveToolRefs( { toolRefs } )

        const { config } = await FlowMcpCli.#readConfig( { cwd } )
        const { envPath } = config
        const { data: envContent } = await FlowMcpCli.#readText( { filePath: envPath } )
        const envObject = envContent
            ? FlowMcpCli.#parseEnvFile( { envContent } ).envObject
            : {}

        const tools = []

        const schemasBaseDir = FlowMcpCli.#schemasDir()
        const sharedListsMap = {}
        await schemas
            .reduce( ( promise, { main, file } ) => promise.then( async () => {
                if( main && main[ 'sharedLists' ] && main[ 'sharedLists' ].length > 0 && file ) {
                    const filePath = join( schemasBaseDir, file )
                    const { sharedLists: resolved } = await FlowMcpCli.#resolveSharedListsForSchema( { main, filePath } )
                    sharedListsMap[ file ] = resolved
                }
            } ), Promise.resolve() )

        schemas
            .forEach( ( { main, file } ) => {
                if( !main || !main[ 'routes' ] ) {
                    return
                }

                const namespace = main[ 'namespace' ] || 'unknown'
                const routes = main[ 'routes' ]
                const schemaTags = main[ 'tags' ] || []
                const sharedLists = sharedListsMap[ file ] || {}

                Object.keys( routes )
                    .forEach( ( routeName ) => {
                        try {
                            const { toolName: name } = FlowMcpCli.#buildToolName( { routeName, namespace } )
                            const description = routes[ routeName ][ 'description' ] || ''

                            const routeConfig = routes[ routeName ]
                            const routeParameters = routeConfig[ 'parameters' ] || []
                            const { parameters } = FlowMcpCli.#extractParameters( { routeParameters, sharedLists } )

                            tools.push( { name, description, 'tags': schemaTags, parameters } )
                        } catch {
                            // skip broken tools
                        }
                    } )
            } )

        const result = {
            'status': true,
            'toolCount': tools.length,
            tools
        }

        return { result }
    }


    static validationValidate( { schemaPath } ) {
        const struct = { 'status': false, 'messages': [] }

        if( schemaPath === undefined || schemaPath === null ) {
            struct[ 'messages' ].push( 'schemaPath: Missing value. Provide a path to a schema file or directory.' )
        } else if( typeof schemaPath !== 'string' ) {
            struct[ 'messages' ].push( 'schemaPath: Must be a string.' )
        }

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    static validationTest( { schemaPath } ) {
        const struct = { 'status': false, 'messages': [] }

        if( schemaPath === undefined || schemaPath === null ) {
            struct[ 'messages' ].push( 'schemaPath: Missing value. Provide a path to a schema file or directory.' )
        } else if( typeof schemaPath !== 'string' ) {
            struct[ 'messages' ].push( 'schemaPath: Must be a string.' )
        }

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    static validationImport( { url } ) {
        const struct = { 'status': false, 'messages': [] }

        if( url === undefined || url === null ) {
            struct[ 'messages' ].push( 'url: Missing value. Provide a GitHub repository URL.' )
        } else if( typeof url !== 'string' ) {
            struct[ 'messages' ].push( 'url: Must be a string.' )
        } else if( !url.includes( 'github.com' ) ) {
            struct[ 'messages' ].push( 'url: Must be a GitHub repository URL.' )
        }

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    static validationImportRegistry( { registryUrl } ) {
        const struct = { 'status': false, 'messages': [] }

        if( registryUrl === undefined || registryUrl === null ) {
            struct[ 'messages' ].push( `registryUrl: Missing value. Provide a URL to a ${appConfig[ 'registryFileName' ]} file.` )
        } else if( typeof registryUrl !== 'string' ) {
            struct[ 'messages' ].push( 'registryUrl: Must be a string.' )
        } else if( !registryUrl.startsWith( 'http://' ) && !registryUrl.startsWith( 'https://' ) ) {
            struct[ 'messages' ].push( 'registryUrl: Must be a valid HTTP or HTTPS URL.' )
        }

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    static validationUpdate( { sourceName } ) {
        const struct = { 'status': false, 'messages': [] }

        if( sourceName !== undefined && sourceName !== null ) {
            if( typeof sourceName !== 'string' ) {
                struct[ 'messages' ].push( 'sourceName: Must be a string.' )
            } else if( sourceName.trim().length === 0 ) {
                struct[ 'messages' ].push( 'sourceName: Must not be empty.' )
            }
        }

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    static validationGroupAppend( { name, tools } ) {
        const struct = { 'status': false, 'messages': [] }

        if( name === undefined || name === null ) {
            struct[ 'messages' ].push( 'name: Missing value. Provide a group name.' )
        } else if( typeof name !== 'string' ) {
            struct[ 'messages' ].push( 'name: Must be a string.' )
        } else if( name.trim().length === 0 ) {
            struct[ 'messages' ].push( 'name: Must not be empty.' )
        }

        if( tools === undefined || tools === null ) {
            struct[ 'messages' ].push( 'tools: Missing value. Provide --tools "source/file.mjs::route1,source/file.mjs::route2".' )
        } else if( typeof tools !== 'string' ) {
            struct[ 'messages' ].push( 'tools: Must be a string.' )
        } else if( tools.trim().length === 0 ) {
            struct[ 'messages' ].push( 'tools: Must not be empty.' )
        }

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    static validationGroupRemove( { name, tools } ) {
        const struct = { 'status': false, 'messages': [] }

        if( name === undefined || name === null ) {
            struct[ 'messages' ].push( 'name: Missing value. Provide a group name.' )
        } else if( typeof name !== 'string' ) {
            struct[ 'messages' ].push( 'name: Must be a string.' )
        } else if( name.trim().length === 0 ) {
            struct[ 'messages' ].push( 'name: Must not be empty.' )
        }

        if( tools === undefined || tools === null ) {
            struct[ 'messages' ].push( 'tools: Missing value. Provide --tools "source/file.mjs::route1,source/file.mjs::route2".' )
        } else if( typeof tools !== 'string' ) {
            struct[ 'messages' ].push( 'tools: Must be a string.' )
        } else if( tools.trim().length === 0 ) {
            struct[ 'messages' ].push( 'tools: Must not be empty.' )
        }

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    static validationGroupSetDefault( { name } ) {
        const struct = { 'status': false, 'messages': [] }

        if( name === undefined || name === null ) {
            struct[ 'messages' ].push( 'name: Missing value. Provide a group name.' )
        } else if( typeof name !== 'string' ) {
            struct[ 'messages' ].push( 'name: Must be a string.' )
        } else if( name.trim().length === 0 ) {
            struct[ 'messages' ].push( 'name: Must not be empty.' )
        }

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    static validationPromptAdd( { group, name, file } ) {
        const struct = { 'status': false, 'messages': [] }

        if( group === undefined || group === null ) {
            struct[ 'messages' ].push( 'group: Missing value. Provide a group name.' )
        } else if( typeof group !== 'string' ) {
            struct[ 'messages' ].push( 'group: Must be a string.' )
        } else if( group.trim().length === 0 ) {
            struct[ 'messages' ].push( 'group: Must not be empty.' )
        }

        if( name === undefined || name === null ) {
            struct[ 'messages' ].push( 'name: Missing value. Provide a prompt name.' )
        } else if( typeof name !== 'string' ) {
            struct[ 'messages' ].push( 'name: Must be a string.' )
        } else if( name.trim().length === 0 ) {
            struct[ 'messages' ].push( 'name: Must not be empty.' )
        }

        if( file === undefined || file === null ) {
            struct[ 'messages' ].push( 'file: Missing value. Provide --file <path> to a .md file.' )
        } else if( typeof file !== 'string' ) {
            struct[ 'messages' ].push( 'file: Must be a string.' )
        } else if( file.trim().length === 0 ) {
            struct[ 'messages' ].push( 'file: Must not be empty.' )
        } else if( !file.endsWith( '.md' ) ) {
            struct[ 'messages' ].push( 'file: Must be a .md file.' )
        }

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    static validationPromptRemove( { group, name } ) {
        const struct = { 'status': false, 'messages': [] }

        if( group === undefined || group === null ) {
            struct[ 'messages' ].push( 'group: Missing value. Provide a group name.' )
        } else if( typeof group !== 'string' ) {
            struct[ 'messages' ].push( 'group: Must be a string.' )
        } else if( group.trim().length === 0 ) {
            struct[ 'messages' ].push( 'group: Must not be empty.' )
        }

        if( name === undefined || name === null ) {
            struct[ 'messages' ].push( 'name: Missing value. Provide a prompt name.' )
        } else if( typeof name !== 'string' ) {
            struct[ 'messages' ].push( 'name: Must be a string.' )
        } else if( name.trim().length === 0 ) {
            struct[ 'messages' ].push( 'name: Must not be empty.' )
        }

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    static validationPromptShow( { group, name } ) {
        const struct = { 'status': false, 'messages': [] }

        if( group === undefined || group === null ) {
            struct[ 'messages' ].push( 'group: Missing value. Provide a group name.' )
        } else if( typeof group !== 'string' ) {
            struct[ 'messages' ].push( 'group: Must be a string.' )
        } else if( group.trim().length === 0 ) {
            struct[ 'messages' ].push( 'group: Must not be empty.' )
        }

        if( name === undefined || name === null ) {
            struct[ 'messages' ].push( 'name: Missing value. Provide a prompt name.' )
        } else if( typeof name !== 'string' ) {
            struct[ 'messages' ].push( 'name: Must be a string.' )
        } else if( name.trim().length === 0 ) {
            struct[ 'messages' ].push( 'name: Must not be empty.' )
        }

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    static validationPromptSearch( { query } ) {
        const struct = { 'status': false, 'messages': [] }

        if( query === undefined || query === null ) {
            struct[ 'messages' ].push( 'query: Missing value. Provide a search query.' )
        } else if( typeof query !== 'string' ) {
            struct[ 'messages' ].push( 'query: Must be a string.' )
        } else if( query.trim().length === 0 ) {
            struct[ 'messages' ].push( 'query: Must not be empty.' )
        }

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    static #extractPromptDescription( { lines } ) {
        let inDescription = false
        const descLines = []

        lines
            .forEach( ( line ) => {
                if( line.trim() === '## Description' ) {
                    inDescription = true

                    return
                }

                if( inDescription && line.startsWith( '## ' ) ) {
                    inDescription = false

                    return
                }

                if( inDescription ) {
                    descLines.push( line )
                }
            } )

        const description = descLines
            .join( ' ' )
            .trim()
            .replace( /\s+/g, ' ' )

        return description
    }


    static #detectToolReferences( { lines, toolRefs } ) {
        let inWorkflow = false
        const backtickPattern = /`([a-zA-Z][a-zA-Z0-9]*)`/g

        const routeNames = toolRefs
            .map( ( ref ) => {
                const parts = ref.split( '::' )
                const routeName = parts.length > 1 ? parts[ 1 ] : null

                return routeName
            } )
            .filter( ( r ) => {
                const exists = r !== null

                return exists
            } )

        const detectedRefs = new Set()

        lines
            .forEach( ( line ) => {
                if( line.trim() === '## Workflow' ) {
                    inWorkflow = true

                    return
                }

                if( inWorkflow && line.startsWith( '## ' ) && !line.startsWith( '### ' ) ) {
                    inWorkflow = false

                    return
                }

                if( inWorkflow ) {
                    let match = backtickPattern.exec( line )
                    const matches = []
                    while( match !== null ) {
                        matches.push( match[ 1 ] )
                        match = backtickPattern.exec( line )
                    }

                    matches
                        .forEach( ( m ) => {
                            detectedRefs.add( m )
                        } )
                }
            } )

        const resolved = []
        const unresolved = []

        Array.from( detectedRefs )
            .forEach( ( ref ) => {
                const found = routeNames.includes( ref )

                if( found ) {
                    resolved.push( ref )
                } else {
                    unresolved.push( ref )
                }
            } )

        return { resolved, unresolved }
    }


    static #validateGlobalConfig( { globalConfig } ) {
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


    static #validateLocalConfig( { localConfig } ) {
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


    static async #healthCheck( { cwd } ) {
        const checks = []

        // Level 1: Global Config
        const globalConfigPath = FlowMcpCli.#globalConfigPath()
        const { data: globalConfig } = await FlowMcpCli.#readJson( { filePath: globalConfigPath } )
        const globalConfigExists = globalConfig !== null && globalConfig[ 'initialized' ] !== undefined

        if( !globalConfigExists ) {
            checks.push( {
                'level': 1,
                'name': 'globalConfig',
                'ok': false,
                'path': globalConfigPath,
                'fix': `Run: ${appConfig[ 'cliCommand' ]} init`
            } )

            return { checks, 'healthy': false }
        }

        const { valid: globalStructureValid, warnings: globalWarnings } = FlowMcpCli.#validateGlobalConfig( { globalConfig } )
        const globalConfigCheck = {
            'level': 1,
            'name': 'globalConfig',
            'ok': globalStructureValid,
            'path': globalConfigPath,
            'fix': globalWarnings.length > 0
                ? globalWarnings[ 0 ]
                : `Run: ${appConfig[ 'cliCommand' ]} init`
        }

        if( globalWarnings.length > 0 ) {
            globalConfigCheck[ 'warnings' ] = globalWarnings
        }

        checks.push( globalConfigCheck )

        // Level 2: .env File
        const { envPath } = globalConfig
        let envOk = false
        try {
            await access( envPath, constants.F_OK )
            envOk = true
        } catch {
            envOk = false
        }

        checks.push( {
            'level': 2,
            'name': 'envFile',
            'ok': envOk,
            'path': envPath,
            'fix': `Ensure .env file exists at: ${envPath}`
        } )

        // Level 3: Schemas
        const schemasDir = FlowMcpCli.#schemasDir()
        let schemaSourceCount = 0
        let sourceDirs = []
        try {
            const entries = await readdir( schemasDir )
            const entryResults = await entries
                .reduce( ( promise, entry ) => promise.then( async ( acc ) => {
                    const entryStat = await stat( join( schemasDir, entry ) )
                    if( entryStat.isDirectory() ) {
                        acc.push( entry )
                    }

                    return acc
                } ), Promise.resolve( [] ) )
            sourceDirs = entryResults
            schemaSourceCount = sourceDirs.length
        } catch {
            schemaSourceCount = 0
        }

        const schemasOk = schemaSourceCount > 0

        checks.push( {
            'level': 3,
            'name': 'schemas',
            'ok': schemasOk,
            'detail': `${schemaSourceCount} source(s)`,
            'fix': `Run: ${appConfig[ 'cliCommand' ]} import <github-url>`
        } )

        // Level 3b: Env Params
        if( envOk && schemaSourceCount > 0 ) {
            const envContent = await readFile( envPath, 'utf-8' )
            const { envObject } = FlowMcpCli.#parseEnvFile( { envContent } )

            const allRequiredParams = new Set()
            const paramsByNamespace = {}

            await sourceDirs
                .reduce( ( promise, sourceDir ) => promise.then( async () => {
                    const registryPath = join( schemasDir, sourceDir, '_registry.json' )
                    const { data: registry } = await FlowMcpCli.#readJson( { filePath: registryPath } )

                    if( registry && Array.isArray( registry[ 'schemas' ] ) ) {
                        registry[ 'schemas' ]
                            .forEach( ( entry ) => {
                                const { requiredServerParams, namespace } = entry
                                if( Array.isArray( requiredServerParams ) && requiredServerParams.length > 0 ) {
                                    requiredServerParams
                                        .forEach( ( param ) => {
                                            allRequiredParams.add( param )
                                            if( !paramsByNamespace[ param ] ) {
                                                paramsByNamespace[ param ] = []
                                            }
                                            paramsByNamespace[ param ].push( namespace )
                                        } )
                                }
                            } )
                    }
                } ), Promise.resolve() )

            const missingParams = [ ...allRequiredParams ]
                .filter( ( param ) => {
                    const isMissing = envObject[ param ] === undefined || envObject[ param ].trim() === ''

                    return isMissing
                } )

            const envParamsOk = missingParams.length === 0
            const envParamsWarnings = missingParams
                .map( ( param ) => {
                    const namespaces = paramsByNamespace[ param ].join( ', ' )

                    return `Missing "${param}" (needed by: ${namespaces})`
                } )

            const envParamsCheck = {
                'level': 3,
                'name': 'envParams',
                'ok': envParamsOk,
                'detail': envParamsOk
                    ? `${allRequiredParams.size} env var(s) verified`
                    : `${missingParams.length}/${allRequiredParams.size} env var(s) missing`,
                'fix': missingParams.length > 0
                    ? `Add missing env vars to ${envPath}: ${missingParams.join( ', ' )}`
                    : null
            }

            if( envParamsWarnings.length > 0 ) {
                envParamsCheck[ 'warnings' ] = envParamsWarnings
            }

            checks.push( envParamsCheck )
        }

        // Level 4: Local Config
        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )
        const localConfigExists = localConfig !== null

        if( !localConfigExists ) {
            checks.push( {
                'level': 4,
                'name': 'localConfig',
                'ok': false,
                'path': localConfigPath,
                'fix': `Run: ${appConfig[ 'cliCommand' ]} init (in project directory)`
            } )
        } else {
            const { valid: localStructureValid, warnings: localWarnings } = FlowMcpCli.#validateLocalConfig( { localConfig } )
            const localConfigCheck = {
                'level': 4,
                'name': 'localConfig',
                'ok': localStructureValid,
                'path': localConfigPath,
                'fix': localWarnings.length > 0
                    ? localWarnings[ 0 ]
                    : `Run: ${appConfig[ 'cliCommand' ]} init (in project directory)`
            }

            if( localWarnings.length > 0 ) {
                localConfigCheck[ 'warnings' ] = localWarnings
            }

            checks.push( localConfigCheck )
        }

        // Level 5: Groups
        const hasGroups = localConfig !== null
            && localConfig[ 'groups' ] !== undefined
            && typeof localConfig[ 'groups' ] === 'object'
            && localConfig[ 'groups' ] !== null
            && Object.keys( localConfig[ 'groups' ] ).length > 0
        const hasDefault = localConfig !== null
            && localConfig[ 'defaultGroup' ] !== undefined
            && localConfig[ 'defaultGroup' ] !== null

        const groupWarnings = []

        if( hasGroups && hasDefault ) {
            const defaultGroupName = localConfig[ 'defaultGroup' ]
            if( !localConfig[ 'groups' ][ defaultGroupName ] ) {
                groupWarnings.push( `defaultGroup: "${defaultGroupName}" does not reference an existing group` )
            }

            Object.entries( localConfig[ 'groups' ] )
                .forEach( ( [ groupName, groupData ] ) => {
                    if( typeof groupData !== 'object' || groupData === null ) {
                        groupWarnings.push( `groups.${groupName}: Must be an object` )
                    } else {
                        const hasTools = Array.isArray( groupData[ 'tools' ] )
                        const hasSchemas = Array.isArray( groupData[ 'schemas' ] )

                        if( !hasTools && !hasSchemas ) {
                            groupWarnings.push( `groups.${groupName}: Must have "tools" or "schemas" array` )
                        }
                    }
                } )
        }

        const groupsOk = hasGroups && hasDefault && groupWarnings.length === 0
        const groupsCheck = {
            'level': 5,
            'name': 'groups',
            'ok': groupsOk,
            'detail': hasGroups
                ? `default: ${localConfig[ 'defaultGroup' ] || 'none'}`
                : 'no groups',
            'fix': groupWarnings.length > 0
                ? groupWarnings[ 0 ]
                : `Run: ${appConfig[ 'cliCommand' ]} group set <name> --tools "source/file.mjs::route,..."`
        }

        if( groupWarnings.length > 0 ) {
            groupsCheck[ 'warnings' ] = groupWarnings
        }

        checks.push( groupsCheck )

        const healthy = checks
            .filter( ( { ok } ) => {
                const isFailing = !ok

                return isFailing
            } )
            .length === 0

        return { checks, healthy }
    }


    static #globalConfigDir() {
        const dir = join( homedir(), appConfig[ 'globalConfigDirName' ] )

        return dir
    }


    static #globalConfigPath() {
        const configPath = join( FlowMcpCli.#globalConfigDir(), 'config.json' )

        return configPath
    }


    static #schemasDir() {
        const dir = join( FlowMcpCli.#globalConfigDir(), 'schemas' )

        return dir
    }


    static #cacheDir() {
        const dir = join( FlowMcpCli.#globalConfigDir(), appConfig[ 'cacheDirName' ] )

        return dir
    }


    static #buildCacheKey( { namespace, routeName, userParams } ) {
        const hasParams = Object.keys( userParams ).length > 0
        if( !hasParams ) {
            const cacheKey = `${namespace}/${routeName}.json`

            return { cacheKey }
        }

        const sortedJson = JSON.stringify(
            Object.keys( userParams )
                .sort()
                .reduce( ( acc, key ) => {
                    acc[ key ] = userParams[ key ]

                    return acc
                }, {} )
        )

        const paramHash = createHash( 'sha256' )
            .update( sortedJson )
            .digest( 'hex' )
            .slice( 0, 12 )
        const cacheKey = `${namespace}/${routeName}/${paramHash}.json`

        return { cacheKey }
    }


    static async #readCache( { cacheKey } ) {
        const cachePath = join( FlowMcpCli.#cacheDir(), cacheKey )

        try {
            const raw = await readFile( cachePath, 'utf-8' )
            const cached = JSON.parse( raw )
            const { meta, data } = cached

            const now = new Date()
            const expiresAt = new Date( meta[ 'expiresAt' ] )
            const isExpired = now >= expiresAt

            return { data, meta, isExpired, cachePath }
        } catch {
            return { data: null, meta: null, isExpired: true, cachePath }
        }
    }


    static async #writeCache( { cacheKey, data, ttl } ) {
        const cachePath = join( FlowMcpCli.#cacheDir(), cacheKey )
        const cacheDirectory = dirname( cachePath )
        await mkdir( cacheDirectory, { recursive: true } )

        const now = new Date()
        const expiresAt = new Date( now.getTime() + ttl * 1000 )
        const dataString = JSON.stringify( data )

        const cacheEntry = {
            'meta': {
                'fetchedAt': now.toISOString(),
                'expiresAt': expiresAt.toISOString(),
                ttl,
                'size': dataString.length
            },
            data
        }

        await writeFile( cachePath, JSON.stringify( cacheEntry, null, 2 ), 'utf-8' )

        return { cachePath, meta: cacheEntry[ 'meta' ] }
    }


    static async cacheClear( { namespace } ) {
        const cacheBase = FlowMcpCli.#cacheDir()

        try {
            if( namespace ) {
                const namespacePath = join( cacheBase, namespace )
                await FlowMcpCli.#removeDirRecursive( { dirPath: namespacePath } )

                const result = {
                    'status': true,
                    'message': `Cache cleared for namespace "${namespace}".`
                }

                return { result }
            }

            await FlowMcpCli.#removeDirRecursive( { dirPath: cacheBase } )

            const result = {
                'status': true,
                'message': 'All cache cleared.'
            }

            return { result }
        } catch( err ) {
            const result = FlowMcpCli.#error( {
                'error': `Failed to clear cache: ${err.message}`,
                'fix': `Check permissions on ${cacheBase}`
            } )

            return { result }
        }
    }


    static async #removeDirRecursive( { dirPath } ) {
        try {
            const entries = await readdir( dirPath, { withFileTypes: true } )

            await entries
                .reduce( ( promise, entry ) => promise.then( async () => {
                    const entryPath = join( dirPath, entry.name )

                    if( entry.isDirectory() ) {
                        await FlowMcpCli.#removeDirRecursive( { dirPath: entryPath } )
                    } else {
                        await unlink( entryPath )
                    }
                } ), Promise.resolve() )

            const { rmdir } = await import( 'node:fs/promises' )
            await rmdir( dirPath )
        } catch {
            // directory doesn't exist, nothing to clear
        }
    }


    static async cacheStatus() {
        const cacheBase = FlowMcpCli.#cacheDir()
        const entries = []

        try {
            const namespaces = await readdir( cacheBase, { withFileTypes: true } )

            await namespaces
                .filter( ( entry ) => {
                    const isDir = entry.isDirectory()

                    return isDir
                } )
                .reduce( ( promise, nsEntry ) => promise.then( async () => {
                    const nsPath = join( cacheBase, nsEntry.name )
                    const files = await FlowMcpCli.#collectCacheFiles( { dirPath: nsPath, prefix: nsEntry.name } )
                    files
                        .forEach( ( file ) => {
                            entries.push( file )
                        } )
                } ), Promise.resolve() )
        } catch {
            // cache directory doesn't exist yet
        }

        const totalSize = entries
            .reduce( ( sum, entry ) => {
                const size = sum + ( entry[ 'size' ] || 0 )

                return size
            }, 0 )

        const result = {
            'status': true,
            'cacheDir': cacheBase,
            'totalEntries': entries.length,
            'totalSize': totalSize,
            entries
        }

        return { result }
    }


    static async #collectCacheFiles( { dirPath, prefix } ) {
        const collected = []

        try {
            const items = await readdir( dirPath, { withFileTypes: true } )

            await items
                .reduce( ( promise, item ) => promise.then( async () => {
                    const itemPath = join( dirPath, item.name )

                    if( item.isDirectory() ) {
                        const subFiles = await FlowMcpCli.#collectCacheFiles( {
                            dirPath: itemPath,
                            prefix: `${prefix}/${item.name}`
                        } )
                        subFiles
                            .forEach( ( file ) => {
                                collected.push( file )
                            } )
                    } else if( item.name.endsWith( '.json' ) ) {
                        try {
                            const raw = await readFile( itemPath, 'utf-8' )
                            const parsed = JSON.parse( raw )
                            const { meta } = parsed

                            const now = new Date()
                            const expiresAt = new Date( meta[ 'expiresAt' ] )
                            const isExpired = now >= expiresAt

                            collected.push( {
                                'key': `${prefix}/${item.name}`,
                                'fetchedAt': meta[ 'fetchedAt' ],
                                'expiresAt': meta[ 'expiresAt' ],
                                'ttl': meta[ 'ttl' ],
                                'size': meta[ 'size' ],
                                'expired': isExpired
                            } )
                        } catch {
                            // corrupt cache file, skip
                        }
                    }
                } ), Promise.resolve() )
        } catch {
            // directory doesn't exist
        }

        return collected
    }


    static async #writeGlobalConfig( { config } ) {
        const globalConfigPath = FlowMcpCli.#globalConfigPath()
        await writeFile( globalConfigPath, JSON.stringify( config, null, 4 ), 'utf-8' )

        return { status: true }
    }


    static #parseToolRef( { toolRef } ) {
        const separatorIndex = toolRef.indexOf( '::' )
        if( separatorIndex === -1 ) {
            return { 'schemaRef': toolRef, 'routeName': null }
        }

        const schemaRef = toolRef.slice( 0, separatorIndex )
        const routeName = toolRef.slice( separatorIndex + 2 )

        return { schemaRef, routeName }
    }


    static #filterMainRoutes( { main, routeNames } ) {
        const { namespace, name, description, version, docs, tags, root, requiredServerParams, headers, sharedLists, requiredLibraries } = main
        const originalRoutes = main[ 'routes' ] || {}
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
            'routes': filteredRoutes
        }

        if( sharedLists ) { filteredMain[ 'sharedLists' ] = sharedLists }
        if( requiredLibraries ) { filteredMain[ 'requiredLibraries' ] = requiredLibraries }

        return { 'main': filteredMain }
    }


    static async #listAvailableTools() {
        const { sources } = await FlowMcpCli.#listSources()
        const schemasBaseDir = FlowMcpCli.#schemasDir()
        const tools = []

        await sources
            .reduce( ( promise, source ) => promise.then( async () => {
                const { name: sourceName, schemas: sourceSchemas } = source

                await sourceSchemas
                    .reduce( ( schemaPromise, schemaEntry ) => schemaPromise.then( async () => {
                        const { file, namespace } = schemaEntry
                        const schemaRef = `${sourceName}/${file}`
                        const filePath = join( schemasBaseDir, schemaRef )
                        const { main } = await FlowMcpCli.#loadSchema( { filePath } )

                        if( main && main[ 'routes' ] ) {
                            Object.entries( main[ 'routes' ] )
                                .forEach( ( [ routeName, routeConfig ] ) => {
                                    const routeDescription = routeConfig[ 'description' ] || ''
                                    const toolRef = `${schemaRef}::${routeName}`
                                    const { toolName } = FlowMcpCli.#buildToolName( {
                                        routeName,
                                        'namespace': main[ 'namespace' ] || namespace
                                    } )

                                    tools.push( {
                                        toolRef,
                                        toolName,
                                        schemaRef,
                                        routeName,
                                        namespace,
                                        'description': routeDescription,
                                        'tags': main[ 'tags' ] || [],
                                        'schemaName': main[ 'name' ] || ''
                                    } )
                                } )
                        }
                    } ), Promise.resolve() )
            } ), Promise.resolve() )

        return { tools }
    }


    static async #loadSharedAliases() {
        const { sources } = await FlowMcpCli.#listSources()
        const schemasBaseDir = FlowMcpCli.#schemasDir()
        const aliasIndex = []

        await sources
            .reduce( ( promise, source ) => promise.then( async () => {
                const { name: sourceName } = source
                const registryPath = join( schemasBaseDir, sourceName, '_registry.json' )
                const { data: registry } = await FlowMcpCli.#readJson( { filePath: registryPath } )

                if( !registry || !Array.isArray( registry[ 'shared' ] ) ) { return }

                await registry[ 'shared' ]
                    .reduce( ( p, sharedEntry ) => p.then( async () => {
                        const { file: sharedFile } = sharedEntry
                        const filePath = join( schemasBaseDir, sourceName, sharedFile )

                        try {
                            const mod = await import( pathToFileURL( filePath ).href )
                            let exportedArray = Object.values( mod )
                                .find( ( v ) => Array.isArray( v ) )

                            if( !exportedArray ) {
                                const listObj = Object.values( mod )
                                    .find( ( v ) => v && typeof v === 'object' && Array.isArray( v[ 'entries' ] ) )
                                exportedArray = listObj ? listObj[ 'entries' ] : null
                            }

                            if( !exportedArray ) { return }

                            const searchTerms = exportedArray
                                .reduce( ( acc, obj ) => {
                                    const alias = obj[ 'alias' ] || obj[ 'code' ] || obj[ 'alpha2' ] || ''
                                    const name = obj[ 'name' ] || ''

                                    if( alias ) { acc.push( alias.toLowerCase() ) }
                                    if( name ) { acc.push( name.toLowerCase() ) }

                                    return acc
                                }, [] )

                            const matchingSchemaRefs = ( registry[ 'schemas' ] || [] )
                                .filter( ( s ) => {
                                    const schemaShared = s[ 'shared' ] || []
                                    const matches = schemaShared.includes( sharedFile )

                                    return matches
                                } )
                                .map( ( s ) => {
                                    const ref = `${sourceName}/${s[ 'file' ]}`

                                    return ref
                                } )

                            aliasIndex.push( {
                                'sharedFile': sharedFile,
                                searchTerms,
                                'schemaRefs': matchingSchemaRefs
                            } )
                        } catch {
                            // _shared file could not be loaded — skip
                        }
                    } ), Promise.resolve() )
            } ), Promise.resolve() )

        return { aliasIndex }
    }


    static #scoreToolMatch( { tool, queryTokens, sharedMatchRefs } ) {
        const { toolName, namespace, description, tags, schemaName } = tool
        const lowerName = toolName.toLowerCase()
        const lowerNamespace = namespace.toLowerCase()
        const lowerDesc = description.toLowerCase()
        const lowerSchemaName = schemaName.toLowerCase()
        const lowerTags = tags
            .map( ( tag ) => {
                const lower = tag.toLowerCase()

                return lower
            } )
        const nameSegments = lowerName.split( '_' )

        let totalScore = 0

        const allTokensMatch = queryTokens
            .every( ( token ) => {
                let tokenScore = 0
                const wordBoundary = new RegExp( `\\b${token}\\b` )

                if( lowerNamespace === token ) { tokenScore += 20 }
                if( nameSegments.includes( token ) ) { tokenScore += 15 }
                if( lowerTags.includes( token ) ) { tokenScore += 12 }
                if( wordBoundary.test( lowerSchemaName ) ) { tokenScore += 8 }
                if( wordBoundary.test( lowerDesc ) ) { tokenScore += 5 }

                totalScore += tokenScore

                return tokenScore > 0
            } )

        if( !allTokensMatch && !( sharedMatchRefs && sharedMatchRefs.has( tool[ 'schemaRef' ] ) ) ) {
            return { 'score': 0 }
        }

        if( sharedMatchRefs && sharedMatchRefs.has( tool[ 'schemaRef' ] ) ) {
            totalScore += 10
        }

        return { 'score': totalScore }
    }


    static #buildToolName( { routeName, namespace } ) {
        const routeNameSnakeCase = routeName
            .replace( /([a-z0-9])([A-Z])/g, '$1_$2' )
            .toLowerCase()
        const namespaceSnakeCase = namespace
            .replace( /([a-z0-9])([A-Z])/g, '$1_$2' )
            .toLowerCase()

        let toolName = `${routeNameSnakeCase}_${namespaceSnakeCase}`
        toolName = toolName
            .substring( 0, 63 )
            .replaceAll( ':', '' )
            .replaceAll( '-', '_' )
            .replaceAll( '/', '_' )

        return { toolName }
    }


    static #createDemoSchema() {
        const content = `export const main = {
    namespace: 'demo',
    name: 'Ping Demo',
    description: 'Simple ping schema for testing the CLI',
    version: '${appConfig[ 'schemaSpec' ]}',
    docs: [],
    tags: [ 'demo' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: { 'Accept': 'application/json' },
    routes: {
        ping: {
            method: 'GET',
            description: 'Simple ping endpoint',
            path: '/get',
            parameters: [],
            tests: [ { _description: 'Ping test' } ]
        }
    }
}
`

        return { content }
    }


    static #parseGithubUrl( { url } ) {
        const cleaned = url
            .replace( /\.git$/, '' )
            .replace( /\/$/, '' )

        const parts = cleaned.split( '/' )
        const githubIndex = parts
            .findIndex( ( part ) => {
                const isGithub = part.includes( 'github.com' )

                return isGithub
            } )

        const owner = parts[ githubIndex + 1 ]
        const repo = parts[ githubIndex + 2 ]

        return { owner, repo }
    }


    static #resolveRegistryBaseUrl( { registryUrl } ) {
        const lastSlashIndex = registryUrl.lastIndexOf( '/' )
        const baseUrl = lastSlashIndex > 0
            ? registryUrl.slice( 0, lastSlashIndex )
            : registryUrl

        return baseUrl
    }


    static #buildRawUrl( { owner, repo, branch, path } ) {
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`

        return rawUrl
    }


    static async #fetchUrl( { url, timeout = 10000 } ) {
        try {
            const response = await fetch( url, {
                'signal': AbortSignal.timeout( timeout )
            } )

            if( !response.ok ) {
                return { 'data': null, 'error': `HTTP ${response.status}: ${response.statusText}` }
            }

            const data = await response.text()

            return { data, 'error': null }
        } catch( err ) {
            const message = err.name === 'TimeoutError'
                ? `Request timed out after ${timeout}ms`
                : err.message

            return { 'data': null, 'error': message }
        }
    }


    static #hashContent( { content } ) {
        const hash = createHash( 'sha256' ).update( content, 'utf-8' ).digest( 'hex' )

        return { hash }
    }


    static async #hashFile( { filePath } ) {
        try {
            const content = await readFile( filePath, 'utf-8' )
            const { hash } = FlowMcpCli.#hashContent( { content } )

            return { hash, 'error': null }
        } catch {
            return { 'hash': null, 'error': null }
        }
    }


    static async #downloadSchema( { url, targetPath, allowOverwrite = false } ) {
        const targetDir = dirname( targetPath )
        await mkdir( targetDir, { recursive: true } )

        const { data, error } = await FlowMcpCli.#fetchUrl( { url } )
        if( !data ) {
            return { 'success': false, 'downloadStatus': 'failed', 'hash': null, error }
        }

        const { hash: remoteHash } = FlowMcpCli.#hashContent( { 'content': data } )
        const { hash: localHash } = await FlowMcpCli.#hashFile( { filePath: targetPath } )

        if( localHash !== null ) {
            if( localHash === remoteHash ) {
                return { 'success': true, 'downloadStatus': 'skipped', 'hash': remoteHash, 'error': null }
            }

            if( !allowOverwrite ) {
                return { 'success': true, 'downloadStatus': 'conflict', 'hash': remoteHash, 'error': null }
            }
        }

        const tmpPath = `${targetPath}.tmp`
        await writeFile( tmpPath, data, 'utf-8' )
        await rename( tmpPath, targetPath )

        const downloadStatus = localHash === null ? 'downloaded' : 'updated'

        return { 'success': true, downloadStatus, 'hash': remoteHash, 'error': null }
    }


    static #compareRegistries( { remoteSchemas, localRegistry } ) {
        const localSchemaFiles = ( localRegistry && Array.isArray( localRegistry[ 'schemas' ] ) )
            ? localRegistry[ 'schemas' ]
                .map( ( entry ) => {
                    const file = entry[ 'file' ]

                    return file
                } )
            : []

        const remoteSchemaFiles = remoteSchemas
            .map( ( entry ) => {
                const file = entry[ 'file' ]

                return file
            } )

        const newSchemas = remoteSchemaFiles
            .filter( ( file ) => {
                const isNew = !localSchemaFiles.includes( file )

                return isNew
            } )

        const existingSchemas = remoteSchemaFiles
            .filter( ( file ) => {
                const exists = localSchemaFiles.includes( file )

                return exists
            } )

        const removedSchemas = localSchemaFiles
            .filter( ( file ) => {
                const isRemoved = !remoteSchemaFiles.includes( file )

                return isRemoved
            } )

        return { newSchemas, existingSchemas, removedSchemas }
    }


    static async #updateSource( { sourceName, registryUrl } ) {
        const { data: registryText, error: fetchError } = await FlowMcpCli.#fetchUrl( { 'url': registryUrl } )
        if( !registryText ) {
            console.log( `    ${chalk.red( '✗' )} Failed to fetch registry: ${fetchError}` )
            const updateResult = {
                sourceName,
                'status': false,
                'error': `Failed to fetch registry: ${fetchError}`,
                'downloaded': 0,
                'updated': 0,
                'skipped': 0,
                'failed': 0,
                'removedFiles': []
            }

            return { updateResult }
        }

        let remoteRegistry
        try {
            remoteRegistry = JSON.parse( registryText )
        } catch {
            console.log( `    ${chalk.red( '✗' )} Invalid JSON in remote registry` )
            const updateResult = {
                sourceName,
                'status': false,
                'error': 'Invalid JSON in remote registry',
                'downloaded': 0,
                'updated': 0,
                'skipped': 0,
                'failed': 0,
                'removedFiles': []
            }

            return { updateResult }
        }

        const { schemas: remoteSchemas, baseDir, shared: remoteShared } = remoteRegistry

        if( !Array.isArray( remoteSchemas ) ) {
            console.log( `    ${chalk.red( '✗' )} Remote registry missing "schemas" array` )
            const updateResult = {
                sourceName,
                'status': false,
                'error': 'Remote registry missing "schemas" array',
                'downloaded': 0,
                'updated': 0,
                'skipped': 0,
                'failed': 0,
                'removedFiles': []
            }

            return { updateResult }
        }

        const sourceDir = join( FlowMcpCli.#schemasDir(), sourceName )
        await mkdir( sourceDir, { recursive: true } )

        const localRegistryPath = join( sourceDir, '_registry.json' )
        const { data: localRegistry } = await FlowMcpCli.#readJson( { filePath: localRegistryPath } )

        const { newSchemas, existingSchemas, removedSchemas } = FlowMcpCli.#compareRegistries( {
            remoteSchemas,
            localRegistry
        } )

        const registryBaseUrl = FlowMcpCli.#resolveRegistryBaseUrl( { registryUrl } )
        const baseDirAlreadyInUrl = baseDir && registryBaseUrl.endsWith( baseDir )

        let downloaded = 0
        let updated = 0
        let skipped = 0
        let failed = 0
        const localHashes = ( localRegistry && localRegistry[ 'localHashes' ] ) || {}
        const errors = []

        if( Array.isArray( remoteShared ) && remoteShared.length > 0 ) {
            await remoteShared
                .reduce( ( promise, sharedEntry, index ) => promise.then( async () => {
                    const { file } = sharedEntry
                    const remotePath = ( baseDir && !baseDirAlreadyInUrl )
                        ? `${baseDir}/${file}`
                        : file

                    const fileUrl = `${registryBaseUrl}/${remotePath}`
                    const targetPath = join( sourceDir, file )
                    process.stdout.write( `    Shared ${index + 1}/${remoteShared.length}: ${file}\r` )

                    await FlowMcpCli.#downloadSchema( { 'url': fileUrl, targetPath, 'allowOverwrite': true } )
                } ), Promise.resolve() )
            process.stdout.write( ' '.repeat( 80 ) + '\r' )
        }

        const allSchemaFiles = [ ...newSchemas, ...existingSchemas ]

        await allSchemaFiles
            .reduce( ( promise, file, index ) => promise.then( async () => {
                const schemaEntry = remoteSchemas
                    .find( ( entry ) => {
                        const isMatch = entry[ 'file' ] === file

                        return isMatch
                    } )

                if( !schemaEntry ) {
                    return
                }

                const remotePath = ( baseDir && !baseDirAlreadyInUrl )
                    ? `${baseDir}/${file}`
                    : file

                const fileUrl = `${registryBaseUrl}/${remotePath}`
                const targetPath = join( sourceDir, file )
                process.stdout.write( `    Checking ${index + 1}/${allSchemaFiles.length}: ${file}\r` )

                const { success, downloadStatus, hash, error: dlError } = await FlowMcpCli.#downloadSchema( {
                    'url': fileUrl,
                    targetPath,
                    'allowOverwrite': true
                } )

                if( success ) {
                    if( downloadStatus === 'downloaded' ) {
                        downloaded = downloaded + 1
                    } else if( downloadStatus === 'updated' ) {
                        updated = updated + 1
                    } else {
                        skipped = skipped + 1
                    }

                    if( hash ) {
                        localHashes[ file ] = hash
                    }
                } else {
                    failed = failed + 1
                    errors.push( `${file}: ${dlError}` )
                }
            } ), Promise.resolve() )
        process.stdout.write( ' '.repeat( 80 ) + '\r' )

        const registryCopy = {
            'name': remoteRegistry[ 'name' ],
            'description': remoteRegistry[ 'description' ],
            'schemaSpec': remoteRegistry[ 'schemaSpec' ],
            'baseDir': remoteRegistry[ 'baseDir' ],
            'shared': remoteRegistry[ 'shared' ],
            'schemas': remoteRegistry[ 'schemas' ],
            localHashes
        }

        await writeFile(
            localRegistryPath,
            JSON.stringify( registryCopy, null, 4 ),
            'utf-8'
        )

        const globalConfigPath = FlowMcpCli.#globalConfigPath()
        const { data: existingConfig } = await FlowMcpCli.#readJson( { filePath: globalConfigPath } )
        const globalConfig = existingConfig || {}

        if( !globalConfig[ 'sources' ] ) {
            globalConfig[ 'sources' ] = {}
        }

        if( globalConfig[ 'sources' ][ sourceName ] ) {
            globalConfig[ 'sources' ][ sourceName ][ 'schemaCount' ] = downloaded + updated + skipped
            globalConfig[ 'sources' ][ sourceName ][ 'updatedAt' ] = new Date().toISOString()
        }

        await FlowMcpCli.#writeGlobalConfig( { 'config': globalConfig } )

        const totalSchemas = downloaded + updated + skipped

        console.log( `    ${chalk.green( '✓' )} ${totalSchemas} schemas: ${downloaded} new, ${updated} updated, ${skipped} up to date${failed > 0 ? chalk.red( `, ${failed} failed` ) : ''}` )

        if( removedSchemas.length > 0 ) {
            console.log( `    ${chalk.yellow( '⚠' )} ${removedSchemas.length} schema(s) removed from remote (local files kept)` )
        }

        const updateResult = {
            sourceName,
            'status': failed === 0,
            downloaded,
            updated,
            skipped,
            failed,
            totalSchemas,
            'removedFiles': removedSchemas,
            'summary': `${downloaded} new, ${updated} updated, ${skipped} up to date`,
            'errors': errors.length > 0 ? errors : undefined
        }

        return { updateResult }
    }


    static async #listSources() {
        const schemasBaseDir = FlowMcpCli.#schemasDir()
        const globalConfigPath = FlowMcpCli.#globalConfigPath()
        const { data: globalConfig } = await FlowMcpCli.#readJson( { filePath: globalConfigPath } )
        const configSources = ( globalConfig && globalConfig[ 'sources' ] ) || {}

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
        } catch {
            sourceDirs = []
        }

        const sources = []

        await sourceDirs
            .reduce( ( promise, sourceDir ) => promise.then( async () => {
                const sourcePath = join( schemasBaseDir, sourceDir )
                const sourceConfig = configSources[ sourceDir ] || {}
                const { type, repository } = sourceConfig

                const registryPath = join( sourcePath, '_registry.json' )
                const { data: registry } = await FlowMcpCli.#readJson( { filePath: registryPath } )

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
                    const files = await FlowMcpCli.#listSchemaFiles( { dirPath: sourcePath } )
                    schemas = files
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

                const sourceEntry = {
                    'name': sourceDir,
                    'type': type || 'builtin',
                    'repository': repository || null,
                    'schemaCount': schemas.length,
                    schemas
                }

                sources.push( sourceEntry )
            } ), Promise.resolve() )

        return { sources }
    }


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
                    const subFiles = await FlowMcpCli.#listSchemaFiles( {
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


    static async #resolveDefaultGroupSchemas( { cwd } ) {
        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )

        if( !localConfig || !localConfig[ 'defaultGroup' ] ) {
            return { 'schemas': null, 'error': 'No default group set. Provide a schema path or set a default group.' }
        }

        const { defaultGroup } = localConfig
        const group = localConfig[ 'groups' ] && localConfig[ 'groups' ][ defaultGroup ]

        if( !group ) {
            return { 'schemas': null, 'error': `Default group "${defaultGroup}" not found.` }
        }

        const toolRefs = group[ 'tools' ] || group[ 'schemas' ] || []
        const { schemas } = await FlowMcpCli.#resolveToolRefs( { toolRefs } )

        return { schemas, 'error': null }
    }


    static async #resolveGroupName( { group, cwd } ) {
        if( group ) {
            return { 'groupName': group, 'error': null, 'fix': null }
        }

        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )

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
        const { data: localConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )

        if( !localConfig || !localConfig[ 'groups' ] || !localConfig[ 'groups' ][ groupName ] ) {
            return {
                'schemas': null,
                'error': `Group "${groupName}" not found.`,
                'fix': `Run ${appConfig[ 'cliCommand' ]} group list to see available groups.`
            }
        }

        const group = localConfig[ 'groups' ][ groupName ]
        const toolRefs = group[ 'tools' ] || group[ 'schemas' ] || []
        const { schemas } = await FlowMcpCli.#resolveToolRefs( { toolRefs } )

        return { schemas, 'error': null, 'fix': null }
    }


    static async #resolveToolRefs( { toolRefs } ) {
        const schemasBaseDir = FlowMcpCli.#schemasDir()
        const schemaRouteMap = {}

        toolRefs
            .forEach( ( ref ) => {
                const { schemaRef, routeName } = FlowMcpCli.#parseToolRef( { 'toolRef': ref } )
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
                const filePath = join( schemasBaseDir, schemaRef )
                const { main, handlersFn, error } = await FlowMcpCli.#loadSchema( { filePath } )

                if( main ) {
                    if( routeNames.length > 0 ) {
                        const { main: filteredMain } = FlowMcpCli.#filterMainRoutes( { main, routeNames } )
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


    static async #readConfig( { cwd } ) {
        const globalConfigPath = FlowMcpCli.#globalConfigPath()
        const { data: globalConfig } = await FlowMcpCli.#readJson( { filePath: globalConfigPath } )

        if( !globalConfig ) {
            return { 'config': null, 'error': `Not initialized. Run: ${appConfig[ 'cliCommand' ]} init` }
        }

        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )

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


    static async #readJson( { filePath } ) {
        try {
            const content = await readFile( filePath, 'utf-8' )
            const data = JSON.parse( content )

            return { data }
        } catch {
            return { 'data': null }
        }
    }


    static async #readText( { filePath } ) {
        try {
            const data = await readFile( filePath, 'utf-8' )

            return { data, 'error': null }
        } catch {
            return { 'data': null, 'error': `Cannot read file: ${filePath}` }
        }
    }


    static #mergeConfig( { existing, updates } ) {
        const merged = { ...existing }

        Object.entries( updates )
            .forEach( ( [ key, value ] ) => {
                if( merged[ key ] === undefined ) {
                    merged[ key ] = value
                }
            } )

        return { 'config': merged }
    }


    static #printHeadline() {
        console.log( chalk.cyan(
            figlet.textSync( appConfig[ 'appName' ], {
                'font': 'Standard',
                'horizontalLayout': 'default'
            } )
        ) )

        if( appConfig[ 'appName' ] !== appConfig[ 'poweredBy' ] ) {
            console.log( chalk.gray( `  Powered by ${appConfig[ 'poweredBy' ]}` ) )
        }
    }


    static #printKeyValue( { key, value } ) {
        const keyStr = `${key}:`.padEnd( 14 )

        console.log( `  ${chalk.gray( keyStr )} ${value}` )
    }


    static #formatHealthWarnings( { checks } ) {
        const warnings = []

        checks
            .filter( ( { ok } ) => {
                const isFailing = !ok

                return isFailing
            } )
            .forEach( ( check ) => {
                const { name, path, fix, detail } = check
                const checkWarnings = check[ 'warnings' ]

                if( checkWarnings && checkWarnings.length > 0 ) {
                    const label = name === 'globalConfig' ? 'Global config'
                        : name === 'localConfig' ? 'Local config'
                        : name === 'groups' ? 'Groups'
                        : name

                    checkWarnings
                        .forEach( ( w ) => {
                            warnings.push( `${label}: ${w}` )
                        } )
                } else {
                    const label = name === 'globalConfig' ? 'Global config not found'
                        : name === 'envFile' ? `.env file not found at ${path}`
                        : name === 'schemas' ? 'No schema sources found'
                        : name === 'localConfig' ? 'Local config not found'
                        : name === 'groups' ? 'No groups defined'
                        : name

                    const warning = fix
                        ? `${label}. ${fix}`
                        : label

                    warnings.push( warning )
                }
            } )

        return { warnings }
    }


    static #printHelpText() {
        const cmd = appConfig[ 'cliCommand' ]
        const helpText = `Usage: ${cmd} <command> [options]

Setup:
  init                                Interactive setup (creates config, sets .env path)

Tool Discovery:
  search <query>                      Find available tools
  add <tool-name>                     Activate a tool for this project
  remove <tool-name>                  Deactivate a tool
  list                                Show active tools

Schema Management:
  schemas                             List all imported sources and schemas
  import <github-url>                 Import schemas from a GitHub repository
  import-registry <url>               Import schemas from a custom registry URL
  update [source-name]                Update schemas from remote registries
  status                              Show config, sources, groups and health info

Group Management:
  group append <name> --tools <list>  Add tools to a group (creates group if needed)
  group remove <name> --tools <list>  Remove tools from a group
  group list                          List all groups and their tools
  group set-default <name>            Set the default group

Prompt Management:
  prompt list                         List all prompts across all groups
  prompt search <query>               Search prompts by title or description
  prompt show <group>/<name>          Display prompt file content
  prompt add <group> <name> --file <path>  Add a prompt to a group
  prompt remove <group> <name>        Remove a prompt from a group

Validation & Testing:
  validate [path]                     Validate schema(s) structurally
  test project                        Test all schemas in default/specified group
  test user                           Test all user schemas
  test single <path>                  Test a single schema file

Execution:
  run                                 Start MCP server (stdio) for default group
  call list-tools                     List available tools from default group
  call <tool-name> [json]             Execute a tool call

Options:
  --tools <list>              Comma-separated tool refs (source/file.mjs::route)
  --group <name>              Override default group for run/call/validate/test
  --route <name>              Filter test to a single route
  --branch <name>             Branch for import (default: main)
  --help, -h                  Show this help message

Tool Ref Format:
  source/file.mjs::routeName  Single tool from a schema
  source/file.mjs             All tools from a schema

Note: Run "${cmd} init" first. This is the only interactive command.
      All other commands are designed for AI agents (non-interactive, JSON I/O).
`

        process.stdout.write( helpText )
    }


    static async #quickInstall( { cwd, version, commit, schemaSpec } ) {
        const globalDir = FlowMcpCli.#globalConfigDir()
        await mkdir( globalDir, { recursive: true } )

        // .env path: use existing or create default
        const globalConfigPath = FlowMcpCli.#globalConfigPath()
        const { data: existingGlobalConfig } = await FlowMcpCli.#readJson( { filePath: globalConfigPath } )
        let envPath

        if( existingGlobalConfig && existingGlobalConfig[ 'envPath' ] ) {
            envPath = existingGlobalConfig[ 'envPath' ]
        } else {
            envPath = join( globalDir, appConfig[ 'defaultEnvFileName' ] )
            try {
                await access( envPath, constants.F_OK )
            } catch {
                await writeFile( envPath, '# Add your API keys here\n# Example: ETHERSCAN_API_KEY=your_key_here\n', 'utf-8' )
            }
        }

        console.log( `  ${chalk.green( '\u2713' )} .env path: ${chalk.gray( envPath )}` )

        // Global config
        const now = new Date().toISOString()
        const globalConfigUpdates = {
            envPath,
            'flowmcpCore': { version, commit, schemaSpec },
            'initialized': now,
            'sources': {
                'demo': { 'type': 'builtin', 'schemaCount': 1 }
            }
        }

        const { config: mergedGlobalConfig } = FlowMcpCli.#mergeConfig( {
            'existing': existingGlobalConfig || {},
            'updates': globalConfigUpdates
        } )

        mergedGlobalConfig[ 'envPath' ] = envPath
        await FlowMcpCli.#writeGlobalConfig( { 'config': mergedGlobalConfig } )
        console.log( `  ${chalk.green( '\u2713' )} Global config saved` )

        // Demo schema
        const schemasDir = FlowMcpCli.#schemasDir()
        let schemaSourceCount = 0
        try {
            const entries = await readdir( schemasDir )
            schemaSourceCount = await entries
                .reduce( ( promise, entry ) => promise.then( async ( count ) => {
                    const entryStat = await stat( join( schemasDir, entry ) )
                    if( entryStat.isDirectory() ) {
                        return count + 1
                    }

                    return count
                } ), Promise.resolve( 0 ) )
        } catch {
            schemaSourceCount = 0
        }

        if( schemaSourceCount === 0 ) {
            const demoDir = join( schemasDir, 'demo' )
            await mkdir( demoDir, { recursive: true } )
            const { content: demoContent } = FlowMcpCli.#createDemoSchema()
            await writeFile( join( demoDir, 'ping.mjs' ), demoContent, 'utf-8' )
            console.log( `  ${chalk.green( '\u2713' )} Demo schema created` )
        }

        // Local config
        const localDir = join( cwd, appConfig[ 'localConfigDirName' ] )
        await mkdir( localDir, { recursive: true } )
        const localConfigPath = join( localDir, 'config.json' )
        const { data: existingLocalConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )

        const { config: mergedLocalConfig } = FlowMcpCli.#mergeConfig( {
            'existing': existingLocalConfig || {},
            'updates': { 'root': `~/${appConfig[ 'globalConfigDirName' ]}` }
        } )

        await writeFile( localConfigPath, JSON.stringify( mergedLocalConfig, null, 4 ), 'utf-8' )
        console.log( `  ${chalk.green( '\u2713' )} Local config saved` )

        // Auto-import default registry
        console.log( '' )
        console.log( `  ${chalk.cyan( 'Importing default schemas...' )}` )

        const { result: importResult } = await FlowMcpCli.importRegistry( {
            'registryUrl': appConfig[ 'defaultRegistryUrl' ]
        } )

        if( importResult[ 'status' ] ) {
            console.log( `  ${chalk.green( '\u2713' )} ${importResult[ 'summary' ] || `Imported ${importResult[ 'schemasImported' ]} schema(s)`}` )
        } else {
            const importError = importResult[ 'error' ] || importResult[ 'errors' ]?.join( ', ' ) || 'Unknown error'
            console.log( `  ${chalk.yellow( '!' )} Import failed: ${importError}` )
        }

        // Create "default" group with all tools
        const { tools: availableTools } = await FlowMcpCli.#listAvailableTools()

        if( availableTools.length > 0 ) {
            const allToolRefs = availableTools
                .map( ( tool ) => {
                    const ref = tool[ 'toolRef' ]

                    return ref
                } )

            const { data: currentLocalConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )
            const updatedLocalConfig = currentLocalConfig || { 'root': `~/${appConfig[ 'globalConfigDirName' ]}` }

            if( !updatedLocalConfig[ 'groups' ] ) {
                updatedLocalConfig[ 'groups' ] = {}
            }

            updatedLocalConfig[ 'groups' ][ 'default' ] = {
                'description': 'All available tools',
                'tools': allToolRefs
            }

            updatedLocalConfig[ 'defaultGroup' ] = 'default'

            await writeFile( localConfigPath, JSON.stringify( updatedLocalConfig, null, 4 ), 'utf-8' )
            console.log( `  ${chalk.green( '\u2713' )} Group "default" created with ${allToolRefs.length} tool(s)` )
        }

        console.log( '' )
    }


    static async #manualInstall( { cwd, version, commit, schemaSpec } ) {
        const globalConfigPath = FlowMcpCli.#globalConfigPath()
        const { data: existingGlobalConfig } = await FlowMcpCli.#readJson( { filePath: globalConfigPath } )
        let envPath

        if( existingGlobalConfig && existingGlobalConfig[ 'envPath' ] ) {
            envPath = existingGlobalConfig[ 'envPath' ]
            console.log( `  ${chalk.green( '\u2713' )} Using existing .env path: ${chalk.gray( envPath )}` )
        } else {
            const { envPath: promptedEnvPath } = await FlowMcpCli.#promptEnvPath()
            envPath = promptedEnvPath
        }

        const globalDir = FlowMcpCli.#globalConfigDir()
        await mkdir( globalDir, { recursive: true } )

        const now = new Date().toISOString()
        const globalConfigUpdates = {
            envPath,
            'flowmcpCore': { version, commit, schemaSpec },
            'initialized': now,
            'sources': {
                'demo': { 'type': 'builtin', 'schemaCount': 1 }
            }
        }

        const { config: mergedGlobalConfig } = FlowMcpCli.#mergeConfig( {
            'existing': existingGlobalConfig || {},
            'updates': globalConfigUpdates
        } )

        mergedGlobalConfig[ 'envPath' ] = envPath
        await FlowMcpCli.#writeGlobalConfig( { 'config': mergedGlobalConfig } )

        const schemasDir = FlowMcpCli.#schemasDir()
        let schemaSourceCount = 0
        try {
            const entries = await readdir( schemasDir )
            schemaSourceCount = await entries
                .reduce( ( promise, entry ) => promise.then( async ( count ) => {
                    const entryStat = await stat( join( schemasDir, entry ) )
                    if( entryStat.isDirectory() ) {
                        return count + 1
                    }

                    return count
                } ), Promise.resolve( 0 ) )
        } catch {
            schemaSourceCount = 0
        }

        if( schemaSourceCount > 0 ) {
            console.log( `  ${chalk.green( '\u2713' )} ${schemaSourceCount} schema source(s) found` )
        } else {
            const demoDir = join( schemasDir, 'demo' )
            await mkdir( demoDir, { recursive: true } )
            const { content: demoContent } = FlowMcpCli.#createDemoSchema()
            await writeFile( join( demoDir, 'ping.mjs' ), demoContent, 'utf-8' )
            console.log( `  ${chalk.green( '\u2713' )} Demo schema created` )
        }

        const localDir = join( cwd, appConfig[ 'localConfigDirName' ] )
        await mkdir( localDir, { recursive: true } )
        const localConfigPath = join( localDir, 'config.json' )
        const { data: existingLocalConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )

        const { config: mergedLocalConfig } = FlowMcpCli.#mergeConfig( {
            'existing': existingLocalConfig || {},
            'updates': { 'root': `~/${appConfig[ 'globalConfigDirName' ]}` }
        } )

        await writeFile( localConfigPath, JSON.stringify( mergedLocalConfig, null, 4 ), 'utf-8' )

        console.log( '' )
        console.log( `  ${chalk.green( '\u2713' )} Global config saved to ${chalk.gray( FlowMcpCli.#globalConfigPath() )}` )
        console.log( `  ${chalk.green( '\u2713' )} Local config saved to ${chalk.gray( localConfigPath )}` )
        console.log( '' )

        // Import schemas
        const { wantImport } = await inquirer.prompt( [
            {
                'type': 'confirm',
                'name': 'wantImport',
                'message': 'Import schemas?',
                'default': true
            }
        ] )

        if( wantImport ) {
            const { registryUrl } = await inquirer.prompt( [
                {
                    'type': 'input',
                    'name': 'registryUrl',
                    'message': `Registry URL (${appConfig[ 'registryFileName' ]}):`,
                    'default': appConfig[ 'defaultRegistryUrl' ],
                    validate: ( input ) => {
                        if( !input || input.trim().length === 0 ) {
                            return 'Please provide a URL.'
                        }

                        if( !input.startsWith( 'http://' ) && !input.startsWith( 'https://' ) ) {
                            return 'Must be a valid HTTP or HTTPS URL.'
                        }

                        return true
                    }
                }
            ] )

            const { result: importResult } = await FlowMcpCli.importRegistry( {
                'registryUrl': registryUrl.trim()
            } )

            if( importResult[ 'status' ] ) {
                console.log( `  ${chalk.green( '\u2713' )} ${importResult[ 'summary' ] || `Imported ${importResult[ 'schemasImported' ]} schema(s) from "${importResult[ 'source' ]}"`}` )
            } else {
                const importError = importResult[ 'error' ] || importResult[ 'errors' ]?.join( ', ' ) || 'Unknown error'
                console.log( `  ${chalk.yellow( '!' )} Import failed: ${importError}` )
            }

            console.log( '' )
        }

        // Create group
        const { checks: latestChecks } = await FlowMcpCli.#healthCheck( { cwd } )
        const latestGroupsCheck = latestChecks
            .find( ( { name } ) => {
                const isGroups = name === 'groups'

                return isGroups
            } )

        if( latestGroupsCheck && !latestGroupsCheck[ 'ok' ] ) {
            const { tools: availableTools } = await FlowMcpCli.#listAvailableTools()

            if( availableTools.length > 0 ) {
                const toolChoices = availableTools
                    .map( ( tool ) => {
                        const { toolRef, toolName, description: toolDescription } = tool
                        const label = `${toolName}  ${chalk.gray( toolDescription || '' )}`
                        const choice = { 'name': label, 'value': toolRef }

                        return choice
                    } )

                const { wantGroup } = await inquirer.prompt( [
                    {
                        'type': 'confirm',
                        'name': 'wantGroup',
                        'message': 'Create a tool group now?',
                        'default': true
                    }
                ] )

                if( wantGroup ) {
                    const { groupName } = await inquirer.prompt( [
                        {
                            'type': 'input',
                            'name': 'groupName',
                            'message': 'Group name:',
                            validate: ( input ) => {
                                if( !input || input.trim().length === 0 ) {
                                    return 'Please provide a group name.'
                                }

                                return true
                            }
                        }
                    ] )

                    const { selectedTools } = await inquirer.prompt( [
                        {
                            'type': 'checkbox',
                            'name': 'selectedTools',
                            'message': `Select tools for group "${groupName.trim()}":`,
                            'choices': toolChoices,
                            validate: ( input ) => {
                                if( input.length === 0 ) {
                                    return 'Select at least one tool.'
                                }

                                return true
                            }
                        }
                    ] )

                    const { description: groupDescription } = await inquirer.prompt( [
                        {
                            'type': 'input',
                            'name': 'description',
                            'message': 'Group description (optional):',
                            'default': ''
                        }
                    ] )

                    const localGroupDir = join( cwd, appConfig[ 'localConfigDirName' ] )
                    await mkdir( localGroupDir, { recursive: true } )
                    const localGroupConfigPath = join( localGroupDir, 'config.json' )

                    const { data: currentLocalConfig } = await FlowMcpCli.#readJson( { filePath: localGroupConfigPath } )
                    const updatedLocalConfig = currentLocalConfig || { 'root': `~/${appConfig[ 'globalConfigDirName' ]}` }

                    if( !updatedLocalConfig[ 'groups' ] ) {
                        updatedLocalConfig[ 'groups' ] = {}
                    }

                    const trimmedGroupName = groupName.trim()
                    updatedLocalConfig[ 'groups' ][ trimmedGroupName ] = {
                        'description': groupDescription.trim() || '',
                        'tools': selectedTools
                    }

                    if( !updatedLocalConfig[ 'defaultGroup' ] ) {
                        updatedLocalConfig[ 'defaultGroup' ] = trimmedGroupName
                    }

                    await writeFile( localGroupConfigPath, JSON.stringify( updatedLocalConfig, null, 4 ), 'utf-8' )

                    console.log( `  ${chalk.green( '\u2713' )} Group "${trimmedGroupName}" created with ${selectedTools.length} tool(s)` )
                    if( updatedLocalConfig[ 'defaultGroup' ] === trimmedGroupName ) {
                        console.log( `  ${chalk.green( '\u2713' )} Set as default group` )
                    }
                    console.log( '' )
                }
            }
        }
    }


    static async #promptEnvPath() {
        const { envPath } = await inquirer.prompt( [
            {
                'type': 'input',
                'name': 'envPath',
                'message': 'Path to .env file:',
                validate: async ( input ) => {
                    if( !input || input.trim().length === 0 ) {
                        return 'Please provide a path to your .env file.'
                    }

                    const resolvedPath = resolve( input.trim() )

                    try {
                        await access( resolvedPath, constants.F_OK )
                        const fileStat = await stat( resolvedPath )
                        if( !fileStat.isFile() ) {
                            return 'Path is not a file.'
                        }

                        return true
                    } catch {
                        return `File not found: ${resolvedPath}`
                    }
                },
                filter: ( input ) => {
                    const resolvedPath = resolve( input.trim() )

                    return resolvedPath
                }
            }
        ] )

        const resolvedPath = resolve( envPath.trim() )

        try {
            const content = await readFile( resolvedPath, 'utf-8' )
            const varCount = content
                .split( '\n' )
                .filter( ( line ) => {
                    const isVar = line.includes( '=' ) && !line.startsWith( '#' )

                    return isVar
                } )
                .length

            console.log( `  ${chalk.green( '✓' )} ${varCount} variable${varCount !== 1 ? 's' : ''} found` )
        } catch {
            console.log( `  ${chalk.yellow( '!' )} File will be created on first use` )
        }

        return { 'envPath': resolvedPath }
    }


    static async #promptSchemasDir() {
        const { schemasDir } = await inquirer.prompt( [
            {
                'type': 'input',
                'name': 'schemasDir',
                'message': 'Schemas directory (optional, Enter to skip):',
                'default': ''
            }
        ] )

        const trimmed = schemasDir.trim()
        const result = trimmed.length > 0 ? trimmed : null

        return { 'schemasDir': result }
    }


    static async #promptConfirm() {
        const { confirmed } = await inquirer.prompt( [
            {
                'type': 'confirm',
                'name': 'confirmed',
                'message': 'Save configuration?',
                'default': true
            }
        ] )

        return { confirmed }
    }


    static #detectCoreInfo() {
        try {
            const require = createRequire( import.meta.url )
            const corePath = require.resolve( 'flowmcp/v2' )
            let dir = dirname( corePath )

            let version = 'unknown'
            [ 1, 2, 3, 4, 5 ]
                .forEach( () => {
                    if( version !== 'unknown' ) { return }

                    const candidate = join( dir, 'package.json' )
                    if( existsSync( candidate ) ) {
                        try {
                            const pkg = JSON.parse( readFileSync( candidate, 'utf-8' ) )
                            if( pkg[ 'name' ] ) {
                                version = pkg[ 'version' ] || 'unknown'
                            }
                        } catch { /* skip malformed package.json */ }
                    }

                    dir = dirname( dir )
                } )

            const commit = '8a9e8f1'
            const schemaSpec = appConfig[ 'schemaSpec' ]

            return { version, commit, schemaSpec }
        } catch {
            return {
                'version': 'unknown',
                'commit': 'unknown',
                'schemaSpec': appConfig[ 'schemaSpec' ] || 'unknown'
            }
        }
    }


    static #getAllTests( { main } ) {
        const routes = main[ 'routes' ] || {}
        const tests = []

        Object.entries( routes )
            .forEach( ( [ routeName, routeConfig ] ) => {
                const routeTests = routeConfig[ 'tests' ] || []

                routeTests
                    .forEach( ( testCase ) => {
                        const { _description, ...userParams } = testCase

                        tests.push( {
                            routeName,
                            'description': _description || '',
                            userParams
                        } )
                    } )
            } )

        return tests
    }


    static async #resolveHandlers( { main, handlersFn, filePath } ) {
        let handlerMap = {}

        if( !handlersFn ) {
            return { handlerMap }
        }

        try {
            const sharedListRefs = main[ 'sharedLists' ] || []
            let sharedLists = {}
            let libraries = {}

            if( sharedListRefs.length > 0 ) {
                const { listsDir } = FlowMcpCli.#findListsDir( { filePath } )
                if( listsDir ) {
                    const resolved = await FlowMCP.resolveSharedLists( { sharedListRefs, listsDir } )
                    sharedLists = resolved[ 'sharedLists' ] || {}
                }
            }

            const requiredLibraries = main[ 'requiredLibraries' ] || []
            if( requiredLibraries.length > 0 ) {
                const schemaRequire = createRequire( resolve( filePath ) )

                await requiredLibraries
                    .reduce( ( promise, lib ) => promise.then( async () => {
                        try {
                            const mod = await import( schemaRequire.resolve( lib ) )
                            libraries[ lib ] = mod.default || mod
                        } catch {
                            const mod = schemaRequire( lib )
                            libraries[ lib ] = mod
                        }
                    } ), Promise.resolve() )
            }

            const tempHandlers = handlersFn( { sharedLists, libraries } )
            const allRouteNames = Object.keys( tempHandlers || {} )
            const created = FlowMCP.createHandlers( { handlersFn, sharedLists, libraries, 'routeNames': allRouteNames } )
            handlerMap = created[ 'handlerMap' ] || {}
        } catch( resolveErr ) {
            if( process.env[ 'FLOWMCP_DEBUG' ] ) {
                console.error( `[resolveHandlers] ${resolveErr.message}` )
            }
            handlerMap = {}
        }

        return { handlerMap }
    }


    static #findListsDir( { filePath } ) {
        const resolved = resolve( filePath )
        const dir = dirname( resolved )
        const siblingLists = join( dir, '_lists' )

        if( existsSync( siblingLists ) ) {
            return { 'listsDir': siblingLists }
        }

        const parentDir = dirname( dir )
        const parentLists = join( parentDir, '_lists' )

        if( existsSync( parentLists ) ) {
            return { 'listsDir': parentLists }
        }

        return { 'listsDir': null }
    }


    static async #resolveSharedListsForSchema( { main, filePath } ) {
        const sharedListRefs = main?.[ 'sharedLists' ] || []
        let sharedLists = {}

        if( sharedListRefs.length > 0 && filePath ) {
            try {
                const { listsDir } = FlowMcpCli.#findListsDir( { filePath } )
                if( listsDir ) {
                    const resolved = await FlowMCP.resolveSharedLists( { sharedListRefs, listsDir } )
                    sharedLists = resolved[ 'sharedLists' ] || {}
                }
            } catch {
                sharedLists = {}
            }
        }

        return { sharedLists }
    }


    static #prepareServerTool( { main, handlerMap, serverParams, routeName } ) {
        const namespace = main[ 'namespace' ] || 'unknown'
        const routes = main[ 'routes' ] || {}
        const routeConfig = routes[ routeName ]

        if( !routeConfig ) {
            throw new Error( `Route "${routeName}" not found in schema "${namespace}"` )
        }

        const { toolName } = FlowMcpCli.#buildToolName( { routeName, namespace } )
        const { description } = routeConfig
        const zod = ZodBuilder.getZodSchema( { 'route': routeConfig } )

        const func = async ( userParams ) => {
            const fetchResult = await FlowMCP.fetch( {
                main,
                handlerMap,
                userParams,
                serverParams,
                routeName
            } )

            const { status, messages, data, dataAsString } = fetchResult

            return { status, messages, data, dataAsString }
        }

        return { toolName, description, zod, func }
    }


    static async #loadSchema( { filePath, bustCache = false } ) {
        try {
            const resolvedPath = resolve( filePath )
            const fileUrl = pathToFileURL( resolvedPath ).href
            const importPath = bustCache
                ? `${fileUrl}?t=${Date.now()}`
                : fileUrl
            const mod = await import( importPath )
            const main = mod[ 'main' ] || null
            const handlersFn = mod[ 'handlers' ] || null

            if( !main ) {
                return { 'main': null, 'handlersFn': null, 'error': `No main export in: ${filePath}` }
            }

            return { main, handlersFn, 'error': null }
        } catch( err ) {
            return { 'main': null, 'handlersFn': null, 'error': `Failed to load schema: ${filePath} - ${err.message}` }
        }
    }


    static async #loadSchemasFromPath( { schemaPath } ) {
        const resolvedPath = resolve( schemaPath )

        let pathStat
        try {
            pathStat = await stat( resolvedPath )
        } catch {
            return { 'schemas': null, 'error': `Path not found: ${schemaPath}` }
        }

        if( pathStat.isFile() ) {
            const { main, handlersFn, error } = await FlowMcpCli.#loadSchema( { filePath: resolvedPath } )
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
                    const { main, handlersFn, error } = await FlowMcpCli.#loadSchema( { filePath } )

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


    static #parseEnvFile( { envContent } ) {
        const envObject = envContent
            .split( '\n' )
            .filter( ( line ) => {
                const isValid = line.includes( '=' ) && !line.startsWith( '#' )

                return isValid
            } )
            .reduce( ( acc, line ) => {
                const separatorIndex = line.indexOf( '=' )
                const key = line.slice( 0, separatorIndex ).trim()
                const value = line.slice( separatorIndex + 1 ).trim()
                acc[ key ] = value

                return acc
            }, {} )

        return { envObject }
    }


    static #buildServerParams( { envObject, requiredServerParams } ) {
        const serverParams = requiredServerParams
            .reduce( ( acc, paramName ) => {
                const value = envObject[ paramName ]
                if( value !== undefined ) {
                    acc[ paramName ] = value
                }

                return acc
            }, {} )

        return { serverParams }
    }


    static async #resolveActiveToolRefs( { cwd } ) {
        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )

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
        const { toolRefs } = await FlowMcpCli.#resolveActiveToolRefs( { cwd } )

        if( toolRefs.length === 0 ) {
            return {
                'schemas': null,
                'error': 'No active tools.',
                'fix': `Use ${appConfig[ 'cliCommand' ]} add <tool-name> to activate tools.`
            }
        }

        const { schemas } = await FlowMcpCli.#resolveToolRefs( { toolRefs } )

        return { schemas, 'error': null, 'fix': null }
    }


    static #error( { error, fix } ) {
        const result = { 'status': false, error }
        if( fix ) {
            result[ 'fix' ] = fix
        }

        return result
    }


    static async #requireInit() {
        const globalConfigPath = FlowMcpCli.#globalConfigPath()
        const { data: globalConfig } = await FlowMcpCli.#readJson( { filePath: globalConfigPath } )

        if( !globalConfig || !globalConfig[ 'initialized' ] ) {
            return {
                'initialized': false,
                'error': `Not initialized. Run: ${appConfig[ 'cliCommand' ]} init`,
                'fix': `Ask the user to run: ${appConfig[ 'cliCommand' ]} init`
            }
        }

        return { 'initialized': true, 'error': null, 'fix': null }
    }


    static #collectRequiredModules( { registrySchemas } ) {
        const moduleMap = new Map()

        registrySchemas
            .forEach( ( schemaEntry ) => {
                const { file, requiredModules } = schemaEntry
                if( !Array.isArray( requiredModules ) || requiredModules.length === 0 ) {
                    return
                }

                requiredModules
                    .forEach( ( mod ) => {
                        const { name, version } = mod
                        const existing = moduleMap.get( name )

                        if( !existing ) {
                            moduleMap.set( name, { name, version, 'usedBy': [ file ] } )
                        } else {
                            existing[ 'usedBy' ].push( file )
                            const existingClean = existing[ 'version' ].replace( /[\^~>=<]/g, '' )
                            const newClean = version.replace( /[\^~>=<]/g, '' )

                            if( newClean > existingClean ) {
                                existing[ 'version' ] = version
                            }
                        }
                    } )
            } )

        const modules = [ ...moduleMap.values() ]

        return { modules }
    }


    static #buildInstallCommand( { sourceDir, modules } ) {
        const packages = modules
            .map( ( mod ) => {
                const pkg = `${mod[ 'name' ]}@${mod[ 'version' ]}`

                return pkg
            } )
            .join( ' ' )

        const command = `cd ${sourceDir} && npm install ${packages}`

        return { command }
    }


    static #verifyModules( { sourceDir, modules } ) {
        const installed = []
        const missing = []

        modules
            .forEach( ( mod ) => {
                const modulePath = join( sourceDir, 'node_modules', mod[ 'name' ] )
                const exists = existsSync( modulePath )

                if( exists ) {
                    installed.push( mod[ 'name' ] )
                } else {
                    missing.push( mod[ 'name' ] )
                }
            } )

        const allInstalled = missing.length === 0

        return { allInstalled, installed, missing }
    }


    static async #loadAllSchemas() {
        const { sources } = await FlowMcpCli.#listSources()
        const schemasBaseDir = FlowMcpCli.#schemasDir()
        const allSchemas = []

        await sources
            .reduce( ( promise, source ) => promise.then( async () => {
                await source[ 'schemas' ]
                    .reduce( ( innerPromise, schemaInfo ) => innerPromise.then( async () => {
                        const { file } = schemaInfo
                        const filePath = join( schemasBaseDir, source[ 'name' ], file )
                        const { main, handlersFn, error } = await FlowMcpCli.#loadSchema( { filePath } )

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


    static #extractParameters( { routeParameters, sharedLists } ) {
        const parameters = {}

        const userParameters = routeParameters
            .filter( ( param ) => {
                const { position } = param
                const isUserParam = position[ 'value' ] === '{{USER_PARAM}}'

                return isUserParam
            } )

        userParameters
            .forEach( ( param ) => {
                const { position, z } = param
                const { key } = position

                if( !z ) {
                    parameters[ key ] = { 'type': 'string', 'required': true }

                    return
                }

                const { primitive, options } = z

                const entry = {}

                if( primitive.startsWith( 'enum(' ) ) {
                    entry[ 'type' ] = 'enum'
                    let enumContent = primitive
                    if( enumContent.includes( '{{' ) && sharedLists ) {
                        const { result } = FlowMCP.interpolateEnum( { 'template': enumContent, sharedLists } )
                        enumContent = result
                    }
                    const inner = enumContent.slice( 5, -1 )
                    entry[ 'values' ] = inner.split( ',' )
                        .map( ( v ) => {
                            const trimmed = v.trim()

                            return trimmed
                        } )
                        .filter( ( v ) => v.length > 0 )
                } else if( primitive.startsWith( 'number(' ) ) {
                    entry[ 'type' ] = 'number'
                } else if( primitive.startsWith( 'array(' ) ) {
                    entry[ 'type' ] = 'array'
                } else {
                    entry[ 'type' ] = 'string'
                }

                const optionsList = options || []
                const hasOptional = optionsList
                    .find( ( opt ) => {
                        const isOptional = opt === 'optional()'

                        return isOptional
                    } )

                const defaultOption = optionsList
                    .find( ( opt ) => {
                        const isDefault = opt.startsWith( 'default(' )

                        return isDefault
                    } )

                if( hasOptional || defaultOption ) {
                    entry[ 'required' ] = false
                } else {
                    entry[ 'required' ] = true
                }

                if( defaultOption ) {
                    const inner = defaultOption.slice( 8, -1 )
                    const parsed = Number( inner )
                    entry[ 'default' ] = Number.isNaN( parsed ) ? inner : parsed
                }

                parameters[ key ] = entry
            } )

        return { parameters }
    }


    static async #saveToolSchema( { toolName, description, parameters, cwd } ) {
        const toolsDir = join( cwd, appConfig[ 'localConfigDirName' ], 'tools' )
        await mkdir( toolsDir, { recursive: true } )

        const toolSchema = { 'name': toolName, description, parameters }
        const filePath = join( toolsDir, `${toolName}.json` )
        await writeFile( filePath, JSON.stringify( toolSchema, null, 4 ), 'utf-8' )

        return { filePath }
    }


    static async #removeToolSchema( { toolName, cwd } ) {
        const filePath = join( cwd, appConfig[ 'localConfigDirName' ], 'tools', `${toolName}.json` )

        try {
            await unlink( filePath )

            return { 'removed': true }
        } catch {
            return { 'removed': false }
        }
    }
}


export { FlowMcpCli }
