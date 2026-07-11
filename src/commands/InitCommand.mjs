import { readFile, mkdir, readdir, stat, access } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { constants, existsSync, readFileSync } from 'node:fs'

import chalk from 'chalk'
import inquirer from 'inquirer'
import figlet from 'figlet'
import { FlowMCP } from 'flowmcp'

import { appConfig } from '../data/config.mjs'
import { ConfigStore } from '../lib/ConfigStore.mjs'
import { CliOutput } from '../lib/CliOutput.mjs'
import { FsUtils } from '../lib/FsUtils.mjs'
import { EnvResolver } from '../lib/EnvResolver.mjs'


// Memo 152 / PRD-019 (D-08 cluster "init-install") — `flowmcp init` (the ONLY interactive
// command) + its health-check / install helpers, extracted from FlowMcpCli. Memo 032: init
// NEVER auto-writes or auto-deletes a .env (quickInstall / manualInstall check existence and
// ask). F19=B: schemaFolders[]-only, no RegistryFetcher / network download path (the module-
// install helpers #collectRequiredModules / #buildInstallCommand / #verifyModules are kept
// faithfully but are currently uncalled — the registry-download caller was removed in PRD-016).
// healthCheck / printHeadline / formatHealthWarnings are PUBLIC static because the help + status
// commands (kept in FlowMcpCli) consume them. FlowMcpCli.init stays a public delegation. No
// back-reference to FlowMcpCli.
class InitCommand {
    static async init( { cwd } ) {
        InitCommand.printHeadline()

        const { version, commit, schemaSpec } = InitCommand.#detectCoreInfo()
        const shortCommit = commit.length > 7 ? commit.slice( 0, 7 ) : commit
        console.log( `  ${chalk.gray( 'Core:' )} v${version} ${chalk.gray( `(${shortCommit})` )}  ${chalk.gray( 'Spec:' )} ${schemaSpec}` )
        console.log( '' )

        // Step 1: Health Check - show current state
        const { checks, healthy } = await InitCommand.healthCheck( { cwd } )
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
                await InitCommand.#quickInstall( { cwd, version, commit, schemaSpec } )
            } else {
                await InitCommand.#manualInstall( { cwd, version, commit, schemaSpec } )
            }
        } else {
            console.log( `  ${chalk.green( '\u2713' )} All checks passed. Run '${appConfig[ 'cliCommand' ]} update' to check for schema updates.` )
            console.log( '' )
        }

        // Final health check
        const { checks: finalChecks, healthy: finalHealthy } = await InitCommand.healthCheck( { cwd } )

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

        const { data: finalGlobalConfig } = await FsUtils.readJson( { filePath: ConfigStore.globalConfigPath() } )
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


    static async healthCheck( { cwd } ) {
        const checks = []

        // Level 1: Global Config
        const globalConfigPath = ConfigStore.globalConfigPath()
        const { data: globalConfig } = await FsUtils.readJson( { filePath: globalConfigPath } )
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

        const { valid: globalStructureValid, warnings: globalWarnings } = ConfigStore.validateGlobalConfig( { globalConfig } )
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
        } catch( err ) {
            CliOutput.emitCoded( { 'code': 'HLT-001', 'location': 'healthCheck: env file access check failed', err } )
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
        const schemasDir = ConfigStore.schemasDir()
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
        } catch( err ) {
            CliOutput.emitCoded( { 'code': 'HLT-002', 'location': 'healthCheck: schema dir scan failed', err } )
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
            const { envObject } = EnvResolver.parseEnvFile( { envContent } )

            const allRequiredParams = new Set()
            const paramsByNamespace = {}

            await sourceDirs
                .reduce( ( promise, sourceDir ) => promise.then( async () => {
                    const registryPath = join( schemasDir, sourceDir, '_registry.json' )
                    const { data: registry } = await FsUtils.readJson( { filePath: registryPath } )

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
        const { data: localConfig } = await FsUtils.readJson( { filePath: localConfigPath } )
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
            const { valid: localStructureValid, warnings: localWarnings } = ConfigStore.validateLocalConfig( { localConfig } )
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
                : `Register a schema folder in schemaFolders[] (edit the global config), then run '${appConfig[ 'cliCommand' ]} list'.`
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


    static printHeadline() {
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


    static formatHealthWarnings( { checks } ) {
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


    static async #quickInstall( { cwd, version, commit, schemaSpec } ) {
        const globalDir = ConfigStore.globalConfigDir()
        await mkdir( globalDir, { recursive: true } )

        // .env path: use existing or create default
        const globalConfigPath = ConfigStore.globalConfigPath()
        const { data: existingGlobalConfig } = await FsUtils.readJson( { filePath: globalConfigPath } )
        let envPath

        if( existingGlobalConfig && existingGlobalConfig[ 'envPath' ] ) {
            envPath = existingGlobalConfig[ 'envPath' ]
        } else {
            envPath = join( globalDir, appConfig[ 'defaultEnvFileName' ] )
            try {
                await access( envPath, constants.F_OK )
            } catch {
                throw new Error(
                    `CLI-016 quickInstall: FlowMCP requires an .env file at ${envPath}.\n` +
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
            'schemaFolders': [],
            'sources': {
                'demo': { 'type': 'builtin', 'schemaCount': 1 }
            }
        }

        const { config: mergedGlobalConfig } = ConfigStore.mergeConfig( {
            'existing': existingGlobalConfig || {},
            'updates': globalConfigUpdates
        } )

        mergedGlobalConfig[ 'envPath' ] = envPath
        await ConfigStore.writeGlobalConfig( { 'config': mergedGlobalConfig } )
        console.log( `  ${chalk.green( '\u2713' )} Global config saved` )

        // Demo schema
        const schemasDir = ConfigStore.schemasDir()
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
        } catch( err ) {
            CliOutput.emitCoded( { 'code': 'CLI-017', 'location': 'quickInstall: schemas dir scan failed', err } )
            schemaSourceCount = 0
        }

        if( schemaSourceCount === 0 ) {
            const demoDir = join( schemasDir, 'demo' )
            await mkdir( demoDir, { recursive: true } )
            const { content: demoContent } = InitCommand.#createDemoSchema()
            await FsUtils.writeGuarded( { 'path': join( demoDir, 'ping.mjs' ), 'content': demoContent, 'onExists': 'overwrite' } )
            console.log( `  ${chalk.green( '\u2713' )} Demo schema created` )
        }

        // Local config
        const localDir = join( cwd, appConfig[ 'localConfigDirName' ] )
        await mkdir( localDir, { recursive: true } )
        const localConfigPath = join( localDir, 'config.json' )
        const { data: existingLocalConfig } = await FsUtils.readJson( { filePath: localConfigPath } )

        const { config: mergedLocalConfig } = ConfigStore.mergeConfig( {
            'existing': existingLocalConfig || {},
            'updates': { 'root': `~/${appConfig[ 'globalConfigDirName' ]}` }
        } )

        await FsUtils.writeGuarded( { 'path': localConfigPath, 'content': JSON.stringify( mergedLocalConfig, null, 4 ), 'onExists': 'overwrite' } )
        console.log( `  ${chalk.green( '\u2713' )} Local config saved` )

        // F19=B (Memo 152): init is schemaFolders[]-only. No network download,
        // no legacy group creation (Memo 099 replaced groups with selections).
        console.log( '' )
        console.log( `  ${chalk.cyan( 'Next:' )} register a v4 schema folder in ${chalk.bold( 'schemaFolders[]' )}` )
        console.log( `  of ${chalk.gray( ConfigStore.globalConfigPath() )}:` )
        console.log( '      "schemaFolders": [ { "name": "<source>", "path": "<abs-path-to-schemas>" } ]' )
        console.log( `  then run ${chalk.bold( 'flowmcp list' )} to see the available tools.` )
        console.log( '' )
    }


    static async #manualInstall( { cwd, version, commit, schemaSpec } ) {
        const globalConfigPath = ConfigStore.globalConfigPath()
        const { data: existingGlobalConfig } = await FsUtils.readJson( { filePath: globalConfigPath } )
        let envPath

        if( existingGlobalConfig && existingGlobalConfig[ 'envPath' ] ) {
            envPath = existingGlobalConfig[ 'envPath' ]
            console.log( `  ${chalk.green( '\u2713' )} Using existing .env path: ${chalk.gray( envPath )}` )
        } else {
            const { envPath: promptedEnvPath } = await InitCommand.#promptEnvPath()
            envPath = promptedEnvPath
        }

        const globalDir = ConfigStore.globalConfigDir()
        await mkdir( globalDir, { recursive: true } )

        const now = new Date().toISOString()
        const globalConfigUpdates = {
            envPath,
            'flowmcpCore': { version, commit, schemaSpec },
            'initialized': now,
            'schemaFolders': [],
            'sources': {
                'demo': { 'type': 'builtin', 'schemaCount': 1 }
            }
        }

        const { config: mergedGlobalConfig } = ConfigStore.mergeConfig( {
            'existing': existingGlobalConfig || {},
            'updates': globalConfigUpdates
        } )

        mergedGlobalConfig[ 'envPath' ] = envPath
        await ConfigStore.writeGlobalConfig( { 'config': mergedGlobalConfig } )

        const schemasDir = ConfigStore.schemasDir()
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
        } catch( err ) {
            CliOutput.emitCoded( { 'code': 'CLI-018', 'location': 'manualInstall: schemas dir scan failed', err } )
            schemaSourceCount = 0
        }

        if( schemaSourceCount > 0 ) {
            console.log( `  ${chalk.green( '\u2713' )} ${schemaSourceCount} schema source(s) found` )
        } else {
            const demoDir = join( schemasDir, 'demo' )
            await mkdir( demoDir, { recursive: true } )
            const { content: demoContent } = InitCommand.#createDemoSchema()
            await FsUtils.writeGuarded( { 'path': join( demoDir, 'ping.mjs' ), 'content': demoContent, 'onExists': 'overwrite' } )
            console.log( `  ${chalk.green( '\u2713' )} Demo schema created` )
        }

        const localDir = join( cwd, appConfig[ 'localConfigDirName' ] )
        await mkdir( localDir, { recursive: true } )
        const localConfigPath = join( localDir, 'config.json' )
        const { data: existingLocalConfig } = await FsUtils.readJson( { filePath: localConfigPath } )

        const { config: mergedLocalConfig } = ConfigStore.mergeConfig( {
            'existing': existingLocalConfig || {},
            'updates': { 'root': `~/${appConfig[ 'globalConfigDirName' ]}` }
        } )

        await FsUtils.writeGuarded( { 'path': localConfigPath, 'content': JSON.stringify( mergedLocalConfig, null, 4 ), 'onExists': 'overwrite' } )

        console.log( '' )
        console.log( `  ${chalk.green( '\u2713' )} Global config saved to ${chalk.gray( ConfigStore.globalConfigPath() )}` )
        console.log( `  ${chalk.green( '\u2713' )} Local config saved to ${chalk.gray( localConfigPath )}` )
        console.log( '' )

        // F19=B (Memo 152): init is schemaFolders[]-only. No network download,
        // no legacy group creation (Memo 099 replaced groups with selections).
        console.log( `  ${chalk.cyan( 'Next:' )} register a v4 schema folder in ${chalk.bold( 'schemaFolders[]' )}` )
        console.log( `  of ${chalk.gray( ConfigStore.globalConfigPath() )}:` )
        console.log( '      "schemaFolders": [ { "name": "<source>", "path": "<abs-path-to-schemas>" } ]' )
        console.log( `  then run ${chalk.bold( 'flowmcp list' )} to see the available tools.` )
        console.log( '' )
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
                        return `ENV-001 promptEnvPath: File not found: ${resolvedPath}`
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
        } catch( err ) {
            CliOutput.emitCoded( { 'code': 'ENV-002', 'location': 'promptEnvPath: env file read failed', err } )
            console.log( `  ${chalk.yellow( '!' )} File will be created on first use` )
        }

        return { 'envPath': resolvedPath }
    }


    static #detectCoreInfo() {
        try {
            const require = createRequire( import.meta.url )
            const corePath = require.resolve( 'flowmcp' )
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
                        } catch( err ) {
                            CliOutput.emitCoded( { 'code': 'CLI-019', 'location': 'detectCoreInfo: package.json parse failed', err } )
                        }
                    }

                    dir = dirname( dir )
                } )

            const commit = '8a9e8f1'
            const schemaSpec = appConfig[ 'schemaSpec' ]

            return { version, commit, schemaSpec }
        } catch( err ) {
            CliOutput.emitCoded( { 'code': 'CLI-020', 'location': 'detectCoreInfo: core resolution failed', err } )
            return {
                'version': 'unknown',
                'commit': 'unknown',
                'schemaSpec': appConfig[ 'schemaSpec' ] || 'unknown'
            }
        }
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
}


export { InitCommand }
