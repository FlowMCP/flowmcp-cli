/**
 * FlowMCP — MIT License
 *
 * DISCLAIMER: This code orchestrates calls to third-party APIs. Each API has
 * its own Terms of Services. FlowMCP makes no representation about TOS
 * compliance, data licensing, or fitness for any purpose. Users are solely
 * responsible for reviewing and adhering to each API provider's terms.
 *
 * For more information, see LICENSE.md and DISCLAIMER.md in the repo root.
 */

import { readFile, writeFile, mkdir, readdir, stat, access, unlink, rename } from 'node:fs/promises'
import { join, resolve, basename, extname, dirname, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { constants, existsSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'

import chalk from 'chalk'
import Database from 'better-sqlite3'
import figlet from 'figlet'
import inquirer from 'inquirer'
import { FlowMCP } from 'flowmcp/v2'

import { ZodBuilder } from './ZodBuilder.mjs'

import { appConfig, catalogCategories } from '../data/config.mjs'
import { ADDON_REGISTRY } from '../data/addons.mjs'
import { PathVariableResolver } from '../path/resolvePathVariables.mjs'
import { AddonLoader } from '../addons/loadAddon.mjs'
import { SqliteGtfsResourceValidator } from '../validators/SqliteGtfsResourceValidator.mjs'


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
                    await FlowMcpCli.#mirrorSharedToLists( { targetPath } )
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

        await FlowMcpCli.#writeGuarded( {
            'path': join( sourceDir, '_registry.json' ),
            'content': JSON.stringify( registryCopy, null, 4 ),
            'onExists': 'overwrite'
        } )

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

        await FlowMcpCli.#writeGuarded( {
            'path': join( sourceDir, '_registry.json' ),
            'content': JSON.stringify( registryCopy, null, 4 ),
            'onExists': 'overwrite'
        } )

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
        const expandedRefs = []

        await toolRefs
            .reduce( ( promise, ref ) => promise.then( async () => {
                if( FlowMcpCli.#isSpecId( { 'ref': ref } ) ) {
                    const { valid, namespace, type, name: specName, error: parseError } = FlowMcpCli.#parseSpecId( { 'specId': ref } )

                    if( !valid ) {
                        invalidRefs.push( ref )

                        return
                    }

                    const { index } = await FlowMcpCli.getNamespaceIndex( { cwd } )

                    if( type === 'tool' ) {
                        const specId = `${namespace}/tool/${specName}`
                        if( !index[ 'tools' ][ specId ] ) {
                            invalidRefs.push( ref )

                            return
                        }

                        expandedRefs.push( specId )
                    } else if( type === 'schema' ) {
                        const containerKey = `${namespace}/${specName}`
                        const container = index[ 'containers' ][ containerKey ]

                        if( !container ) {
                            invalidRefs.push( ref )

                            return
                        }

                        const toolEntries = Object.entries( index[ 'tools' ] )
                        const containerSource = toolEntries
                            .find( ( [ , entry ] ) => {
                                const matchesFile = container[ 'files' ]
                                    .find( ( f ) => {
                                        const isSame = f === entry[ 'file' ]

                                        return isSame
                                    } )

                                return !!matchesFile
                            } )

                        const source = containerSource ? containerSource[ 1 ][ 'source' ] : null

                        await container[ 'files' ]
                            .reduce( ( fp, file ) => fp.then( async () => {
                                const schemaRef = source ? `${source}/${file}` : file
                                const filePath = join( schemasBaseDir, schemaRef )
                                const { main } = await FlowMcpCli.#loadSchema( { filePath } )

                                if( main ) {
                                    const routeMap = main[ 'routes' ] || main[ 'tools' ] || {}
                                    const ns = main[ 'namespace' ] || namespace

                                    Object.keys( routeMap )
                                        .forEach( ( routeName ) => {
                                            const primitiveId = `${ns}/tool/${routeName}`
                                            expandedRefs.push( primitiveId )
                                        } )
                                } else {
                                    invalidRefs.push( ref )
                                }
                            } ), Promise.resolve() )
                    } else {
                        invalidRefs.push( ref )
                    }
                } else {
                    const { schemaRef, routeName } = FlowMcpCli.#parseToolRef( { 'toolRef': ref } )
                    const filePath = join( schemasBaseDir, schemaRef )

                    try {
                        await access( filePath, constants.F_OK )

                        if( routeName ) {
                            const { main } = await FlowMcpCli.#loadSchema( { filePath } )
                            const refRouteMap = main ? ( main[ 'routes' ] || main[ 'tools' ] ) : null
                            if( !main || !refRouteMap || !refRouteMap[ routeName ] ) {
                                invalidRefs.push( ref )

                                return
                            }
                        }

                        expandedRefs.push( ref )
                    } catch {
                        invalidRefs.push( ref )
                    }
                }
            } ), Promise.resolve() )

        if( invalidRefs.length > 0 ) {
            const result = FlowMcpCli.#error( {
                'error': `Tools not found: ${invalidRefs.join( ', ' )}`,
                'fix': `Run ${appConfig[ 'cliCommand' ]} call list-tools to see available tool references.`
            } )

            return { result }
        }

        const resolvedRefs = expandedRefs

        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )
        const config = localConfig || { 'root': `~/${appConfig[ 'globalConfigDirName' ]}` }

        if( !config[ 'groups' ] ) {
            config[ 'groups' ] = {}
        }

        const existingTools = config[ 'groups' ][ name ]
            ? ( config[ 'groups' ][ name ][ 'tools' ] || config[ 'groups' ][ name ][ 'schemas' ] || [] )
            : []

        const merged = [ ...new Set( [ ...existingTools, ...resolvedRefs ] ) ]
        const added = resolvedRefs
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
        await FlowMcpCli.#writeGuarded( { 'path': localConfigPath, 'content': JSON.stringify( config, null, 4 ), 'onExists': 'overwrite' } )

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

        await FlowMcpCli.#writeGuarded( { 'path': localConfigPath, 'content': JSON.stringify( localConfig, null, 4 ), 'onExists': 'overwrite' } )

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
        await FlowMcpCli.#writeGuarded( { 'path': localConfigPath, 'content': JSON.stringify( localConfig, null, 4 ), 'onExists': 'overwrite' } )

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

        await FlowMcpCli.#writeGuarded( { 'path': localConfigPath, 'content': JSON.stringify( localConfig, null, 4 ), 'onExists': 'overwrite' } )

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

        await FlowMcpCli.#writeGuarded( { 'path': localConfigPath, 'content': JSON.stringify( localConfig, null, 4 ), 'onExists': 'overwrite' } )

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

        const v4 = await FlowMcpCli.#loadV4Module()

        if( !schemaPath && cwd ) {
            const { schemas: groupSchemas, error: groupError } = await FlowMcpCli.#resolveDefaultGroupSchemas( { cwd } )
            if( groupError ) {
                const result = FlowMcpCli.#error( { error: groupError } )

                return { result }
            }

            const results = groupSchemas
                .map( ( { main, file } ) => FlowMcpCli.#validateSingleSchema( { main, file, v4 } ) )

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
            .map( ( { main, file } ) => FlowMcpCli.#validateSingleSchema( { main, file, v4 } ) )

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


    static async migrate( { schemaPath, cwd, all = false, dryRun = false } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { status: validStatus, messages: validMessages } = FlowMcpCli.validationMigrate( { schemaPath, all } )
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
                const result = FlowMcpCli.#error( { 'error': `Path not found: ${dirPath}` } )

                return { result }
            }

            if( !dirStat.isDirectory() ) {
                const result = FlowMcpCli.#error( { 'error': `Path is not a directory: ${dirPath}. Use --all with a directory.` } )

                return { result }
            }

            const { files } = await FlowMcpCli.#findSchemaFiles( { dirPath: resolvedDir } )
            filePaths = files
        } else {
            const resolvedPath = resolve( schemaPath )

            let pathStat
            try {
                pathStat = await stat( resolvedPath )
            } catch {
                const result = FlowMcpCli.#error( { 'error': `Path not found: ${schemaPath}` } )

                return { result }
            }

            if( pathStat.isDirectory() ) {
                const { files } = await FlowMcpCli.#findSchemaFiles( { dirPath: resolvedPath } )
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

                await FlowMcpCli.#writeGuarded( { 'path': filePath, 'content': updatedContent, 'onExists': 'overwrite' } )
                migrated += 1
                const targetVersion = ( hasV3Version || hasMainSkills ) ? 'v4' : 'v3'
                const reasonParts = [ `Successfully migrated to ${targetVersion}` ]
                if( warnings.length > 0 ) { reasonParts.push( `Warnings: ${warnings.join( '; ' )}` ) }
                results.push( { 'file': filePath, 'action': 'migrated', 'reason': reasonParts.join( '. ' ) } )
            } catch( err ) {
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


    // Memo 102 / PRD-002 — FlowMcpCli.test (the dev test project/user/single
    // runner) removed. Its PASS criterion was HTTP 200 only — a strict subset of
    // the deterministic grading pretest (HTTP 200 + non-empty data). Schema
    // checking now has ONE path: grading deterministic <id>. The exclusive
    // v4-primitive --only view migrated onto that command (PRD-001/002). The
    // shared helpers (#runTypedTests, #executeTest, #validateOnlyFilter,
    // #computeDeclared, #aggregateByPrimitive) are KEPT — they back the migrated
    // grading deterministic --only path.

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

        // PRD-008 — pre-serve dedup. Two schemaFolders carrying the same provider
        // would compute the same MCP tool name and make the SDK throw
        // "Tool ${name} is already registered". We track every registered name and,
        // on a real collision, re-derive the name with the source coordinate appended
        // (deterministic). A genuine within-config duplicate (same source, same name)
        // is skipped with a visible stderr note instead of crashing the server.
        const registeredToolNames = new Set()
        const resolveRegisterableName = ( { baseName, routeName, namespace, source } ) => {
            const plan = FlowMcpCli.#disambiguateToolName( { baseName, routeName, namespace, source, registeredToolNames } )
            if( plan.note !== null ) {
                process.stderr.write( `${appConfig[ 'appName' ]}: ${plan.note}\n` )
            }

            return { 'finalName': plan.finalName, 'skip': plan.skip }
        }

        await resolvedSchemas
            .reduce( ( promise, { main, handlersFn, file, source } ) => promise.then( async () => {
                const requiredServerParams = main[ 'requiredServerParams' ] || []
                const { serverParams } = FlowMcpCli.#buildServerParams( { envObject, requiredServerParams } )
                const schemasBaseDir = FlowMcpCli.#schemasDir()
                const schemaFilePath = join( schemasBaseDir, file )
                const { handlerMap } = await FlowMcpCli.#resolveHandlers( { main, handlersFn, 'filePath': schemaFilePath } )
                const namespaceForTools = main[ 'namespace' ] || 'unknown'

                Object.keys( main[ 'tools' ] || main[ 'routes' ] || {} )
                    .forEach( ( routeName ) => {
                        const { toolName, description, zod, func } = FlowMcpCli.#prepareServerTool( {
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
                    const { resourceHandlerMap } = await FlowMcpCli.#resolveHandlers( { main, handlersFn, 'filePath': schemaFilePath } )

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

                                    server.tool( toolName, description, {}, async ( args ) => {
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

        const result = { 'status': true, 'mode': 'stdio', 'group': serverName }

        return { result }
    }


    static async callListTools( { group, cwd } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        // Memo 099 Kap 5 — list ALL tools from the configured schemaFolders (no group/activation).
        const { schemas: resolvedSchemas, error: resolveError, fix: resolveFix } = await FlowMcpCli.#resolveAllSchemas()

        // PRD-008 — a duplicate schemaFolders[] name is a hard config error.
        if( resolveError !== null && resolveError !== undefined ) {
            const result = FlowMcpCli.#error( { 'error': resolveError, 'fix': resolveFix } )

            return { result }
        }

        const tools = []

        resolvedSchemas
            .forEach( ( { main, source } ) => {
                const namespace = main[ 'namespace' ] || 'unknown'
                const routes = main[ 'routes' ] || main[ 'tools' ] || {}

                Object.keys( routes )
                    .forEach( ( routeName ) => {
                        try {
                            const { toolName } = FlowMcpCli.#buildToolName( { routeName, namespace } )
                            const description = routes[ routeName ][ 'description' ] || ''

                            // PRD-008 — surface the source coordinate so a qualified
                            // "<source>:<namespace>/tool/<name>" call is readable from `list`.
                            tools.push( { toolName, namespace, routeName, description, 'source': source || null } )
                        } catch( err ) {
                            tools.push( {
                                'toolName': `error_${routeName}_${namespace}`,
                                namespace,
                                routeName,
                                'source': source || null,
                                'description': `Error: ${err.message}`
                            } )
                        }
                    } )
            } )

        const result = {
            'status': true,
            'group': '_all',
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

        // Memo 051 PRD-20 — route auto-injected sqlite-gtfs tools to addon handlers
        const autoToolRoute = await FlowMcpCli.#maybeCallSqliteGtfsAutoTool( {
            toolName,
            jsonArgs,
            noCache,
            refresh
        } )
        if( autoToolRoute ) {
            return autoToolRoute
        }

        let resolvedToolName = toolName
        // PRD-008 — an optional "<source>:" prefix scopes the call to one
        // schemaFolders[] source (no first-wins guess on a collision).
        let sourceFilter = null

        if( FlowMcpCli.#isSpecId( { 'ref': toolName } ) ) {
            const { valid, namespace, type, name: specName, source } = FlowMcpCli.#parseSpecId( { 'specId': toolName } )

            if( !valid ) {
                const result = FlowMcpCli.#error( {
                    'error': `Invalid Spec-ID "${toolName}".`,
                    'fix': `Use format: <namespace>/tool/<name> (optional prefix "<source>:").`
                } )

                return { result }
            }

            if( type === 'schema' ) {
                const result = FlowMcpCli.#error( {
                    'error': `Cannot call a container Spec-ID "${toolName}". Specify a tool Spec-ID: <namespace>/tool/<name>`,
                    'fix': `Use format: ${namespace}/tool/<route-name>`
                } )

                return { result }
            }

            if( type !== 'tool' ) {
                const result = FlowMcpCli.#error( {
                    'error': `Spec-ID type "${type}" cannot be called directly.`,
                    'fix': `Only tool Spec-IDs are callable: <namespace>/tool/<name>`
                } )

                return { result }
            }

            sourceFilter = source
            const { toolName: mcpToolName } = FlowMcpCli.#buildToolName( { 'routeName': specName, 'namespace': namespace } )
            resolvedToolName = mcpToolName
        }

        // Memo 099 Kap 5 — no activation: resolve against ALL configured schemaFolders.
        const { schemas: allSchemas, error: resolveError, fix: resolveFix } = await FlowMcpCli.#resolveAllSchemas()

        // PRD-008 — a duplicate schemaFolders[] name is a hard config error.
        if( resolveError !== null && resolveError !== undefined ) {
            const result = FlowMcpCli.#error( { 'error': resolveError, 'fix': resolveFix } )

            return { result }
        }

        // PRD-008 — when a "<source>:" prefix is given, restrict resolution to that
        // source so the qualified call hits exactly that folder (no first-wins).
        const resolvedSchemas = sourceFilter === null || sourceFilter === undefined
            ? allSchemas
            : allSchemas.filter( ( entry ) => entry[ 'source' ] === sourceFilter )

        if( ( sourceFilter !== null && sourceFilter !== undefined ) && resolvedSchemas.length === 0 ) {
            const result = FlowMcpCli.#error( {
                'error': `No schemaFolders[] source named "${sourceFilter}" provides the requested tool.`,
                'fix': `Check the source name (run "${appConfig[ 'cliCommand' ]} call list-tools" to see each tool's "source"), or drop the "<source>:" prefix.`
            } )

            return { result }
        }

        const { config } = await FlowMcpCli.#readConfig( { cwd } )
        const { envPath } = config
        const { data: envContent } = await FlowMcpCli.#readText( { filePath: envPath } )
        const envObject = envContent
            ? FlowMcpCli.#parseEnvFile( { envContent } ).envObject
            : {}

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
                const routes = main[ 'routes' ] || main[ 'tools' ] || {}

                Object.keys( routes )
                    .forEach( ( routeName ) => {
                        if( matchedMain ) {
                            return
                        }

                        try {
                            const { toolName: candidateName } = FlowMcpCli.#buildToolName( { routeName, namespace } )

                            if( candidateName === resolvedToolName ) {
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
            const resourceResult = await FlowMcpCli.#callResourceQuery( { toolName, jsonArgs, resolvedSchemas } )

            if( resourceResult ) {
                return resourceResult
            }

            const result = FlowMcpCli.#error( {
                'error': `Tool "${toolName}" not found.`,
                'fix': `Run ${appConfig[ 'cliCommand' ]} search <query> or ${appConfig[ 'cliCommand' ]} list to see available tool names.`
            } )

            return { result }
        }

        // Memo 099 Kap 6 — graceful degradation: a tool whose required keys are
        // missing is disabled, never a global abort. The other tools stay usable.
        const matchedRequiredKeys = matchedMain[ 'requiredServerParams' ] || []
        const matchedMissingKeys = matchedRequiredKeys
            .filter( ( key ) => {
                const present = envObject[ key ] !== undefined && String( envObject[ key ] ).length > 0

                return present === false
            } )

        if( matchedMissingKeys.length > 0 ) {
            const { tools: availableTools } = await FlowMcpCli.#listAvailableTools()
            const otherCount = availableTools.length > 0 ? availableTools.length - 1 : 0
            const result = FlowMcpCli.#error( {
                'error': `Tool "${toolName}" is not available — missing key(s): ${matchedMissingKeys.join( ', ' )}.`,
                'fix': `Add the key(s) to ${envPath}. ${otherCount} other tool(s) remain callable.`
            } )

            return { result }
        }

        const matchedRouteConfig = ( matchedMain[ 'routes' ] || matchedMain[ 'tools' ] )[ matchedRouteName ]
        const matchedRouteParameters = matchedRouteConfig[ 'parameters' ] || []
        const { filePath: matchedSchemaFilePath } = matchedFile
            ? await FlowMcpCli.#resolveSchemaPath( { schemaRef: matchedFile } )
            : { filePath: null }
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

        // Memo 099 Kap 6 — read env so search can flag key-gated (disabled) tools
        const { config: searchConfig } = await FlowMcpCli.#readConfig( { cwd: process.cwd() } )
        const searchEnvPath = searchConfig ? searchConfig[ 'envPath' ] : null
        const { data: searchEnvContent } = searchEnvPath
            ? await FlowMcpCli.#readText( { filePath: searchEnvPath } )
            : { data: null }
        const searchEnvObject = searchEnvContent
            ? FlowMcpCli.#parseEnvFile( { envContent: searchEnvContent } ).envObject
            : {}

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
                const { toolName, description, namespace, tags, schemaRef, routeName } = tool
                const entry = {
                    'name': toolName,
                    description,
                    namespace,
                    tags,
                    score,
                    'type': tool[ 'type' ] || 'tool',
                    'call': `${appConfig[ 'cliCommand' ]} call ${toolName}`,
                    schemaRef,
                    routeName
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
        const isDetailView = matchCount === 1

        const enrichedTools = await limitedTools
            .reduce( ( promise, tool ) => promise.then( async ( acc ) => {
                const { schemaRef, routeName, name: toolName } = tool
                const { filePath } = await FlowMcpCli.#resolveSchemaPath( { schemaRef } )

                try {
                    const { main } = await FlowMcpCli.#loadSchema( { filePath } )

                    if( main ) {
                        // Memo 099 Kap 6 — flag tools whose required keys are missing
                        const requiredKeys = main[ 'requiredServerParams' ] || []
                        const missingKeys = requiredKeys
                            .filter( ( key ) => {
                                const present = searchEnvObject[ key ] !== undefined && String( searchEnvObject[ key ] ).length > 0

                                return present === false
                            } )
                        if( missingKeys.length > 0 ) {
                            tool[ 'disabled' ] = true
                            tool[ 'disabledReason' ] = `missing ${missingKeys.join( ', ' )}`
                        }

                        const { meta } = FlowMcpCli.#extractMetaFlags( { main, routeName } )
                        const { requiredParams, optionalParams } = FlowMcpCli.#extractParameterDetails( { main, routeName } )
                        const { example } = FlowMcpCli.#generateCallExample( { toolName, requiredParams } )

                        tool[ 'meta' ] = meta
                        tool[ 'requiredParams' ] = requiredParams
                            .map( ( { key, type, isEnum, enumExamples, listRef } ) => {
                                const entry = { key, type }
                                if( isEnum && enumExamples.length > 0 ) {
                                    entry[ 'examples' ] = enumExamples
                                }
                                if( isEnum && listRef ) {
                                    entry[ 'list' ] = listRef
                                }

                                return entry
                            } )
                        tool[ 'example' ] = example

                        if( isDetailView ) {
                            tool[ 'optionalParams' ] = optionalParams
                                .map( ( { key, type, isEnum, enumExamples, listRef } ) => {
                                    const entry = { key, type }
                                    if( isEnum && listRef ) {
                                        entry[ 'list' ] = listRef
                                    }
                                    if( isEnum && enumExamples.length > 0 ) {
                                        entry[ 'examples' ] = enumExamples
                                    }

                                    return entry
                                } )
                        }
                    }
                } catch {
                    // Schema could not be loaded — return without enrichment
                }

                const toolType = tool[ 'type' ] || 'tool'
                if( tool[ 'namespace' ] && tool[ 'routeName' ] ) {
                    tool[ 'specId' ] = `${tool[ 'namespace' ]}/${toolType}/${tool[ 'routeName' ]}`
                }

                delete tool[ 'schemaRef' ]
                delete tool[ 'routeName' ]
                acc.push( tool )

                return acc
            } ), Promise.resolve( [] ) )

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
            'tools': enrichedTools
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

        // Memo 051 PRD-18 — when add target is a local schema file (.mjs)
        // containing a `sqlite-gtfs` resource, use the addon pipeline.
        const sqliteGtfsRoute = await FlowMcpCli.#maybeAddSqliteGtfsSchema( { toolName, cwd, force } )
        if( sqliteGtfsRoute ) {
            return sqliteGtfsRoute
        }

        if( FlowMcpCli.#isSpecId( { 'ref': toolName } ) ) {
            const { valid, namespace, type, name: specName, error: parseError } = FlowMcpCli.#parseSpecId( { 'specId': toolName } )

            if( !valid ) {
                const result = FlowMcpCli.#error( {
                    'error': `Invalid Spec-ID: ${parseError}`,
                    'fix': `Use format: <namespace>/tool/<name> or <namespace>/<schema-name>`
                } )

                return { result }
            }

            const { index } = await FlowMcpCli.getNamespaceIndex( { cwd } )

            let refsToAdd = []

            if( type === 'tool' ) {
                const specId = `${namespace}/tool/${specName}`
                if( !index[ 'tools' ][ specId ] ) {
                    const result = FlowMcpCli.#error( {
                        'error': `Spec-ID "${toolName}" not found in namespace index.`,
                        'fix': `Run ${appConfig[ 'cliCommand' ]} search <query> to find available tools.`
                    } )

                    return { result }
                }

                refsToAdd = [ specId ]
            } else if( type === 'schema' ) {
                const containerKey = `${namespace}/${specName}`
                const container = index[ 'containers' ][ containerKey ]

                if( !container ) {
                    const result = FlowMcpCli.#error( {
                        'error': `Container Spec-ID "${toolName}" not found in namespace index.`,
                        'fix': `Run ${appConfig[ 'cliCommand' ]} search <query> to find available schemas.`
                    } )

                    return { result }
                }

                const toolEntries = Object.entries( index[ 'tools' ] )
                const containerSource = toolEntries
                    .find( ( [ , entry ] ) => {
                        const matchesFile = container[ 'files' ]
                            .find( ( f ) => {
                                const isSame = f === entry[ 'file' ]

                                return isSame
                            } )

                        return !!matchesFile
                    } )

                const source = containerSource ? containerSource[ 1 ][ 'source' ] : null

                await container[ 'files' ]
                    .reduce( ( fp, file ) => fp.then( async () => {
                        const schemaRef = source ? `${source}/${file}` : file
                        const { filePath } = await FlowMcpCli.#resolveSchemaPath( { schemaRef } )
                        const { main } = await FlowMcpCli.#loadSchema( { filePath } )

                        if( main ) {
                            const routeMap = main[ 'routes' ] || main[ 'tools' ] || {}
                            const ns = main[ 'namespace' ] || namespace

                            Object.keys( routeMap )
                                .forEach( ( routeName ) => {
                                    const primitiveId = `${ns}/tool/${routeName}`
                                    refsToAdd.push( primitiveId )
                                } )
                        }
                    } ), Promise.resolve() )

                if( refsToAdd.length === 0 ) {
                    const result = FlowMcpCli.#error( {
                        'error': `Container "${toolName}" expanded to zero tools.`,
                        'fix': `Verify the schema files exist and have routes defined.`
                    } )

                    return { result }
                }
            } else {
                const sliceKey = type === 'resource' ? 'resources'
                    : type === 'prompt' ? 'prompts'
                    : type === 'skill' ? 'skills'
                    : null

                if( !sliceKey || !index[ sliceKey ] ) {
                    const result = FlowMcpCli.#error( {
                        'error': `Spec-ID type "${type}" is not supported by the add command.`,
                        'fix': `Only tool and schema Spec-IDs are supported.`
                    } )

                    return { result }
                }

                const specId = `${namespace}/${type}/${specName}`
                if( !index[ sliceKey ][ specId ] ) {
                    const result = FlowMcpCli.#error( {
                        'error': `Spec-ID "${toolName}" not found in namespace index.`,
                        'fix': `Run ${appConfig[ 'cliCommand' ]} search <query> to find available tools.`
                    } )

                    return { result }
                }

                refsToAdd = [ specId ]
            }

            const namespacesToCheck = Array.from( new Set( refsToAdd
                .map( ( ref ) => {
                    const ns = ref.split( '/' )[ 0 ]

                    return ns
                } ) ) )

            // Resolve the schema files corresponding to refsToAdd so the guard
            // checks only those exact schemas (not the whole namespace).
            // refSchemaMap keeps the ref -> schemaRef relation so a degraded
            // (key-gated) schema can be removed from refsToAdd after the guard
            // partitions keyless vs key-gated (Memo 092 PRD-L, keyless-first).
            const schemaFilesForGuard = []
            const refSchemaMap = {}
            refsToAdd
                .forEach( ( ref ) => {
                    const toolEntry = index[ 'tools' ] && index[ 'tools' ][ ref ]
                    if( !toolEntry ) {
                        return
                    }

                    const { source, file } = toolEntry
                    const schemaRef = `${source}/${file}`
                    refSchemaMap[ ref ] = schemaRef
                    const alreadyTracked = schemaFilesForGuard
                        .find( ( r ) => {
                            const isSame = r === schemaRef

                            return isSame
                        } )

                    if( !alreadyTracked ) {
                        schemaFilesForGuard.push( schemaRef )
                    }
                } )

            const { allowed: guardAllowed, activatableRefs: guardActivatable, result: guardResult } = await FlowMcpCli.#activationGuard( {
                'namespaces': namespacesToCheck,
                'schemaFiles': schemaFilesForGuard,
                cwd,
                force,
                toolName
            } )

            if( !guardAllowed ) {
                return { 'result': guardResult }
            }

            // keyless-first: only keep refs whose schema is activatable. Refs
            // without a known schemaRef (no tool entry) are kept unchanged so
            // existing behavior for non-guarded refs is preserved.
            const activatableSet = new Set( guardActivatable || [] )
            refsToAdd = refsToAdd
                .filter( ( ref ) => {
                    const schemaRef = refSchemaMap[ ref ]
                    if( schemaRef === undefined ) {
                        return true
                    }

                    const isActivatable = activatableSet.has( schemaRef )

                    return isActivatable
                } )

            if( refsToAdd.length === 0 ) {
                const result = FlowMcpCli.#error( {
                    'error': `Cannot activate "${toolName}" — no keyless provider available; all require keys.`,
                    'fix': `Set a key or use --force.`
                } )

                return { result }
            }

            const localConfigDir = join( cwd, appConfig[ 'localConfigDirName' ] )
            const localConfigPath = join( localConfigDir, 'config.json' )
            const { data: localConfig } = await FlowMcpCli.#readJson( { filePath: localConfigPath } )

            let updatedConfig
            if( !localConfig ) {
                await mkdir( localConfigDir, { recursive: true } )
                updatedConfig = {
                    'root': `~/${appConfig[ 'globalConfigDirName' ]}`,
                    'tools': [ ...refsToAdd ]
                }
            } else {
                updatedConfig = localConfig

                if( !updatedConfig[ 'tools' ] ) {
                    updatedConfig[ 'tools' ] = []
                }

                refsToAdd
                    .forEach( ( ref ) => {
                        const alreadyExists = updatedConfig[ 'tools' ]
                            .find( ( r ) => {
                                const isDuplicate = r === ref

                                return isDuplicate
                            } )

                        if( !alreadyExists ) {
                            updatedConfig[ 'tools' ].push( ref )
                        }
                    } )
            }

            await FlowMcpCli.#writeGuarded( { 'path': localConfigPath, 'content': JSON.stringify( updatedConfig, null, 4 ), 'onExists': 'overwrite' } )

            const result = {
                'status': true,
                'added': refsToAdd.length === 1 ? refsToAdd[ 0 ] : refsToAdd,
                'specId': toolName,
                'parameters': {}
            }

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

        const { filePath: schemaFilePath } = await FlowMcpCli.#resolveSchemaPath( { schemaRef } )
        const { main } = await FlowMcpCli.#loadSchema( { filePath: schemaFilePath, 'bustCache': force } )

        let extractedParameters = {}
        const extractRouteMap = main ? ( main[ 'routes' ] || main[ 'tools' ] ) : null
        if( extractRouteMap && extractRouteMap[ routeName ] ) {
            const routeConfig = extractRouteMap[ routeName ]
            const routeParameters = routeConfig[ 'parameters' ] || []
            const { sharedLists: resolvedLists } = await FlowMcpCli.#resolveSharedListsForSchema( { main, 'filePath': schemaFilePath } )
            const { parameters: transformed } = FlowMcpCli.#extractParameters( { routeParameters, 'sharedLists': resolvedLists } )
            extractedParameters = transformed
        }

        const namespaceForGuard = main && main[ 'namespace' ] ? main[ 'namespace' ] : null
        if( namespaceForGuard ) {
            const { allowed: guardAllowed, result: guardResult } = await FlowMcpCli.#activationGuard( {
                'namespaces': [ namespaceForGuard ],
                'schemaFiles': [ schemaRef ],
                cwd,
                force,
                toolName
            } )

            if( !guardAllowed ) {
                return { 'result': guardResult }
            }
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

        await FlowMcpCli.#writeGuarded( { 'path': localConfigPath, 'content': JSON.stringify( updatedConfig, null, 4 ), 'onExists': 'overwrite' } )
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

        await FlowMcpCli.#writeGuarded( { 'path': localConfigPath, 'content': JSON.stringify( localConfig, null, 4 ), 'onExists': 'overwrite' } )
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

        // Memo 099 Kap 5/6 — list ALL tools from the configured schemaFolders.
        // A tool whose required keys are missing from .env is flagged disabled
        // (visible, never hidden) so the user sees exactly what is unavailable.
        const { config } = await FlowMcpCli.#readConfig( { cwd } )
        const { envPath } = config
        const { data: envContent } = await FlowMcpCli.#readText( { filePath: envPath } )
        const envObject = envContent
            ? FlowMcpCli.#parseEnvFile( { envContent } ).envObject
            : {}

        const { schemas, error: resolveError, fix: resolveFix } = await FlowMcpCli.#resolveAllSchemas()

        // PRD-008 — a duplicate schemaFolders[] name is a hard config error.
        if( resolveError !== null && resolveError !== undefined ) {
            const result = FlowMcpCli.#error( { 'error': resolveError, 'fix': resolveFix } )

            return { result }
        }

        const tools = []
        let disabledCount = 0

        const sharedListsMap = {}
        await schemas
            .reduce( ( promise, { main, file } ) => promise.then( async () => {
                if( main && main[ 'sharedLists' ] && main[ 'sharedLists' ].length > 0 && file ) {
                    const { filePath } = await FlowMcpCli.#resolveSchemaPath( { schemaRef: file } )
                    const { sharedLists: resolved } = await FlowMcpCli.#resolveSharedListsForSchema( { main, filePath } )
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
                            const { toolName: name } = FlowMcpCli.#buildToolName( { routeName, namespace } )
                            const description = routes[ routeName ][ 'description' ] || ''

                            const routeConfig = routes[ routeName ]
                            const routeParameters = routeConfig[ 'parameters' ] || []
                            const { parameters } = FlowMcpCli.#extractParameters( { routeParameters, sharedLists } )

                            const entry = { name, description, 'tags': schemaTags, parameters }
                            if( disabled === true ) {
                                entry[ 'disabled' ] = true
                                entry[ 'disabledReason' ] = `missing ${missingKeys.join( ', ' )}`
                                disabledCount += 1
                            }

                            tools.push( entry )
                        } catch {
                            // skip broken tools
                        }
                    } )
            } )

        // Memo 051 PRD-19 — include auto-injected tools from cached sqlite-gtfs schemas
        const { entries: sealCacheEntries } = await FlowMcpCli.#listSqliteGtfsCacheEntries()
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
        const { index } = await FlowMcpCli.getNamespaceIndex( { cwd } )
        const { warnings: collisionWarnings } = FlowMcpCli.#formatCollisionWarnings( { 'collisions': index ? index[ 'collisions' ] : [] } )

        const result = {
            'status': true,
            'toolCount': tools.length,
            disabledCount,
            tools,
            collisionWarnings
        }

        return { result }
    }


    static async listSharedLists( { listName } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { sources } = await FlowMcpCli.#listSources()

        if( sources.length === 0 ) {
            const result = FlowMcpCli.#error( {
                'error': 'No schema sources found.',
                'fix': `Run: ${appConfig[ 'cliCommand' ]} import <url>`
            } )

            return { result }
        }

        const schemasBaseDir = FlowMcpCli.#schemasDir()
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
                } catch {
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
                        } catch {
                            // skip broken list files
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
            const result = FlowMcpCli.#error( {
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
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const normalizedName = listName && !listName.endsWith( '.mjs' ) ? `${listName}.mjs` : listName

        if( !normalizedName ) {
            const result = FlowMcpCli.#error( {
                'error': 'Missing listName.',
                'fix': 'Provide a list name, e.g. evm-chains or evm-chains.mjs'
            } )

            return { result }
        }

        let parsedEntry
        try {
            parsedEntry = JSON.parse( jsonEntry )
        } catch {
            const result = FlowMcpCli.#error( {
                'error': `Invalid JSON entry: "${jsonEntry}"`,
                'fix': 'Provide a valid JSON object, e.g. \'{"alias":"FOO","chainId":99}\''
            } )

            return { result }
        }

        if( typeof parsedEntry !== 'object' || parsedEntry === null || Array.isArray( parsedEntry ) ) {
            const result = FlowMcpCli.#error( {
                'error': 'Entry must be a JSON object (not an array or primitive).',
                'fix': 'Provide a plain JSON object, e.g. \'{"alias":"FOO","chainId":99}\''
            } )

            return { result }
        }

        const { sources } = await FlowMcpCli.#listSources()
        const schemasBaseDir = FlowMcpCli.#schemasDir()

        let listFilePath = null

        await sources
            .reduce( ( promise, source ) => promise.then( async () => {
                if( listFilePath ) { return }

                const { name: sourceName } = source
                const candidate = join( schemasBaseDir, sourceName, '_lists', normalizedName )

                try {
                    await access( candidate, constants.F_OK )
                    listFilePath = candidate
                } catch {
                    // not in this source
                }
            } ), Promise.resolve() )

        if( !listFilePath ) {
            const result = FlowMcpCli.#error( {
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
            const result = FlowMcpCli.#error( {
                'error': `Failed to import list file "${normalizedName}".`,
                'fix': 'Check the list file for syntax errors.'
            } )

            return { result }
        }

        if( !listObj ) {
            const result = FlowMcpCli.#error( {
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
                const result = FlowMcpCli.#error( {
                    'error': `Entry is missing required fields: ${missingRequired.join( ', ')}`,
                    'fix': `Required fields: ${requiredFields.join( ', ' )}`
                } )

                return { result }
            }

            if( unknownKeys.length > 0 ) {
                const result = FlowMcpCli.#error( {
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
                const result = FlowMcpCli.#error( {
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

        await FlowMcpCli.#writeGuarded( { 'path': listFilePath, 'content': newContent, 'onExists': 'overwrite' } )

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
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        if( !alias ) {
            const result = FlowMcpCli.#error( {
                'error': 'Missing alias.',
                'fix': 'Provide an alias to look up, e.g. ETHEREUM_MAINNET'
            } )

            return { result }
        }

        const { sources } = await FlowMcpCli.#listSources()
        const schemasBaseDir = FlowMcpCli.#schemasDir()
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
                        } catch {
                            return
                        }

                        if( !fileContent.includes( alias ) ) {
                            return
                        }

                        let schemaMain
                        try {
                            const mod = await import( pathToFileURL( filePath ).href )
                            schemaMain = mod[ 'main' ] || null
                        } catch {
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


    static async generateCatalog( { cwd } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { tools: allTools } = await FlowMcpCli.#listAvailableTools()
        const schemasBaseDir = FlowMcpCli.#schemasDir()

        const tagsByNamespace = {}

        await allTools
            .reduce( ( promise, tool ) => promise.then( async () => {
                const { schemaRef, namespace } = tool

                if( tagsByNamespace[ namespace ] ) { return }

                const filePath = join( schemasBaseDir, schemaRef )

                try {
                    const { main } = await FlowMcpCli.#loadSchema( { filePath } )

                    if( main && main[ 'tags' ] ) {
                        tagsByNamespace[ namespace ] = main[ 'tags' ]
                    } else {
                        tagsByNamespace[ namespace ] = []
                    }
                } catch {
                    tagsByNamespace[ namespace ] = []
                }
            } ), Promise.resolve() )

        const categoryStats = catalogCategories
            .map( ( category ) => {
                const { name, match } = category
                const matchingTools = allTools
                    .filter( ( tool ) => {
                        const ns = tool[ 'namespace' ].toLowerCase()
                        const matched = match
                            .some( ( m ) => ns.startsWith( m ) )

                        return matched
                    } )

                const tagCounts = {}
                matchingTools
                    .forEach( ( tool ) => {
                        const nsTags = tagsByNamespace[ tool[ 'namespace' ] ] || []
                        nsTags
                            .filter( ( t ) => !t.startsWith( 'cacheTtl' ) )
                            .forEach( ( tag ) => {
                                tagCounts[ tag ] = ( tagCounts[ tag ] || 0 ) + 1
                            } )
                    } )

                const topTags = Object.entries( tagCounts )
                    .sort( ( a, b ) => b[ 1 ] - a[ 1 ] )
                    .slice( 0, 7 )
                    .map( ( [ tag ] ) => tag )

                const namespaceCounts = {}
                matchingTools
                    .forEach( ( tool ) => {
                        const ns = tool[ 'namespace' ]
                        namespaceCounts[ ns ] = ( namespaceCounts[ ns ] || 0 ) + 1
                    } )

                const topProviders = Object.entries( namespaceCounts )
                    .sort( ( a, b ) => b[ 1 ] - a[ 1 ] )
                    .slice( 0, 3 )
                    .map( ( [ ns ] ) => `${ns}-*` )

                return {
                    name,
                    'toolCount': matchingTools.length,
                    topTags,
                    topProviders
                }
            } )
            .filter( ( c ) => c[ 'toolCount' ] > 0 )

        const uncategorizedTools = allTools
            .filter( ( tool ) => {
                const ns = tool[ 'namespace' ].toLowerCase()
                const isInCategory = catalogCategories
                    .some( ( cat ) => {
                        const matched = cat[ 'match' ]
                            .some( ( m ) => ns.startsWith( m ) )

                        return matched
                    } )

                return !isInCategory
            } )

        if( uncategorizedTools.length > 0 ) {
            const uncategorizedNamespaces = {}
            uncategorizedTools
                .forEach( ( tool ) => {
                    uncategorizedNamespaces[ tool[ 'namespace' ] ] = true
                } )

            categoryStats.push( {
                'name': 'Other',
                'toolCount': uncategorizedTools.length,
                'topTags': [],
                'topProviders': Object.keys( uncategorizedNamespaces ).slice( 0, 3 )
                    .map( ( ns ) => `${ns}-*` )
            } )
        }

        const totalTools = allTools.length
        const categoryCount = categoryStats.length

        const rows = categoryStats
            .map( ( cat ) => {
                const tags = cat[ 'topTags' ].join( ', ' ) || '—'
                const providers = cat[ 'topProviders' ].join( ', ' ) || '—'

                return `| ${cat[ 'name' ]} | ${cat[ 'toolCount' ]} | ${tags} | ${providers} |`
            } )
            .join( '\n' )

        const markdown = [
            `# FlowMCP Meta-Katalog (${totalTools} Tools, ${categoryCount} Kategorien)`,
            `# Suche: flowmcp search <query>`,
            '',
            '| Kategorie | Tools | Top-Tags | Top-Providers |',
            '|-----------|:-----:|----------|---------------|',
            rows,
            ''
        ].join( '\n' )

        const outputDir = join( cwd, '.claude', 'rules' )
        const outputPath = join( outputDir, 'flowmcp-catalog.md' )

        await mkdir( outputDir, { 'recursive': true } )
        await FlowMcpCli.#writeGuarded( { 'path': outputPath, 'content': markdown, 'onExists': 'overwrite' } )

        const tokenEstimate = Math.ceil( markdown.length / 4 )

        const result = {
            'status': true,
            'path': outputPath,
            'categories': categoryCount,
            totalTools,
            tokenEstimate,
            'content': markdown
        }

        return { result }
    }


    static async generateSkill( { toolId } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        if( !toolId || typeof toolId !== 'string' || toolId.trim().length === 0 ) {
            const result = FlowMcpCli.#error( {
                'error': 'Missing tool ID.',
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} skill generate <tool-name>`
            } )

            return { result }
        }

        const { tools: allTools } = await FlowMcpCli.#listAvailableTools()
        const matchedTool = allTools
            .find( ( t ) => t[ 'toolName' ] === toolId )

        if( !matchedTool ) {
            const result = FlowMcpCli.#error( {
                'error': `Tool "${toolId}" not found.`,
                'fix': `Use: ${appConfig[ 'cliCommand' ]} search <keyword> to find tool names`
            } )

            return { result }
        }

        const schemasBaseDir = FlowMcpCli.#schemasDir()
        const filePath = join( schemasBaseDir, matchedTool[ 'schemaRef' ] )
        const { main } = await FlowMcpCli.#loadSchema( { filePath } )

        if( !main ) {
            const result = FlowMcpCli.#error( {
                'error': `Could not load schema for "${toolId}".`,
                'fix': 'Schema file may be corrupted or missing.'
            } )

            return { result }
        }

        const { routeName } = matchedTool
        const tools = main[ 'tools' ] || main[ 'routes' ] || {}
        const route = tools[ routeName ] || {}

        const { meta } = FlowMcpCli.#extractMetaFlags( { main, routeName } )
        const { requiredParams, optionalParams } = FlowMcpCli.#extractParameterDetails( { main, routeName } )
        const { example } = FlowMcpCli.#generateCallExample( { 'toolName': toolId, requiredParams } )

        const allParams = [ ...requiredParams, ...optionalParams ]
        const paramRows = allParams
            .map( ( param ) => {
                const { key, type, isEnum, enumExamples, listRef } = param
                const isRequired = requiredParams
                    .some( ( rp ) => rp[ 'key' ] === key )
                const required = isRequired ? 'Yes' : 'No'
                const typeDisplay = isEnum && listRef
                    ? `enum (${listRef})`
                    : type

                return `| ${key} | ${typeDisplay} | ${required} | — |`
            } )
            .join( '\n' )

        const enumSections = allParams
            .filter( ( p ) => p[ 'isEnum' ] && ( p[ 'listRef' ] || p[ 'enumExamples' ].length > 0 ) )
            .map( ( p ) => {
                if( p[ 'listRef' ] ) {
                    return `### ${p[ 'key' ]} (${p[ 'listRef' ]})\nExamples: see \`flowmcp lists ${p[ 'listRef' ]}\``
                }

                return `### ${p[ 'key' ]}\nValues: ${p[ 'enumExamples' ].join( ', ' )}`
            } )
            .join( '\n\n' )

        const description = route[ 'description' ] || main[ 'description' ] || ''

        const sections = [
            `# Skill: ${toolId}`,
            '',
            `> ${description}`,
            '',
            '## Meta',
            `- ${meta}`,
            '',
            '## Parameters',
            '',
            '| Parameter | Type | Required | Default |',
            '|-----------|------|----------|---------|',
            paramRows,
            ''
        ]

        if( enumSections.length > 0 ) {
            sections.push( '## Enum Values', '', enumSections, '' )
        }

        sections.push(
            '## Call',
            '',
            '```bash',
            example,
            '```',
            ''
        )

        const content = sections
            .flat()
            .join( '\n' )

        const result = {
            'status': true,
            toolId,
            'content': content
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


    // Memo 099 Kap 3 — resolve ~/anchor-relative schemaFolders paths (no hardcoded usernames)
    static #resolvePath( { path } ) {
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
    static async #readSchemaFolders() {
        const globalConfigPath = FlowMcpCli.#globalConfigPath()
        const { data: globalConfig } = await FlowMcpCli.#readJson( { filePath: globalConfigPath } )
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
                const { resolvedPath } = FlowMcpCli.#resolvePath( { path } )

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
                    'fix': `Edit ${FlowMcpCli.#globalConfigPath()} and give every schemaFolders[] entry a distinct "name".`
                }
            }
        }

        return { schemaFolders, 'duplicateError': null }
    }


    static async #readLocalSources() {
        const globalConfigPath = FlowMcpCli.#globalConfigPath()
        const { data: globalConfig } = await FlowMcpCli.#readJson( { filePath: globalConfigPath } )
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


    static async #resolveSourceDir( { sourceName } ) {
        // Memo 099 Kap 4 — schemaFolders[] win: source dir = <path>/providers (direct, no disk-copy)
        const { schemaFolders } = await FlowMcpCli.#readSchemaFolders()
        const folder = schemaFolders
            .find( ( entry ) => entry[ 'name' ] === sourceName )

        if( folder !== undefined ) {
            const sourceDir = join( folder[ 'path' ], 'providers' )

            return { sourceDir, isLocal: true }
        }

        const { localSources } = await FlowMcpCli.#readLocalSources()
        const local = localSources[ sourceName ]

        if( local !== undefined ) {
            return { sourceDir: local[ 'path' ], isLocal: true }
        }

        const sourceDir = join( FlowMcpCli.#schemasDir(), sourceName )

        return { sourceDir, isLocal: false }
    }


    static async #resolveSchemaPath( { schemaRef } ) {
        if( typeof schemaRef !== 'string' || schemaRef.length === 0 ) {
            return { filePath: join( FlowMcpCli.#schemasDir(), String( schemaRef ) ), isLocal: false }
        }

        const slashIndex = schemaRef.indexOf( '/' )
        if( slashIndex === -1 ) {
            return { filePath: join( FlowMcpCli.#schemasDir(), schemaRef ), isLocal: false }
        }

        const sourceName = schemaRef.slice( 0, slashIndex )
        const rest = schemaRef.slice( slashIndex + 1 )
        const { sourceDir, isLocal } = await FlowMcpCli.#resolveSourceDir( { sourceName } )
        const filePath = join( sourceDir, rest )

        return { filePath, isLocal }
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

        // Cache refresh is a deliberate, named overwrite (Memo 068 R2 verschärft) — never silent.
        await FlowMcpCli.#writeGuarded( { 'path': cachePath, 'content': JSON.stringify( cacheEntry, null, 2 ), 'onExists': 'overwrite' } )

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


    // ---------------------------------------------------------------------
    // Memo 051 — sqlite-gtfs add-pipeline helpers (PRD-18, PRD-19, PRD-20,
    // PRD-21, PRD-22). All entry points route through `#maybeAddSqliteGtfsSchema`
    // which is invoked at the top of `add()`.
    // ---------------------------------------------------------------------

    static #sqliteGtfsCacheDir( { sourceKey } ) {
        const dir = join( FlowMcpCli.#cacheDir(), sourceKey )

        return dir
    }


    static #sqliteGtfsCachePath( { schemaNamespace, schemaName, sourceKey } ) {
        const fileName = `${schemaNamespace}-${schemaName}.json`
        const filePath = join( FlowMcpCli.#sqliteGtfsCacheDir( { sourceKey } ), fileName )

        return { filePath }
    }


    static async #writeSealCache( { schemaNamespace, schemaName, schemaFile, dbPath, sourceKey, addonName, namespace, meta, tools, overridden, mode = 'file-based', url = null, parseConfig = null } ) {
        const { filePath } = FlowMcpCli.#sqliteGtfsCachePath( { schemaNamespace, schemaName, sourceKey } )
        await mkdir( dirname( filePath ), { recursive: true } )

        let dbMtime = null
        if( dbPath ) {
            try {
                const st = await stat( dbPath )
                dbMtime = st.mtime.toISOString()
            } catch {
                dbMtime = null
            }
        }

        const entry = {
            'schemaName': schemaName,
            'schemaNamespace': schemaNamespace,
            'schemaFile': schemaFile,
            'sourceKey': sourceKey,
            'addonName': addonName,
            'namespace': namespace,
            'mode': mode,
            'dbPath': dbPath,
            'url': url,
            'parseConfig': parseConfig,
            'sealedAt': new Date().toISOString(),
            'dbMtime': dbMtime,
            'meta': meta,
            'tools': tools,
            'overridden': overridden || []
        }

        // Seal cache refresh is a deliberate, named overwrite (Memo 068 R2) — never silent.
        await FlowMcpCli.#writeGuarded( { 'path': filePath, 'content': JSON.stringify( entry, null, 2 ), 'onExists': 'overwrite' } )

        return { filePath, entry }
    }


    static async #readSealCache( { schemaNamespace, schemaName, sourceKey } ) {
        const { filePath } = FlowMcpCli.#sqliteGtfsCachePath( { schemaNamespace, schemaName, sourceKey } )

        try {
            const raw = await readFile( filePath, 'utf-8' )
            const entry = JSON.parse( raw )
            const { isStale } = await FlowMcpCli.#checkSealCacheStale( { entry, 'dbPath': entry[ 'dbPath' ] } )

            return { entry, isStale }
        } catch {
            return { 'entry': null, 'isStale': true }
        }
    }


    static async #checkSealCacheStale( { entry, dbPath } ) {
        // URL-mode entries (Memo 096) have no local file — file-mtime staleness
        // does not apply. Freshness is governed by the add-on's in-memory TTL.
        if( entry && entry[ 'mode' ] === 'url' ) { return { 'isStale': false } }
        if( !entry || !entry[ 'dbMtime' ] ) { return { 'isStale': true } }

        try {
            const st = await stat( dbPath )
            const currentMtime = st.mtime.toISOString()
            const isStale = currentMtime !== entry[ 'dbMtime' ]

            return { isStale }
        } catch {
            return { 'isStale': true }
        }
    }


    static async #listSqliteGtfsCacheEntries() {
        const entries = []
        const sourceKeys = Object.keys( ADDON_REGISTRY )

        await sourceKeys
            .reduce( ( outer, sourceKey ) => outer.then( async () => {
                const dir = FlowMcpCli.#sqliteGtfsCacheDir( { sourceKey } )

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
                            } catch {
                                // corrupt — skip
                            }
                        } ), Promise.resolve() )
                } catch {
                    // cache dir for this source doesn't exist yet
                }
            } ), Promise.resolve() )

        return { entries }
    }


    static async #maybeAddSqliteGtfsSchema( { toolName, cwd, force } ) {
        const looksLikeFile = toolName.endsWith( '.mjs' ) || toolName.endsWith( '.js' )
        if( !looksLikeFile ) { return null }

        const resolvedSchemaPath = resolve( toolName )

        let schemaExists = false
        try {
            await access( resolvedSchemaPath, constants.F_OK )
            schemaExists = true
        } catch {
            schemaExists = false
        }

        if( !schemaExists ) { return null }

        const { main, error: loadError } = await FlowMcpCli.#loadSchema( { 'filePath': resolvedSchemaPath, 'bustCache': force } )
        if( !main ) {
            const result = FlowMcpCli.#error( {
                'error': `Cannot load schema file: ${loadError || 'unknown error'}`,
                'fix': `Verify the schema file exports 'main' or 'schema': ${resolvedSchemaPath}`
            } )

            return { result }
        }

        const resourcesRaw = main[ 'resources' ]
        if( !resourcesRaw ) { return null }

        const resourcesArr = Array.isArray( resourcesRaw )
            ? resourcesRaw
            : Object.values( resourcesRaw )

        const sqliteGtfsResources = resourcesArr
            .filter( ( r ) => {
                const isMatch = r && ADDON_REGISTRY[ r.source ] !== undefined

                return isMatch
            } )

        if( sqliteGtfsResources.length === 0 ) { return null }

        const pipeline = await FlowMcpCli.#executeSqliteGtfsAddPipeline( {
            'main': main,
            'sqliteGtfsResources': sqliteGtfsResources,
            'schemaFile': resolvedSchemaPath,
            cwd,
            force
        } )

        return pipeline
    }


    static async #executeSqliteGtfsAddPipeline( { main, sqliteGtfsResources, schemaFile, cwd, force } ) {
        const namespace = main[ 'namespace' ] || 'unknown'
        const schemaName = main[ 'name' ] || namespace

        console.log( `Loading schema ${schemaName} ...` )

        // PRD-17 structural validation
        const structuralErrors = FlowMcpCli.#runSqliteGtfsResourceChecks( { main } )
        if( structuralErrors.length > 0 ) {
            const messages = structuralErrors.map( ( e ) => `${e.code}: ${e.message} (${e.path})` )
            const result = FlowMcpCli.#error( {
                'error': `Schema validation failed: ${messages.join( '; ' )}`,
                'fix': `Fix the resource definition in ${schemaFile} (see Memo 051 / Spec v4.1.0 RES030..RES035).`
            } )

            return { result }
        }

        console.log( 'Validating spec compliance ... OK (v4.1.0)' )

        const resource = sqliteGtfsResources[ 0 ]
        const sourceKey = resource.source
        const isUrlMode = resource.mode === 'url'

        // Memo 096 — URL mode: no path, no seal. Fetch + parse + in-memory.
        let resolvedPath = null
        if( !isUrlMode ) {
            // PRD-14 path resolution
            let resolved
            try {
                resolved = PathVariableResolver.resolvePathVariables( { 'path': resource.path } )
            } catch( err ) {
                const result = FlowMcpCli.#error( {
                    'error': `RES035: ${err.message}`,
                    'fix': `Set FLOWMCP_RESOURCES or use a literal path in ${schemaFile}`
                } )

                return { result }
            }

            resolvedPath = resolved.resolvedPath
            console.log( `Resolving path: ${resource.path} → ${resolvedPath}` )

            // RES033 — DB existence + readable
            let dbExists = false
            try {
                await access( resolvedPath, constants.R_OK )
                dbExists = true
            } catch {
                dbExists = false
            }

            if( !dbExists ) {
                const result = FlowMcpCli.#error( {
                    'error': `RES033: DB at ${resolvedPath} cannot be opened (file not found or corrupt).`,
                    'fix': `Place the converted SQLite DB at ${resolvedPath} (see ${ADDON_REGISTRY[ sourceKey ] ? ADDON_REGISTRY[ sourceKey ].name : sourceKey} docs).`
                } )

                return { result }
            }
        }

        // PRD-15 + PRD-16 load addon
        console.log( 'Loading resource ...' )

        let addonLoaded
        try {
            addonLoaded = await AddonLoader.loadAddon( { sourceKey } )
        } catch( err ) {
            const result = FlowMcpCli.#error( {
                'error': `Failed to load addon for source '${sourceKey}': ${err.message}`,
                'fix': `Ensure '${ADDON_REGISTRY[ sourceKey ] ? ADDON_REGISTRY[ sourceKey ].name : sourceKey}' is installed as a package.json dependency.`
            } )

            return { result }
        }

        const { addonName, addonModule } = addonLoaded
        const FlowMcpAdapter = addonModule.FlowMcpAdapter
        if( !FlowMcpAdapter ) {
            const result = FlowMcpCli.#error( {
                'error': `Addon ${addonName} does not export FlowMcpAdapter.`,
                'fix': `Update ${addonName} to expose the FlowMcpAdapter consumer API.`
            } )

            return { result }
        }

        let meta = null
        let capabilities = {}
        const cacheKeyValue = isUrlMode ? resource.url : resolvedPath

        if( isUrlMode ) {
            // RES044 — url must be present + HTTPS (defence in depth; structural check already ran)
            const urlValid = typeof resource.url === 'string' && resource.url.startsWith( 'https://' )
            if( !urlValid ) {
                const result = FlowMcpCli.#error( {
                    'error': `RES044: resource.mode 'url' requires an HTTPS url (got: ${resource.url === undefined ? 'undefined' : resource.url}).`,
                    'fix': `Set a valid https:// url in ${schemaFile}`
                } )

                return { result }
            }

            // Load on add: fetch complete file + parse + validate-on-load (F6, replaces verifySeal).
            console.log( `Fetching ${resource.url} ...` )
            let loaded
            try {
                loaded = await FlowMcpAdapter.loadFromUrl( { 'url': resource.url, 'parseConfig': resource.parseConfig } )
            } catch( err ) {
                const result = FlowMcpCli.#error( {
                    'error': `RES044: failed to load url resource '${resource.url}' via ${addonName}: ${err.message}`,
                    'fix': `Verify the url returns a complete, valid ${sourceKey === 'geo-csv' ? 'CSV/TSV (and parseConfig matches its columns)' : 'GeoJSON'} document over HTTPS.`
                } )

                return { result }
            }

            capabilities = loaded.capabilities || {}
            meta = {
                'mode': 'url',
                'url': resource.url,
                'addon': addonName,
                'recordCount': loaded.recordCount,
                'capabilities': capabilities
            }
            console.log( `  → URL loaded: ${loaded.recordCount} records (in-memory)` )
        } else {
            // PRD-06 verifySeal — RES032 on miss
            let sealResult
            try {
                sealResult = FlowMcpAdapter.verifySeal( { 'dbPath': resolvedPath } )
            } catch( err ) {
                const result = FlowMcpCli.#error( {
                    'error': `RES033: DB at ${resolvedPath} cannot be opened: ${err.message}`,
                    'fix': `Verify the DB file is readable and not corrupt.`
                } )

                return { result }
            }

            if( !sealResult || sealResult.sealed !== true ) {
                const reason = sealResult ? sealResult.reason : 'UNKNOWN'
                const result = FlowMcpCli.#error( {
                    'error': `RES032: DB at ${resolvedPath} does not contain meta.qualitySeal === '${sourceKey}'. Schema rejected. (reason=${reason})`,
                    'fix': `Convert the source via ${ADDON_REGISTRY[ sourceKey ] ? ADDON_REGISTRY[ sourceKey ].name : sourceKey} to obtain a sealed DB.`
                } )

                return { result }
            }

            meta = sealResult.meta
            const specRevision = meta && meta.specRevision ? meta.specRevision : 'unknown'
            const converterVersion = meta && meta.converterVersion ? meta.converterVersion : 'unknown'

            console.log( `  → Seal: ${sourceKey} ✓` )
            console.log( `  → Spec-Revision: ${specRevision}` )
            console.log( `  → Converter: ${addonName}@${converterVersion}` )

            capabilities = ( meta && meta.capabilities ) || {}
        }

        const activeCapabilities = Object
            .entries( capabilities )
            .filter( ( [ , value ] ) => {
                const isActive = value === true

                return isActive
            } )
            .map( ( [ key ] ) => {
                return key
            } )

        console.log( `Capabilities: ${activeCapabilities.length > 0 ? activeCapabilities.join( ', ' ) : '(none)'}` )

        // PRD-08 buildToolDefinitions
        let toolDefs
        try {
            const built = FlowMcpAdapter.buildToolDefinitions( { [ isUrlMode ? 'url' : 'dbPath' ]: cacheKeyValue, namespace } )
            toolDefs = built.tools || []
        } catch( err ) {
            const result = FlowMcpCli.#error( {
                'error': `Failed to build tool definitions from addon ${addonName}: ${err.message}`,
                'fix': `Verify the addon supports the schema namespace.`
            } )

            return { result }
        }

        // PRD-22 override: schema-defined tools win over auto-tools
        const schemaToolsRaw = main[ 'tools' ] || {}
        const schemaToolsArr = Array.isArray( schemaToolsRaw )
            ? schemaToolsRaw
            : Object.entries( schemaToolsRaw )
                .map( ( [ name, def ] ) => {
                    const merged = { name, ...def }

                    return merged
                } )

        const schemaToolNames = new Set(
            schemaToolsArr
                .filter( ( t ) => {
                    const hasName = t && typeof t.name === 'string' && t.name.length > 0

                    return hasName
                } )
                .map( ( t ) => {
                    const fullName = t.name.includes( '.' ) ? t.name : `${namespace}.${t.name}`

                    return fullName
                } )
        )

        const overriddenAutoTools = toolDefs
            .filter( ( t ) => {
                const isOverridden = schemaToolNames.has( t.name )

                return isOverridden
            } )
            .map( ( t ) => {
                return t.name
            } )

        const filteredAutoTools = toolDefs
            .filter( ( t ) => {
                const keep = !schemaToolNames.has( t.name )

                return keep
            } )

        const overrideSuffix = overriddenAutoTools.length > 0
            ? ` (${overriddenAutoTools.length} overridden by schema)`
            : ''

        console.log( `Auto-injecting ${filteredAutoTools.length} tools from ${addonName}${overrideSuffix}:` )
        filteredAutoTools
            .forEach( ( tool ) => {
                console.log( `  - ${tool.name}  [auto]` )
            } )

        if( overriddenAutoTools.length > 0 ) {
            console.log( 'Schema-defined tools (override auto-tools):' )
            overriddenAutoTools
                .forEach( ( name ) => {
                    console.log( `  - ${name}` )
                } )
        }

        // PRD-21 cache write
        const registryTools = []
        filteredAutoTools
            .forEach( ( tool ) => {
                registryTools.push( {
                    'name': tool.name,
                    'description': tool.description,
                    'inputSchema': tool.inputSchema,
                    'outputSchema': tool.outputSchema,
                    'auto': true,
                    'localName': tool.name.includes( '.' ) ? tool.name.split( '.' ).slice( 1 ).join( '.' ) : tool.name
                } )
            } )

        schemaToolsArr
            .forEach( ( tool ) => {
                if( !tool || typeof tool.name !== 'string' ) { return }
                const fullName = tool.name.includes( '.' ) ? tool.name : `${namespace}.${tool.name}`
                registryTools.push( {
                    'name': fullName,
                    'description': tool.description || '',
                    'inputSchema': tool.inputSchema || null,
                    'auto': false,
                    'localName': tool.name
                } )
            } )

        await FlowMcpCli.#writeSealCache( {
            schemaNamespace: namespace,
            schemaName,
            schemaFile,
            dbPath: resolvedPath,
            sourceKey,
            addonName,
            namespace,
            meta,
            'tools': registryTools,
            'overridden': overriddenAutoTools,
            'mode': isUrlMode ? 'url' : 'file-based',
            'url': isUrlMode ? resource.url : null,
            'parseConfig': isUrlMode ? ( resource.parseConfig || null ) : null
        } )

        console.log( 'Schema active.' )

        const result = {
            'status': true,
            'schema': schemaName,
            'namespace': namespace,
            'dbPath': resolvedPath,
            'url': isUrlMode ? resource.url : null,
            'mode': isUrlMode ? 'url' : 'file-based',
            'addon': addonName,
            'sourceKey': sourceKey,
            'autoToolCount': filteredAutoTools.length,
            'schemaToolCount': schemaToolsArr.length,
            'overriddenAutoTools': overriddenAutoTools,
            'tools': registryTools.map( ( t ) => {
                return { 'name': t.name, 'auto': t.auto }
            } ),
            'capabilities': activeCapabilities
        }

        if( force ) {
            result[ 'message' ] = 'Schema reloaded from source.'
        }

        return { result }
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
            try { db.close() } catch { /* ignore */ }
        }
    }


    static async #maybeCallSqliteGtfsAutoTool( { toolName, jsonArgs, noCache, refresh } ) {
        if( typeof toolName !== 'string' || !toolName.includes( '.' ) ) { return null }

        const { entries } = await FlowMcpCli.#listSqliteGtfsCacheEntries()
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
                const result = FlowMcpCli.#error( {
                    'error': 'Invalid JSON argument.',
                    'fix': `Provide valid JSON: ${appConfig[ 'cliCommand' ]} call ${toolName} '{"param": "value"}'`
                } )

                return { result }
            }
        }

        // Cache layer (PRD-20 — reuse standard cache helpers)
        const isCacheable = !noCache
        if( isCacheable && !refresh ) {
            const { cacheKey } = FlowMcpCli.#buildCacheKey( {
                'namespace': entry[ 'namespace' ],
                'routeName': tool[ 'localName' ],
                userParams
            } )
            const { data: cachedData, meta: cacheMeta, isExpired } = await FlowMcpCli.#readCache( { cacheKey } )
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
            const result = FlowMcpCli.#error( {
                'error': `Failed to load addon '${entry[ 'addonName' ]}': ${err.message}`,
                'fix': `Ensure '${entry[ 'addonName' ]}' is installed as a package.json dependency.`
            } )

            return { result }
        }

        const FlowMcpAdapter = addonLoaded.addonModule.FlowMcpAdapter
        if( !FlowMcpAdapter ) {
            const result = FlowMcpCli.#error( {
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
                const result = FlowMcpCli.#error( {
                    'error': `Failed to load url resource '${entry[ 'url' ]}' for '${toolName}': ${err.message}`,
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
            const result = FlowMcpCli.#error( {
                'error': `Failed to read addon methods for ${entry[ 'addonName' ]}: ${err.message}`,
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
            const result = FlowMcpCli.#error( {
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
                handlerResult = FlowMcpCli.#executeSqliteGtfsSqlTemplate( {
                    'dbPath': entry[ 'dbPath' ],
                    'sqlTemplate': method.sqlTemplate,
                    'paramDefs': method.params || {},
                    'userParams': userParams
                } )
            } else {
                const result = FlowMcpCli.#error( {
                    'error': `Addon method '${method.name}' has neither a handler nor a sqlTemplate.`,
                    'fix': `Update '${entry[ 'addonName' ]}' to expose a callable handler or sqlTemplate.`
                } )

                return { result }
            }
        } catch( err ) {
            const result = FlowMcpCli.#error( {
                'error': `Auto-tool '${toolName}' handler failed: ${err.message}`,
                'fix': `Verify input parameters and that the DB is readable at ${entry[ 'dbPath' ]}.`
            } )

            return { result }
        }

        if( isCacheable ) {
            const { cacheKey } = FlowMcpCli.#buildCacheKey( {
                'namespace': entry[ 'namespace' ],
                'routeName': tool[ 'localName' ],
                userParams
            } )
            const ttlSeconds = 60
            const { meta: writeMeta } = await FlowMcpCli.#writeCache( {
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


    static async #writeGlobalConfig( { config } ) {
        const globalConfigPath = FlowMcpCli.#globalConfigPath()
        // Global config is updated deliberately on init/add/remove — named overwrite.
        await FlowMcpCli.#writeGuarded( { 'path': globalConfigPath, 'content': JSON.stringify( config, null, 4 ), 'onExists': 'overwrite' } )

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


    static #isSpecId( { ref } ) {
        if( typeof ref !== 'string' ) {
            return false
        }

        const hasLegacySep = ref.includes( '::' )
        const hasSlash = ref.includes( '/' )
        const isMjsPath = ref.endsWith( '.mjs' )

        return !hasLegacySep && hasSlash && !isMjsPath
    }


    static #filterMainRoutes( { main, routeNames } ) {
        const { namespace, name, description, version, docs, tags, root, requiredServerParams, headers, sharedLists, requiredLibraries } = main
        const routesKey = main[ 'routes' ] ? 'routes' : ( main[ 'tools' ] ? 'tools' : 'routes' )
        const originalRoutes = main[ routesKey ] || {}
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
            [ routesKey ]: filteredRoutes
        }

        if( sharedLists ) { filteredMain[ 'sharedLists' ] = sharedLists }
        if( requiredLibraries ) { filteredMain[ 'requiredLibraries' ] = requiredLibraries }

        return { 'main': filteredMain }
    }


    static async #listAvailableTools() {
        const { sources } = await FlowMcpCli.#listSources()
        const tools = []

        await sources
            .reduce( ( promise, source ) => promise.then( async () => {
                const { name: sourceName, schemas: sourceSchemas } = source

                await sourceSchemas
                    .reduce( ( schemaPromise, schemaEntry ) => schemaPromise.then( async () => {
                        const { file, namespace } = schemaEntry
                        const schemaRef = `${sourceName}/${file}`
                        const { filePath } = await FlowMcpCli.#resolveSchemaPath( { schemaRef } )
                        const { main } = await FlowMcpCli.#loadSchema( { filePath } )

                        const effectiveNamespace = main && main[ 'namespace' ] ? main[ 'namespace' ] : namespace

                        const toolEntries = main ? ( main[ 'tools' ] || main[ 'routes' ] ) : null
                        if( main && toolEntries ) {
                            Object.entries( toolEntries )
                                .forEach( ( [ routeName, routeConfig ] ) => {
                                    const routeDescription = routeConfig[ 'description' ] || ''
                                    const toolRef = `${schemaRef}::${routeName}`
                                    const { toolName } = FlowMcpCli.#buildToolName( {
                                        routeName,
                                        'namespace': effectiveNamespace
                                    } )

                                    tools.push( {
                                        toolRef,
                                        toolName,
                                        schemaRef,
                                        routeName,
                                        'namespace': effectiveNamespace,
                                        'description': routeDescription,
                                        'tags': main[ 'tags' ] || [],
                                        'schemaName': main[ 'name' ] || '',
                                        'type': 'tool'
                                    } )
                                } )
                        }

                        if( main && main[ 'resources' ] ) {
                            Object.entries( main[ 'resources' ] )
                                .forEach( ( [ resourceName, resourceConfig ] ) => {
                                    const resourceDescription = resourceConfig[ 'description' ] || ''
                                    const toolRef = `${schemaRef}::resource::${resourceName}`
                                    const toolName = `${resourceName}_${effectiveNamespace}`

                                    tools.push( {
                                        toolRef,
                                        toolName,
                                        schemaRef,
                                        'routeName': resourceName,
                                        'namespace': effectiveNamespace,
                                        'description': resourceDescription,
                                        'tags': main[ 'tags' ] || [],
                                        'schemaName': main[ 'name' ] || '',
                                        'type': 'resource'
                                    } )
                                } )
                        }

                        if( main && main[ 'skills' ] ) {
                            main[ 'skills' ]
                                .forEach( ( skillDef ) => {
                                    const skillName = skillDef[ 'name' ] || 'unknown'
                                    const skillDescription = skillDef[ 'description' ] || ''
                                    const toolRef = `${schemaRef}::skill::${skillName}`
                                    const toolName = `${skillName}_${effectiveNamespace}`

                                    tools.push( {
                                        toolRef,
                                        toolName,
                                        schemaRef,
                                        'routeName': skillName,
                                        'namespace': effectiveNamespace,
                                        'description': skillDescription,
                                        'tags': main[ 'tags' ] || [],
                                        'schemaName': main[ 'name' ] || '',
                                        'type': 'skill'
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

        if( queryTokens.length === 1 && lowerName === queryTokens[ 0 ] ) {
            return { 'score': 100 }
        }

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

                if( tokenScore === 0 ) {
                    const segmentContains = nameSegments
                        .some( ( seg ) => seg.includes( token ) )
                    if( segmentContains ) { tokenScore += 8 }
                }

                if( tokenScore === 0 ) {
                    const descContains = lowerDesc.includes( token )
                    if( descContains ) { tokenScore += 3 }
                }

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


    static #extractMetaFlags( { main, routeName } ) {
        const tools = main[ 'tools' ] || main[ 'routes' ] || {}
        const route = tools[ routeName ] || {}
        const method = ( route[ 'method' ] || 'GET' ).toUpperCase()
        const tags = main[ 'tags' ] || []
        const serverParams = main[ 'requiredServerParams' ] || []

        const flags = []

        if( method === 'GET' ) {
            flags.push( 'Read-only' )
        } else {
            flags.push( `${method}` )
        }

        if( serverParams.length > 0 ) {
            flags.push( 'API-Key required' )
        } else {
            flags.push( 'No API-Key' )
        }

        const hasCacheTtl = tags
            .some( ( tag ) => tag.startsWith( 'cacheTtl' ) )
        if( hasCacheTtl ) {
            flags.push( 'Cached' )
        }

        const meta = flags.join( ' | ' )

        return { meta }
    }


    static #extractParameterDetails( { main, routeName } ) {
        const tools = main[ 'tools' ] || main[ 'routes' ] || {}
        const route = tools[ routeName ] || {}
        const parameters = route[ 'parameters' ] || []
        const sharedListRefs = main[ 'sharedLists' ] || []

        const requiredParams = []
        const optionalParams = []

        parameters
            .forEach( ( param ) => {
                const key = param?.[ 'position' ]?.[ 'key' ] || 'unknown'
                const primitive = param?.[ 'z' ]?.[ 'primitive' ] || 'string()'
                const options = param?.[ 'z' ]?.[ 'options' ] || []
                const isOptional = options
                    .some( ( opt ) => opt.startsWith( 'optional' ) )

                const typeMatch = primitive.match( /^(\w+)\(/ )
                const type = typeMatch ? typeMatch[ 1 ] : 'string'

                const isEnum = primitive.startsWith( 'enum(' )
                let enumExamples = []
                let listRef = null

                if( isEnum ) {
                    const enumContent = primitive.slice( 5, -1 )
                    const templateMatch = enumContent.match( /\{\{(\w+):(\w+)\}\}/ )

                    if( templateMatch ) {
                        const listName = templateMatch[ 1 ]
                        listRef = listName
                            .replace( /([a-z0-9])([A-Z])/g, '$1-$2' )
                            .toLowerCase()
                    } else {
                        enumExamples = enumContent
                            .split( ',' )
                            .map( ( v ) => v.trim().replace( /^'|'$/g, '' ) )
                            .slice( 0, 5 )
                    }
                }

                const entry = { key, type, isEnum, enumExamples, listRef }

                if( isOptional ) {
                    optionalParams.push( entry )
                } else {
                    requiredParams.push( entry )
                }
            } )

        return { requiredParams, optionalParams }
    }


    static #generateCallExample( { toolName, requiredParams } ) {
        const paramParts = requiredParams
            .map( ( param ) => {
                const { key, type, enumExamples } = param

                if( type === 'number' ) {
                    return `"${key}":1`
                }

                if( type === 'boolean' ) {
                    return `"${key}":true`
                }

                if( enumExamples && enumExamples.length > 0 ) {
                    return `"${key}":"${enumExamples[ 0 ]}"`
                }

                return `"${key}":"<${key}>"`
            } )

        let example = ''

        if( paramParts.length > 0 ) {
            example = `flowmcp call ${toolName} '{${paramParts.join( ',' )}}'`
        } else {
            example = `flowmcp call ${toolName}`
        }

        return { example }
    }


    // PRD-008 — the MCP tool name is `<route>_<namespace>` (snake_case, 63-char cap).
    // The optional `source` (schemaFolders[] name) is appended ONLY when
    // `disambiguate === true`, i.e. on a real collision between two folders that
    // carry the same provider. Without disambiguation the name is byte-identical to
    // the pre-PRD-008 behaviour — agents that reference existing tool names keep
    // working (no silent rename). The source append is deterministic (same source
    // string -> same suffix) and re-applies the 63-char cap so the SDK never sees an
    // over-long name.
    static #buildToolName( { routeName, namespace, source = null, disambiguate = false } ) {
        const routeNameSnakeCase = routeName
            .replace( /([a-z0-9])([A-Z])/g, '$1_$2' )
            .toLowerCase()
        const namespaceSnakeCase = namespace
            .replace( /([a-z0-9])([A-Z])/g, '$1_$2' )
            .toLowerCase()

        const sanitize = ( value ) => value
            .replaceAll( ':', '' )
            .replaceAll( '-', '_' )
            .replaceAll( '/', '_' )

        if( disambiguate === true && typeof source === 'string' && source.length > 0 ) {
            const sourceSnakeCase = source
                .replace( /([a-z0-9])([A-Z])/g, '$1_$2' )
                .toLowerCase()
            // Reserve room for the source suffix so the base name is not truncated
            // away entirely: cap the base at 63 - (1 + sourceLen) before appending.
            const suffix = `_${sanitize( sourceSnakeCase )}`
            const baseCap = Math.max( 0, 63 - suffix.length )
            const base = sanitize( `${routeNameSnakeCase}_${namespaceSnakeCase}` ).substring( 0, baseCap )
            const toolName = `${base}${suffix}`.substring( 0, 63 )

            return { toolName }
        }

        let toolName = `${routeNameSnakeCase}_${namespaceSnakeCase}`
        toolName = sanitize( toolName.substring( 0, 63 ) )

        return { toolName }
    }


    // PRD-008 — stateful pre-serve dedup planner (the SDK throws on a duplicate tool
    // name). Given the already-registered names set, decide the final registerable
    // name for one base name. On a real collision it appends the source coordinate
    // (deterministic via #buildToolName disambiguate=true). A genuine duplicate that
    // cannot be disambiguated (no/equal source) is skipped — never a silent throw.
    // Mutates `registeredToolNames`. Returns { finalName, skip, note }.
    static #disambiguateToolName( { baseName, routeName, namespace, source, registeredToolNames } ) {
        if( registeredToolNames.has( baseName ) === false ) {
            registeredToolNames.add( baseName )

            return { 'finalName': baseName, 'skip': false, 'note': null }
        }

        const { toolName: qualifiedName } = FlowMcpCli.#buildToolName( { routeName, namespace, source, 'disambiguate': true } )
        if( qualifiedName !== baseName && registeredToolNames.has( qualifiedName ) === false ) {
            registeredToolNames.add( qualifiedName )

            return { 'finalName': qualifiedName, 'skip': false, 'note': `tool name collision on "${baseName}" — registered the source-qualified name "${qualifiedName}" instead.` }
        }

        return { 'finalName': baseName, 'skip': true, 'note': `duplicate tool name "${baseName}" cannot be disambiguated (same source) — skipped.` }
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

        await FlowMcpCli.#writeGuarded( {
            'path': localRegistryPath,
            'content': JSON.stringify( registryCopy, null, 4 ),
            'onExists': 'overwrite'
        } )

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


    static async catalogLink( { name, path } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        if( typeof name !== 'string' || name.trim().length === 0 ) {
            const result = FlowMcpCli.#error( {
                'error': 'Missing source name.',
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} catalog link <name> <absolute-path>`
            } )

            return { result }
        }

        if( typeof path !== 'string' || path.trim().length === 0 ) {
            const result = FlowMcpCli.#error( {
                'error': 'Missing source path.',
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} catalog link <name> <absolute-path>`
            } )

            return { result }
        }

        const absolutePath = resolve( path )
        const dirExists = await access( absolutePath )
            .then( () => true )
            .catch( () => false )

        if( dirExists === false ) {
            const result = FlowMcpCli.#error( {
                'error': `Source path does not exist: ${absolutePath}`,
                'fix': 'Provide an existing directory that contains FlowMCP schema files.'
            } )

            return { result }
        }

        const globalConfigPath = FlowMcpCli.#globalConfigPath()
        const { data: existingConfig } = await FlowMcpCli.#readJson( { filePath: globalConfigPath } )
        const globalConfig = existingConfig || {}

        if( !globalConfig[ 'localSources' ] || typeof globalConfig[ 'localSources' ] !== 'object' || Array.isArray( globalConfig[ 'localSources' ] ) ) {
            globalConfig[ 'localSources' ] = {}
        }

        globalConfig[ 'localSources' ][ name ] = {
            'path': absolutePath,
            'linkedAt': new Date().toISOString()
        }

        await FlowMcpCli.#writeGlobalConfig( { config: globalConfig } )

        const { sources } = await FlowMcpCli.#listSources()
        const linked = sources
            .find( ( source ) => source[ 'name' ] === name )

        const result = {
            'status': true,
            'linked': name,
            'path': absolutePath,
            'schemaCount': linked ? linked[ 'schemaCount' ] : 0
        }

        return { result }
    }


    static async catalogUnlink( { name } ) {
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        if( typeof name !== 'string' || name.trim().length === 0 ) {
            const result = FlowMcpCli.#error( {
                'error': 'Missing source name.',
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} catalog unlink <name>`
            } )

            return { result }
        }

        const globalConfigPath = FlowMcpCli.#globalConfigPath()
        const { data: existingConfig } = await FlowMcpCli.#readJson( { filePath: globalConfigPath } )
        const globalConfig = existingConfig || {}
        const localSources = globalConfig[ 'localSources' ]

        if( !localSources || typeof localSources !== 'object' || localSources[ name ] === undefined ) {
            const result = FlowMcpCli.#error( {
                'error': `Local source "${name}" is not linked.`,
                'fix': `Run ${appConfig[ 'cliCommand' ]} catalog sources to see linked sources.`
            } )

            return { result }
        }

        delete localSources[ name ]
        await FlowMcpCli.#writeGlobalConfig( { config: globalConfig } )

        const result = {
            'status': true,
            'unlinked': name
        }

        return { result }
    }


    static async catalogSources() {
        const { localSources } = await FlowMcpCli.#readLocalSources()

        const linked = Object.entries( localSources )
            .map( ( [ name, entry ] ) => {
                const sourceInfo = { name, 'path': entry[ 'path' ] }

                return sourceInfo
            } )

        const result = {
            'status': true,
            'count': linked.length,
            'sources': linked
        }

        return { result }
    }


    static async #listSources() {
        const schemasBaseDir = FlowMcpCli.#schemasDir()
        const globalConfigPath = FlowMcpCli.#globalConfigPath()
        const { data: globalConfig } = await FlowMcpCli.#readJson( { filePath: globalConfigPath } )
        const configSources = ( globalConfig && globalConfig[ 'sources' ] ) || {}

        // Memo 099 Kap 4 — schemaFolders[] is the single source of truth (the disk = the truth).
        // Legacy ~/.flowmcp/schemas scan + localSources are the fallback until migration (Memo 099 Kap 9).
        const { schemaFolders, duplicateError } = await FlowMcpCli.#readSchemaFolders()

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
            const { localSources } = await FlowMcpCli.#readLocalSources()

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

            const localSourceNames = Object.keys( localSources )
                .filter( ( name ) => sourceDirs.includes( name ) === false )
            allSourceNames = [ ...sourceDirs, ...localSourceNames ]
        }

        const sources = []

        await allSourceNames
            .reduce( ( promise, sourceDir ) => promise.then( async () => {
                const { sourceDir: sourcePath, isLocal } = await FlowMcpCli.#resolveSourceDir( { sourceName: sourceDir } )
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
                const { filePath } = await FlowMcpCli.#resolveSchemaPath( { schemaRef } )
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


    /**
     * Resolve env keys with local override + global fallback (Memo 032 PRD-07).
     *
     * Search order:
     *   1. Local: <cwd>/.flowmcp/.env (project-specific override, optional)
     *   2. Global: configured envPath in ~/.flowmcp/config.json, or fallback ~/.flowmcp/.env
     *
     * Local keys override global keys when both present (merge, not replace).
     *
     * @param {Object} params
     * @param {string} params.cwd - Current working directory
     * @returns {Promise<{envObject: Object, sources: {local: string|null, global: string|null}}>}
     */
    static async #resolveEnv( { cwd } ) {
        const localEnvPath = join( cwd, appConfig[ 'localConfigDirName' ], '.env' )
        const globalConfigPath = FlowMcpCli.#globalConfigPath()
        const { data: globalConfig } = await FlowMcpCli.#readJson( { filePath: globalConfigPath } )
        const configuredGlobalEnv = ( globalConfig && globalConfig[ 'envPath' ] )
            ? globalConfig[ 'envPath' ]
            : join( FlowMcpCli.#globalConfigDir(), appConfig[ 'defaultEnvFileName' ] )

        let globalEnv = {}
        let globalSourcePath = null
        const { data: globalContent } = await FlowMcpCli.#readText( { filePath: configuredGlobalEnv } )
        if( globalContent !== null ) {
            globalEnv = FlowMcpCli.#parseEnvFile( { envContent: globalContent } ).envObject
            globalSourcePath = configuredGlobalEnv
        }

        let localEnv = {}
        let localSourcePath = null
        const { data: localContent } = await FlowMcpCli.#readText( { filePath: localEnvPath } )
        if( localContent !== null ) {
            localEnv = FlowMcpCli.#parseEnvFile( { envContent: localContent } ).envObject
            localSourcePath = localEnvPath
        }

        const envObject = { ...globalEnv, ...localEnv }

        return {
            envObject,
            'sources': {
                'local': localSourcePath,
                'global': globalSourcePath
            }
        }
    }


    // Test-only accessor for #resolveEnv (Memo 032 PRD-07). Do not use in production code.
    static async _testResolveEnv( { cwd } ) {
        return FlowMcpCli.#resolveEnv( { cwd } )
    }


    // Test-only accessor for #activationGuard (Memo 092 PRD-L). Lets tests
    // assert the keyless-first partition (activatableRefs/degraded) directly
    // for mixed keyless + key-gated schema sets. Do not use in production code.
    static async _testActivationGuard( { namespaces = [], schemaFiles = null, cwd, force = false, toolName } ) {
        return FlowMcpCli.#activationGuard( { namespaces, schemaFiles, cwd, force, toolName } )
    }


    /**
     * Check whether an env value is "filled" (non-placeholder, sufficiently long, real).
     * Used by env doctor to bucket keys into filled vs missing.
     */
    static #isKeyFilled( { value } ) {
        if( value === undefined || value === null ) {
            return false
        }

        if( typeof value !== 'string' ) {
            return false
        }

        const trimmed = value.trim()
        if( trimmed.length === 0 ) {
            return false
        }

        // No minimum-length heuristic: many valid credentials are short — usernames
        // (GEONAMES_USERNAME, REGIONALSTATISTIK_USERNAME) and short API keys (OMDb
        // keys are 8 chars). A length gate produced false "missing" reports. Empty
        // and placeholder checks are the real signal.
        const placeholders = [ 'your_key_here', '<your-key', '# Example', 'YOUR_KEY', 'TODO' ]
        const lowered = trimmed.toLowerCase()
        const isPlaceholder = placeholders
            .find( ( pattern ) => {
                const match = lowered.includes( pattern.toLowerCase() )

                return match
            } )

        if( isPlaceholder ) {
            return false
        }

        return true
    }


    /**
     * Walk all active schemas, collect requiredServerParams from main.
     * Optional schemaFilter limits to a single namespace.
     */
    static async #collectAllRequiredServerParams( { cwd, schemaFilter = null } ) {
        const { index } = await FlowMcpCli.getNamespaceIndex( { cwd } )
        const tools = index[ 'tools' ] || {}
        const schemasBaseDir = FlowMcpCli.#schemasDir()
        const keyToSchemas = new Map()
        const loadedFiles = new Set()

        const entries = Object.entries( tools )
        await entries
            .reduce( ( promise, [ specId, entry ] ) => promise.then( async () => {
                const { file, source } = entry
                const namespace = specId.split( '/' )[ 0 ]

                if( schemaFilter && namespace !== schemaFilter ) {
                    return
                }

                const fileKey = `${source}/${file}`
                if( loadedFiles.has( fileKey ) ) {
                    return
                }
                loadedFiles.add( fileKey )

                const filePath = join( schemasBaseDir, source, file )
                const { main } = await FlowMcpCli.#loadSchema( { filePath } )

                if( !main ) {
                    return
                }

                const requiredServerParams = main[ 'requiredServerParams' ] || []
                requiredServerParams
                    .forEach( ( paramKey ) => {
                        if( !keyToSchemas.has( paramKey ) ) {
                            keyToSchemas.set( paramKey, [] )
                        }

                        const existing = keyToSchemas.get( paramKey )
                        const schemaId = `${main[ 'namespace' ] || namespace}/${file}`
                        const alreadyTracked = existing
                            .find( ( s ) => {
                                const isSame = s === schemaId

                                return isSame
                            } )

                        if( !alreadyTracked ) {
                            existing.push( schemaId )
                        }
                    } )
            } ), Promise.resolve() )

        const keys = Array.from( keyToSchemas.keys() ).sort()

        return { keys, keyToSchemas }
    }


    /**
     * `flowmcp dev env doctor` (Memo 032 PRD-09).
     *
     * Reports which required keys are filled / missing / unused.
     * Supports JSON output, --fix-template, --print-signups, --strict and --schema filter.
     */
    static async devEnvDoctor( { schema = null, strict = false, fixTemplate = false, json = false, printSignups = false, cwd } ) {
        const { envObject, sources } = await FlowMcpCli.#resolveEnv( { cwd } )
        const { keys: required } = await FlowMcpCli.#collectAllRequiredServerParams( { cwd, 'schemaFilter': schema } )

        const filled = []
        const missing = []

        required
            .forEach( ( key ) => {
                const value = envObject[ key ]
                const isFilled = FlowMcpCli.#isKeyFilled( { value } )

                if( isFilled ) {
                    filled.push( key )
                } else {
                    missing.push( key )
                }
            } )

        const requiredSet = new Set( required )
        const unused = Object.keys( envObject )
            .filter( ( key ) => {
                const isInRequired = requiredSet.has( key )

                return !isInRequired
            } )
            .sort()

        if( json ) {
            const result = {
                'status': true,
                sources,
                filled,
                missing,
                unused,
                required
            }

            if( strict && missing.length > 0 ) {
                process.exitCode = 1
                result[ 'status' ] = false
            }

            return { result }
        }

        if( fixTemplate ) {
            const template = missing
                .map( ( key ) => {
                    const line = `${key}=`

                    return line
                } )
                .join( '\n' )

            return { result: { 'status': true, template } }
        }

        if( printSignups ) {
            const guidePath = join( dirname( fileURLToPath( import.meta.url ) ), '..', 'data', 'acquisition-guide.json' )
            const { data: guide } = await FlowMcpCli.#readJson( { filePath: guidePath } )
            const guideKeys = ( guide && guide[ 'keys' ] ) || {}

            const lines = missing
                .map( ( key ) => {
                    const entry = guideKeys[ key ]
                    const url = entry ? entry[ 'signupUrl' ] : 'no signup URL'
                    const line = `${key}: ${url}`

                    return line
                } )

            return { result: { 'status': true, 'signups': lines.join( '\n' ) } }
        }

        const globalLabel = sources[ 'global' ] || '(none)'
        const localLabel = sources[ 'local' ] || '(none)'

        console.log( '' )
        console.log( chalk.cyan( '  Env Doctor' ) )
        console.log( `  ${chalk.gray( 'Global:' )} ${globalLabel}` )
        console.log( `  ${chalk.gray( 'Local: ' )} ${localLabel}` )
        console.log( '' )
        console.log( `  ${chalk.green( '✓' )} Filled:  ${filled.length}` )
        console.log( `  ${chalk.yellow( '⚠' )} Missing: ${missing.length}` )
        console.log( `  ${chalk.gray( '·' )} Unused:  ${unused.length}` )
        console.log( '' )

        if( missing.length > 0 ) {
            console.log( chalk.yellow( '  Missing keys:' ) )
            missing
                .forEach( ( key ) => {
                    console.log( `    - ${key}` )
                } )
            console.log( '' )
        }

        const summary = `Filled ${filled.length}, Missing ${missing.length}, Unused ${unused.length}`

        if( strict && missing.length > 0 ) {
            process.exitCode = 1

            return { result: { 'status': false, summary, missing } }
        }

        return { result: { 'status': true, summary } }
    }


    /**
     * `flowmcp dev env backup` (Memo 032 PRD-11).
     * Snapshots the resolved env to ~/.flowmcp/.env-backups/{ISO}.env.
     */
    static async devEnvBackup( { cwd } ) {
        const { sources } = await FlowMcpCli.#resolveEnv( { cwd } )
        const source = sources[ 'global' ] || sources[ 'local' ]

        if( !source ) {
            const result = FlowMcpCli.#error( {
                'error': 'No env file found to back up.',
                'fix': `Create one at ~/${appConfig[ 'globalConfigDirName' ]}/${appConfig[ 'defaultEnvFileName' ]} first.`
            } )

            return { result }
        }

        const { data: content } = await FlowMcpCli.#readText( { filePath: source } )
        if( content === null ) {
            const result = FlowMcpCli.#error( {
                'error': `Cannot read env file: ${source}`,
                'fix': 'Check filesystem permissions.'
            } )

            return { result }
        }

        const backupDir = join( FlowMcpCli.#globalConfigDir(), '.env-backups' )
        await mkdir( backupDir, { recursive: true } )

        const iso = new Date().toISOString().replace( /:/g, '-' )
        const backup = join( backupDir, `${iso}.env` )
        await FlowMcpCli.#writeGuarded( { 'path': backup, 'content': content, 'onExists': 'overwrite' } )

        const result = { 'status': true, source, backup }

        return { result }
    }


    /**
     * `flowmcp dev env restore <file>` (Memo 032 PRD-11).
     * Restores a previous backup to the global env path. Prompts for confirmation.
     */
    static async devEnvRestore( { file, cwd: _cwd } ) {
        if( !file || typeof file !== 'string' ) {
            const result = FlowMcpCli.#error( {
                'error': 'Missing backup file path.',
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} dev env restore <file>`
            } )

            return { result }
        }

        const { data: content } = await FlowMcpCli.#readText( { filePath: file } )
        if( content === null ) {
            const result = FlowMcpCli.#error( {
                'error': `Backup file not found: ${file}`,
                'fix': `Use: ${appConfig[ 'cliCommand' ]} dev env backup to create a snapshot first.`
            } )

            return { result }
        }

        const targetPath = join( FlowMcpCli.#globalConfigDir(), appConfig[ 'defaultEnvFileName' ] )

        const { confirmed } = await inquirer.prompt( [
            {
                'type': 'confirm',
                'name': 'confirmed',
                'message': `Restore ${file} to ${targetPath}? Existing keys will be overwritten.`,
                'default': false
            }
        ] )

        if( !confirmed ) {
            const result = { 'status': false, 'error': 'Restore cancelled by user.' }

            return { result }
        }

        await mkdir( dirname( targetPath ), { recursive: true } )
        await FlowMcpCli.#writeGuarded( { 'path': targetPath, 'content': content, 'onExists': 'overwrite' } )

        const result = { 'status': true, 'restored': targetPath }

        return { result }
    }


    /**
     * `flowmcp dev env diff <file>` (Memo 032 PRD-11).
     * Diff current resolved env against a backup file. Returns key NAMES only — never values.
     */
    static async devEnvDiff( { file, cwd } ) {
        if( !file || typeof file !== 'string' ) {
            const result = FlowMcpCli.#error( {
                'error': 'Missing backup file path.',
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} dev env diff <file>`
            } )

            return { result }
        }

        const { data: backupContent } = await FlowMcpCli.#readText( { filePath: file } )
        if( backupContent === null ) {
            const result = FlowMcpCli.#error( {
                'error': `Backup file not found: ${file}`,
                'fix': `Use: ${appConfig[ 'cliCommand' ]} dev env backup to create a snapshot first.`
            } )

            return { result }
        }

        const { envObject: current } = await FlowMcpCli.#resolveEnv( { cwd } )
        const { envObject: backup } = FlowMcpCli.#parseEnvFile( { 'envContent': backupContent } )

        const currentKeys = new Set( Object.keys( current ) )
        const backupKeys = new Set( Object.keys( backup ) )

        const onlyInCurrent = Array.from( currentKeys )
            .filter( ( key ) => {
                const inBackup = backupKeys.has( key )

                return !inBackup
            } )
            .sort()

        const onlyInBackup = Array.from( backupKeys )
            .filter( ( key ) => {
                const inCurrent = currentKeys.has( key )

                return !inCurrent
            } )
            .sort()

        const valueDiffKeys = Array.from( currentKeys )
            .filter( ( key ) => {
                const inBoth = backupKeys.has( key )
                if( !inBoth ) {
                    return false
                }

                const differs = current[ key ] !== backup[ key ]

                return differs
            } )
            .sort()

        const result = {
            'status': true,
            onlyInCurrent,
            onlyInBackup,
            valueDiffKeys
        }

        return { result }
    }


    /**
     * `flowmcp dev env acquire` (Memo 032 PRD-08).
     * Lists/filters acquisition guidance for missing keys.
     */
    static async devEnvAcquire( { key = null, mode = null, printGuide = false, json = false, cwd } ) {
        const guidePath = join( dirname( fileURLToPath( import.meta.url ) ), '..', 'data', 'acquisition-guide.json' )
        const { data: guide } = await FlowMcpCli.#readJson( { filePath: guidePath } )

        if( !guide || !guide[ 'keys' ] ) {
            const result = FlowMcpCli.#error( {
                'error': 'Acquisition guide not found.',
                'fix': 'Reinstall flowmcp-cli or check src/data/acquisition-guide.json'
            } )

            return { result }
        }

        const { result: doctorResult } = await FlowMcpCli.devEnvDoctor( { 'json': true, cwd } )
        const missing = doctorResult[ 'missing' ] || []

        let candidates = missing
            .map( ( missingKey ) => {
                const entry = guide[ 'keys' ][ missingKey ]
                const wrapped = entry ? { 'key': missingKey, ...entry } : null

                return wrapped
            } )
            .filter( ( entry ) => {
                const isKnown = entry !== null

                return isKnown
            } )

        if( key ) {
            candidates = candidates
                .filter( ( entry ) => {
                    const matches = entry[ 'key' ] === key

                    return matches
                } )
        }

        if( mode ) {
            candidates = candidates
                .filter( ( entry ) => {
                    const matches = entry[ 'authMode' ] === mode

                    return matches
                } )
        }

        if( json ) {
            const result = { 'status': true, 'count': candidates.length, 'entries': candidates }

            return { result }
        }

        if( printGuide ) {
            const lines = []
            lines.push( '# FlowMCP — API Key Acquisition Guide' )
            lines.push( '' )
            lines.push( `Generated: ${new Date().toISOString()}` )
            lines.push( '' )

            candidates
                .forEach( ( entry ) => {
                    lines.push( `## ${entry[ 'key' ]}` )
                    lines.push( '' )
                    lines.push( `- Provider: ${entry[ 'provider' ]}` )
                    lines.push( `- Signup URL: ${entry[ 'signupUrl' ]}` )
                    lines.push( `- Auth mode: ${entry[ 'authMode' ]}` )
                    lines.push( `- Free tier: ${entry[ 'freeTier' ]}` )

                    if( entry[ 'notes' ] && entry[ 'notes' ].length > 0 ) {
                        lines.push( `- Notes: ${entry[ 'notes' ]}` )
                    }

                    lines.push( '' )
                    lines.push( 'Steps:' )
                    const steps = entry[ 'steps' ] || []
                    steps
                        .forEach( ( step, index ) => {
                            lines.push( `${index + 1}. ${step}` )
                        } )
                    lines.push( '' )
                } )

            const markdown = lines.join( '\n' )

            return { result: { 'status': true, 'markdown': markdown } }
        }

        console.log( '' )
        console.log( chalk.cyan( '  Env Acquire' ) )
        console.log( `  ${chalk.gray( 'Missing keys with guidance:' )} ${candidates.length}` )
        console.log( '' )

        candidates
            .forEach( ( entry ) => {
                console.log( `  ${chalk.yellow( entry[ 'key' ] )} (${entry[ 'authMode' ]})` )
                console.log( `    Provider: ${entry[ 'provider' ]}` )
                console.log( `    Signup:   ${entry[ 'signupUrl' ]}` )
                console.log( '' )
            } )

        const result = { 'status': true, 'count': candidates.length }

        return { result }
    }


    /**
     * Activation guard (Memo 032 PRD-10).
     *
     * Returns allowed:false with an explanatory result when keys are missing.
     * Checks only schemas relevant to the activation:
     *   - If schemaFiles is provided, restrict to those exact files.
     *   - Otherwise, fall back to namespace-wide scan via devEnvDoctor.
     */
    /**
     * Distinguish a blocking "API key" from a non-secret "identity" param
     * (e.g. NOMINATIM_USER_AGENT, Memo 092 PRD-L decision #6). Identity params
     * are required by the schema but carry no secret — their absence must NOT
     * make a keyless provider key-gated, so they never block activation.
     *
     * [ANNAHME] Suffix heuristic (`_USER_AGENT`). A cleaner solution is a
     * per-param schema field (e.g. kind: 'apiKey' | 'identity') in flowmcp-spec;
     * replace this heuristic once the spec gains that field (PRD-L open point 1).
     * Kept localized here on purpose — no new spec field is invented.
     */
    static #isBlockingKey( { paramName } ) {
        const nonSecretSuffixes = [ '_USER_AGENT' ]
        const isNonSecret = nonSecretSuffixes
            .some( ( suffix ) => {
                const matches = paramName.endsWith( suffix )

                return matches
            } )

        return !isNonSecret
    }


    /**
     * Per-schema activation evaluation (Memo 092 PRD-L). Replaces the old flat
     * "aggregate all missing keys" logic with a partition: each evaluated entry
     * carries its own blocking `missingKeys` and non-blocking `setupHints`
     * (missing identity params). The caller decides keyless-first activation.
     *
     * Returns one entry per ref:
     *   { ref, namespace, missingKeys: [...], setupHints: [...] }
     * where `ref` is the schemaRef (schemaFiles branch) or namespace
     * (namespaces fallback branch).
     */
    static async #evaluateActivation( { namespaces, schemaFiles = null, envObject, cwd } ) {
        if( schemaFiles && schemaFiles.length > 0 ) {
            const schemasBaseDir = FlowMcpCli.#schemasDir()

            const { evaluated } = await schemaFiles
                .reduce( ( promise, schemaRef ) => promise.then( async ( acc ) => {
                    const filePath = join( schemasBaseDir, schemaRef )
                    const { main } = await FlowMcpCli.#loadSchema( { filePath } )

                    if( !main ) {
                        acc[ 'evaluated' ].push( { 'ref': schemaRef, 'namespace': schemaRef, 'missingKeys': [], 'setupHints': [] } )

                        return acc
                    }

                    const requiredServerParams = main[ 'requiredServerParams' ] || []
                    const namespace = main[ 'namespace' ] || schemaRef
                    const { missingKeys, setupHints } = FlowMcpCli.#partitionMissingParams( { requiredServerParams, envObject } )

                    acc[ 'evaluated' ].push( { 'ref': schemaRef, namespace, missingKeys, setupHints } )

                    return acc
                } ), Promise.resolve( { 'evaluated': [] } ) )

            return { evaluated }
        }

        const { evaluated } = await namespaces
            .reduce( ( promise, namespace ) => promise.then( async ( acc ) => {
                const { result } = await FlowMcpCli.devEnvDoctor( { 'schema': namespace, 'json': true, cwd } )
                const namespaceMissing = result[ 'missing' ] || []
                const { missingKeys, setupHints } = FlowMcpCli.#partitionMissingParams( { 'requiredServerParams': namespaceMissing, 'envObject': null } )

                acc[ 'evaluated' ].push( { 'ref': namespace, namespace, missingKeys, setupHints } )

                return acc
            } ), Promise.resolve( { 'evaluated': [] } ) )

        return { evaluated }
    }


    /**
     * Split a list of (potentially missing) required params into blocking
     * `missingKeys` and non-blocking `setupHints` (identity params).
     * When `envObject` is provided, only params that are NOT already filled
     * are considered; when it is null the params are assumed already-missing
     * (used by the namespaces fallback which receives a pre-filtered list).
     */
    static #partitionMissingParams( { requiredServerParams, envObject } ) {
        const missingKeys = []
        const setupHints = []

        requiredServerParams
            .forEach( ( key ) => {
                if( envObject !== null ) {
                    const isFilled = FlowMcpCli.#isKeyFilled( { 'value': envObject[ key ] } )

                    if( isFilled ) {
                        return
                    }
                }

                const isBlocking = FlowMcpCli.#isBlockingKey( { 'paramName': key } )
                const target = isBlocking ? missingKeys : setupHints
                const alreadyTracked = target
                    .find( ( m ) => {
                        const isSame = m === key

                        return isSame
                    } )

                if( !alreadyTracked ) {
                    target.push( key )
                }
            } )

        return { missingKeys, setupHints }
    }


    /**
     * Keyless-first activation guard (Memo 092 PRD-L, decision #6).
     *
     * Instead of all-or-nothing, the guard PARTITIONS the requested schemas:
     * keyless providers (and providers whose only missing params are
     * non-blocking identity params) are ALWAYS activatable; providers with a
     * genuinely missing API key are DEGRADED (skipped) and reported EXPLICITLY
     * (no silent skip). The anchor degrades, it does not block. Activation is
     * only rejected when NO keyless provider remains.
     *
     * Returns { allowed, activatableRefs, degraded, setupHintRefs, result }.
     * `--force` keeps Bestandsverhalten: it activates degraded providers too.
     */
    static async #activationGuard( { namespaces, schemaFiles = null, cwd, force, toolName } ) {
        const { envObject } = await FlowMcpCli.#resolveEnv( { cwd } )
        const { evaluated } = await FlowMcpCli.#evaluateActivation( { namespaces, schemaFiles, envObject, cwd } )

        // process.exitCode may have been set by devEnvDoctor with strict:true.
        // Activation-guard is informative — clear it.
        if( process.exitCode === 1 ) {
            process.exitCode = 0
        }

        const activatable = evaluated
            .filter( ( e ) => {
                const isClear = e[ 'missingKeys' ].length === 0

                return isClear
            } )
        const degraded = evaluated
            .filter( ( e ) => {
                const isDegraded = e[ 'missingKeys' ].length > 0

                return isDegraded
            } )
        const withSetupHints = evaluated
            .filter( ( e ) => {
                const hasHints = e[ 'setupHints' ].length > 0

                return hasHints
            } )

        // Non-blocking identity params (e.g. NOMINATIM_USER_AGENT) are reported
        // as a setup hint but never block — keyless-first.
        if( withSetupHints.length > 0 ) {
            const hintLines = withSetupHints
                .map( ( e ) => {
                    const line = `  - ${e[ 'namespace' ]}: set ${e[ 'setupHints' ].join( ', ' )} (identity param, recommended)`

                    return line
                } )
                .join( '\n' )
            console.warn( chalk.yellow( `Setup hint for "${toolName}" — non-blocking identity param(s) unset:\n${hintLines}` ) )
        }

        // --force keeps the old behavior: activate everything, including degraded
        // providers, regardless of missing keys.
        if( force ) {
            if( degraded.length > 0 ) {
                const missingAll = degraded
                    .reduce( ( acc, e ) => acc.concat( e[ 'missingKeys' ] ), [] )
                console.warn( chalk.yellow( `Warning: activating "${toolName}" with ${missingAll.length} missing key(s): ${missingAll.join( ', ' )}` ) )
            }

            return {
                'allowed': true,
                'activatableRefs': evaluated.map( ( e ) => e[ 'ref' ] ),
                degraded,
                'result': null
            }
        }

        // keyless-first: degraded (key-gated) providers are skipped with an
        // EXPLICIT report — never silently dropped (NO SILENT DEFAULT).
        if( degraded.length > 0 ) {
            const lines = degraded
                .map( ( e ) => {
                    const line = `  - ${e[ 'namespace' ]}: missing ${e[ 'missingKeys' ].join( ', ' )}`

                    return line
                } )
                .join( '\n' )
            console.warn( chalk.yellow(
                `Degraded activation for "${toolName}" — keyless providers active, ${degraded.length} provider(s) skipped (set keys to enable):\n${lines}`
            ) )
        }

        // Only block when not a single keyless provider survives.
        if( activatable.length === 0 ) {
            const allMissing = degraded
                .reduce( ( acc, e ) => acc.concat( e[ 'missingKeys' ] ), [] )
            const firstMissing = allMissing.length > 0 ? allMissing[ 0 ] : null
            const fix = firstMissing
                ? `Get keys: ${appConfig[ 'cliCommand' ]} dev env acquire --key ${firstMissing}. Or use --force.`
                : `Set a key or use --force.`
            const result = {
                'status': false,
                'error': `Cannot activate "${toolName}" — no keyless provider available; all require keys: ${allMissing.join( ', ' )}`,
                fix
            }

            return { 'allowed': false, 'activatableRefs': [], degraded, result }
        }

        return {
            'allowed': true,
            'activatableRefs': activatable.map( ( e ) => e[ 'ref' ] ),
            degraded,
            'result': null
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
  how-to                              Embedded usage prompt for CLAUDE.md

Tool Discovery:
  search <query>                      Find available tools
  list                                Show all tools from the configured schemaFolders

Execution:
  run                                 Start MCP server (stdio)
  call list-tools                     List all available tools
  call <tool-name> [json]             Execute a tool call (no activation needed)

Schema Folders (Memo 099):
  Tools come directly from the folders listed in schemaFolders[] in
  ~/.flowmcp/config.json. Add a folder by editing that array (name + path).
  No "add"/"import" — every tool in every folder is immediately callable.
  A tool whose required API key is missing is shown as
  "[disabled: missing KEY]" and skipped; the rest stay usable.

Development & Schema Maintenance:
  ${cmd} dev <subcommand>             See "${cmd} dev --help" for all dev commands
                                      (validate, test, allowlist, migrate-config,
                                       selection, lists, schemas, status,
                                       prompt, resource, etc.)

Options:
  --tools <list>              Comma-separated tool refs (source/file.mjs::route)
  --route <name>              Filter test to a single route
  --basis <name>              Override basis folder (default: flowmcp)
  --yes, -y                   Auto-confirm prompts
  --dry-run                   Preview changes without applying
  --help, -h                  Show this help message

ID Format (v4):
  namespace/tool/name         Single tool   (2 slashes)
  namespace/schema-name       All tools from a schema  (1 slash)

Note: Run "${cmd} init" first. This is the only interactive command.
      All other commands are designed for AI agents (non-interactive, JSON I/O).
`

        process.stdout.write( helpText )
    }


    static #printDevHelpText() {
        const cmd = appConfig[ 'cliCommand' ]
        const helpText = `Usage: ${cmd} dev <subcommand> [options]

Development & Schema Maintenance commands. Tier 2 — used by schema authors
and maintainers. AI agents typically use Tier 1 commands (${cmd} --help).

Validation & Testing:
  dev validate [path]                 Validate schema(s) structurally
  (Memo 102: "dev test project/user/single" removed — its PASS criterion was a
   strict subset of the deterministic grading pretest. Use:
     grading deterministic <namespace>/<schema>        structural validate + data pretest
     grading deterministic <namespace>/tool/<name>     restrict to one tool
       --only=<csv>                   v4-primitive view: tools | resources | skills | prompts | selections)

Configuration:
  dev allowlist --add <library>       Add library to allowlist (flowmcp.config.json)
  dev allowlist --remove <library>    Remove library from allowlist
  dev allowlist --list                Show current allowlist
  dev migrate-config                  Migrate config from v3 path::route format to v4 spec-IDs

Schema Management:
  dev schemas                         List all schemas from the configured schemaFolders
  dev import-agent <url>              Import an agent manifest
  dev status                          Show config, schemaFolders and health info
  (Memo 099: import/import-registry/update removed — add a folder by editing
   schemaFolders[] in ~/.flowmcp/config.json; clone repos with "gh repo clone")

Prompt Management:
  dev prompt list                            List all prompts across all groups
  dev prompt search <query>                  Search prompts by title/description
  dev prompt show <group>/<name>             Display prompt file content
  dev prompt add <group> <name> --file <p>   Add a prompt to a group
  dev prompt remove <group> <name>           Remove a prompt from a group

Resource Management:
  dev resource create <schema-path>          Create SQLite DBs for file-based resources
  dev resource migrate                       Migrate old DB paths to new origin system

Selection Management (v4):
  dev selection list                         List all selections
  dev selection show <name>                  Show selection details
  dev selection validate <path>              Validate a selection file

Grading (v2 — experimental; CLI surface may change):
  grading deterministic <id>                 Structural validate + deterministic data pretest, no scoring (alias: "det"). <id> = <namespace>/<schema> or <namespace>/tool/<name>
    --only=<csv>                             Restrict to v4 primitives. Allowed: tools | resources | skills | prompts | selections
  grading non-deterministic <ns|selection> --emit-prompts
                                             Stage 1 (alias: "nondet"): deterministic pretest + emit ONE self-contained handoff (area-set + Task-ID) for a grading sub-agent (schema read live from schemaFolders[]; the island is built on first run — no separate import step)
  grading non-deterministic <ns|selection> --consume-scores <path>
                                             Stage 3: consume ONE scores payload back; verifies the Task-ID + area-set + per-area question-count (partial-set supported), rebuilds the index, finalizes
    --phase <area[,area...]>                 Restrict grading to an area set: no flag = all applicable areas; one area = single mode; comma-set = subset mode (named-but-not-emittable areas are reported, never silently dropped)
    --on-conflict <abort|skip|overwrite>     Write-conflict policy (default: no-overwrite)
    --no-save                                Run grading without writing to the island (no index.json/grade.json/state.json, no pretest persist); orthogonal to --on-conflict
    --grading-data <path>                    Override the island location for this call
    --export-dir <path>                      Override the export destination root for this call
  grading export <ns|selection>              Export graded state (index.json) back to the source
  grading state <ns|selection>               Show current rollup status (read-only); carries the nextAction split (deterministic-now CLI work vs ONE non-deterministic area-set + Task-ID preview, plus gated areas with reasons)
  grading worklist <ns>                      Deterministic defect list only (subsumed into "doctor"; kept for back-compat)
  grading doctor <ns>                        Local, read-only "defects + last tips + next step": merges the deterministic defects, the last LLM improvement tips, a next re-entry loop, and the same nextAction split as "state" (never online, never writes grade.json)
  (also available as "${cmd} grading ..." — the "dev" prefix is optional)
  Two-level handover: the CLI emits ONE self-contained artifact for a sub-agent
    and consumes ONE payload back — one area-set, one Task-ID, one round-trip.
  Island default: ~/.flowmcp/grading (override via --grading-data,
    FLOWMCP_GRADING_DATA, or "gradingDataDir" in ~/.flowmcp/config.json)
  Export default: <island>/_exports (override via --export-dir,
    FLOWMCP_GRADING_EXPORT, or "gradingExportDir" in ~/.flowmcp/config.json)
  Target <id> forms:
    namespace                 whole provider           (no slash),  e.g. etherscan
    namespace/schema-name     all tools from a schema  (1 slash),   e.g. etherscan/balance
    namespace/tool/name       a single tool            (2 slashes), e.g. etherscan/tool/getBalance
    namespace/selection/name  a named selection                     e.g. core/selection/mvp
    optional prefix source:   pick one schemaFolders[] source       e.g. Production:etherscan/tool/getBalance
      (CLI feature; the source coordinate is not part of the Spec-ID itself)

Shared Lists (v4):
  dev lists list                             List all shared lists
  dev lists show <name>                      Show shared list details
  dev lists add-entry <name> <jsonEntry>     Add an entry to a shared list
  dev lists refs <alias>                     Backward-lookup: who references this alias?

Environment (.env):
  dev env doctor                             Coverage check: which required keys are missing?
  dev env acquire                            Sign-up help for missing providers
  dev env backup                             Snapshot the current .env
  dev env restore <file>                     Restore .env from a backup
  dev env diff <file>                        Compare current .env against a backup (key names only)

Other:
  dev cache <subcommand>                     Manage tool cache
  dev validate-catalog                       Validate a catalog file
  dev skill <subcommand>                     Skill management
  dev catalog <subcommand>                   Catalog management

Run "${cmd} --help" for Tier 1 commands (agent-facing).
`

        process.stdout.write( helpText )
    }


    static devHelp() {
        FlowMcpCli.#printDevHelpText()

        return { result: { status: true } }
    }


    static async howTo( { cwd: _cwd } = {} ) {
        const cmd = appConfig[ 'cliCommand' ]
        const text = `# ${cmd} — How to use

700+ data tools. Search, activate, call.

## Workflow

1. \`${cmd} search <topic>\`                Find tools
2. \`${cmd} add <id>\`                      Activate
3. \`${cmd} call <id> [args]\`              Get data

## ID Format

  namespace/tool/name                      Single tool  (2 slashes)
  namespace/schema-name                    All tools from a schema  (1 slash)

## Examples

\`\`\`
${cmd} search ethereum blocks
${cmd} add etherscan/tool/getContractAbi
${cmd} call etherscan/tool/getContractAbi '{"address":"0x...","chain":"ETHEREUM_MAINNET"}'

${cmd} add moralis/nftApi
${cmd} list
\`\`\`

## Development Commands

Run \`${cmd} dev --help\` for development commands (validate, test,
allowlist, migrate-config, etc.).
`

        process.stdout.write( text )

        return { result: { status: true } }
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
                throw new Error(
                    `FlowMCP requires an .env file at ${envPath}.\n` +
                    `Create it manually with your API keys, then re-run this command.\n` +
                    `Or specify a custom path: flowmcp init --env-path <path>\n` +
                    `Template:\n` +
                    `  ETHERSCAN_API_KEY=your_key\n` +
                    `  MORALIS_API_KEY=your_key\n` +
                    `  # See 'flowmcp dev env doctor --print-signups' for all required keys.`
                )
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
            await FlowMcpCli.#writeGuarded( { 'path': join( demoDir, 'ping.mjs' ), 'content': demoContent, 'onExists': 'overwrite' } )
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

        await FlowMcpCli.#writeGuarded( { 'path': localConfigPath, 'content': JSON.stringify( mergedLocalConfig, null, 4 ), 'onExists': 'overwrite' } )
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

            await FlowMcpCli.#writeGuarded( { 'path': localConfigPath, 'content': JSON.stringify( updatedLocalConfig, null, 4 ), 'onExists': 'overwrite' } )
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
            await FlowMcpCli.#writeGuarded( { 'path': join( demoDir, 'ping.mjs' ), 'content': demoContent, 'onExists': 'overwrite' } )
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

        await FlowMcpCli.#writeGuarded( { 'path': localConfigPath, 'content': JSON.stringify( mergedLocalConfig, null, 4 ), 'onExists': 'overwrite' } )

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

                    await FlowMcpCli.#writeGuarded( { 'path': localGroupConfigPath, 'content': JSON.stringify( updatedLocalConfig, null, 4 ), 'onExists': 'overwrite' } )

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


    static #getAllTestsTyped( { main } ) {
        const schemaRef = main[ 'namespace' ] || 'unknown'
        const tests = []

        // (1) Tools (also accepts legacy v1.x `routes`)
        const tools = main[ 'tools' ] || main[ 'routes' ] || {}
        Object.entries( tools )
            .forEach( ( [ toolName, toolConfig ] ) => {
                const toolTests = toolConfig[ 'tests' ] || []

                toolTests
                    .forEach( ( testCase ) => {
                        const { _description, ...userParams } = testCase

                        tests.push( {
                            'primitive': 'tool',
                            schemaRef,
                            'name': toolName,
                            'test': { '_description': _description || '', userParams },
                            'context': { 'routeName': toolName }
                        } )
                    } )
            } )

        // (2) Resources — main.resources is an object of resources, each with queries, each with tests
        const resources = main[ 'resources' ] || {}
        Object.entries( resources )
            .forEach( ( [ resourceName, resourceConfig ] ) => {
                const queries = resourceConfig[ 'queries' ] || {}

                Object.entries( queries )
                    .forEach( ( [ queryName, queryConfig ] ) => {
                        const queryTests = queryConfig[ 'tests' ] || []

                        queryTests
                            .forEach( ( testCase ) => {
                                const { _description, ...userParams } = testCase

                                tests.push( {
                                    'primitive': 'resource',
                                    schemaRef,
                                    'name': `${resourceName}.${queryName}`,
                                    'test': { '_description': _description || '', userParams },
                                    'context': { resourceName, queryName }
                                } )
                            } )
                    } )
            } )

        // (3) Skills — Structural-Tests; implizites Structural-Test-Set falls keine tests
        const skills = main[ 'skills' ] || []
        skills
            .forEach( ( skill ) => {
                const skillName = skill[ 'name' ]
                const explicitTests = skill[ 'tests' ] || []

                const skillTests = explicitTests.length > 0
                    ? explicitTests
                    : [ { '_description': `Structural: ${skillName}` } ]

                skillTests
                    .forEach( ( testCase ) => {
                        const { _description, ...userParams } = testCase

                        tests.push( {
                            'primitive': 'skill',
                            schemaRef,
                            'name': skillName,
                            'test': { '_description': _description || '', userParams },
                            'context': { skill, 'kind': 'structural' }
                        } )
                    } )
            } )

        // (4) Prompts
        const prompts = main[ 'prompts' ] || []
        prompts
            .forEach( ( prompt ) => {
                const promptName = prompt[ 'name' ]
                const promptTests = prompt[ 'tests' ] || []

                promptTests
                    .forEach( ( testCase ) => {
                        const { _description, ...userParams } = testCase

                        tests.push( {
                            'primitive': 'prompt',
                            schemaRef,
                            'name': promptName,
                            'test': { '_description': _description || '', userParams },
                            'context': { prompt }
                        } )
                    } )
            } )

        // (5) Selection — transitive Member-Liste + Inline-Skills
        const selection = main[ 'selection' ] || null
        if( selection ) {
            const memberLists = [
                { 'type': 'tool',     'ids': selection[ 'tools' ] || [] },
                { 'type': 'resource', 'ids': selection[ 'resources' ] || [] },
                { 'type': 'prompt',   'ids': selection[ 'prompts' ] || [] }
            ]

            memberLists
                .forEach( ( { type, ids } ) => {
                    ids
                        .forEach( ( memberId ) => {
                            tests.push( {
                                'primitive': 'selection-member',
                                schemaRef,
                                'name': memberId,
                                'test': { '_description': `Selection member: ${memberId}`, 'userParams': {} },
                                'context': { memberId, 'memberType': type }
                            } )
                        } )
                } )

            const inlineSkills = selection[ 'skills' ] || []

            inlineSkills
                .forEach( ( skill ) => {
                    const skillName = skill[ 'name' ]
                    const skillTests = skill[ 'tests' ] || [ { '_description': `Selection-skill (structural): ${skillName}` } ]

                    skillTests
                        .forEach( ( testCase ) => {
                            const { _description, ...userParams } = testCase

                            tests.push( {
                                'primitive': 'skill',
                                schemaRef,
                                'name': skillName,
                                'test': { '_description': _description || '', userParams },
                                'context': { skill, 'kind': 'selection-inline' }
                            } )
                        } )
                } )
        }

        return tests
    }


    static #getAllTests( { main } ) {
        const typedTests = FlowMcpCli.#getAllTestsTyped( { main } )

        // Compat-shim: legacy callers receive flat tool-only entries with top-level routeName + userParams
        const flatTests = typedTests
            .filter( ( entry ) => entry[ 'primitive' ] === 'tool' )
            .map( ( entry ) => {
                const { _description, userParams } = entry[ 'test' ]

                return {
                    'routeName': entry[ 'name' ],
                    'description': _description || '',
                    userParams
                }
            } )

        return flatTests
    }


    // internal: test access only
    static _testHook_getAllTestsTyped( { main } ) {
        return FlowMcpCli.#getAllTestsTyped( { main } )
    }


    // Output capture: full string in JSON mode (fullOutput), 200-char preview otherwise.
    // The human/terminal renderer never prints this field, so the preview cap only ever
    // affected the JSON payload that machine analysis consumes — full output is required there.
    static #limitOutput( { dataAsString, fullOutput } ) {
        const previewLimit = 200

        if( !dataAsString ) {
            return null
        }

        return fullOutput === true ? dataAsString : dataAsString.slice( 0, previewLimit )
    }


    // PRD-005: Primitive-aware test dispatcher (v4-ready)
    // Routes per typedTest.primitive: tool, resource, skill, prompt, selection-member
    // Always returns { status, error, output, durationMs, primitive } — never throws
    static async #executeTest( { typedTest, schemaMain, schemaSource = null, handlerMap = {}, resourceHandlerMap = {}, serverParams = {}, sharedLists = {}, fullOutput = false } ) {
        const startedAt = Date.now()
        const primitive = typedTest[ 'primitive' ]

        try {
            if( primitive === 'tool' ) {
                const { routeName } = typedTest[ 'context' ]
                const { userParams } = typedTest[ 'test' ]

                const fetchResult = await FlowMCP.fetch( {
                    'main': schemaMain,
                    handlerMap,
                    userParams,
                    serverParams,
                    routeName
                } )

                const { status, messages, dataAsString } = fetchResult
                const output = FlowMcpCli.#limitOutput( { dataAsString, fullOutput } )
                const error = status ? null : ( ( messages || [] )[ 0 ] || 'unknown error' )

                return {
                    status,
                    error,
                    output,
                    'durationMs': Date.now() - startedAt,
                    primitive
                }
            }

            if( primitive === 'resource' ) {
                const { resourceName, queryName } = typedTest[ 'context' ]
                const { userParams } = typedTest[ 'test' ]
                const resources = schemaMain[ 'resources' ] || {}
                const resourceDefinition = resources[ resourceName ]
                const schemaRef = typedTest[ 'schemaRef' ] || schemaMain[ 'namespace' ] || 'unknown'

                if( !resourceDefinition ) {
                    return {
                        'status': false,
                        'error': `resource "${resourceName}" not found in schema`,
                        'output': null,
                        'durationMs': Date.now() - startedAt,
                        primitive
                    }
                }

                const execResult = await FlowMCP.executeResource( {
                    resourceDefinition,
                    resourceName,
                    queryName,
                    userParams,
                    'handlerMap': resourceHandlerMap,
                    schemaRef
                } )

                const struct = execResult && execResult[ 'struct' ] ? execResult[ 'struct' ] : execResult || {}
                const ok = struct[ 'status' ] === true
                const dataString = struct[ 'dataAsString' ]
                    ? struct[ 'dataAsString' ]
                    : ( struct[ 'data' ] ? JSON.stringify( struct[ 'data' ] ) : null )
                const output = FlowMcpCli.#limitOutput( { 'dataAsString': dataString, fullOutput } )
                const error = ok ? null : ( ( struct[ 'messages' ] || [] )[ 0 ] || 'resource execution failed' )

                return {
                    'status': ok,
                    error,
                    output,
                    'durationMs': Date.now() - startedAt,
                    primitive
                }
            }

            if( primitive === 'skill' ) {
                // TODO PRD-005: import SkillContentGenerator + PlaceholderResolver from flowmcp/v4 once subpath is exported
                // Currently flowmcp package only exposes ./v2; v4 modules exist in flowmcp-core/src/v4 but no package export
                return {
                    'status': true,
                    'error': null,
                    'output': 'skill-structural-test (TODO: import SkillContentGenerator/PlaceholderResolver from flowmcp/v4)',
                    'durationMs': Date.now() - startedAt,
                    primitive
                }
            }

            if( primitive === 'prompt' ) {
                // TODO PRD-005: import PlaceholderResolver from flowmcp/v4 once subpath is exported
                return {
                    'status': true,
                    'error': null,
                    'output': 'prompt-structural-test (TODO: import PlaceholderResolver from flowmcp/v4)',
                    'durationMs': Date.now() - startedAt,
                    primitive
                }
            }

            if( primitive === 'selection-member' ) {
                // TODO PRD-005: transitive resolution via IdResolver + recursive #getAllTestsTyped on sub-schema
                return {
                    'status': true,
                    'error': null,
                    'output': 'selection-member (transitive-not-yet-implemented)',
                    'durationMs': Date.now() - startedAt,
                    primitive
                }
            }

            return {
                'status': false,
                'error': `unknown primitive: ${primitive}`,
                'output': null,
                'durationMs': Date.now() - startedAt,
                primitive
            }
        } catch( err ) {
            return {
                'status': false,
                'error': err && err.message ? err.message : String( err ),
                'output': null,
                'durationMs': Date.now() - startedAt,
                primitive
            }
        }
    }


    // PRD-005: Iterate typed tests + dispatch + aggregate per-primitive summary
    // Returns { results, summary: { byPrimitive: {...}, overall: 'PASS' | 'FAIL' } }
    static async #runTypedTests( { main, schemaSource = null, handlerMap = {}, resourceHandlerMap = {}, serverParams = {}, sharedLists = {}, fullOutput = false } ) {
        const typedTests = FlowMcpCli.#getAllTestsTyped( { main } )

        const results = await typedTests
            .reduce( ( promise, typedTest ) => promise.then( async ( acc ) => {
                const result = await FlowMcpCli.#executeTest( {
                    typedTest,
                    'schemaMain': main,
                    schemaSource,
                    handlerMap,
                    resourceHandlerMap,
                    serverParams,
                    sharedLists,
                    fullOutput
                } )

                acc.push( {
                    'primitive': typedTest[ 'primitive' ],
                    'name': typedTest[ 'name' ],
                    'schemaRef': typedTest[ 'schemaRef' ],
                    ...result
                } )

                return acc
            } ), Promise.resolve( [] ) )

        const byPrimitive = results
            .reduce( ( acc, r ) => {
                const key = r[ 'primitive' ] || 'unknown'

                if( !acc[ key ] ) {
                    acc[ key ] = { 'pass': 0, 'fail': 0 }
                }

                if( r[ 'status' ] === true ) {
                    acc[ key ][ 'pass' ] = acc[ key ][ 'pass' ] + 1
                } else {
                    acc[ key ][ 'fail' ] = acc[ key ][ 'fail' ] + 1
                }

                return acc
            }, {} )

        const totalFail = Object
            .values( byPrimitive )
            .reduce( ( sum, v ) => sum + v[ 'fail' ], 0 )

        const overall = totalFail === 0 ? 'PASS' : 'FAIL'

        return {
            results,
            'summary': { byPrimitive, overall }
        }
    }


    // PRD-006: validate --only=<csv> filter, map plural CLI values -> internal singular discriminators
    static #validateOnlyFilter( { only } ) {
        if( only === undefined || only === null || only === '' ) {
            return { 'filter': null, 'error': null }
        }

        const allowed = [ 'tools', 'resources', 'skills', 'prompts', 'selections' ]
        const requested = only
            .split( ',' )
            .map( ( s ) => s.trim() )
            .filter( ( s ) => s.length > 0 )

        const invalid = requested
            .filter( ( r ) => {
                const isInvalid = !allowed.includes( r )

                return isInvalid
            } )

        if( invalid.length > 0 ) {
            return {
                'filter': null,
                'error': `Invalid --only values: ${invalid.join( ', ' )}. Allowed: ${allowed.join( ', ' )}`
            }
        }

        const primitiveMap = {
            'tools': 'tool',
            'resources': 'resource',
            'skills': 'skill',
            'prompts': 'prompt',
            'selections': 'selection-member'
        }

        const filter = requested
            .map( ( r ) => {
                return primitiveMap[ r ]
            } )

        return { filter, 'error': null }
    }


    // PRD-006: compute "declared" map per primitive from a schema main
    static #computeDeclared( { main } ) {
        const safeMain = main || {}
        const tools = safeMain[ 'tools' ] || safeMain[ 'routes' ]
        const resources = safeMain[ 'resources' ]
        const skills = safeMain[ 'skills' ]
        const prompts = safeMain[ 'prompts' ]
        const selection = safeMain[ 'selection' ]

        const declared = {
            'tool':              tools !== undefined && tools !== null,
            'resource':          resources !== undefined && resources !== null,
            'skill':             skills !== undefined && skills !== null,
            'prompt':            prompts !== undefined && prompts !== null,
            'selection-member':  selection !== undefined && selection !== null
        }

        return { declared }
    }


    // PRD-006: aggregate per-primitive summary { passed, total, declared, filtered }
    static #aggregateByPrimitive( { results, declared, filter } ) {
        const primitives = [ 'tool', 'resource', 'skill', 'prompt', 'selection-member' ]
        const safeResults = results || []
        const safeDeclared = declared || {}
        const filteredSet = filter ? new Set( filter ) : null

        const summary = primitives
            .reduce( ( acc, p ) => {
                const own = safeResults
                    .filter( ( r ) => {
                        const matches = r[ 'primitive' ] === p

                        return matches
                    } )

                const passed = own
                    .filter( ( r ) => {
                        const isPass = r[ 'status' ] === true

                        return isPass
                    } )
                    .length

                const total = own.length
                const isFiltered = filteredSet ? !filteredSet.has( p ) : false
                const isDeclared = safeDeclared[ p ] === true

                acc[ p ] = {
                    passed,
                    total,
                    'declared': isDeclared,
                    'filtered': isFiltered
                }

                return acc
            }, {} )

        return { summary }
    }


    // PRD-006: render human-readable per-primitive output
    static #renderHumanOutput( { summary, overall } ) {
        const formatLine = ( { label, info } ) => {
            const padded = label.padEnd( 13 )

            return `${padded}${info}`
        }

        const fmt = ( { p, label, extra } ) => {
            const s = summary[ p ] || { 'passed': 0, 'total': 0, 'declared': false, 'filtered': false }

            if( s[ 'filtered' ] ) {
                return formatLine( { label, 'info': 'skipped (filtered)' } )
            }

            if( !s[ 'declared' ] ) {
                return formatLine( { label, 'info': 'none' } )
            }

            if( s[ 'total' ] === 0 ) {
                return formatLine( { label, 'info': '0/0 (none declared)' } )
            }

            const status = s[ 'passed' ] === s[ 'total' ] ? 'PASS' : 'FAIL'
            const tail = extra ? ` (${extra})` : ''

            return formatLine( { label, 'info': `${s[ 'passed' ]}/${s[ 'total' ]} ${status}${tail}` } )
        }

        const lines = []
        lines.push( fmt( { 'p': 'tool',              'label': 'Tools:' } ) )
        lines.push( fmt( { 'p': 'resource',          'label': 'Resources:' } ) )
        lines.push( fmt( { 'p': 'skill',             'label': 'Skills:',     'extra': 'structural' } ) )
        lines.push( fmt( { 'p': 'prompt',            'label': 'Prompts:' } ) )
        lines.push( fmt( { 'p': 'selection-member', 'label': 'Selections:', 'extra': 'Members' } ) )
        lines.push( '' )
        lines.push( `Overall: ${overall ? 'PASS' : 'FAIL'}` )

        return { 'text': lines.join( '\n' ) }
    }


    // PRD-006: render JSON output { overall, primitives, tests }
    static #renderJsonOutput( { summary, overall, results, schemaRef } ) {
        const safeResults = results || []

        const json = {
            'schemaRef': schemaRef || null,
            'overall':   overall ? 'PASS' : 'FAIL',
            'primitives': {
                'tools':       summary[ 'tool' ],
                'resources':   summary[ 'resource' ],
                'skills':      summary[ 'skill' ],
                'prompts':     summary[ 'prompt' ],
                'selections':  summary[ 'selection-member' ]
            },
            'tests': safeResults
                .map( ( r ) => {
                    return {
                        'primitive':  r[ 'primitive' ] || null,
                        'name':       r[ 'name' ] || null,
                        'status':     r[ 'status' ] ? 'PASS' : 'FAIL',
                        'error':      r[ 'error' ] || null,
                        'durationMs': r[ 'durationMs' ] || 0,
                        'output':     r[ 'output' ] || null
                    }
                } )
        }

        return { json, 'text': JSON.stringify( json, null, 2 ) }
    }


    // PRD-006: unified formatter — returns string (human) or JSON object (json)
    static #formatTestSummary( { summary, results, format = 'human', overall = null, schemaRef = null } ) {
        const safeResults = results || []
        const computedOverall = overall !== null
            ? overall
            : safeResults
                .filter( ( r ) => {
                    const isFail = r[ 'status' ] === false

                    return isFail
                } )
                .length === 0

        if( format === 'json' ) {
            const { json } = FlowMcpCli.#renderJsonOutput( {
                summary,
                'overall': computedOverall,
                'results': safeResults,
                schemaRef
            } )

            return { 'value': json, 'text': JSON.stringify( json, null, 2 ) }
        }

        const { text } = FlowMcpCli.#renderHumanOutput( { summary, 'overall': computedOverall } )

        return { 'value': text, text }
    }


    // internal: test access only — PRD-006
    static _testHook_validateOnlyFilter( { only } ) {
        return FlowMcpCli.#validateOnlyFilter( { only } )
    }


    // internal: test access only — PRD-006
    static _testHook_computeDeclared( { main } ) {
        return FlowMcpCli.#computeDeclared( { main } )
    }


    // internal: test access only — PRD-006
    static _testHook_aggregateByPrimitive( { results, declared, filter } ) {
        return FlowMcpCli.#aggregateByPrimitive( { results, declared, filter } )
    }


    // internal: test access only — PRD-006
    static _testHook_formatTestSummary( { summary, results, format, overall, schemaRef } ) {
        return FlowMcpCli.#formatTestSummary( { summary, results, format, overall, schemaRef } )
    }


    // internal: test access only — PRD-005
    static async _testHook_executeTest( { typedTest, schemaMain, handlerMap, resourceHandlerMap, serverParams, sharedLists, fullOutput = false } ) {
        return await FlowMcpCli.#executeTest( {
            typedTest,
            schemaMain,
            'handlerMap': handlerMap || {},
            'resourceHandlerMap': resourceHandlerMap || {},
            'serverParams': serverParams || {},
            'sharedLists': sharedLists || {},
            fullOutput
        } )
    }


    // internal: test access only — PRD-005
    static async _testHook_runTypedTests( { main, schemaSource = null, handlerMap, resourceHandlerMap, serverParams, sharedLists, fullOutput = false } ) {
        return await FlowMcpCli.#runTypedTests( {
            main,
            schemaSource,
            'handlerMap': handlerMap || {},
            'resourceHandlerMap': resourceHandlerMap || {},
            'serverParams': serverParams || {},
            'sharedLists': sharedLists || {},
            fullOutput
        } )
    }


    static async #resolveHandlers( { main, handlersFn, filePath } ) {
        let handlerMap = {}
        let resourceHandlerMap = {}

        if( !handlersFn ) {
            return { handlerMap, resourceHandlerMap }
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
                // Befund C / flowmcp-cli#44: resolve required libraries from a DETERMINISTIC
                // base (the CLI install dir, whose node_modules ships the allowed libs such
                // as ethers) instead of the schema file location. The schema may live under
                // ~/.flowmcp/schemas/<source>/ whose node_modules does NOT carry ethers — that
                // was the root cause of the "ethers nicht auffindbar" workaround. We try the
                // deterministic base first, then fall back to the schema-anchored require for
                // local dev where a schema ships its own deps. A genuinely unresolvable lib is
                // surfaced explicitly (No Silent Defaults) rather than swallowed.
                const { resolveBase } = FlowMcpCli.#resolveLibraryBase()
                const baseRequire = createRequire( join( resolveBase, 'index.js' ) )
                const schemaRequire = createRequire( resolve( filePath ) )
                const unresolved = []

                await requiredLibraries
                    .reduce( ( promise, lib ) => promise.then( async () => {
                        const loaded = await FlowMcpCli.#loadOneLibrary( { lib, baseRequire, schemaRequire } )

                        if( loaded[ 'status' ] === true ) {
                            libraries[ lib ] = loaded[ 'module' ]
                        } else {
                            unresolved.push( lib )
                        }
                    } ), Promise.resolve() )

                if( unresolved.length > 0 ) {
                    throw new Error( `LIB-RESOLVE: required librar${unresolved.length === 1 ? 'y' : 'ies'} not resolvable from CLI base (${resolveBase}) nor schema dir: ${unresolved.join( ', ' )}. Install the librar${unresolved.length === 1 ? 'y' : 'ies'} into the CLI (npm install <lib>) so handlers can load deterministically.` )
                }
            }

            const tempHandlers = handlersFn( { sharedLists, libraries } )
            const allRouteNames = Object.keys( tempHandlers || {} )
            const resources = main[ 'resources' ] || {}
            const created = FlowMCP.createHandlers( { handlersFn, sharedLists, libraries, 'routeNames': allRouteNames, resources } )
            handlerMap = created[ 'handlerMap' ] || {}
            resourceHandlerMap = created[ 'resourceHandlerMap' ] || {}
        } catch( resolveErr ) {
            // No Silent Defaults: a handler-resolution failure (e.g. an unresolvable required
            // library or shared-list ref) must be visible, not swallowed into empty handlers
            // that later surface as a confusing "No response received from server". The empty
            // maps are still returned so callers can degrade, but the cause is always reported.
            console.error( `[resolveHandlers] handler resolution failed: ${resolveErr.message}` )
            handlerMap = {}
            resourceHandlerMap = {}
        }

        return { handlerMap, resourceHandlerMap }
    }


    static async #loadOneLibrary( { lib, baseRequire, schemaRequire } ) {
        // Deterministic base first (CLI install node_modules), then schema-dir fallback.
        const requires = [ baseRequire, schemaRequire ]

        const attempt = await requires
            .reduce( async ( accPromise, req ) => {
                const acc = await accPromise

                if( acc[ 'status' ] === true ) {
                    return acc
                }

                try {
                    const resolvedPath = req.resolve( lib )

                    try {
                        const mod = await import( pathToFileURL( resolvedPath ).href )
                        return { 'status': true, 'module': mod.default || mod }
                    } catch( importErr ) {
                        const mod = req( lib )
                        return { 'status': true, 'module': mod.default || mod }
                    }
                } catch( resolveErr ) {
                    return acc
                }
            }, Promise.resolve( { 'status': false, 'module': null } ) )

        return attempt
    }


    static #resolveLibraryBase() {
        // The CLI package root: src/task/FlowMcpCli.mjs -> ../../ . Its node_modules ships the
        // allowlisted runtime libs (ethers, better-sqlite3). createRequire wants a referencing
        // filename, so callers anchor on an index.js inside this base (need not exist).
        const here = dirname( fileURLToPath( import.meta.url ) )
        const resolveBase = join( here, '..', '..' )

        return { resolveBase }
    }


    static #findListsDir( { filePath } ) {
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


    static async #mirrorSharedToLists( { targetPath } ) {
        const resolved = resolve( targetPath )
        const parent = dirname( resolved )

        if( basename( parent ) !== '_shared' ) {
            return { 'mirrored': false, 'reason': 'not-shared-segment' }
        }

        const listsDir = join( dirname( parent ), '_lists' )
        const listsPath = join( listsDir, basename( resolved ) )
        const content = await readFile( resolved, 'utf-8' )
        const { written, skipped } = await FlowMcpCli.#writeGuarded( {
            'path': listsPath,
            content,
            'onExists': 'skip'
        } )

        return { 'mirrored': written, skipped }
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
        const routes = main[ 'tools' ] || main[ 'routes' ] || {}
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


    // Memo 099 Kap 5 — load ALL schemas from the configured schemaFolders[].
    // No activation: every tool in every folder is immediately resolvable.
    static async #resolveAllSchemas() {
        const { sources, error: sourcesError, fix: sourcesFix } = await FlowMcpCli.#listSources()

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
                        const { filePath } = await FlowMcpCli.#resolveSchemaPath( { schemaRef } )
                        const { main, handlersFn } = await FlowMcpCli.#loadSchema( { filePath } )

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


    static #error( { error, fix } ) {
        const result = { 'status': false, error }
        if( fix ) {
            result[ 'fix' ] = fix
        }

        return result
    }


    // PRD-4.1 — progress sink. Grading runs are slow (per-schema live pretests), so
    // by default we tick to STDERR while running (Befund B: no progress). The machine
    // JSON stays on STDOUT untouched. --quiet (quiet === true) silences the ticks.
    // Stderr is chosen so a piped `... | jq` on stdout is never polluted.
    static #emitProgress( { quiet, message } ) {
        if( quiet === true ) { return }
        process.stderr.write( `[grading] ${message}\n` )
    }


    // PRD-4.2 — concise human summary for a deterministic result, to STDERR.
    // JSON-shape audit conclusion: NO machine key is dropped/renamed (rollup +
    // Provider-Proof consumers depend on them); this summary is ADDITIVE and lives
    // on stderr so a piped stdout stays pure JSON. Suppressed by --quiet and by
    // --json (pure machine mode). Handles both the single-schema and namespace shapes.
    static printDeterministicSummary( { result, quiet, json } ) {
        if( quiet === true || json === true || result === null || result === undefined ) { return }
        if( result[ 'status' ] === false && result[ 'mode' ] === undefined ) {
            process.stderr.write( `[grading] error: ${result[ 'error' ]}\n` )
            return
        }

        const lines = []
        const verdict = result[ 'status' ] === true ? 'PASS' : 'FAIL'
        lines.push( `[grading] ${result[ 'target' ]} — ${verdict}` )

        if( Array.isArray( result[ 'schemas' ] ) === true ) {
            const passed = result[ 'schemas' ].filter( ( s ) => s[ 'status' ] === true ).length
            lines.push( `[grading]   schemas: ${passed}/${result[ 'schemaCount' ]} green` )
        } else if( result[ 'pretest' ] !== undefined && result[ 'pretest' ] !== null ) {
            const pretest = result[ 'pretest' ]
            const validateOk = result[ 'validate' ] !== undefined && result[ 'validate' ] !== null ? result[ 'validate' ][ 'status' ] === true : null
            lines.push( `[grading]   validate: ${validateOk === null ? 'n/a' : ( validateOk ? 'ok' : 'fail' )}  pretest: ${pretest[ 'ok' ] === true ? 'ok' : ( pretest[ 'keyGated' ] === true ? 'key-gated' : 'fail' )}` )
            const stamp = pretest[ 'fromCache' ] === true ? `cached (data ${pretest[ 'dataAt' ]})` : `fresh (data ${pretest[ 'dataAt' ]})`
            lines.push( `[grading]   data: ${stamp}` )
            const below = Array.isArray( pretest[ 'toolsBelowThreshold' ] ) ? pretest[ 'toolsBelowThreshold' ] : []
            if( below.length > 0 ) { lines.push( `[grading]   below bar: ${below.join( ', ' )}` ) }
        }

        if( result[ 'rollupGrade' ] !== undefined ) {
            lines.push( `[grading]   grade: ${result[ 'rollupGrade' ]} (${result[ 'rollupStatus' ]})` )
        }
        if( result[ 'rollupError' ] !== undefined ) {
            lines.push( `[grading]   rollup error: ${result[ 'rollupError' ]}` )
        }

        process.stderr.write( lines.join( '\n' ) + '\n' )
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
        const { sources, error: sourcesError, fix: sourcesFix } = await FlowMcpCli.#listSources()

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
                        const { filePath } = await FlowMcpCli.#resolveSchemaPath( { schemaRef: `${source[ 'name' ]}/${file}` } )
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
        await FlowMcpCli.#writeGuarded( { 'path': filePath, 'content': JSON.stringify( toolSchema, null, 4 ), 'onExists': 'overwrite' } )

        return { filePath }
    }


    static async #findSchemaFiles( { dirPath } ) {
        const entries = await readdir( dirPath, { recursive: true } )
        const files = entries
            .filter( ( entry ) => {
                const ext = extname( entry )
                const isSchema = ext === '.mjs' || ext === '.js'

                return isSchema
            } )
            .map( ( entry ) => {
                const fullPath = join( dirPath, entry )

                return fullPath
            } )
            .sort()

        return { files }
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


    static #normalizeMainForValidation( { main } ) {
        if( !main ) {
            return main
        }

        if( main[ 'tools' ] && !main[ 'routes' ] ) {
            const { tools, resources, skills, ...rest } = main
            const normalizedMain = { ...rest, 'routes': tools }

            return normalizedMain
        }

        return main
    }


    static async #loadV4Module() {
        if( FlowMcpCli.#v4Override ) { return FlowMcpCli.#v4Override }
        try {
            const v4 = await import( 'flowmcp/v4' )
            return v4
        } catch {
            return null
        }
    }


    // Lazy-import for the grading module's public surface (flowmcp-grading/src/index.mjs).
    // Pinned in package.json to a published commit:
    //   "flowmcp-grading": "github:FlowMCP/flowmcp-grading#e911958e91b75799b6efd78c99ebdbe5da103288"
    // (For local cross-repo development, swap to "file:../flowmcp-grading".)
    static async #loadGradingModule() {
        if( FlowMcpCli.#gradingOverride ) { return FlowMcpCli.#gradingOverride }
        try {
            const grading = await import( 'flowmcp-grading' )
            return grading
        } catch {
            return null
        }
    }


    static #enrichV4WithRuntimeMeta( { main, MetaGenerator } ) {
        const tools = main && main[ 'tools' ] ? main[ 'tools' ] : null
        if( !tools || typeof tools !== 'object' ) { return main }

        const enrichedEntries = Object
            .entries( tools )
            .map( ( [ name, tool ] ) => {
                if( tool && tool[ 'meta' ] ) { return [ name, tool ] }
                const { meta } = MetaGenerator.generate( { tool, 'toolName': name } )
                return [ name, { ...tool, meta } ]
            } )

        return { ...main, 'tools': Object.fromEntries( enrichedEntries ) }
    }


    static #validateSingleSchema( { main, file, v4 } ) {
        const namespace = main && main[ 'namespace' ] ? main[ 'namespace' ] : 'unknown'
        const toolCount = Object.keys( ( main && ( main[ 'tools' ] || main[ 'routes' ] ) ) || {} ).length
        const resourceCount = Object.keys( ( main && main[ 'resources' ] ) || {} ).length
        const skillCount = ( ( main && main[ 'skills' ] ) || [] ).length
        const version = main && main[ 'version' ] ? String( main[ 'version' ] ) : ''
        const isV4 = version.startsWith( '4.' )

        const sqliteGtfsErrors = FlowMcpCli.#runSqliteGtfsResourceChecks( { main } )

        try {
            if( isV4 ) {
                if( !v4 || !v4[ 'MainValidator' ] ) {
                    return {
                        file, namespace,
                        'status': false,
                        'messages': [ 'v4 validator unavailable: install flowmcp-core with v4 export' ],
                        'tools': toolCount, 'resources': resourceCount, 'skills': skillCount
                    }
                }
                const enriched = v4[ 'MetaGenerator' ]
                    ? FlowMcpCli.#enrichV4WithRuntimeMeta( { main, 'MetaGenerator': v4[ 'MetaGenerator' ] } )
                    : main
                const { status, messages, warnings } = v4[ 'MainValidator' ].validate( { 'main': enriched } )
                const combinedMessages = [ ...( messages || [] ), ...sqliteGtfsErrors.map( ( e ) => `${e.code}: ${e.message} (${e.path})` ) ]
                const combinedStatus = status && sqliteGtfsErrors.length === 0
                return { file, namespace, 'status': combinedStatus, 'messages': combinedMessages, warnings, 'tools': toolCount, 'resources': resourceCount, 'skills': skillCount }
            }

            const normalizedMain = FlowMcpCli.#normalizeMainForValidation( { main } )
            const { status, messages } = FlowMCP.validateMain( { 'main': normalizedMain } )
            const combinedMessages = [ ...( messages || [] ), ...sqliteGtfsErrors.map( ( e ) => `${e.code}: ${e.message} (${e.path})` ) ]
            const combinedStatus = status && sqliteGtfsErrors.length === 0
            return { file, namespace, 'status': combinedStatus, 'messages': combinedMessages, 'tools': toolCount, 'resources': resourceCount, 'skills': skillCount }
        } catch( err ) {
            const combinedMessages = [ err.message, ...sqliteGtfsErrors.map( ( e ) => `${e.code}: ${e.message} (${e.path})` ) ]
            return {
                file, namespace,
                'status': false,
                'messages': combinedMessages,
                'tools': toolCount, 'resources': resourceCount, 'skills': skillCount
            }
        }
    }


    static #runSqliteGtfsResourceChecks( { main } ) {
        // RES030/RES031/RES035 — structural sqlite-gtfs checks (Memo 051 PRD-17).
        // RES032, RES033, RES034 are pipeline-only — see `flowmcp add` (PRD-18).
        const rawResources = main && main[ 'resources' ]
        if( !rawResources ) { return [] }

        const resourcesArray = Array.isArray( rawResources )
            ? rawResources
            : Object.values( rawResources )

        const hasAnySqliteGtfs = resourcesArray
            .some( ( r ) => {
                const isMatch = r && ADDON_REGISTRY[ r.source ] !== undefined

                return isMatch
            } )

        if( !hasAnySqliteGtfs ) { return [] }

        const { errors } = SqliteGtfsResourceValidator.validateResources( { 'resources': resourcesArray } )

        return errors
    }


    static async #loadGlobalConfig() {
        const globalConfigPath = FlowMcpCli.#globalConfigPath()
        const { data: globalConfig } = await FlowMcpCli.#readJson( { filePath: globalConfigPath } )

        return { globalConfig: globalConfig || {} }
    }


    static #getRegistryPath( { globalConfig } ) {
        const sources = globalConfig[ 'sources' ] || {}
        const sourceNames = Object.keys( sources )

        if( sourceNames.length === 0 ) {
            return null
        }

        const firstSource = sourceNames[ 0 ]
        const registryPath = join( FlowMcpCli.#schemasDir(), firstSource, '_registry.json' )

        return registryPath
    }


    static async #readJsonFile( { filePath } ) {
        const { data } = await FlowMcpCli.#readJson( { filePath } )

        return data
    }


    static #getCatalogDir( { globalConfig } ) {
        const sources = globalConfig[ 'sources' ] || {}
        const sourceNames = Object.keys( sources )

        if( sourceNames.length === 0 ) {
            return FlowMcpCli.#schemasDir()
        }

        const firstSource = sourceNames[ 0 ]
        const catalogDir = join( FlowMcpCli.#schemasDir(), firstSource )

        return catalogDir
    }


    static async importAgent( { agentName, cwd } ) {
        const { initialized, error, fix } = await FlowMcpCli.#requireInit()

        if( !initialized ) {
            return { result: FlowMcpCli.#error( { error, fix } ) }
        }

        if( !agentName ) {
            return { result: FlowMcpCli.#error( { error: 'Missing agent name', fix: 'flowmcp import-agent <agent-name>' } ) }
        }

        const { globalConfig } = await FlowMcpCli.#loadGlobalConfig()
        const registryPath = FlowMcpCli.#getRegistryPath( { globalConfig } )
        const registryData = await FlowMcpCli.#readJsonFile( { filePath: registryPath } )

        if( !registryData ) {
            return { result: FlowMcpCli.#error( { error: 'No registry found', fix: 'Run "flowmcp import-registry <url>" first' } ) }
        }

        const agents = registryData[ 'agents' ] || []
        const agentEntry = agents
            .find( ( entry ) => {
                const isMatch = entry[ 'name' ] === agentName

                return isMatch
            } )

        if( !agentEntry ) {
            const availableNames = agents
                .map( ( entry ) => {
                    const name = entry[ 'name' ]

                    return name
                } )
                .join( ', ' )

            return { result: FlowMcpCli.#error( { error: `Agent "${agentName}" not found in registry`, fix: `Available agents: ${availableNames || 'none'}` } ) }
        }

        const manifestPath = agentEntry[ 'manifest' ]
        const catalogDir = FlowMcpCli.#getCatalogDir( { globalConfig } )
        const fullManifestPath = `${catalogDir}/${manifestPath}`

        let manifest = null

        try {
            manifest = await FlowMcpCli.#readJsonFile( { filePath: fullManifestPath } )
        } catch( err ) {
            return { result: FlowMcpCli.#error( { error: `Cannot read manifest: ${err.message}`, fix: `Check file exists: ${fullManifestPath}` } ) }
        }

        if( !manifest ) {
            return { result: FlowMcpCli.#error( { error: `Manifest not found at ${fullManifestPath}`, fix: 'Re-run "flowmcp import-registry <url>" to download' } ) }
        }

        const tools = manifest[ 'tools' ] || []
        const addedTools = []

        const addPromises = tools
            .map( ( toolId ) => {
                const parts = toolId.split( '/' )
                const toolName = parts[ parts.length - 1 ]

                return { toolId, toolName }
            } )

        addPromises
            .forEach( ( { toolId, toolName } ) => {
                addedTools.push( { toolId, toolName } )
            } )

        const result = {
            status: true,
            agent: agentName,
            description: agentEntry[ 'description' ] || '',
            model: manifest[ 'model' ] || 'not specified',
            tools: addedTools,
            toolCount: addedTools.length,
            message: `Agent "${agentName}" imported with ${addedTools.length} tools`
        }

        return { result }
    }


    static async validateCatalog( { catalogDir, cwd } ) {
        if( !catalogDir ) {
            return { result: FlowMcpCli.#error( { error: 'Missing catalog directory', fix: 'flowmcp validate-catalog <catalog-directory>' } ) }
        }

        const registryPath = join( catalogDir, 'registry.json' )
        let registryData = null

        try {
            const content = await readFile( registryPath, 'utf-8' )
            registryData = JSON.parse( content )
        } catch( err ) {
            return { result: { status: false, errors: [ `CAT001: registry.json must exist in catalog root — ${err.message}` ], warnings: [] } }
        }

        const errors = []
        const warnings = []

        const dirName = catalogDir.split( '/' ).pop()

        if( registryData[ 'name' ] !== dirName ) {
            errors.push( `CAT002: name "${registryData[ 'name' ]}" must match directory name "${dirName}"` )
        }

        const shared = registryData[ 'shared' ] || []

        await Promise.allSettled(
            shared
                .map( async ( entry ) => {
                    const filePath = join( catalogDir, entry[ 'file' ] )

                    try {
                        await stat( filePath )
                    } catch( err ) {
                        errors.push( `CAT003: shared file not found — ${entry[ 'file' ]}` )
                    }
                } )
        )

        const schemas = registryData[ 'schemas' ] || []

        await Promise.allSettled(
            schemas
                .map( async ( entry ) => {
                    const filePath = join( catalogDir, entry[ 'file' ] )

                    try {
                        await stat( filePath )
                    } catch( err ) {
                        errors.push( `CAT004: schema file not found — ${entry[ 'file' ]}` )
                    }
                } )
        )

        const agents = registryData[ 'agents' ] || []

        await Promise.allSettled(
            agents
                .map( async ( entry ) => {
                    const filePath = join( catalogDir, entry[ 'manifest' ] )

                    try {
                        await stat( filePath )
                    } catch( err ) {
                        errors.push( `CAT005: agent manifest not found — ${entry[ 'manifest' ]}` )
                    }
                } )
        )

        const specVersion = registryData[ 'schemaSpec' ] || ''
        const validVersions = [ '2.0.0', '3.0.0' ]

        if( !validVersions.includes( specVersion ) ) {
            errors.push( `CAT007: schemaSpec "${specVersion}" is not a valid FlowMCP specification version` )
        }

        const result = {
            status: errors.length === 0,
            catalog: registryData[ 'name' ] || dirName,
            schemaSpec: specVersion,
            counts: {
                shared: shared.length,
                schemas: schemas.length,
                agents: agents.length
            },
            errors,
            warnings
        }

        return { result }
    }


    static async resourceCreate( { schemaPath, cwd, basis = 'flowmcp', autoConfirm = false } ) {
        const { status: validStatus, messages: validMessages } = FlowMcpCli.validationResourceCreate( { schemaPath } )
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
            const result = FlowMcpCli.#error( {
                'error': `Failed to load schema: ${err.message}`,
                'fix': 'Ensure the schema file exports a valid "main" object.'
            } )

            return { result }
        }

        const main = schemaModule[ 'main' ]
        if( !main ) {
            const result = FlowMcpCli.#error( {
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
                const { dbPath } = FlowMcpCli.#resolveResourcePath( {
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

                    const { tableStatements } = FlowMcpCli.#deriveCreateStatements( { resourceDef } )

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
        const { initialized, error: initError, fix: initFix } = await FlowMcpCli.#requireInit()
        if( !initialized ) {
            const result = FlowMcpCli.#error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const schemasDir = FlowMcpCli.#schemasDir()
        let schemaFiles = []

        try {
            const { files } = await FlowMcpCli.#findSchemaFiles( { 'dirPath': schemasDir } )
            schemaFiles = files
        } catch {
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
                } catch {
                    // Skip schemas that fail to load
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


    static async #callResourceQuery( { toolName, jsonArgs, resolvedSchemas } ) {
        let matchedMain = null
        let matchedHandlersFn = null
        let matchedFile = null
        let matchedResourceName = null
        let matchedQueryName = null

        resolvedSchemas
            .forEach( ( { main, handlersFn, file } ) => {
                if( matchedMain ) {
                    return
                }

                const namespace = main[ 'namespace' ] || 'unknown'
                const resources = main[ 'resources' ] || {}

                Object.entries( resources )
                    .forEach( ( [ resourceName, resourceDef ] ) => {
                        if( matchedMain ) {
                            return
                        }

                        Object.keys( resourceDef[ 'queries' ] || {} )
                            .forEach( ( queryName ) => {
                                if( matchedMain ) {
                                    return
                                }

                                const candidateName = `${queryName}_${namespace}`

                                if( candidateName === toolName ) {
                                    matchedMain = main
                                    matchedHandlersFn = handlersFn
                                    matchedFile = file
                                    matchedResourceName = resourceName
                                    matchedQueryName = queryName
                                }
                            } )
                    } )
            } )

        if( !matchedMain ) {
            return null
        }

        try {
            const schemasBaseDir = FlowMcpCli.#schemasDir()
            const schemaFilePath = matchedFile ? join( schemasBaseDir, matchedFile ) : null
            const { resourceHandlerMap } = await FlowMcpCli.#resolveHandlers( {
                'main': matchedMain,
                'handlersFn': matchedHandlersFn,
                'filePath': schemaFilePath
            } )

            const schemaRef = matchedMain[ 'namespace' ] || 'unknown'
            const resourceDef = matchedMain[ 'resources' ][ matchedResourceName ]

            await FlowMCP.initializeResourceDbs( { 'resources': matchedMain[ 'resources' ], schemaRef } )

            const queryHandlerMap = resourceHandlerMap[ matchedResourceName ] || {}
            const userParams = jsonArgs ? JSON.parse( jsonArgs ) : {}

            const { struct } = await FlowMCP.executeResource( {
                'resourceDefinition': resourceDef,
                'resourceName': matchedResourceName,
                'queryName': matchedQueryName,
                userParams,
                'handlerMap': queryHandlerMap,
                schemaRef
            } )

            const result = {
                'status': struct[ 'status' ],
                'data': struct[ 'data' ],
                'messages': struct[ 'messages' ]
            }

            return { result }
        } catch( err ) {
            const result = FlowMcpCli.#error( {
                'error': `Resource query failed: ${err.message}`,
                'fix': 'Check that the database file exists and is accessible.'
            } )

            return { result }
        }
    }


    static #parseSpecId( { specId } ) {
        if( typeof specId !== 'string' || specId.length === 0 ) {
            return { 'valid': false, 'error': 'Spec-ID must be a non-empty string' }
        }

        // PRD-008 — optional leading "<source>:" coordinate. The colon trenner does
        // not collide with the slash-based Spec-ID grammar, so it is split off first
        // and the remainder is parsed unchanged. No silent default: an empty source
        // ("...:foo") or an empty remainder ("source:") is a hard error.
        let source = null
        let rest = specId
        const colonIndex = specId.indexOf( ':' )
        if( colonIndex !== -1 ) {
            source = specId.slice( 0, colonIndex )
            rest = specId.slice( colonIndex + 1 )

            if( source.length === 0 ) {
                return { 'valid': false, 'error': `Invalid source coordinate in "${specId}": the prefix before ":" must be a schemaFolders[] name.` }
            }

            if( rest.length === 0 ) {
                return { 'valid': false, 'error': `Invalid Spec-ID "${specId}": nothing after the "${source}:" source prefix. Expected "${source}:<namespace>[/tool/name]".` }
            }
        }

        const parts = rest.split( '/' )
        const slashCount = parts.length - 1

        if( slashCount === 0 ) {
            const [ namespace ] = parts
            const namespaceValid = /^[a-z][a-z0-9-]*$/.test( namespace )

            if( namespaceValid === false ) {
                return { 'valid': false, 'error': `Invalid namespace "${namespace}": expected a lowercase identifier matching ^[a-z][a-z0-9-]*$ (e.g. "etherscan").` }
            }

            return { 'valid': true, source, namespace, 'type': 'namespace' }
        }

        if( slashCount === 1 ) {
            const [ namespace, name ] = parts

            return { 'valid': true, source, namespace, 'type': 'schema', name }
        }

        if( slashCount === 2 ) {
            const [ namespace, type, name ] = parts
            const allowedTypes = [ 'tool', 'resource', 'prompt', 'skill', 'selection', 'agent' ]
            const isAllowed = allowedTypes
                .find( ( t ) => {
                    const matches = t === type

                    return matches
                } )

            if( !isAllowed ) {
                return { 'valid': false, 'error': `Unknown Spec-ID type "${type}": expected one of tool|resource|prompt|skill|selection|agent. Example: "${namespace}/tool/${name || 'someRoute'}".` }
            }

            return { 'valid': true, source, namespace, type, name }
        }

        // Per-test selector: "<namespace>/tool/<name>/tests/<N>" (4 slashes). The finest
        // addressing granularity — one recorded test of a tool. <N> is the 1-based test
        // index matching test-<N>.json. No silent default: a malformed sub-path or a
        // non-positive-integer index is a hard error, never widened to the parent tool.
        if( slashCount === 4 ) {
            const [ namespace, kind, name, sub, indexRaw ] = parts
            if( kind !== 'tool' || sub !== 'tests' ) {
                return { 'valid': false, 'error': `Invalid per-test Spec-ID "${specId}": expected "<namespace>/tool/<name>/tests/<N>".` }
            }
            if( /^[1-9][0-9]*$/.test( indexRaw ) === false ) {
                return { 'valid': false, 'error': `Invalid test index "${indexRaw}" in "${specId}": expected a positive 1-based integer.` }
            }

            return { 'valid': true, source, namespace, 'type': 'test', name, 'testIndex': Number( indexRaw ) }
        }

        return {
            'valid': false,
            'error': `Invalid Spec-ID format: "${specId}". Valid forms: "<namespace>" (whole provider), "<namespace>/<schema-name>" (1 slash = schema), "<namespace>/tool/<name>" (2 slashes = tool), "<namespace>/tool/<name>/tests/<N>" (4 slashes = one test). Optional "<source>:" prefix. Example: "etherscan/tool/getBalance".`
        }
    }


    // PRD-009 — shared add-or-collide for ALL four primitives (tools/resources/
    // prompts/skills). Before writing a spec-id, check whether it already exists; if
    // so, record a collision instead of silently overwriting (last-wins) / pushing a
    // first-wins duplicate. The collision entry carries `files` AND `sources` so the
    // visible warning can suggest the qualified "<source>:<spec-id>" fix (PRD-008).
    // Mutates `map` and `collisions`.
    static #trackPrimitive( { map, collisions, specId, file, source, extra } ) {
        if( map[ specId ] ) {
            const existing = collisions
                .find( ( c ) => {
                    const matches = c[ 'specId' ] === specId

                    return matches
                } )

            if( existing ) {
                existing[ 'files' ].push( file )
                existing[ 'sources' ].push( source )
            } else {
                collisions.push( {
                    specId,
                    'files': [ map[ specId ][ 'file' ], file ],
                    'sources': [ map[ specId ][ 'source' ], source ]
                } )
            }

            return
        }

        map[ specId ] = { file, source, ...extra }
    }


    // PRD-009 — render the collisions[] list (built by #trackPrimitive over all four
    // primitives) into visible, non-blocking warnings. Each warning names the
    // colliding spec-id, the involved sources and the copyable qualified fix
    // "<source>:<spec-id>" (PRD-008). One bundled line per spec-id (no per-call
    // noise). English, no risk jargon. Returns [] when there is no collision.
    static #formatCollisionWarnings( { collisions } ) {
        if( Array.isArray( collisions ) === false || collisions.length === 0 ) {
            return { 'warnings': [] }
        }

        const warnings = collisions
            .map( ( collision ) => {
                const { specId, files, sources } = collision
                const knownSources = ( Array.isArray( sources ) ? sources : [] )
                    .filter( ( s ) => typeof s === 'string' && s.length > 0 )
                const uniqueSources = [ ...new Set( knownSources ) ]
                const fixForms = uniqueSources.length > 0
                    ? uniqueSources
                        .map( ( s ) => `${s}:${specId}` )
                        .join( ' or ' )
                    : `<source>:${specId}`
                const sourceLabel = uniqueSources.length > 0 ? uniqueSources.join( ', ' ) : 'unknown sources'
                const fileLabel = ( Array.isArray( files ) ? files : [] ).join( ', ' )

                return {
                    specId,
                    'sources': uniqueSources,
                    'files': Array.isArray( files ) ? files : [],
                    'message': `Collision on "${specId}" across sources [${sourceLabel}] (files: ${fileLabel}). The unqualified call uses the first match. To pick one explicitly, prefix the source: ${fixForms}.`
                }
            } )

        return { warnings }
    }


    static async #buildNamespaceIndex( { cwd } ) {
        const { schemas } = await FlowMcpCli.#loadAllSchemas()

        const tools = {}
        const resources = {}
        const prompts = {}
        const skills = {}
        const containers = {}
        const collisions = []
        const schemasSkipped = []

        schemas
            .forEach( ( schemaEntry ) => {
                const { main, file, source } = schemaEntry

                if( !main ) {
                    return
                }

                const namespace = main[ 'namespace' ]

                if( !namespace ) {
                    schemasSkipped.push( { file, source, 'reason': 'missing namespace' } )

                    return
                }

                const schemaTools = main[ 'tools' ] || main[ 'routes' ] || {}

                Object.keys( schemaTools )
                    .forEach( ( routeName ) => {
                        const specId = `${namespace}/tool/${routeName}`
                        FlowMcpCli.#trackPrimitive( { 'map': tools, collisions, specId, file, source, 'extra': { routeName } } )
                    } )

                const schemaResources = main[ 'resources' ] || {}

                Object.keys( schemaResources )
                    .forEach( ( resourceName ) => {
                        const specId = `${namespace}/resource/${resourceName}`
                        FlowMcpCli.#trackPrimitive( { 'map': resources, collisions, specId, file, source, 'extra': { resourceName } } )
                    } )

                const schemaPrompts = main[ 'prompts' ] || {}

                Object.keys( schemaPrompts )
                    .forEach( ( promptName ) => {
                        const specId = `${namespace}/prompt/${promptName}`
                        FlowMcpCli.#trackPrimitive( { 'map': prompts, collisions, specId, file, source, 'extra': { promptName } } )
                    } )

                const schemaSkills = main[ 'skills' ] || []

                schemaSkills
                    .forEach( ( skill ) => {
                        const skillName = skill[ 'name' ]

                        if( !skillName ) {
                            return
                        }

                        const specId = `${namespace}/skill/${skillName}`
                        FlowMcpCli.#trackPrimitive( { 'map': skills, collisions, specId, file, source, 'extra': { skillName } } )
                    } )
            } )

        const containerGroups = {}

        schemas
            .forEach( ( schemaEntry ) => {
                const { main, file, source } = schemaEntry

                if( !main ) {
                    return
                }

                const namespace = main[ 'namespace' ]

                if( !namespace ) {
                    return
                }

                const containerName = file.replace( /\.mjs$/, '' ).replace( /-part\d+$/, '' )
                const containerKey = `${namespace}/${containerName}`

                if( !containerGroups[ containerKey ] ) {
                    containerGroups[ containerKey ] = { namespace, containerName, source, 'files': [] }
                }

                containerGroups[ containerKey ][ 'files' ].push( file )
            } )

        Object.keys( containerGroups )
            .forEach( ( key ) => {
                const { files } = containerGroups[ key ]
                containers[ key ] = { files }
            } )

        const index = {
            tools,
            resources,
            prompts,
            skills,
            containers,
            collisions,
            'builtAt': new Date().toISOString(),
            'schemaCount': schemas.length
        }

        return { index }
    }


    static async #cachePath( { cwd } ) {
        const cachePath = join( cwd, '.flowmcp', 'namespace-index.json' )
        await mkdir( join( cwd, '.flowmcp' ), { recursive: true } )

        return { cachePath }
    }


    static async #writeNamespaceIndexCache( { cwd, index } ) {
        try {
            const { cachePath } = await FlowMcpCli.#cachePath( { cwd } )
            // Namespace-index cache refresh is a deliberate, named overwrite (Memo 068 R2).
            await FlowMcpCli.#writeGuarded( { 'path': cachePath, 'content': JSON.stringify( index, null, 4 ), 'onExists': 'overwrite' } )

            return { 'success': true, 'path': cachePath }
        } catch( err ) {
            return { 'success': false, 'error': err.message }
        }
    }


    static async #readNamespaceIndexCache( { cwd } ) {
        try {
            const { cachePath } = await FlowMcpCli.#cachePath( { cwd } )

            let content
            try {
                content = await readFile( cachePath, 'utf-8' )
            } catch {
                return { 'exists': false, 'index': null }
            }

            try {
                const index = JSON.parse( content )

                return { 'exists': true, index, 'stale': false }
            } catch( parseErr ) {
                return { 'exists': true, 'index': null, 'stale': true, 'error': parseErr.message }
            }
        } catch( err ) {
            return { 'exists': false, 'index': null, 'error': err.message }
        }
    }


    static async #invalidateNamespaceIndexCache( { cwd } ) {
        try {
            const { cachePath } = await FlowMcpCli.#cachePath( { cwd } )

            try {
                await unlink( cachePath )
            } catch( unlinkErr ) {
                if( unlinkErr.code !== 'ENOENT' ) {
                    return { 'success': false, 'error': unlinkErr.message }
                }
            }

            return { 'success': true }
        } catch( err ) {
            return { 'success': false, 'error': err.message }
        }
    }


    static async getNamespaceIndex( { cwd, forceRebuild = false } ) {
        if( forceRebuild ) {
            const { index } = await FlowMcpCli.#buildNamespaceIndex( { cwd } )
            await FlowMcpCli.#writeNamespaceIndexCache( { cwd, index } )

            return { index, 'source': 'rebuilt' }
        }

        const { exists, index: cachedIndex, stale } = await FlowMcpCli.#readNamespaceIndexCache( { cwd } )

        if( exists && cachedIndex && !stale ) {
            return { 'index': cachedIndex, 'source': 'cache' }
        }

        const { index } = await FlowMcpCli.#buildNamespaceIndex( { cwd } )
        await FlowMcpCli.#writeNamespaceIndexCache( { cwd, index } )

        return { index, 'source': 'rebuilt' }
    }


    static __testOnly_parseSpecId( { specId } ) {
        return FlowMcpCli.#parseSpecId( { specId } )
    }


    static __testOnly_buildToolName( { routeName, namespace, source = null, disambiguate = false } ) {
        return FlowMcpCli.#buildToolName( { routeName, namespace, source, disambiguate } )
    }


    // PRD-008 — exercises the pre-serve dedup planner over a list of tool entries
    // exactly like the serve-loop does, but without the MCP SDK. Returns the final
    // registered names (and skips) so a test can prove two same-provider folders
    // produce NO duplicate registration (the SDK would otherwise throw).
    static __testOnly_planServeToolNames( { entries } ) {
        const registeredToolNames = new Set()
        const plan = entries
            .map( ( entry ) => {
                const { routeName, namespace, source } = entry
                const { toolName: baseName } = FlowMcpCli.#buildToolName( { routeName, namespace } )
                const decided = FlowMcpCli.#disambiguateToolName( { baseName, routeName, namespace, source, registeredToolNames } )

                return { baseName, 'finalName': decided.finalName, 'skip': decided.skip, 'note': decided.note }
            } )

        return { plan, 'registeredNames': [ ...registeredToolNames ] }
    }


    static __testOnly_formatCollisions( { collisions } ) {
        return FlowMcpCli.#formatCollisionWarnings( { collisions } )
    }


    static async __testOnly_buildIndex( { schemas } ) {
        const tools = {}
        const resources = {}
        const prompts = {}
        const skills = {}
        const containers = {}
        const collisions = []

        schemas
            .forEach( ( schemaEntry ) => {
                const { main, file, source } = schemaEntry

                if( !main ) {
                    return
                }

                const namespace = main[ 'namespace' ]

                if( !namespace ) {
                    return
                }

                const schemaTools = main[ 'tools' ] || main[ 'routes' ] || {}

                Object.keys( schemaTools )
                    .forEach( ( routeName ) => {
                        const specId = `${namespace}/tool/${routeName}`
                        FlowMcpCli.#trackPrimitive( { 'map': tools, collisions, specId, file, source, 'extra': { routeName } } )
                    } )

                const schemaResources = main[ 'resources' ] || {}

                Object.keys( schemaResources )
                    .forEach( ( resourceName ) => {
                        const specId = `${namespace}/resource/${resourceName}`
                        FlowMcpCli.#trackPrimitive( { 'map': resources, collisions, specId, file, source, 'extra': { resourceName } } )
                    } )

                const schemaPrompts = main[ 'prompts' ] || {}

                Object.keys( schemaPrompts )
                    .forEach( ( promptName ) => {
                        const specId = `${namespace}/prompt/${promptName}`
                        FlowMcpCli.#trackPrimitive( { 'map': prompts, collisions, specId, file, source, 'extra': { promptName } } )
                    } )

                const schemaSkills = main[ 'skills' ] || []

                schemaSkills
                    .forEach( ( skill ) => {
                        const skillName = skill[ 'name' ]

                        if( !skillName ) {
                            return
                        }

                        const specId = `${namespace}/skill/${skillName}`
                        FlowMcpCli.#trackPrimitive( { 'map': skills, collisions, specId, file, source, 'extra': { skillName } } )
                    } )
            } )

        const containerGroups = {}

        schemas
            .forEach( ( schemaEntry ) => {
                const { main, file } = schemaEntry

                if( !main || !main[ 'namespace' ] ) {
                    return
                }

                const namespace = main[ 'namespace' ]
                const containerName = file.replace( /\.mjs$/, '' ).replace( /-part\d+$/, '' )
                const containerKey = `${namespace}/${containerName}`

                if( !containerGroups[ containerKey ] ) {
                    containerGroups[ containerKey ] = { 'files': [] }
                }

                containerGroups[ containerKey ][ 'files' ].push( file )
            } )

        Object.keys( containerGroups )
            .forEach( ( key ) => {
                const { files } = containerGroups[ key ]
                containers[ key ] = { files }
            } )

        const index = {
            tools,
            resources,
            prompts,
            skills,
            containers,
            collisions,
            'builtAt': new Date().toISOString(),
            'schemaCount': schemas.length
        }

        return { index }
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
                'error': `Config not found at ${configPath}`
            }

            return { result }
        }

        let config
        try {
            config = JSON.parse( rawContent )
        } catch( parseErr ) {
            const result = {
                'status': false,
                'error': `Invalid JSON in config at ${configPath}: ${parseErr.message}`
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

        const schemasBaseDir = FlowMcpCli.#schemasDir()
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

                        const { schemaRef, routeName } = FlowMcpCli.#parseToolRef( { 'toolRef': toolRef } )
                        const filePath = join( schemasBaseDir, schemaRef )
                        const { main, error: loadError } = await FlowMcpCli.#loadSchema( { filePath } )

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
            await FlowMcpCli.#writeGuarded( { 'path': backupPath, 'content': rawContent, 'onExists': 'overwrite' } )
            backup = backupPath

            await FlowMcpCli.#writeGuarded( { 'path': configPath, 'content': JSON.stringify( config, null, 4 ), 'onExists': 'overwrite' } )
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


    static async allowlist( { cwd, action, library } ) {
        const configPath = join( cwd, 'flowmcp.config.json' )
        const validActions = [ 'add', 'remove', 'list' ]

        if( !validActions.includes( action ) ) {
            const result = {
                'status': false,
                'error': `Invalid action "${action}".`,
                'fix': 'Use: add, remove, or list',
                configPath
            }

            return { result }
        }

        if( action !== 'list' ) {
            if( typeof library !== 'string' || library.trim() === '' ) {
                const result = {
                    'status': false,
                    'error': 'Library name must be a non-empty string.',
                    'fix': `Provide a valid npm package name, e.g. "talib" or "@scope/pkg"`,
                    configPath
                }

                return { result }
            }

            const validPattern = /^(@[a-z0-9-_]+\/)?[a-z0-9-_\.]+$/i
            const hasDangerousChars = /[<>|&;`$\\\/\.\.]/.test( library ) && library.includes( '..' )
            const isPathTraversal = library.includes( '..' ) || library.startsWith( '/' ) || library.startsWith( '.' )

            if( isPathTraversal || !validPattern.test( library ) ) {
                const result = {
                    'status': false,
                    'error': `Invalid library name "${library}". Only npm-style package names are allowed.`,
                    'fix': 'Use letters, digits, hyphens, underscores. Scoped names like @scope/pkg are allowed.',
                    configPath
                }

                return { result }
            }
        }

        let config = { 'allowlist': [] }

        try {
            const raw = await readFile( configPath, 'utf-8' )
            config = JSON.parse( raw )

            if( !config[ 'allowlist' ] || !Array.isArray( config[ 'allowlist' ] ) ) {
                config[ 'allowlist' ] = []
            }
        } catch {
            // File does not exist or is invalid — use default structure
        }

        const configAllowlist = config[ 'allowlist' ]

        if( action === 'add' ) {
            const alreadyPresent = configAllowlist.includes( library )

            if( !alreadyPresent ) {
                configAllowlist.push( library )
                config[ 'allowlist' ] = configAllowlist
                await FlowMcpCli.#writeGuarded( { 'path': configPath, 'content': JSON.stringify( config, null, 4 ), 'onExists': 'overwrite' } )
            }

            const result = {
                'status': true,
                action,
                library,
                'added': !alreadyPresent,
                'allowlist': configAllowlist,
                configPath
            }

            return { result }
        }

        if( action === 'remove' ) {
            const wasPresent = configAllowlist.includes( library )
            const updatedAllowlist = configAllowlist
                .filter( ( entry ) => {
                    const shouldKeep = entry !== library

                    return shouldKeep
                } )

            config[ 'allowlist' ] = updatedAllowlist
            await FlowMcpCli.#writeGuarded( { 'path': configPath, 'content': JSON.stringify( config, null, 4 ), 'onExists': 'overwrite' } )

            const result = {
                'status': true,
                action,
                library,
                'removed': wasPresent,
                'allowlist': updatedAllowlist,
                configPath
            }

            return { result }
        }

        // action === 'list'
        let defaultAllowlist = []
        let mergedAllowlist = [ ...configAllowlist ]
        let hasMergeAllowlist = false

        try {
            const { LibraryLoader } = await import( 'flowmcp/v2' )
            hasMergeAllowlist = typeof LibraryLoader.mergeAllowlist === 'function'
            const hasGetDefault = typeof LibraryLoader.getDefaultAllowlist === 'function'

            if( hasGetDefault ) {
                const { defaultAllowlist: defaults } = LibraryLoader.getDefaultAllowlist()
                defaultAllowlist = defaults || []
            }

            if( hasMergeAllowlist ) {
                const { mergedAllowlist: merged } = LibraryLoader.mergeAllowlist( { 'extraAllowlist': configAllowlist } )
                mergedAllowlist = merged || [ ...defaultAllowlist, ...configAllowlist ]
            } else {
                console.warn( 'LibraryLoader.mergeAllowlist not available in installed flowmcp-core; allowlist extensions stored in flowmcp.config.json will be honored once core is updated.' )
                mergedAllowlist = [ ...new Set( [ ...defaultAllowlist, ...configAllowlist ] ) ]
            }
        } catch {
            mergedAllowlist = [ ...new Set( [ ...defaultAllowlist, ...configAllowlist ] ) ]
        }

        const result = {
            'status': true,
            action,
            'default': defaultAllowlist,
            'extensions': configAllowlist,
            'merged': mergedAllowlist,
            hasMergeAllowlist,
            configPath
        }

        return { result }
    }


    static async selectionList( { cwd: _cwd } ) {
        // const { status, messages } = Validation.selectionList( { cwd } )
        // if( !status ) { Validation.error( { messages } ) }

        const schemasBaseDir = FlowMcpCli.#schemasDir()
        const { sources } = await FlowMcpCli.#listSources()

        const sourceDirs = sources
            .map( ( source ) => join( schemasBaseDir, source[ 'name' ] ) )

        const selections = []

        await sourceDirs
            .reduce( ( promise, sourceDir ) => promise.then( async () => {
                let entries = []

                try {
                    entries = await readdir( sourceDir, { recursive: true } )
                } catch {
                    return
                }

                const selectionFiles = entries
                    .filter( ( entry ) => {
                        const isSelectionFile = entry.includes( 'selections' + '/' ) && ( entry.endsWith( '.mjs' ) || entry.endsWith( '.js' ) )

                        return isSelectionFile
                    } )
                    .map( ( entry ) => join( sourceDir, entry ) )

                await selectionFiles
                    .reduce( ( innerPromise, filePath ) => innerPromise.then( async () => {
                        try {
                            const fileUrl = pathToFileURL( filePath ).href
                            const mod = await import( fileUrl )
                            const selection = mod[ 'selection' ]

                            if( !selection ) {
                                return
                            }

                            const { namespace, name, whenToUse, tools, resources, prompts, skills } = selection
                            const allTools = Array.isArray( tools ) ? tools : []
                            const allResources = Array.isArray( resources ) ? resources : []
                            const allPrompts = Array.isArray( prompts ) ? prompts : []
                            const allSkills = Array.isArray( skills ) ? skills : []
                            const toolCount = allTools.length + allResources.length + allPrompts.length + allSkills.length
                            const sourceName = filePath.replace( schemasBaseDir + '/', '' ).split( '/' )[ 0 ]
                            const whenToUseSnippet = typeof whenToUse === 'string' ? whenToUse.slice( 0, 80 ) : ''

                            const entry = {
                                namespace,
                                name,
                                'file': filePath,
                                'source': sourceName,
                                toolCount,
                                'whenToUse': whenToUseSnippet
                            }

                            selections.push( entry )
                        } catch {
                            // skip unreadable files
                        }
                    } ), Promise.resolve() )
            } ), Promise.resolve() )

        const result = {
            'status': true,
            'count': selections.length,
            selections
        }

        return { result }
    }


    static async selectionShow( { cwd: _cwd, name } ) {
        // const { status, messages } = Validation.selectionShow( { name } )
        // if( !status ) { Validation.error( { messages } ) }

        const { result: listResult } = await FlowMcpCli.selectionList( { 'cwd': _cwd } )
        const { selections } = listResult

        const matched = selections
            .find( ( sel ) => {
                const fullId = `${sel[ 'namespace' ]}/selection/${sel[ 'name' ]}`
                const shortId = `${sel[ 'namespace' ]}/${sel[ 'name' ]}`
                const isMatch = fullId === name || shortId === name || sel[ 'name' ] === name

                return isMatch
            } )

        if( !matched ) {
            const result = {
                'status': false,
                'error': `Selection "${name}" not found.`,
                'fix': 'Use: flowmcp dev selection list to see available selections'
            }

            return { result }
        }

        let fullSelection = null

        try {
            const fileUrl = pathToFileURL( matched[ 'file' ] ).href
            const mod = await import( fileUrl )
            fullSelection = mod[ 'selection' ]
        } catch( error ) {
            const result = {
                'status': false,
                'error': `Failed to load selection file: ${error.message}`
            }

            return { result }
        }

        const result = {
            'status': true,
            'file': matched[ 'file' ],
            'source': matched[ 'source' ],
            'selection': fullSelection
        }

        return { result }
    }


    static async selectionValidate( { cwd, path: selectionPath } ) {
        // const { status, messages } = Validation.selectionValidate( { path } )
        // if( !status ) { Validation.error( { messages } ) }

        const resolvedPath = resolve( cwd, selectionPath )
        let mod = null

        try {
            const fileUrl = pathToFileURL( resolvedPath ).href
            mod = await import( fileUrl )
        } catch( error ) {
            const result = {
                'status': false,
                'errors': [ { 'code': 'SEL000', 'message': `Cannot load file: ${error.message}` } ],
                'warnings': []
            }

            return { result }
        }

        const selection = mod[ 'selection' ]

        if( !selection ) {
            const result = {
                'status': false,
                'errors': [ { 'code': 'SEL000', 'message': `File does not export a "selection" constant` } ],
                'warnings': []
            }

            return { result }
        }

        // Try flowmcp/v4 SelectionValidator first
        try {
            const v4 = await import( 'flowmcp/v4' )
            const SelectionValidator = v4 && v4[ 'SelectionValidator' ]

            if( SelectionValidator && typeof SelectionValidator.validate === 'function' ) {
                const validatorResult = SelectionValidator.validate( { selection } )
                const rawErrors = validatorResult[ 'errors' ] || []
                const errors = rawErrors.map( ( e ) => {
                    if( typeof e === 'string' ) {
                        const match = e.match( /^([A-Z]+\d*):\s*(.*)$/ )
                        if( match ) {
                            return { 'code': match[ 1 ], 'message': match[ 2 ] }
                        }
                        return { 'code': 'SEL000', 'message': e }
                    }
                    return e
                } )
                if( typeof selection[ 'namespace' ] === 'string' && selection[ 'namespace' ].includes( '/' ) ) {
                    errors.push( { 'code': 'VAL110', 'message': `"namespace" must not contain slashes (got: "${selection[ 'namespace' ]}")` } )
                }
                if( typeof selection[ 'name' ] === 'string' && selection[ 'name' ].includes( '/' ) ) {
                    errors.push( { 'code': 'VAL110', 'message': `"name" must not contain slashes (got: "${selection[ 'name' ]}")` } )
                }
                const status = errors.length === 0
                const warnings = validatorResult[ 'warnings' ] || []
                const result = { status, errors, warnings }

                return { result }
            }
        } catch {
            // v4 not available — use inline fallback below
        }

        // Inline fallback validator
        const errors = []
        const warnings = []

        // SEL001: required keys present + whenToUse non-empty
        const requiredKeys = [ 'namespace', 'name', 'description', 'whenToUse' ]
        requiredKeys
            .forEach( ( key ) => {
                if( !selection[ key ] || ( typeof selection[ key ] === 'string' && selection[ key ].trim() === '' ) ) {
                    errors.push( { 'code': 'SEL001', 'message': `Required field "${key}" is missing or empty` } )
                }
            } )

        // SEL001 (continued): at least one of tools/resources/prompts/skills must be non-empty
        const toolsArr = Array.isArray( selection[ 'tools' ] ) ? selection[ 'tools' ] : []
        const resourcesArr = Array.isArray( selection[ 'resources' ] ) ? selection[ 'resources' ] : []
        const promptsArr = Array.isArray( selection[ 'prompts' ] ) ? selection[ 'prompts' ] : []
        const skillsArr = Array.isArray( selection[ 'skills' ] ) ? selection[ 'skills' ] : []
        const totalPrimitives = toolsArr.length + resourcesArr.length + promptsArr.length + skillsArr.length

        if( totalPrimitives === 0 ) {
            errors.push( { 'code': 'SEL002', 'message': 'At least one of tools/resources/prompts/skills must be non-empty' } )
        }

        // VAL110: namespace and name must be single words (no slashes)
        if( selection[ 'namespace' ] && selection[ 'namespace' ].includes( '/' ) ) {
            errors.push( { 'code': 'VAL110', 'message': `"namespace" must not contain slashes (got: "${selection[ 'namespace' ]}")` } )
        }

        if( selection[ 'name' ] && selection[ 'name' ].includes( '/' ) ) {
            errors.push( { 'code': 'VAL110', 'message': `"name" must not contain slashes (got: "${selection[ 'name' ]}")` } )
        }

        // SEL002: id format check (if id field provided)
        if( selection[ 'id' ] ) {
            const idParts = selection[ 'id' ].split( '/' )
            const isValidId = idParts.length === 3 && idParts[ 1 ] === 'selection'

            if( !isValidId ) {
                errors.push( { 'code': 'SEL002', 'message': `"id" must follow format namespace/selection/name (got: "${selection[ 'id' ]}")` } )
            }
        }

        const result = {
            'status': errors.length === 0,
            errors,
            warnings
        }

        return { result }
    }


    static #v4Override = null


    static __testInjectV4( { v4 } ) {
        FlowMcpCli.#v4Override = v4
    }


    static #gradingOverride = null


    static __testInjectGrading( { grading } ) {
        FlowMcpCli.#gradingOverride = grading
    }


    // PRD-011 — the four grading methods realizing Stages 0/1/2/3.
    // The CLI is the ONLY component with .env access (REV-14 Kap. 17): it
    // resolves env + builds serverParams + loads the schema, then hands a flat
    // { KEY:value } serverParams object to the grading module. The module reads
    // no .env (G8). Stage 2 (non-deterministic grading) lives in the harness,
    // NOT here — the CLI only emits the /goal handoff and later consumes scores.

    // Resolve the grading-data island root. Precedence (all explicit, no silent
    // default):
    //   1. --grading-data flag (per-call override, cwd-relative)
    //   2. FLOWMCP_GRADING_DATA env var (cwd-relative / absolute)
    //   3. "gradingDataDir" in the GLOBAL ~/.flowmcp/config.json (home-relative / absolute)
    //   4. built-in default ~/.flowmcp/grading
    // The global config + default live in the user home (single source of truth,
    // same location as ~/.flowmcp/.env). In tests os.homedir() is mocked into the
    // repo sandbox, so this never touches the real ~/.flowmcp.
    static async #gradingDataRoot( { cwd, gradingDataDir } ) {
        if( typeof gradingDataDir === 'string' && gradingDataDir.length > 0 ) {
            return resolve( cwd, gradingDataDir )
        }
        const envDir = process.env[ 'FLOWMCP_GRADING_DATA' ]
        if( typeof envDir === 'string' && envDir.length > 0 ) {
            return resolve( cwd, envDir )
        }
        const home = homedir()
        const globalConfigDir = join( home, appConfig[ 'globalConfigDirName' ] )
        const { data: globalConfig } = await FlowMcpCli.#readJson( { 'filePath': join( globalConfigDir, 'config.json' ) } )
        if( globalConfig !== null && typeof globalConfig[ 'gradingDataDir' ] === 'string' && globalConfig[ 'gradingDataDir' ].length > 0 ) {
            return resolve( globalConfigDir, globalConfig[ 'gradingDataDir' ] )
        }
        return join( globalConfigDir, 'grading' )
    }


    // Memo 097 Kap. 5 (PA-5) — resolve the grading key-injection opt-in. Default
    // is OFF: the deterministic pretest runs WITHOUT live keys, so key-gated tools
    // fail deterministically with DPT-005 (no authenticated request leaves the
    // machine). Turning it ON fires real authenticated FLOWMCP.fetch requests
    // against un-audited schema hosts using the developer's live keys — a security
    // decision that MUST be an explicit opt-in, never silent (NO SILENT DEFAULT).
    // Precedence (all explicit):
    //   1. --with-keys flag (per-call developer opt-in)
    //   2. FLOWMCP_GRADING_USE_KEYS env var ("1"/"true"/"yes"/"on" => true)
    //   3. "grading.useKeys" boolean in the GLOBAL ~/.flowmcp/config.json
    //   4. default false
    static async #gradingUseKeys( { withKeys } ) {
        if( withKeys === true ) {
            return { useKeys: true }
        }
        const envFlag = process.env[ 'FLOWMCP_GRADING_USE_KEYS' ]
        if( typeof envFlag === 'string' && [ '1', 'true', 'yes', 'on' ].includes( envFlag.toLowerCase() ) ) {
            return { useKeys: true }
        }
        const home = homedir()
        const globalConfigDir = join( home, appConfig[ 'globalConfigDirName' ] )
        const { data: globalConfig } = await FlowMcpCli.#readJson( { 'filePath': join( globalConfigDir, 'config.json' ) } )
        if( globalConfig !== null && typeof globalConfig[ 'grading' ] === 'object' && globalConfig[ 'grading' ] !== null && globalConfig[ 'grading' ][ 'useKeys' ] === true ) {
            return { useKeys: true }
        }

        return { useKeys: false }
    }


    // Test-only accessors (Memo 097 PA-5/PA-6). Do not use in production code.
    static async __testGradingUseKeys( { withKeys } ) {
        return FlowMcpCli.#gradingUseKeys( { withKeys } )
    }


    static async __testGradingDataRoot( { cwd, gradingDataDir } ) {
        const root = await FlowMcpCli.#gradingDataRoot( { cwd, gradingDataDir } )

        return { root }
    }


    // Writer for the grading-path keys in the GLOBAL ~/.flowmcp/config.json. The
    // resolution precedence already honored "gradingDataDir" / "gradingExportDir";
    // what was missing was a CLI writer (a hand-edit was required). With no --set-*
    // flag this SHOWS the current values + resolved roots. It never auto-creates the
    // config (init must run first) and never blind-writes — it reads the existing
    // config, sets only the requested key(s), and writes back via the guarded writer.
    static async gradingConfig( { cwd, setDataDir, setExportDir, json } ) {
        const globalConfigPath = FlowMcpCli.#globalConfigPath()
        const { data: existingConfig } = await FlowMcpCli.#readJson( { 'filePath': globalConfigPath } )
        if( existingConfig === null ) {
            return { 'result': FlowMcpCli.#error( { 'error': `Global config not found at ${globalConfigPath}.`, 'fix': `Run "${appConfig[ 'cliCommand' ]} init" first to create it.` } ) }
        }

        const wantsSet = setDataDir !== null || setExportDir !== null

        if( setDataDir !== null && ( typeof setDataDir !== 'string' || setDataDir.length === 0 ) ) {
            return { 'result': FlowMcpCli.#error( { 'error': '--set-data-dir requires a non-empty path.', 'fix': `Usage: ${appConfig[ 'cliCommand' ]} grading config --set-data-dir <path>` } ) }
        }
        if( setExportDir !== null && ( typeof setExportDir !== 'string' || setExportDir.length === 0 ) ) {
            return { 'result': FlowMcpCli.#error( { 'error': '--set-export-dir requires a non-empty path.', 'fix': `Usage: ${appConfig[ 'cliCommand' ]} grading config --set-export-dir <path>` } ) }
        }

        if( wantsSet === true ) {
            const nextConfig = Object.keys( existingConfig )
                .reduce( ( acc, key ) => {
                    acc[ key ] = existingConfig[ key ]

                    return acc
                }, {} )
            if( setDataDir !== null ) { nextConfig[ 'gradingDataDir' ] = setDataDir }
            if( setExportDir !== null ) { nextConfig[ 'gradingExportDir' ] = setExportDir }

            await FlowMcpCli.#writeGlobalConfig( { 'config': nextConfig } )
        }

        const { data: currentConfig } = await FlowMcpCli.#readJson( { 'filePath': globalConfigPath } )
        const storedDataDir = typeof currentConfig[ 'gradingDataDir' ] === 'string' && currentConfig[ 'gradingDataDir' ].length > 0 ? currentConfig[ 'gradingDataDir' ] : null
        const storedExportDir = typeof currentConfig[ 'gradingExportDir' ] === 'string' && currentConfig[ 'gradingExportDir' ].length > 0 ? currentConfig[ 'gradingExportDir' ] : null
        const resolvedDataRoot = await FlowMcpCli.#gradingDataRoot( { cwd, 'gradingDataDir': null } )
        const resolvedExportRoot = await FlowMcpCli.#gradingExportRoot( { cwd, 'gradingExportDir': null, 'gradingDataRoot': resolvedDataRoot } )

        const result = {
            'status': true,
            'configPath': globalConfigPath,
            'updated': wantsSet,
            'gradingDataDir': storedDataDir,
            'resolvedDataRoot': resolvedDataRoot,
            'gradingExportDir': storedExportDir,
            'resolvedExportRoot': resolvedExportRoot
        }

        return { result }
    }


    // Resolve the grading EXPORT root. Mirrors #gradingDataRoot exactly (PRD-007).
    // Precedence (all explicit, no silent default):
    //   1. --export-dir flag (per-call override, cwd-relative)
    //   2. FLOWMCP_GRADING_EXPORT env var (cwd-relative / absolute)
    //   3. "gradingExportDir" in the GLOBAL ~/.flowmcp/config.json (home-relative / absolute)
    //   4. built-in default <gradingDataRoot>/_exports (backward-compatible)
    // The string-and-non-empty type check on each level is explicit: a malformed
    // (non-string / empty) value does NOT collapse to the default; it falls
    // through to the next documented level. No `||`-default anywhere.
    static async #gradingExportRoot( { cwd, gradingExportDir, gradingDataRoot } ) {
        if( typeof gradingExportDir === 'string' && gradingExportDir.length > 0 ) {
            return resolve( cwd, gradingExportDir )
        }
        const envDir = process.env[ 'FLOWMCP_GRADING_EXPORT' ]
        if( typeof envDir === 'string' && envDir.length > 0 ) {
            return resolve( cwd, envDir )
        }
        const home = homedir()
        const globalConfigDir = join( home, appConfig[ 'globalConfigDirName' ] )
        const { data: globalConfig } = await FlowMcpCli.#readJson( { 'filePath': join( globalConfigDir, 'config.json' ) } )
        if( globalConfig !== null && typeof globalConfig[ 'gradingExportDir' ] === 'string' && globalConfig[ 'gradingExportDir' ].length > 0 ) {
            return resolve( globalConfigDir, globalConfig[ 'gradingExportDir' ] )
        }
        return join( gradingDataRoot, '_exports' )
    }


    // Repo-relative rendering for any path surfaced to the caller / logs / commit
    // (FlowMCP global rule: only relative paths, never usernames/system paths).
    // When the absolute path lies under cwd, return relative( cwd, path ). When it
    // lies under the user home, collapse the home prefix to `~`. Otherwise return
    // the path unchanged (already relative, or an unrelated absolute we cannot
    // safely rewrite — explicit, no silent home-leak heuristic beyond these two).
    static #toRepoRelativePath( { cwd, path } ) {
        if( typeof path !== 'string' || path.length === 0 ) { return path }
        if( !isAbsolute( path ) ) { return path }

        const rel = relative( cwd, path )
        if( rel.length > 0 && !rel.startsWith( '..' ) && !isAbsolute( rel ) ) {
            return rel
        }

        const home = homedir()
        if( path === home ) { return '~' }
        if( path.startsWith( `${home}/` ) ) {
            return `~/${path.slice( home.length + 1 )}`
        }

        return path
    }


    // Rewrite every absolute/home path embedded in a message string into its
    // repo-relative / home-collapsed form (PRD-007 §3.8). Operates token-wise so a
    // message like "...already exists: /Users/x/y" surfaces "...already exists: ~/y".
    static #relativizeMessagePaths( { cwd, message } ) {
        if( typeof message !== 'string' || message.length === 0 ) { return message }
        return message
            .split( ' ' )
            .map( ( token ) => {
                const stripped = token.replace( /[.,;:]+$/, '' )
                const trailing = token.slice( stripped.length )
                if( !isAbsolute( stripped ) ) { return token }
                return `${FlowMcpCli.#toRepoRelativePath( { cwd, path: stripped } )}${trailing}`
            } )
            .join( ' ' )
    }


    // F29 flow detection — provider vs selection by which island tree holds the
    // target. Ambiguity (in both / in neither) is a hard error with a copyable
    // fix (an explicit path). No silent default.
    static async #detectGradingFlow( { gradingDataRoot, target } ) {
        const providerDir = join( gradingDataRoot, 'providers', target )
        const selectionDir = join( gradingDataRoot, 'selections', target )
        const inProvider = existsSync( providerDir )
        const inSelection = existsSync( selectionDir )

        if( inProvider === true && inSelection === true ) {
            return {
                'status': false,
                'error': `Ambiguous target "${target}": exists in both providers/ and selections/.`,
                'fix': `Pass an explicit path, e.g. ${join( 'providers', target )} or ${join( 'selections', target )}.`
            }
        }

        if( inProvider === false && inSelection === false ) {
            // PRD-004 (B3): a provider no longer needs a pre-existing island folder.
            // If the target is a namespace registered in schemaFolders[], it is a
            // fresh provider flow — the dependency resolver builds the island
            // skeleton from the live read. No silent default: a target that is in
            // NEITHER the island NOR schemaFolders[] is a hard abort.
            const resolved = await FlowMcpCli.#resolveSchemasForTarget( { 'namespace': target } )
            if( resolved.status === true ) {
                return { 'status': true, 'flow': 'provider', 'tier': 'autonomous', 'maxGrade': 'B', 'targetDir': providerDir }
            }

            return {
                'status': false,
                'error': `Target "${target}" found in neither the grading island nor schemaFolders[].`,
                'fix': `Register the provider in schemaFolders[] (a namespace under <path>/providers/), or author a selection under selections/${target}/.`
            }
        }

        if( inProvider === true ) {
            return { 'status': true, 'flow': 'provider', 'tier': 'autonomous', 'maxGrade': 'B', 'targetDir': providerDir }
        }

        return { 'status': true, 'flow': 'selection', 'tier': 'group-bound', 'maxGrade': 'A', 'targetDir': selectionDir }
    }


    // PRD-007 (Memo 102 Phase 3) — the grading target is no longer passed as a raw
    // string straight into #detectGradingFlow. It is first structured through
    // #parseSpecId, which distinguishes the three addressing levels:
    //   - namespace            (no slash)        -> whole provider
    //   - namespace/schema     (1 slash)         -> a schema file (granularity stays
    //                                               namespace-bound in the island, the
    //                                               schema name is carried as scope)
    //   - namespace/tool/name  (2 slashes)       -> a single tool; resolved back to its
    //                                               namespace via #buildNamespaceIndex
    //   - namespace/selection/name               -> selection path (kept first-class)
    // No silent default: an unparseable id or an unknown tool id is a hard abort with
    // a copyable fix. The resolved namespace (and any scope) is returned so callers
    // route into the existing #detectGradingFlow on the namespace.
    static async #resolveGradingTarget( { cwd, gradingDataRoot, target } ) {
        const parsed = FlowMcpCli.#parseSpecId( { 'specId': target } )

        if( parsed.valid === false ) {
            return { 'status': false, 'error': parsed.error, 'fix': 'Pass a target as <namespace>, <namespace>/<schema-name> (1 slash = schema), <namespace>/tool/<name> (2 slashes = tool) or <namespace>/selection/<name>. Optional prefix "<source>:".' }
        }

        const { type, namespace, name, source } = parsed

        // selection stays a first-class grading target (F12 = A): route on the
        // selection name, NOT on the namespace.
        if( type === 'selection' ) {
            const detected = await FlowMcpCli.#detectGradingFlow( { gradingDataRoot, 'target': name } )

            return { ...detected, 'specType': 'selection', 'scopeName': name, source }
        }

        // namespace or schema: the grading granularity is the namespace. For a schema
        // id the schema-name is carried as scope (no behavioural change in the island).
        if( type === 'namespace' || type === 'schema' ) {
            const detected = await FlowMcpCli.#detectGradingFlow( { gradingDataRoot, 'target': namespace } )

            return { ...detected, 'specType': type, 'scopeName': type === 'schema' ? name : null, source }
        }

        // tool: resolve the tool id back to its namespace via the namespace index.
        if( type === 'tool' ) {
            const specId = `${namespace}/tool/${name}`
            const { index } = await FlowMcpCli.getNamespaceIndex( { cwd } )
            const toolEntry = index && index[ 'tools' ] ? index[ 'tools' ][ specId ] : undefined

            if( toolEntry === undefined ) {
                return {
                    'status': false,
                    'error': `Unknown tool id "${target}": no tool "${specId}" is registered in the configured schemaFolders[].`,
                    'fix': `Use the 2-slash tool form "<namespace>/tool/<name>" with a tool that exists (run "${appConfig[ 'cliCommand' ]} list" to see registered tools), or grade the whole provider with "${appConfig[ 'cliCommand' ]} grading deterministic ${namespace}".`
                }
            }

            const detected = await FlowMcpCli.#detectGradingFlow( { gradingDataRoot, 'target': namespace } )
            const { warnings: collisionWarnings } = FlowMcpCli.#formatCollisionWarnings( { 'collisions': index ? index[ 'collisions' ] : [] } )

            return { ...detected, 'specType': 'tool', 'scopeName': name, 'source': source !== null ? source : ( toolEntry[ 'source' ] || null ), collisionWarnings }
        }

        // A 2-slash id of a non-tool primitive (resource/prompt/skill/agent) is not a
        // grading target — no silent default.
        return {
            'status': false,
            'error': `Spec-ID type "${type}" is not a grading target.`,
            'fix': `Grade a <namespace>, a <namespace>/<schema-name>, a <namespace>/tool/<name> or a <namespace>/selection/<name>.`
        }
    }


    // F16 Dependency-Resolver decision tree (implementation-plan N1, owned by
    // the CLI). Branches:
    //   (a) data missing + provider in schemaFolders[] -> build the island
    //       index.json skeleton DIRECTLY from the live read (PRD-004 B3), no import
    //   (b) quality < stable              -> report only (no silent downgrade)
    //   (c) source missing                -> hard abort
    // Downgrade only happens on explicit opt-in (not implemented as silent path).
    // Returns { status, chain[], ... } — the chain is always logged into the result.
    static async #resolveGradingDependencies( { gradingDataRoot, flow, target, targetDir, providerPath, dryRun = false } ) {
        const chain = []
        const indexPath = join( targetDir, 'index.json' )
        const hasIndex = existsSync( indexPath )

        // PRD-012 — --no-save (dryRun): the on-first-run island skeleton build
        // (folders + index.json via RebuildIndex) is itself an island WRITE. Under
        // dryRun it must NOT happen — the island stays byte-identical. The emit path
        // reads its schemas LIVE from schemaFolders[] and never consults this
        // index.json, so skipping the build does not break the run. NO SILENT
        // DEFAULT: the skip is recorded as an explicit chain step, and an unknown
        // namespace still hard-aborts (the live resolve below runs first).
        if( hasIndex === false && dryRun === true ) {
            if( flow === 'provider' ) {
                const namespace = basename( targetDir )
                const resolvedSchemas = await FlowMcpCli.#resolveSchemasForTarget( { namespace } )
                if( resolvedSchemas.status === false ) {
                    return { 'status': false, chain, 'error': resolvedSchemas.error, 'fix': resolvedSchemas.fix }
                }
                chain.push( { 'step': 'auto-build-namespace-index', 'status': 'skipped (dry-run, no island write)' } )
                return { 'status': true, chain }
            }
            // Selection dry-run: an index must already exist (no in-island authoring
            // write under dry-run). Without one, abort honestly rather than write.
            return {
                'status': false,
                chain,
                'error': `--no-save: no index.json at ${indexPath} and the selection skeleton cannot be built without an island write.`,
                'fix': 'Run the selection grading once without --no-save to author the island, then re-run with --no-save.'
            }
        }

        // (c) source missing — for a provider the source is the live schemaFolders[]
        // namespace; for a selection the source is the selection folder itself. A
        // missing targetDir for a selection is a hard abort (caught by F29 already).
        if( hasIndex === false ) {
            if( flow === 'provider' ) {
                // (a) PRD-004 (B3): the island skeleton is built from the LIVE read
                // (schemaFolders[]) + RebuildIndex.rebuildNamespaceIndex — never via
                // an internal importer. The namespace folder is materialised (one
                // folder per live schema) so the rebuild walks a real tree; no
                // snapshot files are written (RebuildIndex resolves a null snapshot
                // to `pending`).
                const namespace = basename( targetDir )
                const resolvedSchemas = await FlowMcpCli.#resolveSchemasForTarget( { namespace } )
                if( resolvedSchemas.status === false ) {
                    // NO SILENT DEFAULT: an unknown namespace stays a hard abort.
                    return {
                        'status': false,
                        chain,
                        'error': resolvedSchemas.error,
                        'fix': resolvedSchemas.fix
                    }
                }

                chain.push( { 'step': 'auto-build-namespace-index', 'reason': 'index.json missing, provider in schemaFolders[]', namespace } )
                const grading = await FlowMcpCli.#loadGradingModule()
                if( grading === null || grading[ 'RebuildIndex' ] === undefined ) {
                    return { 'status': false, chain, 'error': 'grading module unavailable for namespace index build', 'fix': 'npm install / update the flowmcp-grading dependency' }
                }

                await mkdir( targetDir, { 'recursive': true } )
                await resolvedSchemas.schemas
                    .reduce( ( promise, s ) => promise.then( async () => {
                        await mkdir( join( targetDir, s.schemaName ), { 'recursive': true } )
                    } ), Promise.resolve() )

                const built = await grading[ 'RebuildIndex' ].rebuildNamespaceIndex( { 'namespaceDir': targetDir } )
                if( built.status !== true ) {
                    return {
                        'status': false,
                        chain,
                        'error': `Namespace index build failed: ${( built.errors || [] ).join( '; ' )}`,
                        'fix': 'Resolve the namespace-index errors above and re-run grading.'
                    }
                }
                chain.push( { 'step': 'auto-build-namespace-index', 'status': 'done' } )
                return { 'status': true, chain }
            }

            if( flow === 'selection' && existsSync( targetDir ) === true ) {
                // A selection is authored in-island: its source IS the selection
                // folder. Build the derived index.json (rebuildSelectionIndex) on
                // first run instead of aborting.
                chain.push( { 'step': 'auto-build-selection-index', 'reason': 'index.json missing, selection folder present', targetDir } )
                const grading = await FlowMcpCli.#loadGradingModule()
                if( grading === null || grading[ 'RebuildIndex' ] === undefined ) {
                    return { 'status': false, chain, 'error': 'grading module unavailable for selection index build', 'fix': 'npm install / update the flowmcp-grading dependency' }
                }
                const built = await grading[ 'RebuildIndex' ].rebuildSelectionIndex( { 'selectionDir': targetDir, 'providersRoot': join( gradingDataRoot, 'providers' ) } )
                if( built.status !== true ) {
                    return {
                        'status': false,
                        chain,
                        'error': `Selection index build failed: ${( built.errors || [] ).join( '; ' )}`,
                        'fix': 'Resolve the selection-index errors above and re-run grading.'
                    }
                }
                chain.push( { 'step': 'auto-build-selection-index', 'status': 'done' } )
                return { 'status': true, chain }
            }

            // (c) source missing — hard abort. (Providers build their skeleton
            // above from schemaFolders[]; this remains reachable only for a
            // selection whose folder is absent — F29 already guards that case.)
            return {
                'status': false,
                chain,
                'error': `No index.json at ${indexPath} and no resolvable source available.`,
                'fix': 'Author the selection folder (selections/<id>/selection/) or register the provider in schemaFolders[], then re-run grading.'
            }
        }

        // (b) quality < stable — report only. Read the rollup status; if it is
        // below `stable` we surface it but do NOT block emit-prompts (the run is
        // exactly how a target moves toward stable). The report is in the chain.
        const { data: index } = await FlowMcpCli.#readJson( { 'filePath': indexPath } )
        const rollup = index && index[ 'status' ] ? index[ 'status' ] : 'pending'
        if( rollup !== 'stable' ) {
            chain.push( { 'step': 'quality-report', 'rollupStatus': rollup, 'note': 'below stable — report only, no downgrade' } )
        }

        return { 'status': true, chain }
    }


    // F16 case (a) for selection members, PRD-004 (B3): a member referenced by the
    // selection but not yet materialised in the island is resolved LIVE from
    // schemaFolders[] (never imported). For each missing member the island skeleton
    // folder providers/<ns>/<schema>/ is created from the live read, then the
    // selection index is rebuilt so the member resolves. No snapshot files are
    // written — RebuildIndex resolves the null snapshot to `pending`.
    //
    // `--member-source` (`memberSource`) is retained as an OPTIONAL override: when
    // given it pins the providers-root the member namespaces are resolved from
    // (a flat <root>/<ns>/<schema>.mjs tree) instead of schemaFolders[]. It is no
    // longer required (the live read is the default), but kept — not silently
    // dropped — so a caller can grade against an out-of-config source on purpose.
    static async #resolveMissingSelectionMembers( { cwd, grading, gradingDataRoot, targetDir, target, memberSource, chain } ) {
        const indexPath = join( targetDir, 'index.json' )
        const { data: index } = await FlowMcpCli.#readJson( { 'filePath': indexPath } )
        if( index === null || index[ 'members' ] === undefined ) { return { 'status': true } }

        const missing = Object.entries( index[ 'members' ] )
            .filter( ( entry ) => entry[ 1 ] !== null && entry[ 1 ][ 'reason' ] === 'selection member, not imported' )
            .map( ( entry ) => entry[ 0 ] )
        if( missing.length === 0 ) { return { 'status': true } }

        const providersRoot = join( gradingDataRoot, 'providers' )
        const hasOverride = typeof memberSource === 'string' && memberSource.length > 0
        const overrideRoot = hasOverride === true ? resolve( cwd, memberSource ) : null

        const resolveErrors = []
        await missing
            .reduce( ( promise, schemaId ) => promise.then( async () => {
                const parts = schemaId.split( '.' )
                if( parts.length !== 2 ) {
                    resolveErrors.push( `malformed selection member id "${schemaId}" (expected <namespace>.<schema>)` )
                    return
                }
                const memberNamespace = parts[ 0 ]
                const memberSchema = parts[ 1 ]

                // Resolve the member's live source path. Override (flat
                // <root>/<ns>/<schema>.mjs) or schemaFolders[] live read.
                let sourcePath = null
                if( hasOverride === true ) {
                    const candidate = join( overrideRoot, memberNamespace, `${memberSchema}.mjs` )
                    if( existsSync( candidate ) === false ) {
                        resolveErrors.push( `member "${schemaId}" not found under --member-source ${overrideRoot}` )
                        return
                    }
                    sourcePath = candidate
                } else {
                    const resolved = await FlowMcpCli.#resolveSchemasForTarget( { 'namespace': memberNamespace } )
                    if( resolved.status === false ) {
                        resolveErrors.push( resolved.error )
                        return
                    }
                    const hit = resolved.schemas
                        .find( ( s ) => s.schemaName === memberSchema )
                    if( hit === undefined ) {
                        resolveErrors.push( `SRC-002: selection member "${schemaId}" not found in schemaFolders[] (namespace "${memberNamespace}" has: ${resolved.schemas.map( ( s ) => s.schemaName ).join( ', ' ) || 'none'})` )
                        return
                    }
                    sourcePath = hit.sourcePath
                }

                // Materialise the island skeleton folder so rebuildSelectionIndex
                // resolves the member. No snapshot file is written (B2 live read).
                chain.push( { 'step': 'member-auto-chain', 'schemaId': schemaId, 'reason': 'referenced selection member not materialised, live source present', sourcePath } )
                await mkdir( join( providersRoot, memberNamespace, memberSchema ), { 'recursive': true } )
                chain.push( { 'step': 'member-auto-chain', 'schemaId': schemaId, 'status': 'done' } )
            } ), Promise.resolve() )

        if( resolveErrors.length > 0 ) {
            return { 'status': false, 'error': resolveErrors.join( '; ' ), 'fix': 'Register the missing member provider(s) in schemaFolders[], pass --member-source <providers-root>, or fix the selection member ids.' }
        }

        // Rebuild the selection index so the freshly-materialised members resolve.
        const rebuilt = await grading[ 'RebuildIndex' ].rebuildSelectionIndex( { 'selectionDir': targetDir, 'providersRoot': providersRoot } )
        if( rebuilt.status !== true ) {
            return { 'status': false, 'error': `Selection index rebuild after member resolution failed: ${( rebuilt.errors || [] ).join( '; ' )}`, 'fix': 'Inspect the resolved members and re-run.' }
        }
        return { 'status': true }
    }


    // Memo 102 Phase 2 / PRD-006 — the grading-intake sub-command and its
    // FlowMcpCli intake method were removed: the grading run reads the schema live
    // from schemaFolders[] (B2) and builds the island skeleton from that live read
    // (B3), so no internal importer remains. The GradingImport class in
    // flowmcp-grading is KEPT (still exported + consumed by that module's own
    // tests) — see PRD-006 keep-decision.


    static async gradingExport( { cwd, target, onConflict, gradingDataDir, gradingExportDir, json } ) {
        const grading = await FlowMcpCli.#loadGradingModule()
        if( grading === null || grading[ 'GradingExport' ] === undefined ) {
            return { 'result': FlowMcpCli.#error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }

        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': FlowMcpCli.#error( { 'error': 'Missing export target.', 'fix': 'Usage: flowmcp grading export <namespace|selection>' } ) }
        }

        const gradingDataRoot = await FlowMcpCli.#gradingDataRoot( { cwd, gradingDataDir } )
        const detected = await FlowMcpCli.#resolveGradingTarget( { cwd, gradingDataRoot, target } )
        if( detected.status !== true ) {
            return { 'result': FlowMcpCli.#error( { 'error': detected.error, 'fix': detected.fix } ) }
        }

        const exportRoot = await FlowMcpCli.#gradingExportRoot( { cwd, gradingExportDir, gradingDataRoot } )
        const stamp = new Date().toISOString().replace( /[:.]/g, '-' )
        const exportDir = join( exportRoot, `${target.replace( /\//g, '_' )}--${stamp}` )

        // Memo 102 Phase 2 (B2/B3): the island no longer holds schema snapshot
        // files — the schema source is live in schemaFolders[]. The export therefore
        // ships the grade index (the proof) only; stripped schema copies are not
        // pulled from the island anymore (includeSchemas=false). The schemas are
        // referenced live, not duplicated into the export.
        const run = await grading[ 'GradingExport' ].run( {
            'target': detected.targetDir,
            exportDir,
            'includeSchemas': false
        } )

        if( run.status !== true ) {
            // Path-hardening (§3.8): rewrite any absolute/home path embedded in the
            // module's error strings to a repo-relative / ~-collapsed form before
            // it is surfaced to the caller / logged / committed.
            const safeErrors = ( run.errors || [] )
                .map( ( e ) => FlowMcpCli.#relativizeMessagePaths( { cwd, message: e } ) )
            return {
                'result': {
                    'status': false,
                    'error': `Export failed: ${safeErrors.join( '; ' )}`,
                    'fix': 'Resolve the export error above (a pre-existing export folder is never overwritten).',
                    'errors': safeErrors
                }
            }
        }

        // Path-hardening (§3.7): only the repo-relative form of the export paths is
        // surfaced. The absolute form was used internally for the filesystem ops.
        return {
            'result': {
                'status': true,
                'flow': run.flow,
                'indexExportPath': FlowMcpCli.#toRepoRelativePath( { cwd, path: run.indexExportPath } ),
                'schemaExports': ( run.schemaExports || [] )
                    .map( ( s ) => ( { ...s, 'exportPath': FlowMcpCli.#toRepoRelativePath( { cwd, path: s.exportPath } ) } ) ),
                'exportDir': FlowMcpCli.#toRepoRelativePath( { cwd, path: exportDir } )
            }
        }
    }


    static async gradingRun( { cwd, target, phase, emitPrompts, consumeScores, onConflict, memberSource, gradingDataDir, gradingExportDir, maxIterations, maxTurns = null, withKeys, dryRun = false, quiet = false, json } ) {
        const grading = await FlowMcpCli.#loadGradingModule()
        if( grading === null ) {
            return { 'result': FlowMcpCli.#error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }

        // NO SILENT DEFAULT: maxIterations is opt-in. Absent → 1 (single pass, the
        // documented default). A supplied value must parse to a positive integer.
        const { maxIterations: maxIterationsResolved, error: maxIterationsError } = FlowMcpCli.#resolveMaxIterations( { maxIterations } )
        if( maxIterationsError !== null ) {
            return { 'result': FlowMcpCli.#error( { 'error': maxIterationsError, 'fix': 'Pass --max-iterations as a positive integer (default 1).' } ) }
        }

        // PRD-3.5 — the Goal-Block turn bound is configurable (was hardcoded 25). NO
        // SILENT DEFAULT: absent -> 25 (the documented default); a supplied value must
        // parse to a positive integer.
        const { maxTurns: maxTurnsResolved, error: maxTurnsError } = FlowMcpCli.#resolveMaxTurns( { maxTurns } )
        if( maxTurnsError !== null ) {
            return { 'result': FlowMcpCli.#error( { 'error': maxTurnsError, 'fix': 'Pass --max-turns as a positive integer (default 25).' } ) }
        }

        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': FlowMcpCli.#error( { 'error': 'Missing grading target.', 'fix': `Usage: ${appConfig[ 'cliCommand' ]} grading non-deterministic <namespace|selection> --emit-prompts | --consume-scores <path>` } ) }
        }

        // NO SILENT DEFAULT for the mode — exactly one of emit/consume.
        if( emitPrompts !== true && ( consumeScores === null || consumeScores === undefined ) ) {
            return { 'result': FlowMcpCli.#error( { 'error': 'Mode required: --emit-prompts or --consume-scores <path>.', 'fix': 'Pick exactly one mode (2-phase grading, no default mode).' } ) }
        }
        if( emitPrompts === true && consumeScores !== null && consumeScores !== undefined ) {
            return { 'result': FlowMcpCli.#error( { 'error': 'Modes are mutually exclusive: pass either --emit-prompts or --consume-scores, not both.', 'fix': `Run --emit-prompts first, then --consume-scores in a separate call.` } ) }
        }

        // NO SILENT DEFAULT for the conflict policy — explicit allowlist.
        const conflict = onConflict === null || onConflict === undefined ? 'skip' : onConflict
        const validConflicts = [ 'abort', 'skip', 'overwrite' ]
        if( validConflicts.includes( conflict ) === false ) {
            return { 'result': FlowMcpCli.#error( { 'error': `Invalid --on-conflict value: ${conflict}`, 'fix': `Use one of: ${validConflicts.join( ', ' )}.` } ) }
        }

        // PRD-004 — resolve the --phase flag into a multi-area selector (3 modes,
        // no silent default). A bad token aborts before any emit (no partial emit).
        const areaSelector = FlowMcpCli.#resolveAreaSelector( { phase, grading } )
        if( areaSelector.status === false ) {
            return { 'result': FlowMcpCli.#error( { 'error': areaSelector.error, 'fix': 'Pass --phase as a comma-separated set of known areas, or omit it for all applicable areas.' } ) }
        }

        const gradingDataRoot = await FlowMcpCli.#gradingDataRoot( { cwd, gradingDataDir } )

        // F29 flow detection.
        const detected = await FlowMcpCli.#resolveGradingTarget( { cwd, gradingDataRoot, target } )
        if( detected.status !== true ) {
            return { 'result': FlowMcpCli.#error( { 'error': detected.error, 'fix': detected.fix } ) }
        }

        // F16 dependency resolver (auto-chain / report / abort). The chain is
        // always returned in the result so the orchestration is auditable.
        const deps = await FlowMcpCli.#resolveGradingDependencies( {
            gradingDataRoot,
            'flow': detected.flow,
            target,
            'targetDir': detected.targetDir,
            'providerPath': null,
            dryRun
        } )
        if( deps.status !== true ) {
            return { 'result': { 'status': false, 'error': deps.error, 'fix': deps.fix, 'dependencyChain': deps.chain } }
        }

        // Selection flow: F16 case (a) member auto-chain, then PreConditionCheck.
        if( detected.flow === 'selection' ) {
            const resolvedMembers = await FlowMcpCli.#resolveMissingSelectionMembers( {
                cwd, grading, gradingDataRoot, 'targetDir': detected.targetDir, target, memberSource, 'chain': deps.chain
            } )
            if( resolvedMembers.status !== true ) {
                return { 'result': { 'status': false, 'error': resolvedMembers.error, 'fix': resolvedMembers.fix, 'dependencyChain': deps.chain } }
            }
        }

        // Selection flow: PreConditionCheck gate (PRE-004) before Stage 1.
        if( detected.flow === 'selection' && grading[ 'PreConditionCheck' ] !== undefined ) {
            const pre = await grading[ 'PreConditionCheck' ].check( { gradingDataRoot, 'selectionId': target } )
            if( pre.passed !== true ) {
                return {
                    'result': {
                        'status': false,
                        'error': `Pre-condition not met: ${( pre.errors || [] ).join( '; ' )}`,
                        'fix': 'Grade every member to `stable` first (no silent skip), then re-run the selection grading.',
                        'blockedMembers': pre.blockedMembers,
                        'dependencyChain': deps.chain
                    }
                }
            }
        }

        if( emitPrompts === true ) {
            // PA-5: resolve the key-injection opt-in (default OFF) — gates whether the
            // deterministic pretest fires authenticated requests with live keys.
            const { useKeys } = await FlowMcpCli.#gradingUseKeys( { withKeys } )

            return FlowMcpCli.#gradingEmitPrompts( { cwd, grading, gradingDataRoot, 'flow': detected.flow, 'tier': detected.tier, 'maxGrade': detected.maxGrade, 'targetDir': detected.targetDir, target, areaSelector, conflict, 'maxIterations': maxIterationsResolved, 'maxTurns': maxTurnsResolved, useKeys, dryRun, quiet, 'dependencyChain': deps.chain } )
        }

        return FlowMcpCli.#gradingConsumeScores( { cwd, grading, gradingDataRoot, 'flow': detected.flow, 'targetDir': detected.targetDir, target, consumeScores, conflict, gradingDataDir, gradingExportDir, dryRun, 'dependencyChain': deps.chain } )
    }


    // Memo 102 Phase 1 / PRD-001 — deterministic single-schema/-tool validation:
    // structural validation PLUS the DataPretest data-pretest (HTTP 200 + non-empty
    // data), WITHOUT prompt-emit and WITHOUT the non-deterministic LLM scoring.
    // The answer to "is this schema valid?" as one structured result.
    //
    // Target grammar (PRD-001 scope, full 3-level addressing is Phase 3):
    //   namespace/schema-name        (1 slash) -> all tools of one schema
    //   namespace/tool/<name>        (2 slash) -> just the one addressed tool
    //
    // PRD-002 — the --only flag carries the v4-primitive view that used to live in
    // `dev test`: tool/resource run through the DataPretest path; skill/prompt/
    // selection-member run through the existing structural primitive check
    // (#runTypedTests + #aggregateByPrimitive). The same #validateOnlyFilter
    // allowlist applies (no duplication).
    static async gradingDeterministic( { cwd, target, gradingDataDir, gradingExportDir = null, withKeys, only, dryRun = false, force = false, quiet = false, json, skipRollup = false } ) {
        const grading = await FlowMcpCli.#loadGradingModule()
        if( grading === null || grading[ 'DataPretest' ] === undefined ) {
            return { 'result': FlowMcpCli.#error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }

        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': FlowMcpCli.#error( { 'error': 'Missing grading target.', 'fix': 'Usage: flowmcp grading deterministic <namespace> | <namespace>/<schema> | <namespace>/tool/<name>' } ) }
        }

        // PRD-002 — validate the --only filter once (shared with `dev test`'s old
        // path). An unknown value is a HARD error (no silent skip).
        const { filter: onlyFilter, error: onlyError } = FlowMcpCli.#validateOnlyFilter( { only } )
        if( onlyError !== null ) {
            return { 'result': FlowMcpCli.#error( { 'error': onlyError } ) }
        }

        // Parse the Spec-ID. PRD-001 only accepts a schema-ID (1 slash) or a
        // tool-ID (2 slashes, type === 'tool'). Resource/prompt/skill/selection
        // Spec-IDs are out of scope here (no silent acceptance).
        const parsed = FlowMcpCli.#parseSpecId( { 'specId': target } )
        if( parsed.valid !== true ) {
            return { 'result': FlowMcpCli.#error( { 'error': parsed.error, 'fix': 'Use a namespace "<namespace>", a schema-ID "<namespace>/<schema>", or a tool-ID "<namespace>/tool/<name>".' } ) }
        }
        // Memo 107 PRD-004 — bare namespace runs the deterministic grade over every
        // schema of the namespace ("one command per namespace") and produces ONE
        // namespace rollup (index.json) + Provider-Proof (grade.json). Delegated so
        // the single-schema path below stays unchanged.
        if( parsed.type === 'namespace' ) {
            return FlowMcpCli.#gradingDeterministicNamespace( { cwd, 'namespace': parsed.namespace, gradingDataDir, gradingExportDir, withKeys, only, dryRun, force, quiet, json } )
        }
        if( parsed.type !== 'schema' && parsed.type !== 'tool' && parsed.type !== 'test' ) {
            return { 'result': FlowMcpCli.#error( { 'error': `Spec-ID type "${parsed.type}" is not supported by grading deterministic (only namespace, schema-ID, tool-ID or per-test).`, 'fix': 'Use "<namespace>", "<namespace>/<schema>", "<namespace>/tool/<name>" or "<namespace>/tool/<name>/tests/<N>".' } ) }
        }

        const namespace = parsed.namespace
        // A tool-ID and a per-test selector both scope the deterministic grade to one
        // tool (the `_gradings/` granularity is per-tool; a per-test selector addresses
        // a single recorded test of that tool for validation/inspection).
        const toolFilter = parsed.type === 'tool' || parsed.type === 'test' ? parsed.name : null
        const testIndex = parsed.type === 'test' ? parsed.testIndex : null

        // PRD-003 (B2): the deterministic single-mode reads the schema LIVE from
        // schemaFolders[], not from the island import snapshot. The island root is
        // still the OUTPUT store (DataPretest.#persist writes the summary there).
        const gradingDataRoot = await FlowMcpCli.#gradingDataRoot( { cwd, gradingDataDir } )

        // Resolve the schemas for this namespace live. A namespace absent from every
        // schemaFolders[] source is a coded hard error (SRC-001) — never silent.
        const resolvedSchemas = await FlowMcpCli.#resolveSchemasForTarget( { namespace } )
        if( resolvedSchemas.status === false ) {
            return { 'result': FlowMcpCli.#error( { 'error': resolvedSchemas.error, 'fix': resolvedSchemas.fix } ) }
        }
        const liveSchemas = resolvedSchemas.schemas

        // Determine the addressed schema. A schema-ID names the folder directly; a
        // tool-ID needs a Tool->Schema lookup. No silent first-wins: an ambiguous
        // tool match is surfaced with a visible note.
        const resolved = FlowMcpCli.#resolveDeterministicSchemaLive( { liveSchemas, parsed, namespace } )
        if( resolved.status === false ) {
            return { 'result': FlowMcpCli.#error( { 'error': resolved.error, 'fix': resolved.fix } ) }
        }
        const schemaName = resolved.schemaName
        const sourcePath = resolved.sourcePath
        const main = resolved.main
        const handlersFn = resolved.handlersFn

        // PA-5: key-injection opt-in (default OFF) — same gate as emit-prompts.
        const { useKeys } = await FlowMcpCli.#gradingUseKeys( { withKeys } )

        // Step 1 — structural validation (Memo REV-08 Kap. 1: structural validate
        // FIRST, then the deterministic data-pretest = "the validation").
        const v4 = await FlowMcpCli.#loadV4Module()
        const validate = FlowMcpCli.#validateSingleSchema( { main, 'file': basename( sourcePath ), v4 } )

        // Step 2 — the deterministic data-pretest (status === true AND #hasData),
        // a strict superset of `dev test`. Same Phase-0/1 wiring as emit-prompts:
        // resolveEnv -> buildServerParams -> resolveSharedLists -> DataPretest.run,
        // but WITHOUT the prompt/goal emit afterwards.
        const requiredServerParams = Array.isArray( main[ 'requiredServerParams' ] ) ? main[ 'requiredServerParams' ] : []
        const serverParams = useKeys === true
            ? FlowMcpCli.#buildServerParams( { 'envObject': ( await FlowMcpCli.#resolveEnv( { cwd } ) ).envObject, requiredServerParams } ).serverParams
            : {}
        const { sharedLists } = await FlowMcpCli.#resolveSharedListsForSchema( { main, 'filePath': sourcePath } )

        // PRD-012 — --no-save (dryRun) runs the pretest in full but persists NOTHING
        // to the island (no summary.json / test-N.json). The deterministic path has
        // no Stage-3 writes, so dryRun here only gates the DataPretest persist.
        // PRD-4.1 — tick the slow part (live/cached pretest) to stderr.
        FlowMcpCli.#emitProgress( { quiet, 'message': `${target}: structural validate + data pretest${force === true ? ' (--force re-fetch)' : ''}...` } )

        // PRD-2.2 — force threads the cache bypass into the pretest. Without it the
        // pretest reuses the persisted test-N.json (read-cache, PRD-2.1); with it the
        // data is re-fetched. A re-fetch that flips `deterministic-green` flows
        // straight into the _gradings rewrite + rollup below, so the affected
        // deterministic areas are re-evaluated (the grade itself still hangs on the
        // schemaHash — data reuse never silently invalidates it).
        const pretestRaw = await grading[ 'DataPretest' ].run( {
            namespace,
            'toolName': schemaName,
            main,
            handlersFn,
            'schemaSnapshotPath': sourcePath,
            serverParams,
            sharedLists,
            'gradingDataDir': gradingDataRoot,
            dryRun,
            force
        } )

        // Tool-ID: restrict the pretest view to the one addressed tool. The gate is
        // recomputed over the filtered results so `ok` reflects only that tool.
        const { pretest } = FlowMcpCli.#scopeDeterministicPretest( { pretestRaw, toolFilter } )

        // Per-test selector: validate the 1-based test index is in range for the tool
        // and surface the addressed test (no silent default — an out-of-range index is
        // a hard error, never clamped). The `_gradings/` write stays tool-scoped.
        let testScope = null
        if( testIndex !== null ) {
            const toolResults = ( Array.isArray( pretest.results ) ? pretest.results : [] )
                .filter( ( entry ) => entry[ 'name' ] === toolFilter )
            if( testIndex > toolResults.length ) {
                return { 'result': FlowMcpCli.#error( { 'error': `Test index ${testIndex} is out of range for tool "${toolFilter}" (${toolResults.length} recorded test(s)).`, 'fix': `Address a test between 1 and ${toolResults.length}, or run the whole tool "${namespace}/tool/${toolFilter}".` } ) }
            }
            const addressed = toolResults[ testIndex - 1 ]
            testScope = {
                'tool': toolFilter,
                'testIndex': testIndex,
                'working': addressed[ 'working' ],
                'status': addressed[ 'status' ],
                'responseBytes': addressed[ 'responseBytes' ] === undefined ? null : addressed[ 'responseBytes' ],
                'large': addressed[ 'large' ] === true,
                'extreme': addressed[ 'extreme' ] === true
            }
        }

        // PRD-002 — optional v4-primitive view (the migrated `dev test --only`
        // capability). tool/resource come from the DataPretest results; skill/
        // prompt/selection-member from the structural #runTypedTests path.
        let primitives = null
        if( onlyFilter !== null ) {
            const { view } = await FlowMcpCli.#deterministicPrimitiveView( { main, handlersFn, 'schemaSource': sourcePath, serverParams, sharedLists, onlyFilter, toolFilter, pretest } )
            primitives = view
        }

        // Hints derived from the DataPretest errors[]. Phase 5 surfaces the new
        // classes: DPT-006 (parameterless, Bar=1), DPT-007 (key-gated — not evaluable
        // without key, NOT a FAIL), DPT-008 (duplicate test). The pretest object
        // carries keyGated/perTool/stopReason so callers can tell "not evaluable"
        // from a genuine FAIL.
        const { hints } = FlowMcpCli.#deterministicHints( { 'validate': validate, pretest } )
        const status = validate[ 'status' ] === true && pretest.ok === true

        // PRD-4.1 — done-tick with the data stamp (cache reuse vs re-fetch).
        const stamp = pretest.fromCache === true ? `cached, data ${pretest.dataAt}` : `fresh, data ${pretest.dataAt}`
        FlowMcpCli.#emitProgress( { quiet, 'message': `${target}: ${status === true ? 'PASS' : 'FAIL'} (${stamp})` } )

        const result = {
            status,
            'mode': 'deterministic',
            target,
            'saved': dryRun !== true,
            'validate': validate,
            pretest,
            hints
        }
        if( resolved.note !== null && resolved.note !== undefined ) {
            result[ 'note' ] = resolved.note
        }
        if( primitives !== null ) {
            result[ 'primitives' ] = primitives
        }
        if( testScope !== null ) {
            result[ 'testScope' ] = testScope
        }

        // Memo 107 PRD-006 — the deterministic Area grading + full-structure wiring.
        // After the pretest, write the deterministic `_gradings/` entries for this
        // schema (Answer-Mapper -> AreaScorer.writeEntry, NO-OVERWRITE/additive), then
        // — unless this is a namespace sub-call (skipRollup) — rebuild the namespace
        // index.json (RebuildIndex) and the Provider-Proof grade.json (ProviderProof).
        // dryRun (--no-save) skips ALL island writes (PRD-012 / guard 6). This is the
        // gap that turned `grading deterministic` from a summary-only sweep into the
        // real deterministic grading (Memo 107 Kap. 4).
        if( dryRun !== true ) {
            const written = await FlowMcpCli.#deterministicWriteGradings( { grading, gradingDataRoot, namespace, schemaName, main, validate, pretest, toolFilter } )
            result[ 'gradingsWritten' ] = written.written
            if( written.skipped.length > 0 ) { result[ 'gradingsSkipped' ] = written.skipped }
            if( written.errors.length > 0 ) { result[ 'gradingErrors' ] = written.errors }

            if( skipRollup !== true ) {
                const rollup = await FlowMcpCli.#deterministicRollup( { cwd, grading, gradingDataRoot, gradingExportDir, namespace } )
                if( rollup.status !== true ) {
                    // The deterministic GRADE already ran; a rollup/persistence failure is
                    // surfaced (never silent) but does NOT flip the grade `status`.
                    result[ 'rollupError' ] = rollup.error
                } else {
                    result[ 'indexPath' ] = rollup.indexPath
                    result[ 'proofPath' ] = rollup.proofPath
                    result[ 'rollupStatus' ] = rollup.rollupStatus
                    result[ 'rollupGrade' ] = rollup.rollupGrade
                }
            }
        }

        return { result }
    }


    // Memo 107 PRD-005/006 — write the deterministic Area `_gradings/` entries for one
    // schema. The DeterministicAreaMapper turns the structural validation + DataPretest
    // result into spec-conformant deterministic entries (single-test per tool,
    // tools-aggregate-schema), and AreaScorer.writeEntry persists each one timestamped-
    // additive (ASC-010 NO-OVERWRITE — a same-second collision is benign idempotency,
    // not an error). Guard 1 (Kap. 0a.5): `_gradings/` only ever via AreaScorer.writeEntry.
    static async #deterministicWriteGradings( { grading, gradingDataRoot, namespace, schemaName, main, validate, pretest, toolFilter = null } ) {
        const Mapper = grading[ 'DeterministicAreaMapper' ]
        const AreaScorer = grading[ 'AreaScorer' ]
        if( Mapper === undefined || AreaScorer === undefined ) {
            return { 'written': 0, 'skipped': [], 'errors': [ 'flowmcp-grading too old: DeterministicAreaMapper / AreaScorer not exported.' ] }
        }

        const recordedAt = new Date().toISOString().replace( /\.\d{3}Z$/, 'Z' ).replace( /:/g, '-' )
        const mapped = Mapper.mapSchema( { namespace, 'schemaId': schemaName, main, validate, pretest, recordedAt } )
        const providersRoot = join( gradingDataRoot, 'providers' )
        const errors = [ ...mapped.errors ]
        const writeCounter = { count: 0 }

        // Memo 107 PRD-007 (E-4) — a tool-addressed grade (`<ns>/tool/<name>`) writes
        // ONLY that tool's single-test entry; sibling tools' `_gradings/` stay
        // untouched. The schema-level summary.json is unaffected (DataPretest always
        // computes it over the full declared tool set, so it is never blind-replaced).
        const entriesToWrite = toolFilter === null
            ? mapped.entries
            : mapped.entries.filter( ( item ) => item.area === 'single-test' && item.tool === toolFilter )

        await entriesToWrite
            .reduce( ( promise, item ) => promise.then( async () => {
                const { dir, errors: dirErrors } = AreaScorer.resolveGradingsDir( {
                    providersRoot, 'ns': namespace, 'schemaId': schemaName, 'tool': item.tool === null ? undefined : item.tool, 'area': item.area
                } )
                if( dir === null ) { errors.push( ...dirErrors ); return }
                const res = await AreaScorer.writeEntry( { 'entry': item.entry, 'gradingsDir': dir, 'area': item.area, 'timestamp': recordedAt } )
                if( res.written === true ) {
                    writeCounter.count += 1
                    return
                }
                const benign = res.errors.some( ( error ) => error.includes( 'ASC-010' ) === true )
                if( benign === false ) { errors.push( ...res.errors ) }
            } ), Promise.resolve() )

        return { 'written': writeCounter.count, 'skipped': mapped.skipped, errors }
    }


    // Memo 107 PRD-006 — rebuild the namespace rollup (index.json) from the on-disk
    // `_gradings/` and project the committable Provider-Proof (grade.json). Guards 2+3
    // (Kap. 0a.5): index.json only via RebuildIndex.rebuildNamespaceIndex, grade.json
    // only via ProviderProof.write. Reuses the exact wiring proven on consume-scores.
    static async #deterministicRollup( { cwd, grading, gradingDataRoot, gradingExportDir, namespace } ) {
        const RebuildIndex = grading[ 'RebuildIndex' ]
        const ProviderProof = grading[ 'ProviderProof' ]
        if( RebuildIndex === undefined || RebuildIndex === null || ProviderProof === undefined || ProviderProof === null ) {
            return { 'status': false, 'error': 'flowmcp-grading too old: RebuildIndex / ProviderProof not available; the namespace index.json / grade.json were not built.', 'fix': 'Update the flowmcp-grading dependency.' }
        }

        const namespaceDir = join( gradingDataRoot, 'providers', namespace )
        let rebuilt
        try {
            rebuilt = await RebuildIndex.rebuildNamespaceIndex( { namespaceDir } )
        } catch( rebuildError ) {
            return { 'status': false, 'error': `Index rebuild threw: ${rebuildError.message}`, 'fix': 'Resolve the island state above and re-run.' }
        }
        if( rebuilt.status !== true ) {
            return { 'status': false, 'error': `Index rebuild failed: ${( rebuilt.errors || [] ).join( '; ' )}`, 'fix': 'Resolve the index errors above and re-run.' }
        }

        const proof = await FlowMcpCli.#writeProviderProof( {
            cwd, grading, gradingDataRoot, gradingExportDir, 'target': namespace, 'namespaceIndex': rebuilt.index
        } )
        if( proof.status !== true ) {
            return { 'status': false, 'error': proof.error, 'fix': proof.fix }
        }

        return {
            'status': true,
            'indexPath': FlowMcpCli.#toRepoRelativePath( { cwd, 'path': rebuilt.indexPath } ),
            'proofPath': FlowMcpCli.#toRepoRelativePath( { cwd, 'path': proof.proofPath } ),
            'rollupStatus': rebuilt.index[ 'status' ],
            'rollupGrade': rebuilt.index[ 'grade' ]
        }
    }


    // Memo 107 PRD-004 — bare-namespace deterministic grade: run every schema of the
    // namespace (skipRollup, so each writes its own `_gradings/` but defers the rollup),
    // then build the namespace index.json + Provider-Proof grade.json EXACTLY ONCE.
    static async #gradingDeterministicNamespace( { cwd, namespace, gradingDataDir, gradingExportDir, withKeys, only, dryRun, force = false, quiet = false, json } ) {
        const resolved = await FlowMcpCli.#resolveSchemasForTarget( { namespace } )
        if( resolved.status === false ) {
            return { 'result': FlowMcpCli.#error( { 'error': resolved.error, 'fix': resolved.fix } ) }
        }

        const total = resolved.schemas.length
        FlowMcpCli.#emitProgress( { quiet, 'message': `namespace ${namespace}: ${total} schema(s) to grade deterministically` } )

        const perSchema = []
        await resolved.schemas
            .reduce( ( promise, schema, index ) => promise.then( async () => {
                FlowMcpCli.#emitProgress( { quiet, 'message': `[${index + 1}/${total}] ${schema.schemaName}` } )
                const sub = await FlowMcpCli.gradingDeterministic( {
                    cwd, 'target': `${namespace}/${schema.schemaName}`, gradingDataDir, gradingExportDir, withKeys, only, dryRun, force, 'quiet': true, json, 'skipRollup': true
                } )
                const subResult = sub.result
                perSchema.push( {
                    'schema': schema.schemaName,
                    'status': subResult.status === true,
                    'pretestOk': subResult.pretest === undefined || subResult.pretest === null ? null : subResult.pretest.ok,
                    'gradingsWritten': subResult.gradingsWritten === undefined ? 0 : subResult.gradingsWritten
                } )
            } ), Promise.resolve() )

        const out = {
            'status': perSchema.length > 0 && perSchema.every( ( entry ) => entry.status === true ),
            'mode': 'deterministic',
            'target': namespace,
            'saved': dryRun !== true,
            'schemaCount': perSchema.length,
            'schemas': perSchema
        }

        if( dryRun !== true ) {
            const grading = await FlowMcpCli.#loadGradingModule()
            const gradingDataRoot = await FlowMcpCli.#gradingDataRoot( { cwd, gradingDataDir } )
            const rollup = await FlowMcpCli.#deterministicRollup( { cwd, grading, gradingDataRoot, gradingExportDir, namespace } )
            if( rollup.status !== true ) {
                out[ 'rollupError' ] = rollup.error
            } else {
                out[ 'indexPath' ] = rollup.indexPath
                out[ 'proofPath' ] = rollup.proofPath
                out[ 'rollupStatus' ] = rollup.rollupStatus
                out[ 'rollupGrade' ] = rollup.rollupGrade
            }
        }

        return { 'result': out }
    }


    // PRD-2.3 — `grading reload <ns|ns/schema>`: re-fetch + rewrite the persisted
    // test-N.json (force semantics), DECOUPLED from grading. It runs the data
    // pretest with force:true so the read-cache (PRD-2.1) is bypassed and the
    // island test data is refreshed, but it writes NO `_gradings/` entries and NO
    // grade.json/index.json — a pure data reload. Reports the per-schema rewritten
    // test counts + the new data stamp (dataAt). NO SILENT DEFAULTS.
    static async gradingReload( { cwd, target, gradingDataDir, withKeys, quiet = false, json } ) {
        const grading = await FlowMcpCli.#loadGradingModule()
        if( grading === null || grading[ 'DataPretest' ] === undefined ) {
            return { 'result': FlowMcpCli.#error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }
        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': FlowMcpCli.#error( { 'error': 'Missing reload target.', 'fix': 'Usage: flowmcp grading reload <namespace> | <namespace>/<schema>' } ) }
        }

        const parsed = FlowMcpCli.#parseSpecId( { 'specId': target } )
        if( parsed.valid !== true || ( parsed.type !== 'namespace' && parsed.type !== 'schema' ) ) {
            return { 'result': FlowMcpCli.#error( { 'error': `grading reload accepts a namespace or a schema-ID, got "${target}".`, 'fix': 'Use "<namespace>" or "<namespace>/<schema>".' } ) }
        }

        const namespace = parsed.namespace
        const gradingDataRoot = await FlowMcpCli.#gradingDataRoot( { cwd, gradingDataDir } )
        const resolvedSchemas = await FlowMcpCli.#resolveSchemasForTarget( { namespace } )
        if( resolvedSchemas.status === false ) {
            return { 'result': FlowMcpCli.#error( { 'error': resolvedSchemas.error, 'fix': resolvedSchemas.fix } ) }
        }

        const targetSchemas = parsed.type === 'schema'
            ? resolvedSchemas.schemas.filter( ( s ) => s.schemaName === parsed.name )
            : resolvedSchemas.schemas
        if( targetSchemas.length === 0 ) {
            return { 'result': FlowMcpCli.#error( { 'error': `Schema "${target}" not found in schemaFolders[].`, 'fix': 'Address an existing schema or namespace.' } ) }
        }

        const { useKeys } = await FlowMcpCli.#gradingUseKeys( { withKeys } )
        const envObject = useKeys === true ? ( await FlowMcpCli.#resolveEnv( { cwd } ) ).envObject : {}

        const perSchema = []
        const reloadTotal = targetSchemas.length
        FlowMcpCli.#emitProgress( { quiet, 'message': `reload ${target}: re-fetch ${reloadTotal} schema(s)...` } )
        await targetSchemas
            .reduce( ( promise, schema, index ) => promise.then( async () => {
                FlowMcpCli.#emitProgress( { quiet, 'message': `[${index + 1}/${reloadTotal}] reload ${schema.schemaName}` } )
                const requiredServerParams = Array.isArray( schema.main[ 'requiredServerParams' ] ) ? schema.main[ 'requiredServerParams' ] : []
                const serverParams = useKeys === true
                    ? FlowMcpCli.#buildServerParams( { envObject, requiredServerParams } ).serverParams
                    : {}
                const { sharedLists } = await FlowMcpCli.#resolveSharedListsForSchema( { 'main': schema.main, 'filePath': schema.sourcePath } )
                const pretest = await grading[ 'DataPretest' ].run( {
                    namespace,
                    'toolName': schema.schemaName,
                    'main': schema.main,
                    'handlersFn': schema.handlersFn,
                    'schemaSnapshotPath': schema.sourcePath,
                    serverParams,
                    sharedLists,
                    'gradingDataDir': gradingDataRoot,
                    'force': true
                } )
                const testsWritten = ( Array.isArray( pretest.results ) ? pretest.results : [] )
                    .filter( ( r ) => r[ 'primitive' ] === 'tool' || r[ 'primitive' ] === 'resource' )
                    .length
                perSchema.push( {
                    'schema': schema.schemaName,
                    'reloaded': pretest.fromCache === false,
                    'testsWritten': testsWritten,
                    'ok': pretest.ok === true,
                    'keyGated': pretest.keyGated === true,
                    'dataAt': pretest.dataAt === undefined ? null : pretest.dataAt
                } )
            } ), Promise.resolve() )

        return {
            'result': {
                'status': true,
                'mode': 'reload',
                'target': target,
                'schemaCount': perSchema.length,
                'schemas': perSchema
            }
        }
    }


    // PRD-001 + PRD-003 (B2) — resolve the addressed schema from the LIVE
    // schemaFolders[] read (liveSchemas = { schemaName, main, handlersFn,
    // sourcePath }[]). A schema-ID names the folder directly (must exist). A
    // tool-ID needs a Tool->Schema lookup over the live main exports; a tool
    // present in several schema files is reported (visible note), never silently
    // first-won. No silent default.
    static #resolveDeterministicSchemaLive( { liveSchemas, parsed, namespace } ) {
        const schemaNames = liveSchemas.map( ( s ) => s.schemaName )

        if( parsed.type === 'schema' ) {
            const hit = liveSchemas
                .find( ( s ) => s.schemaName === parsed.name )
            if( hit === undefined ) {
                return { 'status': false, 'error': `Schema "${namespace}/${parsed.name}" not found in schemaFolders[] (schemas: ${schemaNames.join( ', ' ) || 'none'}).`, 'fix': 'Register the provider in schemaFolders[], or address an existing schema.' }
            }

            return { 'status': true, 'schemaName': hit.schemaName, 'sourcePath': hit.sourcePath, 'main': hit.main, 'handlersFn': hit.handlersFn, 'note': null }
        }

        // Tool-ID — find which live schema declares this tool by scanning its
        // tools/routes.
        const matches = liveSchemas
            .filter( ( s ) => {
                const tools = s.main[ 'tools' ] || s.main[ 'routes' ] || {}
                return Object.keys( tools ).includes( parsed.name ) === true
            } )

        if( matches.length === 0 ) {
            return { 'status': false, 'error': `Tool "${namespace}/tool/${parsed.name}" not found in any schema (schemas: ${schemaNames.join( ', ' ) || 'none'}).`, 'fix': 'Register the provider in schemaFolders[], or address an existing tool.' }
        }

        const note = matches.length > 1
            ? `Tool "${parsed.name}" found in ${matches.length} schemas (${matches.map( ( m ) => m.schemaName ).join( ', ' )}); using "${matches[ 0 ].schemaName}" (first match — multi-folder collision handling is Phase 3).`
            : null

        return { 'status': true, 'schemaName': matches[ 0 ].schemaName, 'sourcePath': matches[ 0 ].sourcePath, 'main': matches[ 0 ].main, 'handlersFn': matches[ 0 ].handlersFn, note }
    }


    // PRD-001 — project the raw DataPretest result onto an optional single-tool
    // filter. When a tool-ID is given, results[] is narrowed to that tool and the
    // pass-gate (ok/passedDownloadable) is recomputed over the filtered set so the
    // answer reflects only the addressed tool. No silent default: an empty filtered
    // set turns into ok:false with an explicit DPT-style error string.
    static #scopeDeterministicPretest( { pretestRaw, toolFilter } ) {
        const baseResults = Array.isArray( pretestRaw.results ) ? pretestRaw.results : []
        if( toolFilter === null ) {
            // Phase 5 surfacing: carry the deterministic SURFACING classes through to
            // the CLI output so they are visible (never silent) — keyGated (PRD-014),
            // the per-tool classes incl. parameterless/needs-tests (PRD-013), the FAIL
            // set and the explicit stopReason. No silent default: absent fields stay
            // absent rather than being fabricated.
            const pretest = {
                'ok': pretestRaw.ok,
                'keyGated': pretestRaw.keyGated === true,
                'passedDownloadable': pretestRaw.passedDownloadable,
                'required': pretestRaw.required,
                'toolsBelowThreshold': Array.isArray( pretestRaw.toolsBelowThreshold ) ? pretestRaw.toolsBelowThreshold : [],
                'perTool': pretestRaw.perTool === undefined || pretestRaw.perTool === null ? {} : pretestRaw.perTool,
                'stopReason': pretestRaw.stopReason === undefined ? null : pretestRaw.stopReason,
                'fromCache': pretestRaw.fromCache === true,
                'dataAt': pretestRaw.dataAt === undefined ? null : pretestRaw.dataAt,
                'results': baseResults,
                'errors': Array.isArray( pretestRaw.errors ) ? pretestRaw.errors : []
            }

            return { pretest }
        }

        const downloadablePrimitives = [ 'tool', 'resource' ]
        const filtered = baseResults
            .filter( ( r ) => r[ 'name' ] === toolFilter )
        const passedDownloadable = filtered
            .filter( ( r ) => r[ 'working' ] === true )
            .length
        const required = pretestRaw.required
        const downloadableInTool = filtered
            .filter( ( r ) => downloadablePrimitives.includes( r[ 'primitive' ] ) )
            .length

        // Phase 5 surfacing: take the authoritative per-tool class from the raw
        // pretest (DataPretest computed it against the per-tool EFFECTIVE bar, incl.
        // parameterless Bar=1 / key-gated). A key-gated schema is NOT a FAIL for the
        // single tool either. No silent default — an absent per-tool node degrades
        // to the legacy global-bar gate.
        const rawPerTool = pretestRaw.perTool === undefined || pretestRaw.perTool === null ? {} : pretestRaw.perTool
        const toolNode = rawPerTool[ toolFilter ] === undefined ? null : rawPerTool[ toolFilter ]
        const keyGated = pretestRaw.keyGated === true
        const toolBar = toolNode !== null && typeof toolNode.bar === 'number' ? toolNode.bar : required

        // Re-derive the gate for the single tool: not key-gated AND downloadable AND
        // meeting its own effective bar.
        const ok = keyGated === false && downloadableInTool > 0 && passedDownloadable >= toolBar
        const errors = []
        if( keyGated === false && filtered.length === 0 && ( toolNode === null || toolNode.total !== 0 ) ) {
            errors.push( `DPT-004: Tool "${toolFilter}" produced no test results in the pretest.` )
        }
        if( keyGated === false && ok === false && filtered.length > 0 ) {
            errors.push( `DPT-003: Tool "${toolFilter}" below ${toolBar} working downloadable tests (${passedDownloadable}/${toolBar}).` )
        }
        // Preserve the per-tool DPT-004/006/007/008 detail lines that mention this tool.
        const carried = ( Array.isArray( pretestRaw.errors ) ? pretestRaw.errors : [] )
            .filter( ( e ) => typeof e === 'string' && ( e.includes( `${toolFilter}:` ) || ( keyGated && e.includes( 'DPT-007' ) ) ) )

        const pretest = {
            ok,
            keyGated,
            passedDownloadable,
            required,
            'toolsBelowThreshold': ok === false && keyGated === false && toolNode !== null
                ? [ `${toolFilter} (${passedDownloadable}/${toolBar})` ]
                : [],
            'perTool': toolNode === null ? {} : { [ toolFilter ]: toolNode },
            'stopReason': pretestRaw.stopReason === undefined ? null : pretestRaw.stopReason,
            'fromCache': pretestRaw.fromCache === true,
            'dataAt': pretestRaw.dataAt === undefined ? null : pretestRaw.dataAt,
            'results': filtered,
            'errors': [ ...errors, ...carried ]
        }

        return { pretest }
    }


    // PRD-002 — the migrated v4-primitive view (`dev test --only`). tool/resource
    // are sourced from the DataPretest results (PRD-001); skill/prompt/
    // selection-member from the structural #runTypedTests path. Aggregated per
    // primitive via #aggregateByPrimitive (the exact shape `dev test` produced).
    static async #deterministicPrimitiveView( { main, handlersFn, schemaSource, serverParams, sharedLists, onlyFilter, toolFilter, pretest } ) {
        const { handlerMap, resourceHandlerMap } = await FlowMcpCli.#resolveHandlers( { main, handlersFn, 'filePath': schemaSource } )

        let typedResults = []
        try {
            const typedRun = await FlowMcpCli.#runTypedTests( {
                main,
                schemaSource,
                handlerMap,
                'resourceHandlerMap': resourceHandlerMap || {},
                serverParams,
                sharedLists,
                'fullOutput': false
            } )
            typedResults = typedRun[ 'results' ] || []
        } catch( err ) {
            typedResults = [ { 'primitive': 'tool', 'name': '*', 'status': false, 'error': err.message } ]
        }

        // Restrict to the requested primitives, and to the addressed tool when a
        // tool-ID was given.
        const scoped = typedResults
            .filter( ( r ) => onlyFilter.includes( r[ 'primitive' ] ) )
            .filter( ( r ) => toolFilter === null || r[ 'primitive' ] !== 'tool' || r[ 'name' ] === toolFilter )

        const { declared } = FlowMcpCli.#computeDeclared( { main } )
        const { summary } = FlowMcpCli.#aggregateByPrimitive( { 'results': scoped, declared, 'filter': onlyFilter } )

        const view = {
            'tools': summary[ 'tool' ],
            'resources': summary[ 'resource' ],
            'skills': summary[ 'skill' ],
            'prompts': summary[ 'prompt' ],
            'selections': summary[ 'selection-member' ]
        }

        return { view }
    }


    // PRD-001 — derive actionable hints ONLY from the existing structural-validate
    // messages and the DataPretest errors[] (no new error classes here). A green
    // result yields an empty hint list.
    static #deterministicHints( { validate, pretest } ) {
        const hints = []
        if( validate[ 'status' ] !== true ) {
            ( validate[ 'messages' ] || [] )
                .forEach( ( m ) => { hints.push( `structural: ${m}` ) } )
        }
        if( pretest.ok !== true ) {
            ( pretest.errors || [] )
                .forEach( ( e ) => { hints.push( `pretest: ${e}` ) } )
        }

        return { hints }
    }


    // Improvement-loop bound. Memo 097 Kap. 9.0 fix #3: the historical fixed
    // value was 3; the new default is 1 (single pass), higher is opt-in. Absent
    // means default; a supplied value must parse to a positive integer.
    static #resolveMaxIterations( { maxIterations } ) {
        if( maxIterations === null || maxIterations === undefined ) {
            return { 'maxIterations': 1, 'error': null }
        }
        const parsed = Number( maxIterations )
        if( Number.isInteger( parsed ) === false || parsed < 1 ) {
            return { 'maxIterations': null, 'error': `Invalid --max-iterations value: ${maxIterations}` }
        }

        return { 'maxIterations': parsed, 'error': null }
    }


    // PRD-3.5 — resolve the configurable Goal-Block turn bound. Absent -> 25 (the
    // documented default); a supplied value must be a positive integer. NO SILENT
    // DEFAULT for a malformed value (it errors rather than falling back to 25).
    static #resolveMaxTurns( { maxTurns } ) {
        if( maxTurns === null || maxTurns === undefined ) {
            return { 'maxTurns': 25, 'error': null }
        }
        const parsed = Number( maxTurns )
        if( Number.isInteger( parsed ) === false || parsed < 1 ) {
            return { 'maxTurns': null, 'error': `Invalid --max-turns value: ${maxTurns}` }
        }

        return { 'maxTurns': parsed, 'error': null }
    }


    // PRD-004 — resolve the --phase flag into a multi-area selector. Three explicit
    // modes, no silent default:
    //   absent          -> { mode: 'default', areas: null } (all applicable)
    //   one token       -> { mode: 'single', areas: [ a ] }
    //   two+ tokens     -> { mode: 'subset', areas: [ a, b, ... ] }
    // Every named token is whitelist-validated against VALID_AREAS (the grading
    // module's canonical area list). An empty member after trim, a duplicate token,
    // or an unknown area is a HARD error (no silent skip, no silent dedupe).
    static #resolveAreaSelector( { phase, grading } ) {
        if( phase === null || phase === undefined ) {
            return { 'status': true, 'mode': 'default', 'areas': null, 'error': null }
        }
        if( typeof phase !== 'string' ) {
            return { 'status': false, 'mode': null, 'areas': null, 'error': `Invalid --phase type: expected a comma-separated string, got ${typeof phase}.` }
        }

        const rawTokens = phase.split( ',' )
        const tokens = rawTokens.map( ( t ) => t.trim() )
        const emptyMember = tokens.some( ( t ) => t.length === 0 )
        if( emptyMember === true ) {
            return { 'status': false, 'mode': null, 'areas': null, 'error': `Empty --phase member in "${phase}" (no silent skip; every comma-separated area must be non-empty).` }
        }

        const { areas: validAreas } = grading[ 'PromptBuilder' ].getValidAreas()
        const unknown = tokens.filter( ( t ) => validAreas.includes( t ) === false )
        if( unknown.length > 0 ) {
            return { 'status': false, 'mode': null, 'areas': null, 'error': `Unknown --phase area(s): ${unknown.join( ', ' )} (allowed: ${validAreas.join( ', ' )}).` }
        }

        const seen = []
        const duplicates = []
        tokens
            .forEach( ( t ) => {
                if( seen.includes( t ) === true ) { duplicates.push( t ) }
                else { seen.push( t ) }
            } )
        if( duplicates.length > 0 ) {
            return { 'status': false, 'mode': null, 'areas': null, 'error': `Duplicate --phase area(s): ${duplicates.join( ', ' )} (no silent dedupe; pass each area once).` }
        }

        const mode = tokens.length === 1 ? 'single' : 'subset'
        return { 'status': true, mode, 'areas': tokens, 'error': null }
    }


    // Compose one prompt per grading area via the AreaPromptLoader (Memo 097
    // Kap. 9.0). The loader reuses PromptBuilder.build and resolves the package-
    // local prompts/ tree itself, so the CLI does not guess paths.
    static async #composeGradingAreas( { grading, flow, substitutions = null } ) {
        const AreaPromptLoader = grading[ 'AreaPromptLoader' ]
        if( AreaPromptLoader === undefined || AreaPromptLoader === null ) {
            throw new Error( 'AreaPromptLoader unavailable from flowmcp-grading — update the dependency.' )
        }
        const { promptsRoot } = AreaPromptLoader.getPromptsRoot()
        // PRD-3.2: pass the substitution context so the composed prompts carry real
        // schema paths + tool/namespace names (no torso). A null context keeps the
        // legacy placeholder behaviour (back-compat for callers without schema data).
        const { areas } = await AreaPromptLoader.loadAllAreas( { promptsRoot, flow, substitutions } )

        return { areas }
    }


    // PRD-3.2 — build the emit substitution context for a provider. Paths are
    // REPO-RELATIVE (git-security: never leak an absolute path into the emitted
    // artifact). The single-test/tools-aggregate areas are bundled across the
    // namespace, so {{TOOL_NAME}} resolves to the joined declared tool list and
    // {{SCHEMA_NAME}} to the schema name (single schema) or the namespace.
    static #buildEmitSubstitutions( { cwd, namespace, liveSchemas, pretests } ) {
        const allTools = liveSchemas
            .flatMap( ( s ) => {
                const tools = s.main[ 'tools' ] || s.main[ 'routes' ] || {}
                return Object.keys( tools )
            } )
        const toolName = allTools.length > 0 ? allTools.join( ', ' ) : namespace
        const schemaName = liveSchemas.length === 1 ? liveSchemas[ 0 ].schemaName : namespace
        const firstSchema = liveSchemas[ 0 ]
        const schemaPath = firstSchema !== undefined && typeof firstSchema.sourcePath === 'string'
            ? FlowMcpCli.#toRepoRelativePath( { cwd, 'path': firstSchema.sourcePath } )
            : `providers/${namespace}`
        const firstPretest = pretests.find( ( p ) => typeof p.summaryPath === 'string' )
        const responseFixturePath = firstPretest !== undefined
            ? FlowMcpCli.#toRepoRelativePath( { cwd, 'path': firstPretest.summaryPath } )
            : `providers/${namespace}`

        return { namespace, schemaName, toolName, schemaPath, responseFixturePath }
    }


    // PRD-3.3/3.4 — assemble the ONE self-contained Emit-Skill text. Bundles every
    // READY area (non-null prompt = the currently-emittable stage) into a single
    // instruction a subagent works in one pass, and writes the Task-ID + the exact
    // --consume-scores return command INTO the text (Kap 10.1). Hard-gated stage-2
    // areas are named so the operator knows a follow-up emit is due once every
    // schema is deterministic-green.
    static #buildEmitSkill( { target, flow, namespace, taskId, emittedAreas, gatedAreas, payloadSkeleton } ) {
        const ready = emittedAreas
            .filter( ( a ) => typeof a.prompt === 'string' && a.prompt.length > 0 )
        const deferred = emittedAreas
            .filter( ( a ) => a.prompt === null || a.prompt === undefined )
            .map( ( a ) => a.area )

        const header = [
            '# Grading Emit-Skill',
            '',
            'This is a grading skill. Hand it to a subagent and follow the steps in',
            'order. Work the bundled areas below in a SINGLE pass, then return your',
            'results via the command at the end. Answer only from the files you read —',
            'no web research, no assumptions.',
            '',
            `- Target: \`${target}\` (flow: ${flow}, namespace: ${namespace})`,
            `- Task-ID: \`${taskId}\``,
            `- Ready areas this pass: ${ready.map( ( a ) => a.area ).join( ', ' ) || '(none)'}`
        ].join( '\n' )

        const gatedNote = ( Array.isArray( gatedAreas ) ? gatedAreas : [] ).length > 0
            ? [
                '',
                '## Gated areas (NOT in this pass)',
                '',
                'These stage-2 areas are emitted in a FOLLOW-UP skill once every schema',
                'of the namespace is deterministic-green — do not attempt them now:',
                ...( gatedAreas.map( ( g ) => `- ${typeof g === 'string' ? g : ( g.area === undefined ? JSON.stringify( g ) : `${g.area} (${g.reason === undefined ? 'gated' : g.reason})` )}` ) )
            ].join( '\n' )
            : ''

        const deferredNote = deferred.length > 0
            ? `\n\n## Deferred areas\n\nComposed by the harness with the resolved persona (not in this text): ${deferred.join( ', ' )}.`
            : ''

        const areaBlocks = ready
            .map( ( a ) => `\n\n---\n\n## Area: ${a.area}\n\n${a.prompt}` )
            .join( '' )

        const returnContract = [
            '',
            '',
            '---',
            '',
            '## Return your results',
            '',
            'Produce ONE result object per area in this pass. Shape:',
            '',
            '```json',
            JSON.stringify( payloadSkeleton, null, 2 ),
            '```',
            '',
            'When finished, return the filled array by running:',
            '',
            '```bash',
            `flowmcp grading non-deterministic ${namespace} --consume-scores <your-results-file.json>`,
            '```',
            '',
            `The results file MUST carry this Task-ID (\`${taskId}\`) so consume-scores can`,
            'match your answers to this emit. Provide exactly the asked number of results',
            'per area — no more, no fewer.'
        ].join( '\n' )

        return `${header}${gatedNote}${deferredNote}${areaBlocks}${returnContract}\n`
    }


    // Stage 1 — deterministic: Phase-0/1 wiring -> DataPretest.run -> emit the
    // /goal handoff (prompts.json + state.json baton). The CLI does NOT run
    // Agent() — Stage 2 lives in the harness.
    static async #gradingEmitPrompts( { cwd, grading, gradingDataRoot, flow, tier, maxGrade, targetDir, target, areaSelector, conflict, maxIterations, maxTurns = 25, useKeys, dryRun = false, quiet = false, dependencyChain } ) {
        const namespace = basename( targetDir )
        const promptsPath = join( targetDir, 'prompts.json' )
        const statePath = join( targetDir, 'state.json' )

        // PRD-012 — --no-save (dryRun) means NO write happens. The --on-conflict
        // policy is ORTHOGONAL (it only decides HOW an actual write resolves a
        // collision), so when dryRun is set we never consult it: there is no write
        // that could collide. The conflict-gate below runs only for real writes.
        if( dryRun !== true && existsSync( promptsPath ) === true && conflict === 'abort' ) {
            return { 'result': FlowMcpCli.#error( { 'error': `NO-OVERWRITE conflict: ${promptsPath} already exists`, 'fix': 'Pass --on-conflict=skip to keep the existing handoff, or remove it deliberately.' } ) }
        }
        if( dryRun !== true && existsSync( promptsPath ) === true && conflict === 'skip' ) {
            return { 'result': { 'status': true, 'stage': 1, 'mode': 'emit-prompts', 'skipped': true, promptsPath, statePath, dependencyChain } }
        }

        // Phase-0/1 wiring (REV-14 Kap. 15): resolveEnv -> buildServerParams ->
        // loadSchema -> resolveSharedLists -> DataPretest.run directly. The CLI is
        // the only component with .env access; serverParams are flat { KEY:value }.
        const pretests = []

        // PRD-003 (B2): the schemas to grade come LIVE from schemaFolders[], not
        // from the island import snapshot. For a provider the live read is keyed by
        // namespace; for a selection each member (<ns>.<schema>) is resolved live
        // from its declaring provider in schemaFolders[].
        let liveSchemas = null
        let schemaDirs = null
        if( flow === 'provider' ) {
            const resolvedSchemas = await FlowMcpCli.#resolveSchemasForTarget( { namespace } )
            if( resolvedSchemas.status === false ) {
                return { 'result': FlowMcpCli.#error( { 'error': resolvedSchemas.error, 'fix': resolvedSchemas.fix } ) }
            }
            liveSchemas = resolvedSchemas.schemas
        } else {
            // Selection flow: the schemas to pretest are the selection members. They
            // too are resolved LIVE from schemaFolders[] (PRD-003) via their
            // <namespace>.<schemaName> member IDs — never from the island snapshot.
            const resolvedMembers = await FlowMcpCli.#resolveSelectionSchemasLive( { targetDir } )
            if( resolvedMembers.status === false ) {
                return { 'result': FlowMcpCli.#error( { 'error': resolvedMembers.error, 'fix': resolvedMembers.fix } ) }
            }
            liveSchemas = resolvedMembers.schemas
        }
        schemaDirs = liveSchemas.map( ( s ) => s.schemaName )

        // PRD-006: the deterministic pretest runs for EVERY schema regardless of
        // the area selector — the per-schema/per-namespace requiredLevel is derived
        // from these results to gate the namespace areas. The selector filters the
        // emitted AREA prompts later, not the pretest pass.
        const pretestUnits = liveSchemas

        FlowMcpCli.#emitProgress( { quiet, 'message': `emit ${target}: data pretest over ${pretestUnits.length} schema(s)...` } )
        await pretestUnits
            .reduce( ( promise, unit, index ) => promise.then( async () => {
                const { schemaName, main, handlersFn, sourcePath } = unit
                FlowMcpCli.#emitProgress( { quiet, 'message': `[${index + 1}/${pretestUnits.length}] pretest ${schemaName}` } )
                if( main === null || main === undefined ) {
                    pretests.push( { schemaName, 'ok': false, 'errors': [ `cannot load schema source for ${schemaName}` ] } )
                    return
                }

                // PA-5 gate: only inject local keys when the developer explicitly
                // opted in (useKeys === true). When OFF (default), pass an empty
                // serverParams object so key-gated tools fail deterministically with
                // DPT-005 — no authenticated request leaves the machine. The env is
                // still resolved when ON; when OFF we skip the read entirely.
                const requiredServerParams = Array.isArray( main[ 'requiredServerParams' ] ) ? main[ 'requiredServerParams' ] : []
                const serverParams = useKeys === true
                    ? FlowMcpCli.#buildServerParams( { 'envObject': ( await FlowMcpCli.#resolveEnv( { cwd } ) ).envObject, requiredServerParams } ).serverParams
                    : {}
                const { sharedLists } = await FlowMcpCli.#resolveSharedListsForSchema( { main, 'filePath': sourcePath } )

                const pretest = await grading[ 'DataPretest' ].run( {
                    namespace,
                    'toolName': schemaName,
                    main,
                    handlersFn,
                    'schemaSnapshotPath': sourcePath,
                    serverParams,
                    sharedLists,
                    'gradingDataDir': gradingDataRoot,
                    dryRun
                } )

                // F26: never persist serverParams or request payloads — only the
                // schema name, ok-flag and summary path go into the handoff. Missing
                // keys surface by NAME only (DPT-005), never as a value.
                pretests.push( {
                    schemaName,
                    'ok': pretest.ok,
                    'passedDownloadable': pretest.passedDownloadable,
                    'required': pretest.required,
                    'summaryPath': pretest.summaryPath,
                    'errors': pretest.errors
                } )
            } ), Promise.resolve() )

        // Goal-Block (PromptBuilder) — the completion condition + surfacing
        // convention that drives the harness /goal loop (Stage 2).
        // PRD-3.5 — maxTurns is the configurable Goal-Block turn bound (default 25,
        // resolved by the caller). buildGoalBlock echoes it back in `condition`.
        const { goalBlock, condition } = grading[ 'PromptBuilder' ].buildGoalBlock( {
            'condition': `Grade the ${flow} "${target}" (tier ${tier}, max grade ${maxGrade}) across all required areas until every area reaches a stable grade`,
            'maxTurns': maxTurns
        } )

        // Memo 097 Kap. 9.0 fix #1: compose ONE prompt per area via the
        // AreaPromptLoader (which reuses PromptBuilder.build), not only the
        // goalBlock. Neutral areas are composed deterministically here; persona-
        // required areas are surfaced as deferred entries (harness composes them
        // with the resolved domain/selection persona — no invented persona).
        // PRD-3.2: a substitution context fills the real schema path + tool/namespace
        // names into the neutral composed prompts (no {{…}} torso). Repo-relative
        // paths only — never leak an absolute path into the emitted artifact.
        const substitutions = flow === 'provider'
            ? FlowMcpCli.#buildEmitSubstitutions( { cwd, namespace, liveSchemas, pretests } )
            : null
        const { areas } = await FlowMcpCli.#composeGradingAreas( { grading, flow, substitutions } )

        // PRD-005/006/004 — derive the FINAL emitted area set from the composed
        // areas: applicability pre-filter (optional-area precondition absent ->
        // skipped), dependency/Namespace-Gate (non-det namespace areas gated until
        // all schemas deterministic-green), then the caller's area selector. Each
        // partition is auditable; nothing is silently dropped.
        const resolvedAreas = await FlowMcpCli.#resolveEmittedAreas( {
            grading, areas, targetDir, schemaDirs, pretests, areaSelector
        } )
        if( resolvedAreas.status === false ) {
            return { 'result': FlowMcpCli.#error( { 'error': resolvedAreas.error, 'fix': resolvedAreas.fix } ) }
        }
        const emittedAreas = resolvedAreas.emittedAreas
        const skippedAreas = resolvedAreas.skippedAreas
        const gatedAreas = resolvedAreas.gatedAreas

        // PRD-007 — deterministic, order-independent Task-ID over the emitted set.
        // The set must be non-empty to carry a Task-ID; an empty set (everything
        // skipped/gated/filtered) is surfaced explicitly, not silently hashed.
        const emittedAreaSet = emittedAreas.map( ( a ) => a.area )
        const taskResult = FlowMcpCli.#computeGradingTaskId( { grading, namespace, emittedAreaSet } )
        if( taskResult.status === false ) {
            return { 'result': FlowMcpCli.#error( { 'error': taskResult.error, 'fix': taskResult.fix } ) }
        }
        const taskId = taskResult.taskId
        const payloadSkeleton = { taskId, 'areas': emittedAreas.map( ( a ) => ( { 'area': a.area, 'results': [] } ) ) }

        // PRD-3.3/3.4 — assemble ONE self-contained Emit-Skill text: a self-describing
        // header, the bundled READY (non-null prompt) areas, and the Task-ID +
        // --consume-scores return contract IN THE TEXT (not only as JSON siblings).
        // Hard-gated stage-2 areas are named so the operator knows a follow-up emit
        // is needed once every schema is deterministic-green.
        const emitSkill = FlowMcpCli.#buildEmitSkill( {
            target, flow, namespace, taskId, emittedAreas, gatedAreas, payloadSkeleton
        } )

        const now = new Date().toISOString()
        const promptsDoc = {
            target,
            flow,
            tier,
            maxGrade,
            namespace,
            'scoringProtocol': 'v1',
            maxIterations,
            taskId,
            'goal': { condition, maxTurns, goalBlock },
            emitSkill,
            'areas': emittedAreas,
            skippedAreas,
            gatedAreas,
            payloadSkeleton,
            'pretests': pretests
        }

        const stateDoc = {
            target,
            flow,
            tier,
            taskId,
            emittedAreaSet,
            'askedByArea': emittedAreas
                .filter( ( a ) => typeof a.questionCount === 'number' )
                .reduce( ( acc, a ) => { acc[ a.area ] = a.questionCount; return acc }, {} ),
            'taskComplete': false,
            'consumedAreas': [],
            'areaSelector': { 'mode': areaSelector.mode, 'areas': areaSelector.areas },
            'status': 'prompts-emitted',
            'createdAt': now,
            'lastUpdatedAt': now,
            'phases': {
                'promptsEmitted': now,
                'scoresReceived': null,
                'gradeComputed': null,
                'indexRebuilt': null
            },
            dependencyChain
        }

        // PRD-012 — --no-save (dryRun): the deterministic pretest already skipped its
        // own persist; here we ALSO skip the prompts.json/state.json handoff. Skipping
        // only one would leave a half-updated island (handoff present, pretest gone),
        // which is exactly the forbidden state. The result still carries the Task-ID,
        // emitted area-set and pretest summary so the caller can inspect them.
        if( dryRun === true ) {
            return {
                'result': {
                    'status': true,
                    'stage': 1,
                    'mode': 'emit-prompts',
                    'saved': false,
                    'skipped': false,
                    flow,
                    tier,
                    maxGrade,
                    target,
                    'useKeys': useKeys === true,
                    'promptsPath': null,
                    'statePath': null,
                    'pretestCount': pretests.length,
                    taskId,
                    emitSkill,
                    'areaSelector': { 'mode': areaSelector.mode, 'areas': areaSelector.areas },
                    'emittedAreaSet': emittedAreaSet,
                    skippedAreas,
                    gatedAreas,
                    dependencyChain
                }
            }
        }

        // Write-safety: atomic + No-Overwrite. prompts respects the explicit
        // conflict policy; state is a one-time baton (skip if present).
        const promptsWrite = await FlowMcpCli.#writeAtomic( { 'path': promptsPath, 'content': JSON.stringify( promptsDoc, null, 4 ), 'onConflict': conflict } )
        await FlowMcpCli.#writeAtomic( { 'path': statePath, 'content': JSON.stringify( stateDoc, null, 4 ), 'onConflict': 'skip' } )

        return {
            'result': {
                'status': true,
                'stage': 1,
                'mode': 'emit-prompts',
                'saved': true,
                'skipped': promptsWrite.skipped === true,
                flow,
                tier,
                maxGrade,
                target,
                'useKeys': useKeys === true,
                promptsPath,
                statePath,
                'pretestCount': pretests.length,
                taskId,
                emitSkill,
                'areaSelector': { 'mode': areaSelector.mode, 'areas': areaSelector.areas },
                'emittedAreaSet': emittedAreaSet,
                skippedAreas,
                gatedAreas,
                dependencyChain
            }
        }
    }


    // PRD-005/006/004 — partition composed areas into emitted / skipped / gated.
    // Order: applicability pre-filter (PRD-005) -> dependency+Namespace-Gate
    // (PRD-006) -> caller area selector (PRD-004). NO silent default at any step.
    static async #resolveEmittedAreas( { grading, areas, targetDir, schemaDirs, pretests, areaSelector } ) {
        // --- PRD-005: optional-area applicability pre-filter ---------------------
        const aboutProbe = await FlowMcpCli.#detectAboutResourcePresent( { targetDir, schemaDirs } )
        const filtered = FlowMcpCli.#filterApplicableAreas( { grading, areas, aboutPresent: aboutProbe.present } )
        if( filtered.status === false ) {
            return { 'status': false, 'error': filtered.error, 'fix': filtered.fix }
        }

        // --- PRD-006: derive levels + evaluate the dependency graph --------------
        const gated = FlowMcpCli.#evaluateAreaGate( { grading, areas: filtered.applicableAreas, pretests, schemaCount: schemaDirs.length, aboutPresent: aboutProbe.present } )
        if( gated.status === false ) {
            return { 'status': false, 'error': gated.error, 'fix': gated.fix }
        }

        // --- PRD-004: apply the resolved area selector ---------------------------
        const selected = FlowMcpCli.#applyAreaSelector( { areas: gated.readyAreas, areaSelector } )

        // Caller-named-but-skipped/gated areas (subset/single) are surfaced so the
        // caller is never silently ignored. Re-collect any selector-named area that
        // landed in skipped/gated for the result note.
        const skippedAreas = filtered.skippedAreas
            .concat( selected.selectorSkippedNote )

        return {
            'status': true,
            'emittedAreas': selected.emittedAreas,
            'skippedAreas': skippedAreas,
            'gatedAreas': gated.gatedAreas
        }
    }


    // PRD-005 — probe whether the About resource exists at the SOURCE level for any
    // schema folder (resources/about/), mirroring the rebuild lookup but at the
    // resource (not _gradings/) level. A probe error returns present:false with a
    // recorded note — never a thrown swallow, never a silent true.
    static async #detectAboutResourcePresent( { targetDir, schemaDirs } ) {
        const checks = await schemaDirs
            .reduce( async ( accPromise, schemaName ) => {
                const acc = await accPromise
                if( acc.present === true ) { return acc }
                const aboutDir = join( targetDir, schemaName, 'resources', 'about' )
                const exists = existsSync( aboutDir )
                return { 'present': exists, 'note': acc.note }
            }, Promise.resolve( { 'present': false, 'note': null } ) )

        return { 'present': checks.present }
    }


    // PRD-005 — partition composed areas into applicable vs skipped. An OPTIONAL
    // area whose precondition is absent is skipped with a closed-set NaReason.
    // The only optional provider area today is `about-namespace`, whose
    // precondition is About-resource presence. The map is explicit (no silent
    // default); the chosen NaReason is validated against the grading closed set so
    // a spec drift surfaces immediately.
    static #filterApplicableAreas( { grading, areas, aboutPresent } ) {
        const OPTIONAL_AREA_PRECONDITION = { 'about-namespace': { 'naReason': 'out-of-scope-resource', 'present': aboutPresent } }

        const applicableAreas = []
        const skippedAreas = []
        let failure = null

        areas
            .forEach( ( areaEntry ) => {
                const rule = OPTIONAL_AREA_PRECONDITION[ areaEntry.area ]
                if( rule === undefined ) {
                    applicableAreas.push( areaEntry )
                    return
                }
                if( rule.present === true ) {
                    applicableAreas.push( areaEntry )
                    return
                }
                const valid = grading[ 'NaReason' ].isAllowed( { 'naReason': rule.naReason } )
                if( valid.allowed !== true ) {
                    failure = `NaReason "${rule.naReason}" for skipped area ${areaEntry.area} is not in the grading closed set.`
                    return
                }
                skippedAreas.push( { 'area': areaEntry.area, 'naReason': rule.naReason } )
            } )

        if( failure !== null ) {
            return { 'status': false, 'error': failure, 'fix': 'Align the optional-area NaReason map with the grading NaReason closed set.' }
        }

        return { 'status': true, applicableAreas, skippedAreas }
    }


    // PRD-006 — derive per-schema + namespace levels from the pretest results and
    // evaluate the seeded dependency graph. Namespace areas are gated until ALL
    // schemas reach deterministic-green (the cost guard / Provider-Namespace-Gate).
    // Returns ready vs gated partitions; no hardcoded threshold (read from graph).
    static #evaluateAreaGate( { grading, areas, pretests, schemaCount, aboutPresent } ) {
        const loaded = grading[ 'AreaDependencyGraph' ].loadDefaultGraph()
        if( loaded.errors.length > 0 ) {
            return { 'status': false, 'error': `Area dependency graph not loadable: ${loaded.errors.join( '; ' )}`, 'fix': 'Reinstall / update flowmcp-grading (the seeded graph data is missing).' }
        }

        const schemaLevels = pretests
            .map( ( pretest ) => {
                const detGreen = pretest.ok === true
                const derived = grading[ 'RequiredLevel' ].deriveSchemaLevel( {
                    'snapshotPresent': true,
                    'structuralValid': true,
                    'dataPretest': { 'ok': pretest.ok === true },
                    detGreen,
                    'gradingStatus': 'pending'
                } )
                return derived.level
            } )
            .filter( ( level ) => level !== null )

        // No usable schema level (zero schemas / all unresolvable): the namespace
        // cannot reach deterministic-green, so namespace areas stay gated. Use the
        // lowest ladder rung explicitly rather than a silent default.
        const namespaceLevel = schemaLevels.length === schemaCount && schemaLevels.length > 0
            ? grading[ 'RequiredLevel' ].deriveNamespaceLevel( { schemaLevels } ).level
            : 'imported'

        const evaluated = grading[ 'AreaDependencyGraph' ].evaluate( {
            'graph': loaded.graph,
            'derivedLevels': { namespaceLevel, aboutPresent, 'memberLevel': 'imported' }
        } )
        if( evaluated.errors.length > 0 ) {
            return { 'status': false, 'error': `Area gate evaluation failed: ${evaluated.errors.join( '; ' )}`, 'fix': 'Inspect the dependency graph data and derived levels.' }
        }

        const readyAreaNames = evaluated.ready
        const gatedReasonByArea = evaluated.gated
            .reduce( ( acc, g ) => { acc[ g.area ] = g.reason; return acc }, {} )

        const readyAreas = areas.filter( ( a ) => readyAreaNames.includes( a.area ) === true )
        const gatedAreas = areas
            .filter( ( a ) => readyAreaNames.includes( a.area ) === false )
            .map( ( a ) => ( { 'area': a.area, 'reason': gatedReasonByArea[ a.area ] === undefined ? 'dependency not satisfied' : gatedReasonByArea[ a.area ] } ) )

        return { 'status': true, readyAreas, gatedAreas }
    }


    // PRD-004 — apply the resolved area selector to the ready areas. default mode
    // emits all ready; single/subset emit only the named ready areas. A named area
    // that is NOT ready (skipped/gated/unknown-to-flow) is recorded as a note so
    // the caller is not silently ignored.
    static #applyAreaSelector( { areas, areaSelector } ) {
        if( areaSelector.mode === 'default' ) {
            return { 'emittedAreas': areas, 'selectorSkippedNote': [] }
        }

        const readyNames = areas.map( ( a ) => a.area )
        const emittedAreas = areas.filter( ( a ) => areaSelector.areas.includes( a.area ) === true )
        const selectorSkippedNote = areaSelector.areas
            .filter( ( name ) => readyNames.includes( name ) === false )
            .map( ( name ) => ( { 'area': name, 'naReason': 'blocked-by-precondition', 'note': 'named in --phase but not currently emittable (skipped or gated)' } ) )

        return { emittedAreas, selectorSkippedNote }
    }


    // PRD-007 — compute the deterministic Task-ID over the emitted area set via the
    // shared TaskId generator (order-independent, 8-hex). An empty emitted set has
    // no Task-ID — surfaced explicitly (no silent empty hash).
    static #computeGradingTaskId( { grading, namespace, emittedAreaSet } ) {
        if( emittedAreaSet.length === 0 ) {
            return { 'status': false, 'error': 'No emittable areas after applicability/gate/selector resolution.', 'fix': 'Relax --phase, satisfy the dependency gate (reach deterministic-green), or add the missing optional resource.' }
        }
        const generated = grading[ 'TaskId' ].generate( { 'schemaIdSlug': namespace, 'areas': emittedAreaSet } )
        if( generated.errors.length > 0 ) {
            return { 'status': false, 'error': `Task-ID generation failed: ${generated.errors.join( '; ' )}`, 'fix': 'Ensure every emitted area is a known area.' }
        }
        return { 'status': true, 'taskId': generated.taskId }
    }


    // PRD-007 — verify a consume payload against the open emit recorded in
    // state.json. Ordered checks (no silent default): taskId known, area-set
    // subset of the emitted set, per-area answered==asked count. Partial-Set
    // (F11=A): areas present-and-valid are accepted; emitted areas absent from the
    // payload stay pending; the Task-ID is complete ONLY at the full set. Any
    // mismatch -> Reject. The check is ADDITIVE: a scores doc that carries no
    // `taskId` follows the legacy rebuild path unchanged (backward-compatible).
    static #verifyConsumePayload( { grading, scoresDoc, state } ) {
        const present = scoresDoc[ 'taskId' ] !== undefined && scoresDoc[ 'taskId' ] !== null
        if( present === false ) {
            return { 'status': true, 'verified': false, 'acceptedAreas': [], 'missingAreas': [], 'complete': false, 'error': null }
        }

        if( state === null || typeof state[ 'taskId' ] !== 'string' || Array.isArray( state[ 'emittedAreaSet' ] ) === false ) {
            return { 'status': false, 'error': 'Consume payload carries a taskId but no open emit (state.json missing taskId/emittedAreaSet). Re-run --emit-prompts first.' }
        }
        if( scoresDoc[ 'taskId' ] !== state[ 'taskId' ] ) {
            return { 'status': false, 'error': `Unknown taskId: ${scoresDoc[ 'taskId' ]} does not match the open emit ${state[ 'taskId' ]}.` }
        }

        if( Array.isArray( scoresDoc[ 'areas' ] ) === false ) {
            return { 'status': false, 'error': 'Consume payload with a taskId must carry an areas[] array (one entry per consumed area).' }
        }

        const emittedSet = state[ 'emittedAreaSet' ]
        const payloadAreaNames = scoresDoc[ 'areas' ].map( ( a ) => a.area )
        const outOfSet = payloadAreaNames.filter( ( name ) => emittedSet.includes( name ) === false )
        if( outOfSet.length > 0 ) {
            return { 'status': false, 'error': `Area(s) not in the emitted set: ${outOfSet.join( ', ' )} (emitted: ${emittedSet.join( ', ' )}).` }
        }

        // Per-area question-count: an area is ANSWERED when its results[] is
        // non-empty; then answered-count == asked-count, else Reject. An area
        // present with an EMPTY results[] is not-yet-answered (it stays pending,
        // F11=A partial-set) — that is NOT a count mismatch. `asked` is the per-area
        // count the emit recorded; if no count was recorded for an area, the count
        // is not enforced (explicit: only where a count exists, no silent zero).
        const askedByArea = FlowMcpCli.#askedCountByArea( { state } )
        const answeredAreas = scoresDoc[ 'areas' ]
            .filter( ( a ) => Array.isArray( a.results ) === true && a.results.length > 0 )
        const countMismatch = answeredAreas
            .filter( ( a ) => {
                const asked = askedByArea[ a.area ]
                if( asked === undefined ) { return false }
                return a.results.length !== asked
            } )
            .map( ( a ) => `${a.area} (answered ${a.results.length} != asked ${askedByArea[ a.area ]})` )
        if( countMismatch.length > 0 ) {
            return { 'status': false, 'error': `Per-area question-count mismatch: ${countMismatch.join( ', ' )}.` }
        }

        // Accept an area per-area when the agent supplied it in the payload (the
        // skeleton-area is the consume acknowledgement; the rebuild reads the
        // grading files on disk). Areas in the emitted set but absent from the
        // payload stay pending. Task-ID complete ONLY at the full emitted set.
        const priorConsumed = Array.isArray( state[ 'consumedAreas' ] ) ? state[ 'consumedAreas' ] : []
        const acceptedAreas = priorConsumed
            .concat( payloadAreaNames.filter( ( name ) => priorConsumed.includes( name ) === false ) )
        const missingAreas = emittedSet.filter( ( name ) => acceptedAreas.includes( name ) === false )
        const complete = missingAreas.length === 0

        return { 'status': true, 'verified': true, acceptedAreas, missingAreas, complete, 'error': null }
    }


    // The emit recorded one payloadSkeleton area per emitted area; the asked
    // question-count per area is carried on state via the emitted prompts. The
    // skeleton itself has empty results[], so the asked count is read from the
    // emitted prompts when present (state.askedByArea), else not enforced for that
    // area (explicit: only enforce where a count was recorded — no silent zero).
    static #askedCountByArea( { state } ) {
        if( state === null || typeof state[ 'askedByArea' ] !== 'object' || state[ 'askedByArea' ] === null ) {
            return {}
        }
        return state[ 'askedByArea' ]
    }


    // Stage 3 — consume the harness scores -> verify (PRD-007) -> grade ->
    // rebuild*Index (5-status) -> write Provider-Proof (PRD-008) -> finalize baton.
    static async #gradingConsumeScores( { cwd, grading, gradingDataRoot, flow, targetDir, target, consumeScores, conflict, gradingDataDir, gradingExportDir, dryRun = false, dependencyChain } ) {
        const scoresPath = resolve( cwd, consumeScores )
        if( existsSync( scoresPath ) === false ) {
            return { 'result': FlowMcpCli.#error( { 'error': `Scores file not found: ${scoresPath}`, 'fix': 'Pass the path written by the harness Stage 2.' } ) }
        }

        const { data: scoresDoc } = await FlowMcpCli.#readJson( { 'filePath': scoresPath } )
        if( scoresDoc === null ) {
            return { 'result': FlowMcpCli.#error( { 'error': `Invalid JSON in scores file: ${scoresPath}`, 'fix': 'The harness must write valid JSON scores.' } ) }
        }
        if( Array.isArray( scoresDoc[ 'scores' ] ) === false ) {
            return { 'result': FlowMcpCli.#error( { 'error': 'Invalid scores format: "scores" must be an array.', 'fix': 'See the grading scores schema.' } ) }
        }

        const statePath = join( targetDir, 'state.json' )
        const { data: prevState } = await FlowMcpCli.#readJson( { 'filePath': statePath } )

        // PRD-007 — verify the multi-area Task-ID payload (additive; legacy scores
        // without a taskId skip this and proceed). A mismatch is a hard Reject.
        const verify = FlowMcpCli.#verifyConsumePayload( { grading, scoresDoc, 'state': prevState } )
        if( verify.status === false ) {
            return { 'result': FlowMcpCli.#error( { 'error': `Consume rejected: ${verify.error}`, 'fix': 'Return the exact emitted Task-ID and area-set with matching per-area question counts.' } ) }
        }

        // PRD-012 — --no-save (dryRun): the scores file was read and the Task-ID
        // payload verified (pure reads, no island mutation), but Stage-3 writes ALL
        // get skipped: NO RebuildIndex (its contract writes index.json — an
        // "in-memory rebuild for output only" is impossible), NO Provider-Proof
        // grade.json, NO state.json. The island stays byte-identical. NO SILENT
        // DEFAULT: the rollup fields are honestly null/'not-saved', never a guessed
        // status. --on-conflict is ORTHOGONAL and never consulted (no write to
        // collide), and --export-dir / FLOWMCP_GRADING_EXPORT lose to --no-save.
        if( dryRun === true ) {
            return {
                'result': {
                    'status': true,
                    'stage': 3,
                    'mode': 'consume-scores',
                    'saved': false,
                    flow,
                    target,
                    'rollupStatus': 'not-saved',
                    'rollupGrade': null,
                    'indexPath': null,
                    'proofPath': null,
                    'acceptedAreas': verify.verified === true ? verify.acceptedAreas : null,
                    'missingAreas': verify.verified === true ? verify.missingAreas : null,
                    'taskComplete': verify.verified === true ? verify.complete : null,
                    'scoreCount': scoresDoc[ 'scores' ].length,
                    dependencyChain
                }
            }
        }

        // Rebuild the 5-status index from the resolved grade snapshots on disk.
        let rebuilt = null
        if( flow === 'provider' ) {
            rebuilt = await grading[ 'RebuildIndex' ].rebuildNamespaceIndex( { 'namespaceDir': targetDir } )
        } else {
            rebuilt = await grading[ 'RebuildIndex' ].rebuildSelectionIndex( { 'selectionDir': targetDir, 'providersRoot': join( gradingDataRoot, 'providers' ) } )
        }

        if( rebuilt.status !== true ) {
            return {
                'result': {
                    'status': false,
                    'error': `Index rebuild failed: ${( rebuilt.errors || [] ).join( '; ' )}`,
                    'fix': 'Resolve the index errors above and re-run consume-scores.',
                    'errors': rebuilt.errors || [],
                    dependencyChain
                }
            }
        }

        // PRD-008 — write the committable Provider-Proof grade.json for a graded
        // namespace (and a blocked-only namespace via the same rebuilt index). The
        // proof is the single producer of providers/<ns>/grade.json under the
        // repo-side export root. NO silent default — an unresolved export root is a
        // hard error, never a write to the island.
        let proofPathRel = null
        if( flow === 'provider' ) {
            const proof = await FlowMcpCli.#writeProviderProof( {
                cwd, grading, gradingDataRoot, gradingExportDir, target, 'namespaceIndex': rebuilt.index
            } )
            if( proof.status === false ) {
                return { 'result': FlowMcpCli.#error( { 'error': proof.error, 'fix': proof.fix } ) }
            }
            proofPathRel = FlowMcpCli.#toRepoRelativePath( { cwd, 'path': proof.proofPath } )
        }

        // Finalize the state baton (overwrite is the deliberate, named end-state).
        const now = new Date().toISOString()
        const stateDoc = prevState === null
            ? { target, flow, 'createdAt': now, 'phases': {} }
            : prevState
        stateDoc[ 'status' ] = 'graded'
        stateDoc[ 'lastUpdatedAt' ] = now
        stateDoc[ 'rollupStatus' ] = rebuilt.index[ 'status' ]
        stateDoc[ 'rollupGrade' ] = rebuilt.index[ 'grade' ]
        if( stateDoc[ 'phases' ] === undefined ) { stateDoc[ 'phases' ] = {} }
        stateDoc[ 'phases' ][ 'scoresReceived' ] = now
        stateDoc[ 'phases' ][ 'gradeComputed' ] = now
        stateDoc[ 'phases' ][ 'indexRebuilt' ] = now
        stateDoc[ 'dependencyChain' ] = dependencyChain
        // PRD-007 — reflect the per-area accept / Task-ID completion on state.
        if( verify.verified === true ) {
            stateDoc[ 'consumedAreas' ] = verify.acceptedAreas
            stateDoc[ 'missingAreas' ] = verify.missingAreas
            stateDoc[ 'taskComplete' ] = verify.complete
        }

        await FlowMcpCli.#writeGuarded( { 'path': statePath, 'content': JSON.stringify( stateDoc, null, 4 ), 'onExists': 'overwrite' } )

        return {
            'result': {
                'status': true,
                'stage': 3,
                'mode': 'consume-scores',
                'saved': true,
                flow,
                target,
                'rollupStatus': rebuilt.index[ 'status' ],
                'rollupGrade': rebuilt.index[ 'grade' ],
                'indexPath': rebuilt.indexPath,
                'proofPath': proofPathRel,
                'acceptedAreas': verify.verified === true ? verify.acceptedAreas : null,
                'missingAreas': verify.verified === true ? verify.missingAreas : null,
                'taskComplete': verify.verified === true ? verify.complete : null,
                'scoreCount': scoresDoc[ 'scores' ].length,
                dependencyChain
            }
        }
    }


    // PRD-008 — write the committable Provider-Proof for one namespace. The
    // producer (ProviderProof.write) is the SINGLE writer of
    // <exportRoot>/providers/<ns>/grade.json (repo-side, NOT the island). The
    // export root is resolved with the existing precedence; an unresolved root is
    // a hard error (no silent skip, no island write). Idempotency (monitoring
    // backref preservation) is guaranteed inside ProviderProof.write.
    static async #writeProviderProof( { cwd, grading, gradingDataRoot, gradingExportDir, target, namespaceIndex } ) {
        const ProviderProof = grading[ 'ProviderProof' ]
        if( ProviderProof === undefined || ProviderProof === null ) {
            return { 'status': false, 'error': 'ProviderProof unavailable from flowmcp-grading.', 'fix': 'Update the flowmcp-grading dependency.' }
        }

        const exportRoot = await FlowMcpCli.#gradingExportRoot( { cwd, gradingExportDir, gradingDataRoot } )
        if( typeof exportRoot !== 'string' || exportRoot.length === 0 ) {
            return { 'status': false, 'error': 'Export root not resolvable for the Provider-Proof.', 'fix': 'Configure --export-dir, FLOWMCP_GRADING_EXPORT, or gradingExportDir in the global config.' }
        }

        const providerDir = join( exportRoot, 'providers', target )
        const written = await ProviderProof.write( { namespaceIndex, providerDir } )
        if( written.status !== true ) {
            return { 'status': false, 'error': `Provider-Proof write failed: ${( written.errors || [] ).join( '; ' )}`, 'fix': 'Resolve the proof write error above and re-run consume-scores.' }
        }

        return { 'status': true, 'proofPath': written.proofPath }
    }


    // List the schema sub-folders of a provider/selection island (skip _gradings,
    // _exports, resources, skills, selection and JSON files at the root).
    static async #listGradingSchemaDirs( { targetDir } ) {
        const reserved = [ '_gradings', '_exports', 'resources', 'skills', 'selection', 'tools' ]
        let entries = []
        try {
            entries = await readdir( targetDir, { 'withFileTypes': true } )
        } catch {
            return []
        }

        const dirs = entries
            .filter( ( entry ) => entry.isDirectory() === true )
            .map( ( entry ) => entry.name )
            .filter( ( name ) => name.startsWith( '_' ) === false )
            .filter( ( name ) => reserved.includes( name ) === false )
            .sort()

        return dirs
    }


    // Memo 102 Phase 2 / PRD-003 (B2) — resolve the schemas to be graded for a
    // provider namespace LIVE from schemaFolders[], NOT from the island import
    // snapshot. Returns { schemaName, main, handlersFn, sourcePath }[]: the island
    // folder name (schemaName = source file basename, matching GradingImport's
    // schemaSlug) plus the live source path so DataPretest resolves _lists/_shared
    // and requiredLibraries from the real provider folder.
    //
    // NO SILENT DEFAULT: a namespace that is present in NO schemaFolders[] source
    // is a coded hard error (SRC-001) — never an empty list that reads as
    // "0 schemas = ok".
    static async #resolveSchemasForTarget( { namespace } ) {
        const { sources } = await FlowMcpCli.#listSources()
        const matched = []
        const loadErrors = []

        await sources
            .reduce( ( promise, source ) => promise.then( async () => {
                await source[ 'schemas' ]
                    .reduce( ( innerPromise, schemaInfo ) => innerPromise.then( async () => {
                        const { file } = schemaInfo
                        const { filePath } = await FlowMcpCli.#resolveSchemaPath( { 'schemaRef': `${source[ 'name' ]}/${file}` } )
                        const { main, handlersFn, error } = await FlowMcpCli.#loadSchema( { filePath } )

                        if( main === null || main === undefined ) {
                            // A load failure is only relevant if the file might belong to
                            // the target namespace; we cannot know without main.namespace,
                            // so record it for diagnostics without aborting the scan.
                            loadErrors.push( `${source[ 'name' ]}/${file}: ${error}` )
                            return
                        }
                        if( main[ 'namespace' ] !== namespace ) { return }

                        const schemaName = basename( file, '.mjs' )
                        matched.push( { schemaName, main, handlersFn, 'sourcePath': filePath } )
                    } ), Promise.resolve() )
            } ), Promise.resolve() )

        if( matched.length === 0 ) {
            const detail = loadErrors.length > 0 ? ` (load failures during scan: ${loadErrors.join( '; ' )})` : ''
            return {
                'status': false,
                'schemas': [],
                'error': `SRC-001: namespace "${namespace}" not found in any schemaFolders[] source.${detail}`,
                'fix': `Register the provider folder via "${appConfig[ 'cliCommand' ]} init" / schemaFolders[], or address an existing namespace.`
            }
        }

        const sorted = matched
            .sort( ( a, b ) => a.schemaName.localeCompare( b.schemaName ) )

        return { 'status': true, 'schemas': sorted, 'error': null }
    }


    // PRD-003 (B2) — resolve the schemas to pretest for a SELECTION run LIVE from
    // schemaFolders[]. The selection's island index.json lists its members as
    // <namespace>.<schemaName> IDs; each is resolved against the live provider
    // read (never the import snapshot). A member whose namespace is absent from
    // schemaFolders[] surfaces the SRC-001 coded error from #resolveSchemasForTarget;
    // a member whose schema file is missing within an existing namespace is a coded
    // SRC-002 error — never a silent skip.
    static async #resolveSelectionSchemasLive( { targetDir } ) {
        const indexPath = join( targetDir, 'index.json' )
        const { data: index } = await FlowMcpCli.#readJson( { 'filePath': indexPath } )
        if( index === null || index[ 'members' ] === undefined || index[ 'members' ] === null ) {
            return { 'status': true, 'schemas': [], 'error': null }
        }

        const schemaIds = Object.keys( index[ 'members' ] )
        const byNamespace = {}
        const resolvedMembers = []

        const errors = []
        await schemaIds
            .reduce( ( promise, schemaId ) => promise.then( async () => {
                const parts = schemaId.split( '.' )
                if( parts.length !== 2 ) {
                    errors.push( `SRC-002: malformed selection member id "${schemaId}" (expected <namespace>.<schema>).` )
                    return
                }
                const memberNamespace = parts[ 0 ]
                const memberSchema = parts[ 1 ]

                if( byNamespace[ memberNamespace ] === undefined ) {
                    const resolved = await FlowMcpCli.#resolveSchemasForTarget( { 'namespace': memberNamespace } )
                    byNamespace[ memberNamespace ] = resolved
                }
                const nsResult = byNamespace[ memberNamespace ]
                if( nsResult.status === false ) {
                    errors.push( nsResult.error )
                    return
                }

                const hit = nsResult.schemas
                    .find( ( s ) => s.schemaName === memberSchema )
                if( hit === undefined ) {
                    errors.push( `SRC-002: selection member "${schemaId}" not found in schemaFolders[] (namespace "${memberNamespace}" has: ${nsResult.schemas.map( ( s ) => s.schemaName ).join( ', ' ) || 'none'}).` )
                    return
                }
                resolvedMembers.push( hit )
            } ), Promise.resolve() )

        if( errors.length > 0 ) {
            return { 'status': false, 'schemas': [], 'error': errors.join( '; ' ), 'fix': 'Register the missing member provider(s) in schemaFolders[], or fix the selection member ids.' }
        }

        const sorted = resolvedMembers
            .sort( ( a, b ) => a.schemaName.localeCompare( b.schemaName ) )

        return { 'status': true, 'schemas': sorted, 'error': null }
    }


    static async gradingState( { cwd, target, gradingDataDir, json } ) {
        const grading = await FlowMcpCli.#loadGradingModule()
        if( grading === null ) {
            return { 'result': FlowMcpCli.#error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }

        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': FlowMcpCli.#error( { 'error': 'Missing state target.', 'fix': 'Usage: flowmcp grading state <namespace|selection>' } ) }
        }

        const gradingDataRoot = await FlowMcpCli.#gradingDataRoot( { cwd, gradingDataDir } )
        const detected = await FlowMcpCli.#resolveGradingTarget( { cwd, gradingDataRoot, target } )
        if( detected.status !== true ) {
            return { 'result': FlowMcpCli.#error( { 'error': detected.error, 'fix': detected.fix } ) }
        }

        const indexPath = join( detected.targetDir, 'index.json' )
        const statePath = join( detected.targetDir, 'state.json' )
        const { data: index } = await FlowMcpCli.#readJson( { 'filePath': indexPath } )
        const { data: state } = await FlowMcpCli.#readJson( { 'filePath': statePath } )

        // PRD-010 — the graph-driven nextAction block, identical on state + doctor.
        const nextAction = await FlowMcpCli.#computeNextAction( { grading, detected, target } )

        return {
            'result': {
                'status': true,
                'flow': detected.flow,
                'tier': detected.tier,
                target,
                'rollupStatus': index === null ? null : index[ 'status' ],
                'rollupGrade': index === null ? null : index[ 'grade' ],
                'summary': index === null ? null : index[ 'summary' ],
                'batonStatus': state === null ? null : state[ 'status' ],
                'lastUpdatedAt': state === null ? null : state[ 'lastUpdatedAt' ],
                indexPath,
                statePath,
                'indexPresent': index !== null,
                'statePresent': state !== null,
                nextAction
            }
        }
    }


    // Memo 097 Kap. 3 (PA-3) — flat, deduplicated error/improvement worklist for
    // one namespace. A sub-agent abarbeitet this list directly. Sources merged:
    //   - prompts.json -> pretests[].errors  (DPT-003 abort, DPT-004 test-fail /
    //     not-downloadable, DPT-005 missing requiredServerParam — KEY NAME only,
    //     never the value; the emit stage already strips values)
    //   - index.json   -> blockers[]         (import / rebuild errors: {node,reason})
    // Output: a flat array [{ namespace, area|schema, code, message, hint? }].
    // NO SILENT DEFAULT: if the namespace has no prompts.json (never emitted), the
    // command returns a clear coded error instead of pretending an empty worklist.
    static async gradingWorklist( { cwd, target, gradingDataDir, json } ) {
        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': FlowMcpCli.#error( { 'error': 'Missing worklist target.', 'fix': 'Usage: flowmcp grading worklist <namespace> --json' } ) }
        }

        const gradingDataRoot = await FlowMcpCli.#gradingDataRoot( { cwd, gradingDataDir } )
        const detected = await FlowMcpCli.#resolveGradingTarget( { cwd, gradingDataRoot, target } )
        if( detected.status !== true ) {
            return { 'result': FlowMcpCli.#error( { 'error': detected.error, 'fix': detected.fix } ) }
        }

        // PRD-009 — `worklist` is subsumed into `doctor`: the deterministic
        // collection logic lives in ONE shared private collector. `worklist` is
        // retained as a thin wrapper (Never-delete-legacy) returning the same flat
        // array shape as before, OR the WL-001/WL-002 coded error unchanged.
        const collected = await FlowMcpCli.#collectDeterministicDefects( { detected, target } )
        if( collected.status !== true ) {
            return { 'result': FlowMcpCli.#error( { 'error': collected.error, 'fix': collected.fix } ) }
        }

        return { 'result': collected.defects }
    }


    // PRD-009 — the single source of truth for the deterministic defect list of one
    // namespace, reused by BOTH `worklist` (thin wrapper) and `doctor`. Sources:
    //   - prompts.json -> pretests[].errors  (DPT-003/004/005, KEY NAME only)
    //   - index.json   -> blockers[]         (import / rebuild {node,reason})
    // Output: { status, defects: [ { namespace, schema, code, message } ] } with the
    // SAME WL-001 (no prompts.json) / WL-002 (unreadable prompts.json) guards — NO
    // SILENT DEFAULT (never an empty-list fabrication for a missing pretest). The
    // (schema, code, message) tuple is deduplicated (a blocker can appear twice).
    static async #collectDeterministicDefects( { detected, target } ) {
        const promptsPath = join( detected.targetDir, 'prompts.json' )
        const indexPath = join( detected.targetDir, 'index.json' )

        if( existsSync( promptsPath ) === false ) {
            return {
                'status': false,
                'error': `WL-001: No prompts.json for namespace "${target}" — the deterministic pretest has not run yet.`,
                'fix': `Run "${appConfig[ 'cliCommand' ]} grading non-deterministic ${target} --emit-prompts" first, then re-run worklist.`
            }
        }

        const { data: prompts } = await FlowMcpCli.#readJson( { 'filePath': promptsPath } )
        if( prompts === null ) {
            return {
                'status': false,
                'error': `WL-002: prompts.json for namespace "${target}" is unreadable or not valid JSON.`,
                'fix': `Re-emit the prompts (${appConfig[ 'cliCommand' ]} grading non-deterministic ${target} --emit-prompts) to regenerate a valid handoff.`
            }
        }

        const items = []

        // 1. Pretest errors (per-schema). The errors are flat "CODE: message"
        // strings written by DataPretest; split off the leading code.
        const pretests = Array.isArray( prompts[ 'pretests' ] ) ? prompts[ 'pretests' ] : []
        pretests.forEach( ( pretest ) => {
            const schemaName = typeof pretest[ 'schemaName' ] === 'string' ? pretest[ 'schemaName' ] : null
            const errors = Array.isArray( pretest[ 'errors' ] ) ? pretest[ 'errors' ] : []
            errors.forEach( ( raw ) => {
                if( typeof raw !== 'string' || raw.length === 0 ) { return }
                const { code, message } = FlowMcpCli.#splitErrorCode( { raw } )
                items.push( { 'namespace': target, 'schema': schemaName, code, message } )
            } )
        } )

        // 2. Import / rebuild blockers (per-node), if present.
        const { data: index } = await FlowMcpCli.#readJson( { 'filePath': indexPath } )
        const blockers = index !== null && Array.isArray( index[ 'blockers' ] ) ? index[ 'blockers' ] : []
        blockers.forEach( ( blocker ) => {
            const node = typeof blocker[ 'node' ] === 'string' ? blocker[ 'node' ] : null
            const reason = typeof blocker[ 'reason' ] === 'string' ? blocker[ 'reason' ] : null
            if( reason === null ) { return }
            const { code, message } = FlowMcpCli.#splitErrorCode( { 'raw': reason } )
            items.push( { 'namespace': target, 'schema': node, 'code': code === null ? 'IMPORT' : code, message } )
        } )

        // Deduplicate on the (schema, code, message) tuple.
        const seen = {}
        const defects = items.filter( ( item ) => {
            const key = `${item.schema}|${item.code}|${item.message}`
            if( seen[ key ] === true ) { return false }
            seen[ key ] = true

            return true
        } )

        return { 'status': true, defects }
    }


    // PRD-009 — `grading doctor <ns>` — ONE merged, local, read-only, terminal-only
    // result: the deterministic defects (today's worklist, subsumed via the shared
    // collector), the last LLM improvement tips (latest improvementHints[] per
    // schema/area, with iteration), the next re-entry loop (PRD-009 self-contained),
    // and the graph-driven nextAction split (PRD-010). It is NEVER online and NEVER
    // writes grade.json / the island / Kanban: `online: false`, no fetch, no write.
    static async gradingDoctor( { cwd, target, gradingDataDir, json } ) {
        const grading = await FlowMcpCli.#loadGradingModule()
        if( grading === null ) {
            return { 'result': FlowMcpCli.#error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }

        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': FlowMcpCli.#error( { 'error': 'Missing doctor target.', 'fix': 'Usage: flowmcp grading doctor <namespace>' } ) }
        }

        const gradingDataRoot = await FlowMcpCli.#gradingDataRoot( { cwd, gradingDataDir } )
        const detected = await FlowMcpCli.#resolveGradingTarget( { cwd, gradingDataRoot, target } )
        if( detected.status !== true ) {
            return { 'result': FlowMcpCli.#error( { 'error': detected.error, 'fix': detected.fix } ) }
        }

        // Deterministic defects (keeps WL-001/WL-002 — no empty-list fabrication).
        // Memo 107 PRD-013 — a deterministic-only island (migrated / det-graded, no LLM
        // emit round) has no prompts.json: WL-001 is then NOT a hard error but a soft
        // state — defects degrade to [] with an explicit note so the conformance guard
        // and state still surface. Any OTHER collection failure stays a hard error.
        const collected = await FlowMcpCli.#collectDeterministicDefects( { detected, target } )
        let defects = []
        let defectsNote = null
        if( collected.status !== true ) {
            const noPrompts = typeof collected.error === 'string' && collected.error.includes( 'WL-001' ) === true
            if( noPrompts === false ) {
                return { 'result': FlowMcpCli.#error( { 'error': collected.error, 'fix': collected.fix } ) }
            }
            defectsNote = 'No prompts.json — deterministic-only island (no LLM emit round yet). Deterministic defects not collected; conformance + state are still reported.'
        } else {
            defects = collected.defects
        }

        // Last LLM tips (read-only). An absence of grading entries is explicit: an
        // empty tips array WITH a note, never a silently dropped section.
        const tipsResult = await FlowMcpCli.#collectLastTips( { grading, detected } )
        const tips = tipsResult.tips
        const tipsNote = tipsResult.note

        // Self-contained per-namespace next loop (PRD-009).
        const nextLoop = FlowMcpCli.#buildNextLoop( { defects, tips, target } )

        // Graph-driven next-action enumeration (PRD-010), identical on state + doctor.
        const nextAction = await FlowMcpCli.#computeNextAction( { grading, detected, target } )

        // Memo 107 PRD-013 — conformance guard: a schema with summary.json (swept) but
        // no _gradings/ (not graded) is "sweep-only" / unfinished. The deterministic
        // path now writes the full structure by default, so this state is flagged, not
        // produced. No silent default — the swept/graded booleans are explicit per schema.
        const conformance = await FlowMcpCli.#collectConformance( { targetDir: detected.targetDir } )

        return {
            'result': {
                'status': true,
                'namespace': target,
                'online': false,
                defects,
                'defectsNote': defectsNote,
                conformance,
                tips,
                'tipsNote': tipsNote,
                nextLoop,
                nextAction
            }
        }
    }


    // Memo 107 PRD-013 — per-schema conformance: swept (has summary.json) vs graded
    // (has at least one _gradings/ entry, at schema or tool level). A swept-but-not-graded
    // schema is "sweep-only" / unfinished. Read-only; never writes.
    static async #collectConformance( { targetDir } ) {
        const schemaDirs = await FlowMcpCli.#listGradingSchemaDirs( { targetDir } )
        const schemas = []
        await schemaDirs
            .reduce( ( promise, schemaName ) => promise.then( async () => {
                const schemaDir = join( targetDir, schemaName )
                const swept = existsSync( join( schemaDir, 'summary.json' ) )
                const schemaGradings = await FlowMcpCli.#findGradingsDirs( { root: schemaDir } )
                const graded = schemaGradings.length > 0
                schemas.push( { 'schema': schemaName, swept, graded, 'sweepOnly': swept === true && graded === false } )
            } ), Promise.resolve() )

        const sweepOnly = schemas
            .filter( ( entry ) => entry.sweepOnly === true )
            .map( ( entry ) => entry.schema )

        return {
            'conformant': sweepOnly.length === 0,
            'sweepOnlyCount': sweepOnly.length,
            'sweepOnlySchemas': sweepOnly,
            schemas
        }
    }


    // PRD-009 — collect the most recent improvementHints[] per (schema, area) for a
    // namespace, read-only, from the latest grading entry in every _gradings/ dir
    // under the island. Uses RebuildIndex.resolveLatest (newest by filename) +
    // Grading.readEntry (fills loop defaults on READ, never writes). An island with
    // no grading entries yields tips:[] + an explicit note (NO SILENT DEFAULT — the
    // absence is surfaced, not swallowed). Never writes; never goes online.
    static async #collectLastTips( { grading, detected } ) {
        const Grading = grading[ 'Grading' ]
        const RebuildIndex = grading[ 'RebuildIndex' ]
        if( Grading === undefined || RebuildIndex === undefined ) {
            return { 'tips': [], 'note': 'Grading entry reader unavailable from flowmcp-grading; no tips could be read.' }
        }

        const gradingsDirs = await FlowMcpCli.#findGradingsDirs( { root: detected.targetDir } )
        if( gradingsDirs.length === 0 ) {
            return { 'tips': [], 'note': 'No grading entries on disk yet — no LLM grading round has run for this namespace.' }
        }

        const tips = []
        await gradingsDirs
            .reduce( async ( prevPromise, gradingsDir ) => {
                await prevPromise
                const resolved = await RebuildIndex.resolveLatest( { 'dir': gradingsDir, 'logicalName': FlowMcpCli.#gradingsLogicalName( { gradingsDir } ) } )
                if( resolved.status !== true ) { return }

                let raw = null
                try { raw = await readFile( resolved.path, 'utf-8' ) }
                catch { return }

                const read = Grading.readEntry( { 'json': raw } )
                if( read.entry === null ) { return }

                const hints = Array.isArray( read.entry.improvementHints ) ? read.entry.improvementHints : []
                if( hints.length === 0 ) { return }

                const area = typeof read.entry.area === 'string' ? read.entry.area : FlowMcpCli.#gradingsLogicalName( { gradingsDir } )
                const schema = FlowMcpCli.#schemaOfGradingsDir( { root: detected.targetDir, gradingsDir } )
                const iteration = typeof read.entry.iteration === 'number' ? read.entry.iteration : 0
                tips.push( { schema, area, iteration, hints } )
            }, Promise.resolve() )

        return { tips, 'note': null }
    }


    // The filename grammar prefixes every grading entry with its logicalName
    // (`<logicalName>--<timestamp>.json`). The logicalName for a _gradings/ dir is
    // the area-ish name the rebuild used; resolveLatest needs the SAME prefix. We
    // derive it from the dir's existing files (the segment before the first `--`),
    // so the resolver is data-driven, not a hardcoded per-area map.
    static #gradingsLogicalName( { gradingsDir } ) {
        let entries = []
        try { entries = readdirSync( gradingsDir ) }
        catch { return '' }
        const first = entries
            .filter( ( name ) => name.endsWith( '.json' ) === true )
            .sort()
            .at( -1 )
        if( first === undefined ) { return '' }
        const idx = first.indexOf( '--' )
        return idx === -1 ? first.replace( /\.json$/, '' ) : first.slice( 0, idx )
    }


    // The owning schema of a _gradings/ dir is the first path segment under the
    // namespace island root (providers/<ns>/<schema>/.../_gradings). Namespace-level
    // gradings (providers/<ns>/_gradings) have no schema -> null (explicit).
    static #schemaOfGradingsDir( { root, gradingsDir } ) {
        const rel = relative( root, gradingsDir )
        const segments = rel.split( /[\\/]/ ).filter( ( s ) => s.length > 0 )
        if( segments.length === 0 ) { return null }
        if( segments[ 0 ] === '_gradings' ) { return null }
        return segments[ 0 ]
    }


    // Recursively find every `_gradings` directory under an island root. Read-only
    // directory walk (no for/while; reduce over readdir). Reserved/non-schema dirs
    // are still descended (About/skills gradings live deep), so we walk all dirs.
    static async #findGradingsDirs( { root } ) {
        let entries = []
        try { entries = await readdir( root, { 'withFileTypes': true } ) }
        catch { return [] }

        const found = await entries
            .filter( ( entry ) => entry.isDirectory() === true )
            .reduce( async ( prevPromise, entry ) => {
                const acc = await prevPromise
                const childPath = join( root, entry.name )
                if( entry.name === '_gradings' ) {
                    return acc.concat( [ childPath ] )
                }
                const nested = await FlowMcpCli.#findGradingsDirs( { 'root': childPath } )
                return acc.concat( nested )
            }, Promise.resolve( [] ) )

        return found
    }


    // PRD-009 — the self-contained per-namespace next re-entry loop: which areas
    // still carry open defects/tips, and the single CLI action that resumes the
    // Kap. 7.3 loop. Plain language, no invented jargon. When nothing is open the
    // rationale says so explicitly (no silent empty).
    static #buildNextLoop( { defects, tips, target } ) {
        const defectAreas = defects
            .map( ( d ) => ( typeof d.schema === 'string' ? d.schema : null ) )
            .filter( ( s ) => s !== null )
        const tipAreas = tips.map( ( t ) => t.area )

        const openAreas = defectAreas
            .concat( tipAreas )
            .filter( ( name, idx, arr ) => arr.indexOf( name ) === idx )

        if( openAreas.length === 0 ) {
            return {
                'openAreas': [],
                'nextAction': `${appConfig[ 'cliCommand' ]} grading state ${target}`,
                'rationale': 'No deterministic defects and no open improvement tips for this namespace; check the rollup state for remaining grading work.'
            }
        }

        return {
            'openAreas': openAreas,
            'nextAction': `${appConfig[ 'cliCommand' ]} grading non-deterministic ${target} --emit-prompts --phase ${openAreas.join( ',' )}`,
            'rationale': 'These areas still carry deterministic defects or open improvement tips; re-emit prompts for them to continue the grading loop.'
        }
    }


    // PRD-010 — graph-driven next-action enumeration. Read-only: derives per-schema
    // / namespace levels, evaluates the seeded dependency graph (ready vs gated),
    // removes inapplicable optional areas, then splits ready areas into:
    //   - deterministicNow — areas FlowMCP can finish for free (free CLI command)
    //   - nonDeterministic — areas needing an LLM round, collapsed into ONE area-set
    //     with ONE TaskId.generate preview (no emission, no write, no side effect)
    // and reports gated areas with a plain-language reason. NO emission, NO write,
    // NO network. All graph/level/gate logic is CONSUMED from flowmcp-grading.
    static async #computeNextAction( { grading, detected, target } ) {
        const AreaDependencyGraph = grading[ 'AreaDependencyGraph' ]
        const RequiredLevel = grading[ 'RequiredLevel' ]
        const TaskId = grading[ 'TaskId' ]
        if( AreaDependencyGraph === undefined || RequiredLevel === undefined || TaskId === undefined ) {
            return { 'status': false, 'error': 'NA-001: graph/level/Task-ID modules unavailable from flowmcp-grading.', 'fix': 'Update the flowmcp-grading dependency.' }
        }

        const loaded = AreaDependencyGraph.loadDefaultGraph()
        if( loaded.errors.length > 0 ) {
            return { 'status': false, 'error': `NA-002: Area dependency graph not loadable: ${loaded.errors.join( '; ' )}`, 'fix': 'Reinstall / update flowmcp-grading (the seeded graph data is missing).' }
        }

        // Derive the namespace level from the per-schema pretest results carried in
        // prompts.json. No prompts.json -> nothing emitted yet: report this state
        // explicitly (NO SILENT DEFAULT) instead of fabricating a graph evaluation.
        const promptsPath = join( detected.targetDir, 'prompts.json' )
        if( existsSync( promptsPath ) === false ) {
            return {
                'status': true,
                'deterministicNow': { 'areas': [], 'command': null, 'free': true },
                'nonDeterministic': null,
                'gated': [],
                'note': 'No prompts.json yet — emit prompts first to derive the next applicable areas.'
            }
        }
        const { data: prompts } = await FlowMcpCli.#readJson( { 'filePath': promptsPath } )
        const pretests = prompts !== null && Array.isArray( prompts[ 'pretests' ] ) ? prompts[ 'pretests' ] : []

        const schemaDirs = await FlowMcpCli.#listGradingSchemaDirs( { 'targetDir': detected.targetDir } )
        const aboutProbe = await FlowMcpCli.#detectAboutResourcePresent( { 'targetDir': detected.targetDir, schemaDirs } )

        const schemaLevels = pretests
            .map( ( pretest ) => {
                const detGreen = pretest.ok === true
                const derived = RequiredLevel.deriveSchemaLevel( {
                    'snapshotPresent': true,
                    'structuralValid': true,
                    'dataPretest': { 'ok': pretest.ok === true },
                    detGreen,
                    'gradingStatus': 'pending'
                } )
                return derived.level
            } )
            .filter( ( level ) => level !== null )

        const namespaceLevel = schemaLevels.length === schemaDirs.length && schemaLevels.length > 0
            ? RequiredLevel.deriveNamespaceLevel( { schemaLevels } ).level
            : 'imported'

        const evaluated = AreaDependencyGraph.evaluate( {
            'graph': loaded.graph,
            'derivedLevels': { namespaceLevel, 'aboutPresent': aboutProbe.present, 'memberLevel': 'imported' }
        } )
        if( evaluated.errors.length > 0 ) {
            return { 'status': false, 'error': `NA-003: Area gate evaluation failed: ${evaluated.errors.join( '; ' )}`, 'fix': 'Inspect the dependency graph data and derived levels.' }
        }

        // Restrict to the areas in scope for this flow (data-driven, not a hardcoded
        // list): selection-only areas (dependsOn.kind === all-member-schemas) are
        // not enumerated for a provider namespace, and vice versa.
        const inFlowScope = ( name ) => {
            const dep = AreaDependencyGraph.dependsOnFor( { 'graph': loaded.graph, 'area': name } )
            if( dep.errors.length > 0 || dep.dependsOn === null ) { return false }
            const isSelectionArea = dep.dependsOn.kind === 'all-member-schemas'
            return detected.flow === 'selection' ? isSelectionArea === true : isSelectionArea === false
        }

        // Applicability (PRD-005): an optional area whose precondition is absent is
        // not a next-action. about-namespace requires the About resource present.
        const isApplicable = ( name ) => name === 'about-namespace' ? aboutProbe.present === true : true

        const readyAreas = evaluated.ready
            .filter( ( name ) => inFlowScope( name ) === true )
            .filter( ( name ) => isApplicable( name ) === true )

        // Split ready areas by their data-driven classification.
        const classified = readyAreas
            .reduce( ( acc, name ) => {
                const c = AreaDependencyGraph.classifyArea( { 'graph': loaded.graph, 'area': name } )
                if( c.errors.length > 0 ) { acc.errors.push( c.errors.join( '; ' ) ); return acc }
                if( c.classification === 'deterministic' ) { acc.det.push( name ) } else { acc.nonDet.push( name ) }
                return acc
            }, { 'det': [], 'nonDet': [], 'errors': [] } )
        if( classified.errors.length > 0 ) {
            return { 'status': false, 'error': `NA-004: Area classification failed: ${classified.errors.join( '; ' )}`, 'fix': 'Ensure every graph area carries a valid classification.' }
        }

        const deterministicNow = classified.det.length === 0
            ? { 'areas': [], 'command': null, 'free': true }
            : {
                'areas': classified.det,
                'command': `${appConfig[ 'cliCommand' ]} grading non-deterministic ${target} --emit-prompts --phase ${classified.det.join( ',' )}`,
                'free': true
            }

        // ONE non-deterministic area-set, ONE Task-ID preview (Kap. 8). Empty -> null
        // (explicit; no silent omission).
        let nonDeterministic = null
        if( classified.nonDet.length > 0 ) {
            const generated = TaskId.generate( { 'schemaIdSlug': target, 'areas': classified.nonDet } )
            if( generated.errors.length > 0 ) {
                return { 'status': false, 'error': `NA-005: Task-ID preview generation failed: ${generated.errors.join( '; ' )}`, 'fix': 'Ensure every non-deterministic area is a known area.' }
            }
            nonDeterministic = {
                'areaSet': classified.nonDet,
                'taskIdPreview': generated.taskId,
                'command': `${appConfig[ 'cliCommand' ]} grading non-deterministic ${target} --emit-prompts --phase ${classified.nonDet.join( ',' )}`,
                'skill': 'grade-score-single',
                'free': false
            }
        }

        // Gated provider areas with their plain-language reason (the cost guard:
        // non-deterministic namespace areas stay here until deterministic-green).
        const gated = evaluated.gated
            .filter( ( g ) => inFlowScope( g.area ) === true )
            .map( ( g ) => ( { 'area': g.area, 'reason': typeof g.reason === 'string' && g.reason.length > 0 ? g.reason : 'dependency not satisfied' } ) )

        return { 'status': true, deterministicNow, nonDeterministic, gated }
    }


    // Split a "CODE: message" string into { code, message }. When the string has
    // no recognizable leading code, code is null and the whole string is the
    // message (explicit — no invented code).
    static #splitErrorCode( { raw } ) {
        const match = raw.match( /^([A-Z]{2,}-\d{2,})(?::\s*)?(.*)$/ )
        if( match === null ) {
            return { 'code': null, 'message': raw.trim() }
        }

        return { 'code': match[ 1 ], 'message': match[ 2 ].trim() }
    }


    static async __testWriteGuarded( { path, content, onExists } ) {
        return FlowMcpCli.#writeGuarded( { path, content, onExists } )
    }


    static #toSchemaIdSlug( { schemaId } ) {
        return schemaId.replace( /\//g, '_' )
    }


    static async #writeAtomic( { path, content, onConflict } ) {
        const absolutePath = resolve( path )
        if( existsSync( absolutePath ) ) {
            if( onConflict === 'abort' ) {
                throw new Error( `NO-OVERWRITE conflict: ${absolutePath} already exists` )
            }
            return { 'skipped': true, absolutePath }
        }
        const tmp = `${absolutePath}.tmp`
        await writeFile( tmp, content, 'utf-8' )
        await rename( tmp, absolutePath )
        return { 'skipped': false, absolutePath }
    }


    // Memo 068 R2 — the single guarded writer for persistent artifacts.
    // There is NO silent overwrite path: every overwrite must be a deliberate,
    // named choice by the caller via onExists. The safe default (onExists
    // omitted or undefined) refuses to overwrite and reports an error object.
    //   onExists: 'error'     -> existing file => { written:false, error }
    //   onExists: 'skip'      -> existing file => { written:false, skipped:true }
    //   onExists: 'overwrite' -> deliberate, named overwrite (atomic)
    // Object-return, no throw, no silent default.
    static async #writeGuarded( { path, content, onExists } ) {
        const absolutePath = resolve( path )
        const effective = onExists === undefined ? 'error' : onExists
        const exists = existsSync( absolutePath )

        if( exists === true && effective === 'error' ) {
            return { 'written': false, 'skipped': false, 'error': `NO-OVERWRITE: refusing to overwrite existing file: ${absolutePath}` }
        }

        if( exists === true && effective === 'skip' ) {
            return { 'written': false, 'skipped': true, 'error': null }
        }

        await mkdir( dirname( absolutePath ), { recursive: true } )
        const tmp = `${absolutePath}.tmp`
        await writeFile( tmp, content, 'utf-8' )
        await rename( tmp, absolutePath )

        return { 'written': true, 'skipped': false, 'error': null }
    }
}


export { FlowMcpCli }
