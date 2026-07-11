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
import { constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'

import chalk from 'chalk'
import figlet from 'figlet'
import inquirer from 'inquirer'
import { FlowMCP, SkillValidator, SelectionValidator, CatalogIndex, IdResolver } from 'flowmcp'

import { appConfig, catalogCategories } from '../data/config.mjs'
import { ADDON_REGISTRY } from '../data/addons.mjs'
import { PathVariableResolver } from '../path/resolvePathVariables.mjs'
import { SqliteGtfsRuntime } from '../addons/SqliteGtfsRuntime.mjs'
import { SqliteGtfsResourceValidator } from '../validators/SqliteGtfsResourceValidator.mjs'
import { ModuleRegistry } from '../lib/ModuleRegistry.mjs'
import { CliOutput, CliError } from '../lib/CliOutput.mjs'
import { FsUtils } from '../lib/FsUtils.mjs'
import { ConfigStore } from '../lib/ConfigStore.mjs'
import { SchemaSource } from '../lib/SchemaSource.mjs'
import { HttpCache } from '../lib/HttpCache.mjs'
import { EnvResolver } from '../lib/EnvResolver.mjs'
import { SchemaLoaderBridge } from '../lib/SchemaLoaderBridge.mjs'
import { HandlerResolver } from '../lib/HandlerResolver.mjs'
import { NamespaceIndex } from '../lib/NamespaceIndex.mjs'
import { CliBase } from '../lib/CliBase.mjs'
import { AllowlistCommand } from '../commands/AllowlistCommand.mjs'
import { DoctorCommand } from '../commands/DoctorCommand.mjs'
import { EnvCommand } from '../commands/EnvCommand.mjs'
import { CatalogCommand } from '../commands/CatalogCommand.mjs'
import { SelectionCommand } from '../commands/SelectionCommand.mjs'
import { CacheCommand } from '../commands/CacheCommand.mjs'
import { PromptCommand } from '../commands/PromptCommand.mjs'
import { ListsCommand } from '../commands/ListsCommand.mjs'
import { HelpCommand } from '../commands/HelpCommand.mjs'
import { ResourceCommand } from '../commands/ResourceCommand.mjs'


// TODO(next major): remove this delegation facade — the command/lib modules live
// in src/lib + src/commands (Memo 152 Phase 4). The facade is retained (F12=A) so
// the 80+ test suites that bind FlowMcpCli statically stay green through the split.
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





    static async schemas() {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { sources } = await SchemaSource.listSources()

        const result = {
            'status': true,
            sources
        }

        return { result }
    }






    // Memo 152 / PRD-019 (D-08) — delegation facade (F12=A). The `flowmcp prompt`
    // commands live in src/commands/PromptCommand.mjs.
    static async promptList( { cwd } ) {
        return await PromptCommand.promptList( { cwd } )
    }


    static async promptSearch( { query, cwd } ) {
        return await PromptCommand.promptSearch( { query, cwd } )
    }


    static async promptShow( { group, name, cwd } ) {
        return await PromptCommand.promptShow( { group, name, cwd } )
    }


    static async promptAdd( { group, name, file, cwd } ) {
        return await PromptCommand.promptAdd( { group, name, file, cwd } )
    }


    static async promptRemove( { group, name, cwd } ) {
        return await PromptCommand.promptRemove( { group, name, cwd } )
    }


    static async validate( { schemaPath, cwd } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const v4 = FlowMcpCli.#v4Module()

        if( !schemaPath && cwd ) {
            const { schemas: groupSchemas, error: groupError } = await FlowMcpCli.#resolveDefaultGroupSchemas( { cwd } )
            if( groupError ) {
                const result = CliOutput.error( { error: groupError } )

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

        const { schemas, error: loadError } = await SchemaLoaderBridge.loadSchemasFromPath( { schemaPath } )
        if( !schemas ) {
            const result = CliOutput.error( { error: loadError } )

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
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

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

        const { config } = await ConfigStore.readConfig( { cwd } )

        const globalConfigPath = ConfigStore.globalConfigPath()
        const { data: globalConfig } = await FsUtils.readJson( { filePath: globalConfigPath } )
        const sourcesInfo = {}

        if( globalConfig && globalConfig[ 'sources' ] ) {
            Object.entries( globalConfig[ 'sources' ] )
                .forEach( ( [ sourceName, sourceData ] ) => {
                    const { schemaCount } = sourceData
                    sourcesInfo[ sourceName ] = { schemaCount }
                } )
        }

        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FsUtils.readJson( { filePath: localConfigPath } )
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
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        let resolvedSchemas = null
        let serverName = null

        if( !group ) {
            const { schemas: agentSchemas, error: agentError, fix: agentFix } = await FlowMcpCli.#resolveAgentSchemas( { cwd } )
            if( !agentSchemas ) {
                const result = CliOutput.error( { 'error': agentError, 'fix': agentFix } )

                return { result }
            }

            resolvedSchemas = agentSchemas
            serverName = 'default'
        } else {
            const { groupName, error: groupNameError, fix: groupNameFix } = await FlowMcpCli.#resolveGroupName( { group, cwd } )
            if( !groupName ) {
                const result = CliOutput.error( { 'error': groupNameError, 'fix': groupNameFix } )

                return { result }
            }

            const { schemas: groupSchemas, error: schemasError, fix: schemasFix } = await FlowMcpCli.#resolveGroupSchemas( { groupName, cwd } )
            if( !groupSchemas ) {
                const result = CliOutput.error( { 'error': schemasError, 'fix': schemasFix } )

                return { result }
            }

            resolvedSchemas = groupSchemas
            serverName = groupName
        }

        const { config } = await ConfigStore.readConfig( { cwd } )
        const { envPath } = config
        const { data: envContent } = await FsUtils.readText( { filePath: envPath } )
        if( !envContent ) {
            const result = CliOutput.error( {
                'error': `Cannot read .env file at: ${envPath}`,
                'fix': `Ensure the .env file exists at ${envPath}`
            } )

            return { result }
        }

        const { envObject } = EnvResolver.parseEnvFile( { envContent } )

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
            const result = CliOutput.error( {
                'error': `CLI-003 run: Failed to load MCP SDK: ${err.message}`,
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
                const { serverParams } = EnvResolver.buildServerParams( { envObject, requiredServerParams } )
                // Memo 149 Strang B — resolve via the single-source helper (was:
                // join( #schemasDir(), file ) against the dead staging dir).
                const { filePath: schemaFilePath } = await SchemaSource.resolveSchemaFilePath( { schemaRef: file } )
                const { handlerMap } = await HandlerResolver.resolve( { main, handlersFn, 'filePath': schemaFilePath } )
                const namespaceForTools = main[ 'namespace' ] || 'unknown'

                Object.keys( main[ 'tools' ] || main[ 'routes' ] || {} )
                    .forEach( ( routeName ) => {
                        const { toolName, description, zod, func } = FlowMCP.prepareServerTool( {
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
                    const { resourceHandlerMap } = await HandlerResolver.resolve( { main, handlersFn, 'filePath': schemaFilePath } )

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
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        // Memo 099 Kap 5 — list ALL tools from the configured schemaFolders (no group/activation).
        const { schemas: resolvedSchemas, error: resolveError, fix: resolveFix } = await SchemaLoaderBridge.resolveAllSchemas()

        // PRD-008 — a duplicate schemaFolders[] name is a hard config error.
        if( resolveError !== null && resolveError !== undefined ) {
            const result = CliOutput.error( { 'error': resolveError, 'fix': resolveFix } )

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
                            const { toolName } = FlowMCP.buildToolName( { routeName, namespace } )
                            const description = routes[ routeName ][ 'description' ] || ''

                            // PRD-008 — surface the source coordinate so a qualified
                            // "<source>:<namespace>/tool/<name>" call is readable from `list`.
                            tools.push( { toolName, namespace, routeName, description, 'source': source || null } )
                        } catch( err ) {
                            process.stderr.write( `CLI-004 callListTools: tool name build failed: ${err.message}\n` )
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
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        if( !toolName ) {
            const result = CliOutput.error( {
                'error': 'Missing tool name.',
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} call <tool-name> [json]. Run ${appConfig[ 'cliCommand' ]} call list-tools to see available tools.`
            } )

            return { result }
        }

        // Memo 051 PRD-20 — route auto-injected sqlite-gtfs tools to addon handlers
        const autoToolRoute = await SqliteGtfsRuntime.maybeCallSqliteGtfsAutoTool( {
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
        // Memo 128 Kap 10 — for a tool Spec-ID we can resolve via the prebuilt
        // namespace-index (one import) instead of scanning all schemas.
        let lazySpec = null

        if( FlowMcpCli.#isSpecId( { 'ref': toolName } ) ) {
            const { valid, namespace, type, name: specName, source } = FlowMcpCli.#parseSpecId( { 'specId': toolName } )

            if( !valid ) {
                const result = CliOutput.error( {
                    'error': `Invalid Spec-ID "${toolName}".`,
                    'fix': `Use format: <namespace>/tool/<name> (optional prefix "<source>:").`
                } )

                return { result }
            }

            if( type === 'schema' ) {
                const result = CliOutput.error( {
                    'error': `Cannot call a container Spec-ID "${toolName}". Specify a tool Spec-ID: <namespace>/tool/<name>`,
                    'fix': `Use format: ${namespace}/tool/<route-name>`
                } )

                return { result }
            }

            if( type !== 'tool' ) {
                const result = CliOutput.error( {
                    'error': `Spec-ID type "${type}" cannot be called directly.`,
                    'fix': `Only tool Spec-IDs are callable: <namespace>/tool/<name>`
                } )

                return { result }
            }

            sourceFilter = source
            lazySpec = { namespace, 'routeName': specName }
            const { toolName: mcpToolName } = FlowMCP.buildToolName( { 'routeName': specName, 'namespace': namespace } )
            resolvedToolName = mcpToolName
        }

        // Memo 128 Kap 10 — Lazy Schema-Resolution: for a tool Spec-ID, import only
        // the single indexed schema file. Memo 099 Kap 5 — no activation: the full
        // scan (lazy miss / bare name) resolves against ALL configured schemaFolders.
        let resolvedSchemas = null
        let lazyUsed = false

        if( lazySpec !== null ) {
            const { schemas: lazySchemas } = await FlowMcpCli.#resolveSchemaByIndex( {
                'namespace': lazySpec[ 'namespace' ],
                'routeName': lazySpec[ 'routeName' ],
                sourceFilter,
                cwd
            } )

            if( lazySchemas !== null ) {
                resolvedSchemas = lazySchemas
                lazyUsed = true
            }
        }

        if( resolvedSchemas === null ) {
            const { resolvedSchemas: scanned, errorResult } = await FlowMcpCli.#resolveSchemasForCall( { sourceFilter } )

            if( errorResult ) {
                return { 'result': errorResult }
            }

            resolvedSchemas = scanned
        }

        const { config } = await ConfigStore.readConfig( { cwd } )
        const { envPath } = config
        const { data: envContent } = await FsUtils.readText( { filePath: envPath } )
        const envObject = envContent
            ? EnvResolver.parseEnvFile( { envContent } ).envObject
            : {}

        let userParams = {}
        if( jsonArgs ) {
            try {
                userParams = JSON.parse( jsonArgs )
            } catch {
                const result = CliOutput.error( {
                    'error': 'CAL-001 callTool: Invalid JSON argument.',
                    'fix': `Provide valid JSON: ${appConfig[ 'cliCommand' ]} call ${toolName} '{"param": "value"}'`
                } )

                return { result }
            }
        }

        // Memo 128 Kap 10 — wire-name match (also the lazy-resolution re-verify).
        let matched = FlowMcpCli.#matchToolInSchemas( { resolvedSchemas, resolvedToolName } )

        // Stale-index guard: a lazy single-file load that does not contain the
        // requested wire-name (index drifted) falls back to the full scan.
        if( !matched[ 'matchedMain' ] && lazyUsed ) {
            const { resolvedSchemas: scanned, errorResult } = await FlowMcpCli.#resolveSchemasForCall( { sourceFilter } )

            if( errorResult ) {
                return { 'result': errorResult }
            }

            resolvedSchemas = scanned
            matched = FlowMcpCli.#matchToolInSchemas( { resolvedSchemas, resolvedToolName } )
        }

        const { matchedMain, matchedHandlersFn, matchedFile, matchedToolName, matchedRouteName } = matched

        if( !matchedMain ) {
            const resourceResult = await FlowMcpCli.#callResourceQuery( { toolName, jsonArgs, resolvedSchemas } )

            if( resourceResult ) {
                return resourceResult
            }

            const result = CliOutput.error( {
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
            const result = CliOutput.error( {
                'error': `Tool "${toolName}" is not available — missing key(s): ${matchedMissingKeys.join( ', ' )}.`,
                'fix': `Add the key(s) to ${envPath}. ${otherCount} other tool(s) remain callable.`
            } )

            return { result }
        }

        const matchedRouteConfig = ( matchedMain[ 'routes' ] || matchedMain[ 'tools' ] )[ matchedRouteName ]
        const matchedRouteParameters = matchedRouteConfig[ 'parameters' ] || []
        const { filePath: matchedSchemaFilePath } = matchedFile
            ? await SchemaSource.resolveSchemaFilePath( { schemaRef: matchedFile } )
            : { filePath: null }
        const { sharedLists: matchedSharedLists } = await ListsCommand.resolveSharedListsForSchema( { 'main': matchedMain, 'filePath': matchedSchemaFilePath } )
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
            const result = CliOutput.error( {
                'error': `Missing required parameter(s): ${missingParams.join( ', ' )}`,
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} call ${toolName} '${JSON.stringify( expectedParameters, null, 0 )}'`
            } )

            return { result }
        }

        const preload = matchedRouteConfig[ 'preload' ] || null
        const isCacheable = preload && preload[ 'enabled' ] === true && !noCache
        const namespace = matchedMain[ 'namespace' ] || 'unknown'

        if( isCacheable && !refresh ) {
            const { cacheKey } = HttpCache.buildCacheKey( {
                namespace,
                'routeName': matchedRouteName,
                userParams
            } )

            const { data: cachedData, meta, isExpired } = await HttpCache.readCache( { cacheKey } )

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
            const { serverParams } = EnvResolver.buildServerParams( { envObject, requiredServerParams } )
            // Memo 149 Strang B — reuse the already-resolved matchedSchemaFilePath (the
            // param path computed it via #resolveSchemaFilePath above). No second, dead
            // join( #schemasDir(), matchedFile ).
            const { handlerMap } = await HandlerResolver.resolve( { 'main': matchedMain, 'handlersFn': matchedHandlersFn, 'filePath': matchedSchemaFilePath } )

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
                const { cacheKey } = HttpCache.buildCacheKey( {
                    namespace,
                    'routeName': matchedRouteName,
                    userParams
                } )
                const { meta: cacheMeta } = await HttpCache.writeCache( {
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
            const result = CliOutput.error( {
                'error': `CFG-001 matchedRouteConfig: Tool execution failed: ${err.message}`,
                'fix': `Check the tool parameters and env vars. Run ${appConfig[ 'cliCommand' ]} call list-tools for details.`
            } )

            return { result }
        }
    }


    static async search( { query } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        if( !query || typeof query !== 'string' || query.trim().length === 0 ) {
            const result = CliOutput.error( {
                'error': 'Missing search query.',
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} search <query>`
            } )

            return { result }
        }

        const { tools: allTools } = await FlowMcpCli.#listAvailableTools()
        const queryTokens = query.toLowerCase().trim().split( /\s+/ )

        // Memo 099 Kap 6 — read env so search can flag key-gated (disabled) tools
        const { config: searchConfig } = await ConfigStore.readConfig( { cwd: process.cwd() } )
        const searchEnvPath = searchConfig ? searchConfig[ 'envPath' ] : null
        const { data: searchEnvContent } = searchEnvPath
            ? await FsUtils.readText( { filePath: searchEnvPath } )
            : { data: null }
        const searchEnvObject = searchEnvContent
            ? EnvResolver.parseEnvFile( { envContent: searchEnvContent } ).envObject
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
                const { filePath } = await SchemaSource.resolveSchemaPath( { schemaRef } )

                try {
                    const { main } = await SchemaLoaderBridge.loadSchema( { filePath } )

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
                } catch( err ) {
                    // Schema could not be loaded — return without enrichment
                    process.stderr.write( `CLI-005 search: schema enrichment skipped: ${err.message}\n` )
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




    static async list( { cwd } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        // Memo 099 Kap 5/6 — list ALL tools from the configured schemaFolders.
        // A tool whose required keys are missing from .env is flagged disabled
        // (visible, never hidden) so the user sees exactly what is unavailable.
        const { config } = await ConfigStore.readConfig( { cwd } )
        const { envPath } = config
        const { data: envContent } = await FsUtils.readText( { filePath: envPath } )
        const envObject = envContent
            ? EnvResolver.parseEnvFile( { envContent } ).envObject
            : {}

        const { schemas, error: resolveError, fix: resolveFix } = await SchemaLoaderBridge.resolveAllSchemas()

        // PRD-008 — a duplicate schemaFolders[] name is a hard config error.
        if( resolveError !== null && resolveError !== undefined ) {
            const result = CliOutput.error( { 'error': resolveError, 'fix': resolveFix } )

            return { result }
        }

        const tools = []
        let disabledCount = 0

        const sharedListsMap = {}
        await schemas
            .reduce( ( promise, { main, file } ) => promise.then( async () => {
                if( main && main[ 'sharedLists' ] && main[ 'sharedLists' ].length > 0 && file ) {
                    const { filePath } = await SchemaSource.resolveSchemaPath( { schemaRef: file } )
                    const { sharedLists: resolved } = await ListsCommand.resolveSharedListsForSchema( { main, filePath } )
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
                            const { toolName: name } = FlowMCP.buildToolName( { routeName, namespace } )
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
                        } catch( err ) {
                            // skip broken tools
                            process.stderr.write( `CLI-006 list: broken tool skipped: ${err.message}\n` )
                        }
                    } )
            } )

        // Memo 051 PRD-19 — include auto-injected tools from cached sqlite-gtfs schemas
        const { entries: sealCacheEntries } = await SqliteGtfsRuntime.listSqliteGtfsCacheEntries()
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


    // Memo 152 / PRD-019 (D-08) — delegation facade (F12=A). The `flowmcp lists`
    // commands live in src/commands/ListsCommand.mjs.
    static async listSharedLists( { listName } ) {
        return await ListsCommand.listSharedLists( { listName } )
    }


    static async listsAddEntry( { cwd, listName, jsonEntry } ) {
        return await ListsCommand.listsAddEntry( { cwd, listName, jsonEntry } )
    }


    static async listsRefs( { cwd, alias } ) {
        return await ListsCommand.listsRefs( { cwd, alias } )
    }


    static async generateCatalog( { cwd } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { tools: allTools } = await FlowMcpCli.#listAvailableTools()
        const schemasBaseDir = ConfigStore.schemasDir()

        const tagsByNamespace = {}

        await allTools
            .reduce( ( promise, tool ) => promise.then( async () => {
                const { schemaRef, namespace } = tool

                if( tagsByNamespace[ namespace ] ) { return }

                const filePath = join( schemasBaseDir, schemaRef )

                try {
                    const { main } = await SchemaLoaderBridge.loadSchema( { filePath } )

                    if( main && main[ 'tags' ] ) {
                        tagsByNamespace[ namespace ] = main[ 'tags' ]
                    } else {
                        tagsByNamespace[ namespace ] = []
                    }
                } catch( err ) {
                    process.stderr.write( `CLI-012 generateCatalog: schema tags load failed: ${err.message}\n` )
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
        await FsUtils.writeGuarded( { 'path': outputPath, 'content': markdown, 'onExists': 'overwrite' } )

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
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        if( !toolId || typeof toolId !== 'string' || toolId.trim().length === 0 ) {
            const result = CliOutput.error( {
                'error': 'Missing tool ID.',
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} skill generate <tool-name>`
            } )

            return { result }
        }

        const { tools: allTools } = await FlowMcpCli.#listAvailableTools()
        const matchedTool = allTools
            .find( ( t ) => t[ 'toolName' ] === toolId )

        if( !matchedTool ) {
            const result = CliOutput.error( {
                'error': `Tool "${toolId}" not found.`,
                'fix': `Use: ${appConfig[ 'cliCommand' ]} search <keyword> to find tool names`
            } )

            return { result }
        }

        const schemasBaseDir = ConfigStore.schemasDir()
        const filePath = join( schemasBaseDir, matchedTool[ 'schemaRef' ] )
        const { main } = await SchemaLoaderBridge.loadSchema( { filePath } )

        if( !main ) {
            const result = CliOutput.error( {
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









    // Memo 152 / PRD-019 (D-08) — delegation facade (F12=A). The validationPrompt*
    // methods live in src/commands/PromptCommand.mjs; tests call them directly on
    // FlowMcpCli, so the delegations stay. The private helpers
    // (#extractPromptDescription/#detectToolReferences) moved into PromptCommand.
    static validationPromptAdd( { group, name, file } ) {
        return PromptCommand.validationPromptAdd( { group, name, file } )
    }


    static validationPromptRemove( { group, name } ) {
        return PromptCommand.validationPromptRemove( { group, name } )
    }


    static validationPromptShow( { group, name } ) {
        return PromptCommand.validationPromptShow( { group, name } )
    }


    static validationPromptSearch( { query } ) {
        return PromptCommand.validationPromptSearch( { query } )
    }




    static async #healthCheck( { cwd } ) {
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











    // Memo 152 / PRD-019 (D-08) — the HTTP response-cache primitives (cacheDir/
    // buildCacheKey/readCache/writeCache) moved to src/lib/HttpCache.mjs; the
    // `flowmcp cache` command (status/clear + FS helpers) to src/commands/CacheCommand.mjs.
    // These stay as delegation facades (F12=A).
    static async cacheClear( { namespace } ) {
        return await CacheCommand.cacheClear( { namespace } )
    }


    static async cacheStatus() {
        return await CacheCommand.cacheStatus()
    }


    // ---------------------------------------------------------------------
    // Memo 152 / PRD-019 (D-09) — the sqlite-gtfs runtime read path
    // (#sqliteGtfsCacheDir / #listSqliteGtfsCacheEntries /
    // #executeSqliteGtfsSqlTemplate / #maybeCallSqliteGtfsAutoTool) moved to
    // src/addons/SqliteGtfsRuntime.mjs. callTool + list call it directly there;
    // no facade delegation needed (no test binds these private members).
    // ---------------------------------------------------------------------

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
        const { sources } = await SchemaSource.listSources()
        const tools = []

        await sources
            .reduce( ( promise, source ) => promise.then( async () => {
                const { name: sourceName, schemas: sourceSchemas } = source

                await sourceSchemas
                    .reduce( ( schemaPromise, schemaEntry ) => schemaPromise.then( async () => {
                        const { file, namespace } = schemaEntry
                        const schemaRef = `${sourceName}/${file}`
                        const { filePath } = await SchemaSource.resolveSchemaPath( { schemaRef } )
                        const { main } = await SchemaLoaderBridge.loadSchema( { filePath } )

                        const effectiveNamespace = main && main[ 'namespace' ] ? main[ 'namespace' ] : namespace

                        const toolEntries = main ? ( main[ 'tools' ] || main[ 'routes' ] ) : null
                        if( main && toolEntries ) {
                            Object.entries( toolEntries )
                                .forEach( ( [ routeName, routeConfig ] ) => {
                                    const routeDescription = routeConfig[ 'description' ] || ''
                                    const toolRef = `${schemaRef}::${routeName}`
                                    const { toolName } = FlowMCP.buildToolName( {
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
        const { sources } = await SchemaSource.listSources()
        const schemasBaseDir = ConfigStore.schemasDir()
        const aliasIndex = []

        await sources
            .reduce( ( promise, source ) => promise.then( async () => {
                const { name: sourceName } = source
                const registryPath = join( schemasBaseDir, sourceName, '_registry.json' )
                const { data: registry } = await FsUtils.readJson( { filePath: registryPath } )

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
                        } catch( err ) {
                            // _shared file could not be loaded — skip
                            CliOutput.emitCoded( { 'code': 'SCH-002', 'location': 'loadSharedAliases: shared file load failed', err } )
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


    // Memo 152 / PRD-012 (B-04) — buildToolName is now the public core v4 API
    // (FlowMCP.buildToolName), byte-identical to the former CLI copy. The MCP tool
    // name is `<route>_<namespace>` (snake_case, 63-char cap); the optional `source`
    // (schemaFolders[] name) is appended ONLY when `disambiguate === true`. Tool
    // names are a Wire-Contract — no silent rename.

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

        const { toolName: qualifiedName } = FlowMCP.buildToolName( { routeName, namespace, source, 'disambiguate': true } )
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











    static async catalogLink( { name, path } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        if( typeof name !== 'string' || name.trim().length === 0 ) {
            const result = CliOutput.error( {
                'error': 'Missing source name.',
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} catalog link <name> <absolute-path>`
            } )

            return { result }
        }

        if( typeof path !== 'string' || path.trim().length === 0 ) {
            const result = CliOutput.error( {
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
            const result = CliOutput.error( {
                'error': `Source path does not exist: ${absolutePath}`,
                'fix': 'Provide an existing directory that contains FlowMCP schema files.'
            } )

            return { result }
        }

        const globalConfigPath = ConfigStore.globalConfigPath()
        const { data: existingConfig } = await FsUtils.readJson( { filePath: globalConfigPath } )
        const globalConfig = existingConfig || {}

        if( !globalConfig[ 'localSources' ] || typeof globalConfig[ 'localSources' ] !== 'object' || Array.isArray( globalConfig[ 'localSources' ] ) ) {
            globalConfig[ 'localSources' ] = {}
        }

        globalConfig[ 'localSources' ][ name ] = {
            'path': absolutePath,
            'linkedAt': new Date().toISOString()
        }

        await ConfigStore.writeGlobalConfig( { config: globalConfig } )

        const { sources } = await SchemaSource.listSources()
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
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        if( typeof name !== 'string' || name.trim().length === 0 ) {
            const result = CliOutput.error( {
                'error': 'Missing source name.',
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} catalog unlink <name>`
            } )

            return { result }
        }

        const globalConfigPath = ConfigStore.globalConfigPath()
        const { data: existingConfig } = await FsUtils.readJson( { filePath: globalConfigPath } )
        const globalConfig = existingConfig || {}
        const localSources = globalConfig[ 'localSources' ]

        if( !localSources || typeof localSources !== 'object' || localSources[ name ] === undefined ) {
            const result = CliOutput.error( {
                'error': `Local source "${name}" is not linked.`,
                'fix': `Run ${appConfig[ 'cliCommand' ]} catalog sources to see linked sources.`
            } )

            return { result }
        }

        delete localSources[ name ]
        await ConfigStore.writeGlobalConfig( { config: globalConfig } )

        const result = {
            'status': true,
            'unlinked': name
        }

        return { result }
    }


    // Memo 152 / PRD-019 (D-08 cluster "catalog-skill") — catalogSources + validateCatalog
    // moved to src/commands/CatalogCommand.mjs. These stay as public delegations (index.mjs +
    // the catalog test call them). generateSkill/generateCatalog/importAgent/catalogLink/Unlink
    // stay here untouched (importAgent + link/unlink deletion is PRD-020 G-11/G-12).
    static async catalogSources() {
        return CatalogCommand.catalogSources()
    }


    // Memo 152 / PRD-019 (D-08) — #listSources (schemaFolders[] enumeration) and its
    // pure FS-scan helper #listSchemaFiles moved to src/lib/SchemaSource.mjs
    // (SchemaSource.listSources). Call sites here delegate to it.


    static async #resolveDefaultGroupSchemas( { cwd } ) {
        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FsUtils.readJson( { filePath: localConfigPath } )

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
        const { data: localConfig } = await FsUtils.readJson( { filePath: localConfigPath } )

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
        const { data: localConfig } = await FsUtils.readJson( { filePath: localConfigPath } )

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
                const { filePath } = await SchemaSource.resolveSchemaPath( { schemaRef } )
                const { main, handlersFn, error } = await SchemaLoaderBridge.loadSchema( { filePath } )

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





    // Memo 152 / PRD-019 (D-08) — the shared env helpers resolveEnv/parseEnvFile/
    // buildServerParams/isKeyFilled moved to src/lib/EnvResolver.mjs. Call sites
    // across the handler/call/search/serve/env-tools paths call EnvResolver directly.

    // Test-only accessor for EnvResolver.resolveEnv (Memo 032 PRD-07). Do not use in production code.
    static async _testResolveEnv( { cwd } ) {
        return EnvResolver.resolveEnv( { cwd } )
    }









    // Memo 152 / PRD-019 (D-08 cluster "env-tools") — #collectAllRequiredServerParams +
    // devEnvDoctor/Backup/Restore/Diff/Acquire moved to src/commands/EnvCommand.mjs. These
    // stay as public delegations because index.mjs and the dev-env tests call FlowMcpCli.devEnv*
    // directly. Memo 032 rules (no .env auto-write/-delete, restore confirms, diff = names only)
    // are unchanged — the logic was moved verbatim.
    static async devEnvDoctor( { schema = null, strict = false, fixTemplate = false, json = false, printSignups = false, cwd } ) {
        return EnvCommand.doctor( { schema, strict, fixTemplate, json, printSignups, cwd } )
    }


    static async devEnvBackup( { cwd } ) {
        return EnvCommand.backup( { cwd } )
    }


    static async devEnvRestore( { file, cwd } ) {
        return EnvCommand.restore( { file, cwd } )
    }


    static async devEnvDiff( { file, cwd } ) {
        return EnvCommand.diff( { file, cwd } )
    }


    static async devEnvAcquire( { key = null, mode = null, printGuide = false, json = false, cwd } ) {
        return EnvCommand.acquire( { key, mode, printGuide, json, cwd } )
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

Diagnostics:
  doctor                              Structural health check over schemaFolders[]
                                      (lists, modules, refs, config) — reports by
                                      error code; exit 1 if any ERROR check fails
  version, --version                  Print the CLI name and version

Schema Folders (Memo 099):
  Tools come directly from the folders listed in schemaFolders[] in
  ~/.flowmcp/config.json. Add a folder by editing that array (name + path).
  No "add"/"import" — every tool in every folder is immediately callable.
  A tool whose required API key is missing is shown as
  "[disabled: missing KEY]" and skipped; the rest stay usable.

Development & Schema Maintenance:
  ${cmd} dev <subcommand>             See "${cmd} dev --help" for all dev commands
                                      (schema-check, allowlist, migrate-config,
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


    // Memo 152 / PRD-019 (D-08) — delegation facade (F12=A). The `how-to` and
    // `dev --help` text commands live in src/commands/HelpCommand.mjs.
    static devHelp() {
        return HelpCommand.devHelp()
    }


    static async howTo( { cwd } = {} ) {
        return await HelpCommand.howTo( { cwd } )
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
            const { content: demoContent } = FlowMcpCli.#createDemoSchema()
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
            const { envPath: promptedEnvPath } = await FlowMcpCli.#promptEnvPath()
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
            const { content: demoContent } = FlowMcpCli.#createDemoSchema()
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

            // skill / prompt / selection-member carry no downloadable data. They are
            // validated STRUCTURALLY against the real v4 modules (no longer stub-passed):
            // SkillValidator / SelectionValidator / a prompt field check. A structurally
            // invalid primitive returns status:false.
            if( primitive === 'skill' ) {
                const tools = schemaMain[ 'tools' ] || {}
                const resources = schemaMain[ 'resources' ] || {}
                const skill = typedTest[ 'context' ][ 'skill' ]
                const skillName = typedTest[ 'name' ]
                const { status, messages } = SkillValidator.validate( {
                    'skills': { [ skillName ]: skill },
                    tools,
                    resources
                } )
                return {
                    status,
                    'error': status ? null : ( ( messages || [] )[ 0 ] || 'skill structurally invalid' ),
                    'output': `skill-structural:${skillName}`,
                    'durationMs': Date.now() - startedAt,
                    primitive
                }
            }

            if( primitive === 'prompt' ) {
                // No dedicated v4 PromptValidator export — the honest structural check is
                // field-level: a prompt must carry a non-empty string name.
                const prompt = typedTest[ 'context' ][ 'prompt' ]
                const status = prompt !== undefined && prompt !== null && typeof prompt[ 'name' ] === 'string' && prompt[ 'name' ].length > 0
                return {
                    status,
                    'error': status ? null : 'prompt structurally invalid: missing string name',
                    'output': `prompt-structural:${typedTest[ 'name' ]}`,
                    'durationMs': Date.now() - startedAt,
                    primitive
                }
            }

            if( primitive === 'selection-member' ) {
                // Single-schema structural validation of the selection block via the real
                // v4 module. Catalog-resolvability (SEL003) needs cross-schema registry
                // data not available here, so it is omitted.
                const selection = schemaMain[ 'selection' ] || null
                const { valid, errors } = selection === null
                    ? { 'valid': false, 'errors': [ 'selection block missing on schema' ] }
                    : SelectionValidator.validate( { selection, 'catalog': null } )
                return {
                    'status': valid,
                    'error': valid ? null : ( ( errors || [] )[ 0 ] || 'selection structurally invalid' ),
                    'output': `selection-member:${typedTest[ 'name' ]}`,
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
                'error': `CLI-021 executeTest: ${err && err.message ? err.message : String( err )}`,
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


    // internal: test access only — Memo 149 Strang B/C. Exposes #resolveHandlers so the
    // fail-loud shared-list contract (LST-001 / HND-001) and the single-source path
    // helper can be exercised deterministically without a live schemaFolders round-trip.
    static async _testHook_resolveHandlers( { main, handlersFn, filePath } ) {
        return await HandlerResolver.resolve( { main, handlersFn, filePath } )
    }


    // internal: test access only — Memo 149 Strang B. The single source of truth for a
    // schema's on-disk file path.
    static async _testHook_resolveSchemaFilePath( { schemaRef } ) {
        return await SchemaSource.resolveSchemaFilePath( { schemaRef } )
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



    // Memo 152 / PRD-018 (D-06) — #loadOneLibrary moved to core LibraryLoader.#loadOneFromBases;
    // the requiredLibraries block of #resolveHandlers now delegates to LibraryLoader.resolveExternal.


    // Memo 152 / PRD-019 (D-08 foundation cluster "handler-libraries") — #resolveLibraryBase
    // and #cliVersion moved to src/lib/CliBase.mjs (CliBase.resolveBase / CliBase.cliVersion),
    // decoupling version() and doctor() from the monolith.


    // Memo 152 / PRD-019 (D-08) — the allowed-libraries base + installed-list helpers
    // moved to src/commands/AllowlistCommand.mjs (public static, shared with #resolveHandlers
    // and doctor). Call sites here delegate to AllowlistCommand.resolveAllowedLibrariesBase().


    // Memo 152 / PRD-019 (D-08) — the shared-list helpers findListsDir /
    // resolveSharedListsForSchema moved to src/commands/ListsCommand.mjs as public
    // statics; the handler/call/serve call sites here call ListsCommand directly.


    // Memo 152 / PRD-012 (B-04) — prepareServerTool is now the public core v4 API
    // (FlowMCP.prepareServerTool), including the core v4 ZodBuilder (typed defaults).
    // The former CLI copy + local ZodBuilder fork are deleted (drift fix, B-03).


    // Memo 152 / PRD-019 (D-08 foundation cluster "schema-loading-bridge") — #loadSchema /
    // #loadSchemasFromPath / #resolveAllSchemas / #loadAllSchemas / #tryLoadSingleSchema moved
    // to src/lib/SchemaLoaderBridge.mjs as public statics (SchemaLoaderBridge.loadSchema etc.).
    // Call sites here call the bridge directly; the bridge owns the core SchemaLoader delegation.


    // Memo 152 / PRD-019 (D-08) — parseEnvFile / buildServerParams moved to
    // src/lib/EnvResolver.mjs (public statics). See the delegation note above.


    static async #resolveActiveToolRefs( { cwd } ) {
        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FsUtils.readJson( { filePath: localConfigPath } )

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





    // Memo 149 Strang D (F5=A) — `flowmcp --version` / `flowmcp version`. The version
    // stamp that ends the "is an old CLI running?" guessing, without bloating every
    // response.
    static async version() {
        const { name, version } = CliBase.cliVersion()
        const result = { 'status': true, name, version }

        return { result }
    }


    // Memo 152 / PRD-019 (D-08 cluster "doctor") — `flowmcp doctor`, #doctorResult and
    // printDoctorSummary moved to src/commands/DoctorCommand.mjs. These stay as public
    // delegations because index.mjs and the doctor tests call FlowMcpCli.doctor /
    // FlowMcpCli.printDoctorSummary directly.
    static async doctor( { cwd } ) {
        return DoctorCommand.run( { cwd } )
    }


    static printDoctorSummary( { result, json } ) {
        return DoctorCommand.printSummary( { result, json } )
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



    // Memo 152 / PRD-019 (D-08) — #findSchemaFiles moved to FsUtils.findSchemaFiles
    // (shared by the validate/schema-check and resource-migrate paths).


    // Memo 152 / PRD-012 (B-07) — v4 is a hard dependency of the CLI: the v4 core
    // surface is statically imported (no dynamic import, no CLI-022 degradation).
    // Delegates to ModuleRegistry (PRD-017/D-02), which owns the v4/grading
    // injection seam; the __testInject* hooks route through ModuleRegistry.inject.
    static #v4Module() {
        return ModuleRegistry.getV4()
    }


    // Lazy-import for the grading module's public surface (flowmcp-grading/src/index.mjs).
    // Pinned in package.json to a published commit:
    //   "flowmcp-grading": "github:FlowMCP/flowmcp-grading#e911958e91b75799b6efd78c99ebdbe5da103288"
    // (For local cross-repo development, swap to "file:../flowmcp-grading".)
    static async #loadGradingModule() {
        try {
            return await ModuleRegistry.getGrading()
        } catch( err ) {
            CliOutput.emitCoded( { 'code': 'GRD-001', 'location': 'loadGradingModule: flowmcp-grading import failed', err } )
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


    static #v4ConsistencyErrors( { main, toolCount } ) {
        const errors = []
        const routeKeys = main && main[ 'routes' ] ? Object.keys( main[ 'routes' ] ) : []
        if( routeKeys.length > 0 ) {
            errors.push( 'VERSION-001: a 4.x schema must not declare populated "routes" (use "tools")' )
        }
        const skills = main && Array.isArray( main[ 'skills' ] ) ? main[ 'skills' ] : []
        if( skills.length > 0 ) {
            errors.push( 'VERSION-002: a 4.x schema must not declare "skills"' )
        }
        if( toolCount > 8 ) {
            errors.push( `VERSION-003: a 4.x schema declares ${toolCount} tools; the per-file cap is 8 (split the namespace)` )
        }

        return errors
    }


    static #validateSingleSchema( { main, file, v4 } ) {
        const namespace = main && main[ 'namespace' ] ? main[ 'namespace' ] : 'unknown'
        const toolCount = Object.keys( ( main && ( main[ 'tools' ] || main[ 'routes' ] ) ) || {} ).length
        const resourceCount = Object.keys( ( main && main[ 'resources' ] ) || {} ).length
        const skillCount = ( ( main && main[ 'skills' ] ) || [] ).length
        const version = main && main[ 'version' ] ? String( main[ 'version' ] ) : ''
        const isV4 = version.startsWith( '4.' )

        const sqliteGtfsErrors = FlowMcpCli.#runSqliteGtfsResourceChecks( { main } )

        // Memo 152 / PRD-012 (B-06) — v4-only: a schema that does not declare a 4.x
        // version is rejected fail-loud (no silent normalization, no v2 validateMain
        // fallback). Convert a legacy schema explicitly with `flowmcp migrate`.
        if( !isV4 ) {
            const combinedMessages = [ `VAL-009: schema version "${version || 'missing'}" is not v4 — this CLI validates v4-only schemas (version 4.x). Convert a legacy schema with \`flowmcp migrate\`.`, ...sqliteGtfsErrors.map( ( e ) => `${e.code}: ${e.message} (${e.path})` ) ]
            return { file, namespace, 'status': false, 'messages': combinedMessages, 'tools': toolCount, 'resources': resourceCount, 'skills': skillCount }
        }

        try {
            // Memo 119 Kap 3 — version-consistency gate. A schema declaring a 4.x
            // version must be SHAPED like v4: no populated v2 `routes`, no populated
            // v3 `skills`, and at most 8 tools per file. Because v4 reuses the v2
            // transport, a mis-declared schema otherwise only fails at runtime.
            const consistencyErrors = FlowMcpCli.#v4ConsistencyErrors( { main, toolCount } )
            const enriched = v4[ 'MetaGenerator' ]
                ? FlowMcpCli.#enrichV4WithRuntimeMeta( { main, 'MetaGenerator': v4[ 'MetaGenerator' ] } )
                : main
            const { status, messages, warnings } = v4[ 'MainValidator' ].validate( { 'main': enriched } )
            const combinedMessages = [ ...consistencyErrors, ...( messages || [] ), ...sqliteGtfsErrors.map( ( e ) => `${e.code}: ${e.message} (${e.path})` ) ]
            const combinedStatus = status && sqliteGtfsErrors.length === 0 && consistencyErrors.length === 0
            return { file, namespace, 'status': combinedStatus, 'messages': combinedMessages, warnings, 'tools': toolCount, 'resources': resourceCount, 'skills': skillCount }
        } catch( err ) {
            const combinedMessages = [ `SKL-003 validateSingleSchema: ${err.message}`, ...sqliteGtfsErrors.map( ( e ) => `${e.code}: ${e.message} (${e.path})` ) ]
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






    // Retained for importAgent (G-11 stranded command) until its removal in
    // PRD-020. Dataset r4 marked this init-only, but importAgent also calls it.
    static #getRegistryPath( { globalConfig } ) {
        const sources = globalConfig[ 'sources' ] || {}
        const sourceNames = Object.keys( sources )

        if( sourceNames.length === 0 ) {
            return null
        }

        const firstSource = sourceNames[ 0 ]
        const registryPath = join( ConfigStore.schemasDir(), firstSource, '_registry.json' )

        return registryPath
    }


    static async importAgent( { agentName, cwd } ) {
        const { initialized, error, fix } = await ConfigStore.requireInit()

        if( !initialized ) {
            return { result: CliOutput.error( { error, fix } ) }
        }

        if( !agentName ) {
            return { result: CliOutput.error( { error: 'Missing agent name', fix: 'flowmcp import-agent <agent-name>' } ) }
        }

        const { globalConfig } = await ConfigStore.loadGlobalConfig()
        const registryPath = FlowMcpCli.#getRegistryPath( { globalConfig } )
        const registryData = await FsUtils.readJsonFile( { filePath: registryPath } )

        if( !registryData ) {
            return { result: CliOutput.error( { error: 'No registry found', fix: 'Run "flowmcp import-registry <url>" first' } ) }
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

            return { result: CliOutput.error( { error: `Agent "${agentName}" not found in registry`, fix: `Available agents: ${availableNames || 'none'}` } ) }
        }

        const manifestPath = agentEntry[ 'manifest' ]
        const catalogDir = ConfigStore.getCatalogDir( { globalConfig } )
        const fullManifestPath = `${catalogDir}/${manifestPath}`

        let manifest = null

        try {
            manifest = await FsUtils.readJsonFile( { filePath: fullManifestPath } )
        } catch( err ) {
            return { result: CliOutput.error( { error: `IMP-003 importAgent: Cannot read manifest: ${err.message}`, fix: `Check file exists: ${fullManifestPath}` } ) }
        }

        if( !manifest ) {
            return { result: CliOutput.error( { error: `Manifest not found at ${fullManifestPath}`, fix: 'Re-run "flowmcp import-registry <url>" to download' } ) }
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
        return CatalogCommand.validateCatalog( { catalogDir, cwd } )
    }


    // Memo 152 / PRD-019 (D-08) — delegation facade (F12=A). The `flowmcp dev resource`
    // commands live in src/commands/ResourceCommand.mjs. validationResourceCreate is
    // called directly by tests, so its delegation stays.
    static async resourceCreate( { schemaPath, cwd, basis = 'flowmcp', autoConfirm = false } ) {
        return await ResourceCommand.resourceCreate( { schemaPath, cwd, basis, autoConfirm } )
    }


    static validationResourceCreate( { schemaPath } ) {
        return ResourceCommand.validationResourceCreate( { schemaPath } )
    }


    static async resourceMigrate( { cwd, basis = 'flowmcp', dryRun = false, autoConfirm = false } ) {
        return await ResourceCommand.resourceMigrate( { cwd, basis, dryRun, autoConfirm } )
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
            // Memo 149 Strang B — single-source helper (was: join( #schemasDir(), matchedFile )).
            const { filePath: schemaFilePath } = await SchemaSource.resolveSchemaFilePath( { schemaRef: matchedFile } )
            const { resourceHandlerMap } = await HandlerResolver.resolve( {
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
            const result = CliOutput.error( {
                'error': `SQL-020 callResourceQuery: Resource query failed: ${err.message}`,
                'fix': 'Check that the database file exists and is accessible.'
            } )

            return { result }
        }
    }


    // Memo 152 / PRD-018 (D-07) — the spec-id grammar is now a core v4 Spec
    // concern (IdResolver.parseSpecId). This CLI method is a thin delegation kept
    // as the internal call surface + the __testOnly_parseSpecId hook (Hook removal
    // is PRD-020/D-11). Output is byte-identical to the former CLI implementation.
    static #parseSpecId( { specId } ) {
        return IdResolver.parseSpecId( { specId } )
    }


    // PRD-009 — shared add-or-collide for ALL four primitives (tools/resources/
    // prompts/skills). Before writing a spec-id, check whether it already exists; if
    // so, record a collision instead of silently overwriting (last-wins) / pushing a
    // first-wins duplicate. The collision entry carries `files` AND `sources` so the
    // visible warning can suggest the qualified "<source>:<spec-id>" fix (PRD-008).
    // Mutates `map` and `collisions`.
    // Memo 152 / PRD-018 (D-07) — the catalog build primitives moved to core v4
    // (CatalogIndex). These CLI methods stay as thin delegations for the remaining
    // internal callers + the __testOnly_* hooks (Hook removal is PRD-020/D-11).
    static #trackPrimitive( { map, collisions, specId, file, source, extra } ) {
        return CatalogIndex.trackPrimitive( { map, collisions, specId, file, source, extra } )
    }


    // PRD-009 — render the collisions[] list (built by #trackPrimitive over all four
    // primitives) into visible, non-blocking warnings. Each warning names the
    // colliding spec-id, the involved sources and the copyable qualified fix
    // "<source>:<spec-id>" (PRD-008). One bundled line per spec-id (no per-call
    // noise). English, no risk jargon. Returns [] when there is no collision.
    static #formatCollisionWarnings( { collisions } ) {
        return CatalogIndex.formatCollisionWarnings( { collisions } )
    }


    // Memo 152 / PRD-019 (D-08 foundation cluster "namespace-index") — build + get
    // orchestration moved to src/lib/NamespaceIndex.mjs (build/get/tryGet). getNamespaceIndex
    // stays public here as a delegation because tests call FlowMcpCli.getNamespaceIndex and
    // mcp-geo-app reads the on-disk file (Memo 128, frozen format, D-07 byte-stable).
    static async getNamespaceIndex( { cwd, forceRebuild = false } ) {
        return NamespaceIndex.get( { cwd, forceRebuild } )
    }


    // Memo 128 Kap 10 — Lazy Schema-Resolution for a tool Spec-ID call.
    // Consults the prebuilt namespace-index and imports ONLY the one schema file
    // that owns "<namespace>/tool/<routeName>", instead of importing all ~549
    // schemas via #resolveAllSchemas(). Returns a single-element schemas array in
    // the exact shape #resolveAllSchemas() produces, or { schemas: null } on a
    // miss (caller then falls back to the full scan). The wire-name re-verify
    // happens in callTool's match loop, so a stale index can never mis-resolve.
    static async #resolveSchemaByIndex( { namespace, routeName, sourceFilter, cwd } ) {
        const indexResult = await NamespaceIndex.tryGet( { cwd } )
        if( indexResult === null ) {
            return { 'schemas': null }
        }

        const { index } = indexResult
        const tools = index && index[ 'tools' ] ? index[ 'tools' ] : {}
        const specId = `${namespace}/tool/${routeName}`
        const entry = tools[ specId ]

        if( !entry || !entry[ 'file' ] || !entry[ 'source' ] ) {
            return { 'schemas': null }
        }

        // A "<source>:" prefix must hit exactly that source — never first-wins.
        if( ( sourceFilter !== null && sourceFilter !== undefined ) && entry[ 'source' ] !== sourceFilter ) {
            return { 'schemas': null }
        }

        const schemaRef = `${entry[ 'source' ]}/${entry[ 'file' ]}`
        const loaded = await SchemaLoaderBridge.tryLoadSingleSchema( { schemaRef } )
        if( loaded === null ) {
            return { 'schemas': null }
        }

        const { main, handlersFn } = loaded
        if( !main ) {
            return { 'schemas': null }
        }

        const schemas = [ {
            main,
            handlersFn,
            'file': schemaRef,
            'source': entry[ 'source' ],
            'requiredServerParams': main[ 'requiredServerParams' ] || []
        } ]

        return { schemas }
    }


    // Memo 099 Kap 5 — full-scan resolution against ALL configured schemaFolders[].
    // Memo 128 Kap 10 — extracted so callTool can use it as the lazy-resolution
    // fallback (lazy miss / bare name / stale index). Returns either an
    // errorResult (config error / unknown source) or the source-filtered schemas.
    static async #resolveSchemasForCall( { sourceFilter } ) {
        const { schemas: allSchemas, error: resolveError, fix: resolveFix } = await SchemaLoaderBridge.resolveAllSchemas()

        // PRD-008 — a duplicate schemaFolders[] name is a hard config error.
        if( resolveError !== null && resolveError !== undefined ) {
            const errorResult = CliOutput.error( { 'error': resolveError, 'fix': resolveFix } )

            return { 'resolvedSchemas': [], errorResult }
        }

        // PRD-008 — when a "<source>:" prefix is given, restrict resolution to that
        // source so the qualified call hits exactly that folder (no first-wins).
        const resolvedSchemas = sourceFilter === null || sourceFilter === undefined
            ? allSchemas
            : allSchemas.filter( ( entry ) => entry[ 'source' ] === sourceFilter )

        if( ( sourceFilter !== null && sourceFilter !== undefined ) && resolvedSchemas.length === 0 ) {
            const errorResult = CliOutput.error( {
                'error': `No schemaFolders[] source named "${sourceFilter}" provides the requested tool.`,
                'fix': `Check the source name (run "${appConfig[ 'cliCommand' ]} call list-tools" to see each tool's "source"), or drop the "<source>:" prefix.`
            } )

            return { 'resolvedSchemas': [], errorResult }
        }

        return { resolvedSchemas, 'errorResult': null }
    }


    // Memo 128 Kap 10 — wire-name match over a schema list (first-wins). Extracted
    // so callTool can run it twice: once over the lazy single-file result, and
    // again over the full scan if the lazy result drifted from the index.
    static #matchToolInSchemas( { resolvedSchemas, resolvedToolName } ) {
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
                            const { toolName: candidateName } = FlowMCP.buildToolName( { routeName, namespace } )

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

        return { matchedMain, matchedHandlersFn, matchedFile, matchedToolName, matchedRouteName }
    }


    static __testOnly_parseSpecId( { specId } ) {
        return FlowMcpCli.#parseSpecId( { specId } )
    }


    static __testOnly_buildToolName( { routeName, namespace, source = null, disambiguate = false } ) {
        return FlowMCP.buildToolName( { routeName, namespace, source, disambiguate } )
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
                const { toolName: baseName } = FlowMCP.buildToolName( { routeName, namespace } )
                const decided = FlowMcpCli.#disambiguateToolName( { baseName, routeName, namespace, source, registeredToolNames } )

                return { baseName, 'finalName': decided.finalName, 'skip': decided.skip, 'note': decided.note }
            } )

        return { plan, 'registeredNames': [ ...registeredToolNames ] }
    }


    static __testOnly_formatCollisions( { collisions } ) {
        return FlowMcpCli.#formatCollisionWarnings( { collisions } )
    }


    static async __testOnly_buildIndex( { schemas } ) {
        return CatalogIndex.build( { schemas } )
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

                        const { schemaRef, routeName } = FlowMcpCli.#parseToolRef( { 'toolRef': toolRef } )
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


    // Memo 152 / PRD-019 (D-08) — delegation facade (F12=A). The `flowmcp allowlist`
    // command lives in src/commands/AllowlistCommand.mjs.
    static async allowlist( { cwd, action, library } ) {
        return await AllowlistCommand.allowlist( { cwd, action, library } )
    }


    // Memo 152 / PRD-019 (D-08) — delegation facade (F12=A). The `flowmcp selection`
    // commands live in src/commands/SelectionCommand.mjs.
    static async selectionList( { cwd } ) {
        return await SelectionCommand.selectionList( { cwd } )
    }


    static async selectionShow( { cwd, name } ) {
        return await SelectionCommand.selectionShow( { cwd, name } )
    }


    static async selectionValidate( { cwd, path: selectionPath } ) {
        return await SelectionCommand.selectionValidate( { cwd, 'path': selectionPath } )
    }


    static __testInjectV4( { v4 } ) {
        ModuleRegistry.inject( { v4 } )
    }


    static __testInjectGrading( { grading } ) {
        ModuleRegistry.inject( { grading } )
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
        const { data: globalConfig } = await FsUtils.readJson( { 'filePath': join( globalConfigDir, 'config.json' ) } )
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
        const { data: globalConfig } = await FsUtils.readJson( { 'filePath': join( globalConfigDir, 'config.json' ) } )
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
        const globalConfigPath = ConfigStore.globalConfigPath()
        const { data: existingConfig } = await FsUtils.readJson( { 'filePath': globalConfigPath } )
        if( existingConfig === null ) {
            return { 'result': CliOutput.error( { 'error': `Global config not found at ${globalConfigPath}.`, 'fix': `Run "${appConfig[ 'cliCommand' ]} init" first to create it.` } ) }
        }

        const wantsSet = setDataDir !== null || setExportDir !== null

        if( setDataDir !== null && ( typeof setDataDir !== 'string' || setDataDir.length === 0 ) ) {
            return { 'result': CliOutput.error( { 'error': '--set-data-dir requires a non-empty path.', 'fix': `Usage: ${appConfig[ 'cliCommand' ]} grading config --set-data-dir <path>` } ) }
        }
        if( setExportDir !== null && ( typeof setExportDir !== 'string' || setExportDir.length === 0 ) ) {
            return { 'result': CliOutput.error( { 'error': '--set-export-dir requires a non-empty path.', 'fix': `Usage: ${appConfig[ 'cliCommand' ]} grading config --set-export-dir <path>` } ) }
        }

        if( wantsSet === true ) {
            const nextConfig = Object.keys( existingConfig )
                .reduce( ( acc, key ) => {
                    acc[ key ] = existingConfig[ key ]

                    return acc
                }, {} )
            if( setDataDir !== null ) { nextConfig[ 'gradingDataDir' ] = setDataDir }
            if( setExportDir !== null ) { nextConfig[ 'gradingExportDir' ] = setExportDir }

            await ConfigStore.writeGlobalConfig( { 'config': nextConfig } )
        }

        const { data: currentConfig } = await FsUtils.readJson( { 'filePath': globalConfigPath } )
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
        const { data: globalConfig } = await FsUtils.readJson( { 'filePath': join( globalConfigDir, 'config.json' ) } )
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
        const { data: index } = await FsUtils.readJson( { 'filePath': indexPath } )
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
        const { data: index } = await FsUtils.readJson( { 'filePath': indexPath } )
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
            return { 'result': CliOutput.error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }

        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': CliOutput.error( { 'error': 'Missing export target.', 'fix': 'Usage: flowmcp grading export <namespace|selection>' } ) }
        }

        const gradingDataRoot = await FlowMcpCli.#gradingDataRoot( { cwd, gradingDataDir } )
        const detected = await FlowMcpCli.#resolveGradingTarget( { cwd, gradingDataRoot, target } )
        if( detected.status !== true ) {
            return { 'result': CliOutput.error( { 'error': detected.error, 'fix': detected.fix } ) }
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


    static async gradingRun( { cwd, target, phase, runId = null, emitPrompts, consumeScores, onConflict, memberSource, gradingDataDir, gradingExportDir, maxIterations, maxTurns = null, withKeys, dryRun = false, quiet = false, json } ) {
        const grading = await FlowMcpCli.#loadGradingModule()
        if( grading === null ) {
            return { 'result': CliOutput.error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }

        // NO SILENT DEFAULT: maxIterations is opt-in. Absent → 1 (single pass, the
        // documented default). A supplied value must parse to a positive integer.
        const { maxIterations: maxIterationsResolved, error: maxIterationsError } = FlowMcpCli.#resolveMaxIterations( { maxIterations } )
        if( maxIterationsError !== null ) {
            return { 'result': CliOutput.error( { 'error': maxIterationsError, 'fix': 'Pass --max-iterations as a positive integer (default 1).' } ) }
        }

        // PRD-3.5 — the Goal-Block turn bound is configurable (was hardcoded 25). NO
        // SILENT DEFAULT: absent -> 25 (the documented default); a supplied value must
        // parse to a positive integer.
        const { maxTurns: maxTurnsResolved, error: maxTurnsError } = FlowMcpCli.#resolveMaxTurns( { maxTurns } )
        if( maxTurnsError !== null ) {
            return { 'result': CliOutput.error( { 'error': maxTurnsError, 'fix': 'Pass --max-turns as a positive integer (default 25).' } ) }
        }

        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': CliOutput.error( { 'error': 'Missing grading target.', 'fix': `Usage: ${appConfig[ 'cliCommand' ]} grading non-deterministic <namespace|selection> --emit-prompts | --consume-scores <path>` } ) }
        }

        // NO SILENT DEFAULT for the mode — exactly one of emit/consume.
        if( emitPrompts !== true && ( consumeScores === null || consumeScores === undefined ) ) {
            return { 'result': CliOutput.error( { 'error': 'Mode required: --emit-prompts or --consume-scores <path>.', 'fix': 'Pick exactly one mode (2-phase grading, no default mode).' } ) }
        }
        if( emitPrompts === true && consumeScores !== null && consumeScores !== undefined ) {
            return { 'result': CliOutput.error( { 'error': 'Modes are mutually exclusive: pass either --emit-prompts or --consume-scores, not both.', 'fix': `Run --emit-prompts first, then --consume-scores in a separate call.` } ) }
        }

        // NO SILENT DEFAULT for the conflict policy — explicit allowlist.
        const conflict = onConflict === null || onConflict === undefined ? 'skip' : onConflict
        const validConflicts = [ 'abort', 'skip', 'overwrite' ]
        if( validConflicts.includes( conflict ) === false ) {
            return { 'result': CliOutput.error( { 'error': `Invalid --on-conflict value: ${conflict}`, 'fix': `Use one of: ${validConflicts.join( ', ' )}.` } ) }
        }

        // PRD-004 — resolve the --phase flag into a multi-area selector (3 modes,
        // no silent default). A bad token aborts before any emit (no partial emit).
        const areaSelector = FlowMcpCli.#resolveAreaSelector( { phase, grading } )
        if( areaSelector.status === false ) {
            return { 'result': CliOutput.error( { 'error': areaSelector.error, 'fix': 'Pass --phase as a comma-separated set of known areas, or omit it for all applicable areas.' } ) }
        }

        const gradingDataRoot = await FlowMcpCli.#gradingDataRoot( { cwd, gradingDataDir } )

        // F29 flow detection.
        const detected = await FlowMcpCli.#resolveGradingTarget( { cwd, gradingDataRoot, target } )
        if( detected.status !== true ) {
            return { 'result': CliOutput.error( { 'error': detected.error, 'fix': detected.fix } ) }
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

            return FlowMcpCli.#gradingEmitPrompts( { cwd, grading, gradingDataRoot, 'flow': detected.flow, 'tier': detected.tier, 'maxGrade': detected.maxGrade, 'targetDir': detected.targetDir, target, 'scopeName': detected.scopeName, runId, areaSelector, conflict, 'maxIterations': maxIterationsResolved, 'maxTurns': maxTurnsResolved, useKeys, dryRun, quiet, 'dependencyChain': deps.chain } )
        }

        return FlowMcpCli.#gradingConsumeScores( { cwd, grading, gradingDataRoot, 'flow': detected.flow, 'targetDir': detected.targetDir, target, 'scopeName': detected.scopeName, consumeScores, conflict, gradingDataDir, gradingExportDir, dryRun, 'dependencyChain': deps.chain } )
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
    static async gradingDeterministic( { cwd, target, gradingDataDir, gradingExportDir = null, withKeys, only, dryRun = false, force = false, quiet = false, json, skipRollup = false, throttleMs = 0 } ) {
        const grading = await FlowMcpCli.#loadGradingModule()
        if( grading === null || grading[ 'DataPretest' ] === undefined ) {
            return { 'result': CliOutput.error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }

        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': CliOutput.error( { 'error': 'Missing grading target.', 'fix': 'Usage: flowmcp grading deterministic <namespace> | <namespace>/<schema> | <namespace>/tool/<name>' } ) }
        }

        // PRD-002 — validate the --only filter once (shared with `dev test`'s old
        // path). An unknown value is a HARD error (no silent skip).
        const { filter: onlyFilter, error: onlyError } = FlowMcpCli.#validateOnlyFilter( { only } )
        if( onlyError !== null ) {
            return { 'result': CliOutput.error( { 'error': onlyError } ) }
        }

        // Parse the Spec-ID. PRD-001 only accepts a schema-ID (1 slash) or a
        // tool-ID (2 slashes, type === 'tool'). Resource/prompt/skill/selection
        // Spec-IDs are out of scope here (no silent acceptance).
        const parsed = FlowMcpCli.#parseSpecId( { 'specId': target } )
        if( parsed.valid !== true ) {
            return { 'result': CliOutput.error( { 'error': parsed.error, 'fix': 'Use a namespace "<namespace>", a schema-ID "<namespace>/<schema>", or a tool-ID "<namespace>/tool/<name>".' } ) }
        }
        // Memo 107 PRD-004 — bare namespace runs the deterministic grade over every
        // schema of the namespace ("one command per namespace") and produces ONE
        // namespace rollup (index.json) + Provider-Proof (grade.json). Delegated so
        // the single-schema path below stays unchanged.
        if( parsed.type === 'namespace' ) {
            return FlowMcpCli.#gradingDeterministicNamespace( { cwd, 'namespace': parsed.namespace, gradingDataDir, gradingExportDir, withKeys, only, dryRun, force, quiet, json, throttleMs } )
        }
        if( parsed.type !== 'schema' && parsed.type !== 'tool' && parsed.type !== 'test' ) {
            return { 'result': CliOutput.error( { 'error': `Spec-ID type "${parsed.type}" is not supported by grading deterministic (only namespace, schema-ID, tool-ID or per-test).`, 'fix': 'Use "<namespace>", "<namespace>/<schema>", "<namespace>/tool/<name>" or "<namespace>/tool/<name>/tests/<N>".' } ) }
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
            return { 'result': CliOutput.error( { 'error': resolvedSchemas.error, 'fix': resolvedSchemas.fix } ) }
        }
        const liveSchemas = resolvedSchemas.schemas

        // Determine the addressed schema. A schema-ID names the folder directly; a
        // tool-ID needs a Tool->Schema lookup. No silent first-wins: an ambiguous
        // tool match is surfaced with a visible note.
        const resolved = FlowMcpCli.#resolveDeterministicSchemaLive( { liveSchemas, parsed, namespace } )
        if( resolved.status === false ) {
            return { 'result': CliOutput.error( { 'error': resolved.error, 'fix': resolved.fix } ) }
        }
        const schemaName = resolved.schemaName
        const sourcePath = resolved.sourcePath
        const main = resolved.main
        const handlersFn = resolved.handlersFn

        // PA-5: key-injection opt-in (default OFF) — same gate as emit-prompts.
        const { useKeys } = await FlowMcpCli.#gradingUseKeys( { withKeys } )

        // Step 1 — structural validation (Memo REV-08 Kap. 1: structural validate
        // FIRST, then the deterministic data-pretest = "the validation").
        const v4 = FlowMcpCli.#v4Module()
        const validate = FlowMcpCli.#validateSingleSchema( { main, 'file': basename( sourcePath ), v4 } )

        // Step 2 — the deterministic data-pretest (status === true AND #hasData),
        // a strict superset of `dev test`. Same Phase-0/1 wiring as emit-prompts:
        // resolveEnv -> buildServerParams -> resolveSharedLists -> DataPretest.run,
        // but WITHOUT the prompt/goal emit afterwards.
        const requiredServerParams = Array.isArray( main[ 'requiredServerParams' ] ) ? main[ 'requiredServerParams' ] : []
        const serverParams = useKeys === true
            ? EnvResolver.buildServerParams( { 'envObject': ( await EnvResolver.resolveEnv( { cwd } ) ).envObject, requiredServerParams } ).serverParams
            : {}
        const { sharedLists } = await ListsCommand.resolveSharedListsForSchema( { main, 'filePath': sourcePath } )

        // PRD-012 — --no-save (dryRun) runs the pretest in full but persists NOTHING
        // to the island (no summary.json / test-N.json). The deterministic path has
        // no Stage-3 writes, so dryRun here only gates the DataPretest persist.
        // PRD-4.1 — tick the slow part (live/cached pretest) to stderr.
        CliOutput.emitProgress( { quiet, 'message': `${target}: structural validate + data pretest${force === true ? ' (--force re-fetch)' : ''}...` } )

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
            force,
            throttleMs
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
                return { 'result': CliOutput.error( { 'error': `Test index ${testIndex} is out of range for tool "${toolFilter}" (${toolResults.length} recorded test(s)).`, 'fix': `Address a test between 1 and ${toolResults.length}, or run the whole tool "${namespace}/tool/${toolFilter}".` } ) }
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
        CliOutput.emitProgress( { quiet, 'message': `${target}: ${status === true ? 'PASS' : 'FAIL'} (${stamp})` } )

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
        // Memo 112 P6.2 — persist the schemaHash with the deterministic gradings so a
        // later `grading plan` can detect staleness (live hash != stored hash). The
        // Mapper already writes entry.schemaHash when given one (DeterministicAreaMapper);
        // it was simply never fed. A null hash (uncanonicalizable schema) is omitted.
        const HashGenerator = grading[ 'HashGenerator' ]
        const computedHash = HashGenerator !== undefined && HashGenerator !== null
            ? HashGenerator.computeSchemaHash( { 'schema': main } ).hash
            : null
        const schemaHash = typeof computedHash === 'string' && computedHash.length > 0 ? computedHash : undefined
        const mapped = Mapper.mapSchema( { namespace, 'schemaId': schemaName, main, validate, pretest, recordedAt, schemaHash } )
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
            return { 'status': false, 'error': `CLI-025 deterministicRollup: Index rebuild threw: ${rebuildError.message}`, 'fix': 'Resolve the island state above and re-run.' }
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
    static async #gradingDeterministicNamespace( { cwd, namespace, gradingDataDir, gradingExportDir, withKeys, only, dryRun, force = false, quiet = false, json, throttleMs = 0 } ) {
        const resolved = await FlowMcpCli.#resolveSchemasForTarget( { namespace } )
        if( resolved.status === false ) {
            return { 'result': CliOutput.error( { 'error': resolved.error, 'fix': resolved.fix } ) }
        }

        const total = resolved.schemas.length
        CliOutput.emitProgress( { quiet, 'message': `namespace ${namespace}: ${total} schema(s) to grade deterministically` } )

        const perSchema = []
        await resolved.schemas
            .reduce( ( promise, schema, index ) => promise.then( async () => {
                CliOutput.emitProgress( { quiet, 'message': `[${index + 1}/${total}] ${schema.schemaName}` } )
                const sub = await FlowMcpCli.gradingDeterministic( {
                    cwd, 'target': `${namespace}/${schema.schemaName}`, gradingDataDir, gradingExportDir, withKeys, only, dryRun, force, 'quiet': true, json, 'skipRollup': true, throttleMs
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
            return { 'result': CliOutput.error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }
        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': CliOutput.error( { 'error': 'Missing reload target.', 'fix': 'Usage: flowmcp grading reload <namespace> | <namespace>/<schema>' } ) }
        }

        const parsed = FlowMcpCli.#parseSpecId( { 'specId': target } )
        if( parsed.valid !== true || ( parsed.type !== 'namespace' && parsed.type !== 'schema' ) ) {
            return { 'result': CliOutput.error( { 'error': `grading reload accepts a namespace or a schema-ID, got "${target}".`, 'fix': 'Use "<namespace>" or "<namespace>/<schema>".' } ) }
        }

        const namespace = parsed.namespace
        const gradingDataRoot = await FlowMcpCli.#gradingDataRoot( { cwd, gradingDataDir } )
        const resolvedSchemas = await FlowMcpCli.#resolveSchemasForTarget( { namespace } )
        if( resolvedSchemas.status === false ) {
            return { 'result': CliOutput.error( { 'error': resolvedSchemas.error, 'fix': resolvedSchemas.fix } ) }
        }

        const targetSchemas = parsed.type === 'schema'
            ? resolvedSchemas.schemas.filter( ( s ) => s.schemaName === parsed.name )
            : resolvedSchemas.schemas
        if( targetSchemas.length === 0 ) {
            return { 'result': CliOutput.error( { 'error': `Schema "${target}" not found in schemaFolders[].`, 'fix': 'Address an existing schema or namespace.' } ) }
        }

        const { useKeys } = await FlowMcpCli.#gradingUseKeys( { withKeys } )
        const envObject = useKeys === true ? ( await EnvResolver.resolveEnv( { cwd } ) ).envObject : {}

        const perSchema = []
        const reloadTotal = targetSchemas.length
        CliOutput.emitProgress( { quiet, 'message': `reload ${target}: re-fetch ${reloadTotal} schema(s)...` } )
        await targetSchemas
            .reduce( ( promise, schema, index ) => promise.then( async () => {
                CliOutput.emitProgress( { quiet, 'message': `[${index + 1}/${reloadTotal}] reload ${schema.schemaName}` } )
                const requiredServerParams = Array.isArray( schema.main[ 'requiredServerParams' ] ) ? schema.main[ 'requiredServerParams' ] : []
                const serverParams = useKeys === true
                    ? EnvResolver.buildServerParams( { envObject, requiredServerParams } ).serverParams
                    : {}
                const { sharedLists } = await ListsCommand.resolveSharedListsForSchema( { 'main': schema.main, 'filePath': schema.sourcePath } )
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
        const { handlerMap, resourceHandlerMap } = await HandlerResolver.resolve( { main, handlersFn, 'filePath': schemaSource } )

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
            typedResults = [ { 'primitive': 'tool', 'name': '*', 'status': false, 'error': `CLI-026 deterministicPrimitiveView: ${err.message}` } ]
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
    static async #composeGradingAreas( { grading, flow, persona = null, personaAreas = null, substitutions = null } ) {
        const AreaPromptLoader = grading[ 'AreaPromptLoader' ]
        if( AreaPromptLoader === undefined || AreaPromptLoader === null ) {
            throw new Error( 'AreaPromptLoader unavailable from flowmcp-grading — update the dependency.' )
        }
        const { promptsRoot } = AreaPromptLoader.getPromptsRoot()
        // PRD-3.2: pass the substitution context so the composed prompts carry real
        // schema paths + tool/namespace names (no torso). A null context keeps the
        // legacy placeholder behaviour (back-compat for callers without schema data).
        // Memo 141: pass the resolved Schema-Persona so the persona-required areas
        // (about-namespace, namespace-skills) are COMPOSED here instead of deferred.
        // A null persona keeps the legacy defer behaviour (Selection/Task-B flow).
        // personaAreas is the composition-time applicability allow-list (about-namespace
        // corpus-wide; namespace-skills only when the namespace carries skills).
        const { areas } = await AreaPromptLoader.loadAllAreas( { promptsRoot, flow, persona, personaAreas, substitutions } )

        return { areas }
    }


    // PRD-3.2 — build the emit substitution context for a provider. Paths are
    // REPO-RELATIVE (git-security: never leak an absolute path into the emitted
    // artifact). The single-test/tools-aggregate areas are bundled across the
    // namespace, so {{TOOL_NAME}} resolves to the joined declared tool list and
    // {{SCHEMA_NAME}} to the schema name (single schema) or the namespace.
    //
    // Memo 141 — the substitution context additionally carries the persona-required
    // Schema-Area inputs: the resolved base persona + lens (name + repo-relative file,
    // filling the four persona NAME tokens and the {{personaPath}}/{{lensPath}} file
    // map) plus the per-namespace {{aboutPath}}, {{namespacePath}}, {{skillPath}} and
    // {{domainKnowledgePath}}. Composition-time applicability (which persona areas
    // actually compose) is the caller's personaAreas allow-list.
    static #buildEmitSubstitutions( { cwd, grading, namespace, liveSchemas, pretests } ) {
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

        // Memo 141 — per-namespace persona + resource paths. The namespace source dir
        // is the dirname of the first live schema's sourcePath; the About page lives at
        // <nsDir>/resources/about/<ns>-about.md (Memo 137 convention). domainKnowledge
        // for a namespace-skill review is its About page (the canonical namespace
        // description). The skill ({{SKILL_NAME}}/{{skillPath}}) is the first skill the
        // namespace declares, or empty when it has none (namespace-skills then stays
        // off the personaAreas allow-list, so the token is never a torso).
        const nsDir = firstSchema !== undefined && typeof firstSchema.sourcePath === 'string'
            ? dirname( firstSchema.sourcePath )
            : null
        const aboutPath = nsDir !== null
            ? FlowMcpCli.#toRepoRelativePath( { cwd, 'path': join( nsDir, 'resources', 'about', `${namespace}-about.md` ) } )
            : `providers/${namespace}`
        const skill = FlowMcpCli.#resolveFirstSkill( { nsDir } )
        const persona = FlowMcpCli.#resolveSchemaPersonaPaths( { cwd, grading } )

        return {
            namespace,
            schemaName,
            toolName,
            schemaPath,
            responseFixturePath,
            'namespacePath': schemaPath,
            aboutPath,
            'domainKnowledgePath': aboutPath,
            'skillName': skill.skillName,
            'skillPath': skill.skillPath === '' ? '' : FlowMcpCli.#toRepoRelativePath( { cwd, 'path': skill.skillPath } ),
            'basePersonaName': persona.basePersonaName,
            'basePersonaFile': persona.basePersonaFile,
            'lensName': persona.lensName,
            'lensFile': persona.lensFile,
            'personaPath': persona.basePersonaFile,
            'lensPath': persona.lensFile
        }
    }


    // Memo 141 — the resolved technical Schema-Persona for the persona-required
    // Schema-Areas (about-namespace, namespace-skills): the spec base persona
    // `schema-maintainer` reviewed through the `documentation-dx-reviewer` lens
    // (the about/skills documentation lens). Slug convention `<base>--<lens>`.
    static #resolveSchemaPersona() {
        return {
            'id': 'schema-maintainer--documentation-dx-reviewer',
            'basePersona': 'schema-maintainer',
            'lens': 'documentation-dx-reviewer'
        }
    }


    // Memo 141 — resolve repo-relative paths to the base persona + lens files. The
    // lens ships with the grading package (AreaPromptLoader.getPersonasRoot); the base
    // persona is the spec single-source-of-truth in repos/flowmcp-spec/personas. Both
    // are resolved against candidate locations and the first existing one wins; the
    // first candidate is the best-effort fallback (a missing file surfaces as a
    // subagent blocker, never a silent success).
    static #resolveSchemaPersonaPaths( { cwd, grading } ) {
        const persona = FlowMcpCli.#resolveSchemaPersona()
        const AreaPromptLoader = grading !== undefined && grading !== null
            ? grading[ 'AreaPromptLoader' ]
            : null
        const packagePersonasRoot = AreaPromptLoader !== null && typeof AreaPromptLoader.getPersonasRoot === 'function'
            ? AreaPromptLoader.getPersonasRoot().personasRoot
            : null

        const lensCandidates = [
            join( cwd, 'repos', 'flowmcp-grading', 'personas', `${persona.lens}.md` ),
            packagePersonasRoot !== null ? join( packagePersonasRoot, `${persona.lens}.md` ) : null
        ]
            .filter( ( p ) => typeof p === 'string' )
        const baseCandidates = [
            join( cwd, 'repos', 'flowmcp-spec', 'personas', `${persona.basePersona}.md` )
        ]

        const lensAbs = lensCandidates.find( ( p ) => existsSync( p ) ) ?? lensCandidates[ 0 ]
        const baseAbs = baseCandidates.find( ( p ) => existsSync( p ) ) ?? baseCandidates[ 0 ]

        return {
            'basePersonaName': persona.basePersona,
            'basePersonaFile': FlowMcpCli.#toRepoRelativePath( { cwd, 'path': baseAbs } ),
            'lensName': persona.lens,
            'lensFile': FlowMcpCli.#toRepoRelativePath( { cwd, 'path': lensAbs } )
        }
    }


    // Memo 141 — find the first skill a namespace declares (<nsDir>/skills/*.mjs).
    // Returns empty strings when the namespace has none; the caller then keeps
    // namespace-skills off the personaAreas allow-list (no {{SKILL_NAME}} torso).
    static #resolveFirstSkill( { nsDir } ) {
        if( nsDir === null || existsSync( join( nsDir, 'skills' ) ) === false ) {
            return { 'skillName': '', 'skillPath': '' }
        }
        const skillsDir = join( nsDir, 'skills' )
        const skillFile = readdirSync( skillsDir )
            .filter( ( name ) => name.endsWith( '.mjs' ) === true )
            .sort()
            .find( ( name ) => true )
        if( skillFile === undefined ) {
            return { 'skillName': '', 'skillPath': '' }
        }
        return {
            'skillName': basename( skillFile, '.mjs' ),
            'skillPath': join( nsDir, 'skills', skillFile )
        }
    }


    // Memo 112 — assemble the ONE self-contained Emit-Skill as a numbered, single-
    // authored runbook (Zone 1 harness / Zone 2 numbered tasks / Zone 3 return).
    //
    // The three-zone model (Memo 112 Kap 3): the output contract is explained ONCE
    // in Zone 1 (no per-area duplication of the full schema), the middle is a
    // numbered Ablaufplan that names every schema file explicitly (no CSV tool blob,
    // no "think anew every time"), and Zone 3 carries the Task-ID + consume command.
    //
    // The per-area composed blob (from AreaPromptLoader) is NOT pasted verbatim —
    // it is decomposed into its parts (intro sentence, questions list, area-specific
    // output constraints) and re-rendered numbered. Frontmatter, the empty
    // `## Pre-Instructions` header and the duplicated `## Question(s)`/`## Questions`
    // headers are dropped by reconstruction (Memo 112 M1–M3). The big envelope JSON
    // appears once in Zone 1, not per area (M6).
    static #buildEmitSkill( { target, flow, namespace, taskId, emittedAreas, gatedAreas, payloadSkeleton, liveSchemas, pretests, cwd, scopeName = null, runId = null, worklist = null } ) {
        const ready = emittedAreas
            .filter( ( a ) => typeof a.prompt === 'string' && a.prompt.length > 0 )
        const deferred = emittedAreas
            .filter( ( a ) => a.prompt === null || a.prompt === undefined )
            .map( ( a ) => a.area )

        const schemaSteps = FlowMcpCli.#emitSchemaSteps( { liveSchemas, pretests, cwd } )
        const toolSteps = FlowMcpCli.#emitToolSteps( { liveSchemas, pretests, cwd } )
        const schemaGroups = FlowMcpCli.#emitSchemaGroups( { toolSteps, schemaSteps } )
        const singleTestArea = ready.find( ( a ) => FlowMcpCli.#emitAreaUnit( { 'area': a.area } ) === 'tool' )
        // Namespace-level areas only (tool + schema areas are graded INSIDE the per-
        // schema sub-agents, so they are not separate orchestrator steps — F10).
        const namespaceAreas = ready.filter( ( a ) => FlowMcpCli.#emitAreaUnit( { 'area': a.area } ) === 'namespace' )

        // Memo 112 — a schema-scoped emit is a self-contained per-schema sub-skill:
        // the literal prompt one sub-agent gets (no "create tasks" step, returns ONE
        // JSON the orchestrator collects). The namespace emit below is the orchestrator.
        if( scopeName !== null && scopeName !== undefined ) {
            return FlowMcpCli.#buildSchemaSubSkill( { namespace, scopeName, taskId, ready, schemaGroups, singleTestArea } )
        }

        // Memo 112 (REV-05) — the namespace emit is a pure ORCHESTRATOR: it carries NO
        // grading content (questions/contract live ONLY in each per-schema sub-skill).
        // It just tells the main agent to dispatch one sub-agent per schema, each with
        // the schema's own `<namespace>/<schema> --emit-prompts` command as its prompt.
        const header = [
            `# Grading orchestrator — ${namespace}`,
            '',
            'You COORDINATE here — you do NOT grade in this context. Each schema is graded',
            'in its own fresh sub-agent that carries its own complete instructions and',
            'writes its own results. Your job: dispatch them, then finalize.',
            '',
            `- Namespace: \`${namespace}\` · schemas: ${schemaGroups.length} · tools: ${toolSteps.length}`,
            `- Run-ID: \`${runId !== null ? runId : taskId}\` (every sub-agent below shares it — check progress with \`flowmcp grading state ${namespace}\`)`
        ].join( '\n' )

        const runFlag = runId !== null ? runId : taskId
        // Memo 112 P6.3 — dispatch ONLY the worklist (ungraded / stale). A null worklist
        // means "no filter" → dispatch every schema (unchanged behavior). Fresh schemas
        // (graded + schemaHash unchanged) are listed as skipped, not re-graded.
        const dispatchGroups = worklist === null
            ? schemaGroups
            : schemaGroups.filter( ( g ) => worklist.includes( g.schemaName ) === true )
        const skippedGroups = worklist === null
            ? []
            : schemaGroups.filter( ( g ) => worklist.includes( g.schemaName ) === false )
        const dispatchLines = dispatchGroups
            .map( ( g, index ) => `- **Sub-agent ${index + 1}** — schema \`${g.schemaName}\` (${g.tools.length} tool(s)): run \`flowmcp grading non-deterministic ${namespace}/${g.schemaName} --emit-prompts --run ${runFlag}\`, then give that output to a fresh sub-agent as its ENTIRE prompt.` )
            .join( '\n' )
        const skipLine = skippedGroups.length > 0
            ? `\n\n_Skipped (fresh — already graded, schemaHash unchanged): ${skippedGroups.map( ( g ) => `\`${g.schemaName}\`` ).join( ', ' )}._`
            : ''
        const step1 = [
            '## Step 1 — Dispatch one sub-agent per schema (run in parallel)',
            '',
            'For each schema: generate its sub-skill with the command, hand the output to a',
            'fresh sub-agent, and let it grade + write its own results. The per-schema',
            'writes are isolated, so the sub-agents are safe to run in parallel.',
            '',
            dispatchLines.length > 0 ? dispatchLines : '- (no stale/ungraded schemas — nothing to grade this pass)',
            skipLine
        ].join( '\n' )

        const namespaceLines = namespaceAreas
            .map( ( a ) => `- \`${a.area}\`: run \`flowmcp grading non-deterministic ${namespace} --emit-prompts --phase ${a.area}\`, hand it to a fresh sub-agent, grade it once for the namespace.` )
            .join( '\n' )
        const step2 = namespaceAreas.length > 0
            ? [ '', '', '## Step 2 — Namespace-wide areas (after every schema is done)', '', namespaceLines ].join( '\n' )
            : ''

        // Memo 112 P6.4 — the outer loop: poll progress (transient per-run state) until
        // every dispatched schema is scored, re-dispatch any that stalled, then finalize
        // ONCE (persistent namespace rollup + recommendation). maxTurns is the Notausgang.
        const step3 = [
            '',
            '',
            '## Step 3 — Outer loop: wait for completion, then finalize',
            '',
            `Run-ID \`${runFlag}\` ties every sub-agent's progress together. Loop:`,
            '',
            `1. **Poll** \`flowmcp grading state ${namespace}\` → read \`schemaProgress.scored\` / \`.total\`.`,
            '2. **Re-dispatch** any schema still `pending` or failed → re-run its Step-1 command in a fresh sub-agent.',
            '3. **Repeat** 1–2 until `scored == total` (or you hit your maxTurns budget — the Notausgang).',
            `4. **Finalize ONCE** \`flowmcp grading finalize ${namespace}\` → rebuilds the namespace index + grade.json`,
            '   AND prints the recommendation (which schemas remain stale / below target). An empty worklist',
            '   means the namespace is fully graded and fresh — you are done.',
            '',
            'The rollup runs exactly once, never in parallel with the sub-agents.'
        ].join( '\n' )

        const gatedNote = ( Array.isArray( gatedAreas ) ? gatedAreas : [] ).length > 0
            ? [
                '',
                '',
                '## Gated areas (NOT in this pass)',
                '',
                'These stage-2 areas are emitted in a FOLLOW-UP pass once every schema',
                'of the namespace is deterministic-green — do not attempt them now:',
                ...( gatedAreas.map( ( g ) => `- ${typeof g === 'string' ? g : ( g.area === undefined ? JSON.stringify( g ) : `${g.area} (${g.reason === undefined ? 'gated' : g.reason})` )}` ) )
            ].join( '\n' )
            : ''

        const deferredNote = deferred.length > 0
            ? `\n\n## Deferred areas\n\nComposed by the harness with the resolved persona (not in this text): ${deferred.join( ', ' )}.`
            : ''

        return `${header}\n\n${step1}${step2}${step3}${gatedNote}${deferredNote}\n`
    }


    // Memo 112 (REV-05) — the self-contained per-schema sub-skill: the literal prompt
    // ONE sub-agent receives to grade ONE schema. It carries EVERYTHING (minimal
    // contract + questions + ordered per-tool steps + a PRE-FILLED return JSON + the
    // self-consume command), so nothing depends on a shared doc being in context. The
    // burden on the sub-agent is minimal: fill the null scores + one reasoning/tool.
    static #buildSchemaSubSkill( { namespace, scopeName, taskId, ready, schemaGroups, singleTestArea } ) {
        const group = schemaGroups.find( ( g ) => g.schemaName === scopeName )
        const tools = group !== undefined ? group.tools : []
        const toolCount = tools.length
        const scoresFile = `${scopeName}.scores.json`
        const toolAreaCount = ready.filter( ( a ) => FlowMcpCli.#emitAreaUnit( { 'area': a.area } ) === 'tool' ).length
        const schemaAreaCount = ready.filter( ( a ) => FlowMcpCli.#emitAreaUnit( { 'area': a.area } ) === 'schema' ).length

        const header = [
            `# Grading sub-skill — schema \`${scopeName}\` (namespace \`${namespace}\`)`,
            '',
            'You are a sub-agent grading ONE schema. Read the file(s), score the areas',
            'below, fill the pre-built JSON, then run the one command. Answer only from',
            'the files you open: no web research, no assumptions.',
            '',
            `- Schema: \`${scopeName}\` (namespace \`${namespace}\`)`,
            `- Task-ID: \`${taskId}\``,
            `- Tools: ${toolCount} · areas: per-tool ${toolAreaCount}, per-schema ${schemaAreaCount}`
        ].join( '\n' )

        const contract = [
            '## How to score (minimal — keep it light)',
            '',
            'Score every question `1`–`5` (or `"n/a"`). Per-tool areas: one `reasoning`',
            'per tool (not per question). Per-schema areas: one `reasoning` for the area.',
            'Fill only the `null` scores and the empty `reasoning` strings in the JSON',
            'below — add no other fields. The CLI fills ids, hashes, timestamps. On a',
            'file-read error reply only with `{ "blocker": "<file>", "reason": "<why>" }`.',
            'JSON only — no Markdown.'
        ].join( '\n' )

        const questionsRef = FlowMcpCli.#emitQuestionsReference( { ready } )

        const open = group !== undefined
            ? `Open \`${group.schemaPath}\` and read its tests (${group.fixtureNote}).`
            : `Read schema \`${scopeName}\` and its tests.`
        const areaStepLines = ready
            .map( ( a ) => {
                const unit = FlowMcpCli.#emitAreaUnit( { 'area': a.area } )
                const qn = FlowMcpCli.#emitAreaParts( { 'prompt': a.prompt } ).questionIds.length
                if( unit === 'tool' ) {
                    const toolList = tools.length > 0
                        ? tools.map( ( toolName, index ) => `  ${index + 1}. \`${toolName}\`` ).join( '\n' )
                        : '  (no tools)'
                    return `- **${a.area}** — answer its ${qn} questions for EACH tool (one result per tool):\n${toolList}`
                }
                return `- **${a.area}** — answer its ${qn} questions ONCE for this schema (one result).`
            } )
            .join( '\n' )
        const steps = [
            `## Grade schema \`${scopeName}\``,
            '',
            open,
            'Then score the areas (questions listed above):',
            '',
            areaStepLines
        ].join( '\n' )

        const skeleton = FlowMcpCli.#buildSchemaReturnSkeleton( { taskId, ready, tools } )
        const returnBlock = [
            '## Fill this JSON, then submit it — and loop until accepted',
            '',
            `Save the filled JSON as \`${scoresFile}\` — replace every \`null\` with a score`,
            'and every empty `reasoning` with one short sentence. Add nothing else.',
            '',
            '```json',
            skeleton,
            '```',
            '',
            'Then submit it (isolated — safe to run in parallel with other schemas):',
            '',
            '```bash',
            `flowmcp grading non-deterministic ${namespace}/${scopeName} --consume-scores ${scoresFile}`,
            '```',
            '',
            '**You are NOT done until this command succeeds (exit 0).** If it reports a',
            'parse error, a Task-ID mismatch or a result-count mismatch, fix the JSON in',
            `\`${scoresFile}\` and run the command again. Repeat until it is accepted —`,
            'only an accepted submission counts as completing this schema.'
        ].join( '\n' )

        return `${header}\n\n${contract}\n\n${questionsRef}\n\n${steps}\n\n${returnBlock}\n`
    }


    // Memo 112 (REV-05) — the PRE-FILLED per-schema return JSON. One results[] per
    // ready area, with the question ids already laid out and `null` scores + empty
    // reasoning for the sub-agent to fill. Per-tool area → one result per tool (with a
    // `tool` key); per-schema area → exactly one result. consume-scores count-checks
    // results[] against the per-area expected count; the inner shape is ours, kept
    // minimal to raise reliability.
    static #buildSchemaReturnSkeleton( { taskId, ready, tools } ) {
        const areas = ready
            .map( ( a ) => {
                const questionIds = FlowMcpCli.#emitAreaParts( { 'prompt': a.prompt } ).questionIds
                const unit = FlowMcpCli.#emitAreaUnit( { 'area': a.area } )
                const emptyScores = () => questionIds.reduce( ( acc, qid ) => { acc[ qid ] = null; return acc }, {} )
                const results = unit === 'tool'
                    ? tools.map( ( toolName ) => ( { 'tool': toolName, 'scores': emptyScores(), 'reasoning': '' } ) )
                    : [ { 'scores': emptyScores(), 'reasoning': '' } ]
                return { 'area': a.area, results }
            } )
        const skeleton = { taskId, 'scores': [], areas }

        return JSON.stringify( skeleton, null, 2 )
    }


    // Memo 112 (REV-04) — group the per-tool steps by their declaring schema, so the
    // runbook can be organised as ONE task per schema (schemas run sequentially; the
    // tools inside a schema are the ordered sub-steps). Order follows schemaSteps.
    static #emitSchemaGroups( { toolSteps, schemaSteps } ) {
        const tools = Array.isArray( toolSteps ) ? toolSteps : []
        const order = Array.isArray( schemaSteps ) ? schemaSteps : []

        return order
            .map( ( s ) => {
                const groupTools = tools
                    .filter( ( t ) => t.schemaName === s.schemaName )
                    .map( ( t ) => t.toolName )
                return { 'schemaName': s.schemaName, 'schemaPath': s.schemaPath, 'fixtureNote': s.fixtureNote, 'tools': groupTools }
            } )
    }


    // Memo 112 (REV-04) — the questions, listed ONCE as a reference (a set of
    // criteria, keyed by their stable [Q-…] id). Every task points back here instead
    // of repeating the questions per tool/schema.
    static #emitQuestionsReference( { ready } ) {
        const blocks = ready
            .map( ( a ) => {
                const parts = FlowMcpCli.#emitAreaParts( { 'prompt': a.prompt } )
                const unit = FlowMcpCli.#emitAreaUnit( { 'area': a.area } )
                const qList = parts.questions
                    .map( ( q ) => `- [${q.id}] ${q.text}` )
                    .join( '\n' )
                const scope = unit === 'tool'
                    ? `asked PER TOOL — one result per tool, ${parts.questions.length} answers each`
                    : ( unit === 'schema'
                        ? `asked ONCE for this schema — ${parts.questions.length} answers`
                        : `asked ONCE for the namespace — ${parts.questions.length} answers` )
                return [ `### ${a.area} — ${scope}`, '', qList ].join( '\n' )
            } )
            .join( '\n\n' )

        return [ '## Questions (read once)', '', blocks ].join( '\n' )
    }


    // Memo 112 (REV-05, F10=per-schema) — area iteration unit. `single-test` is per
    // TOOL (one result per tool); `tools-aggregate-schema` is per SCHEMA (one result
    // per schema — that is how RebuildIndex reads it). Both belong inside the per-
    // schema sub-agent. The remaining neutral areas are namespace-level (stage-2).
    static #emitAreaUnit( { area } ) {
        if( area === 'single-test' ) { return 'tool' }
        if( area === 'tools-aggregate-schema' ) { return 'schema' }
        return 'namespace'
    }


    // Memo 112 — build per-tool steps: every declared tool with the schema file that
    // declares it and that schema's fixture-size note. Repo-relative paths only.
    static #emitToolSteps( { liveSchemas, pretests, cwd } ) {
        const schemas = Array.isArray( liveSchemas ) ? liveSchemas : []
        const tests = Array.isArray( pretests ) ? pretests : []
        const fixtureBySchema = tests
            .reduce( ( acc, p ) => {
                if( typeof p.summaryPath === 'string' && p.summaryPath.length > 0 ) { acc[ p.schemaName ] = p.summaryPath }
                return acc
            }, {} )

        return schemas
            .flatMap( ( s ) => {
                const toolMap = ( s.main !== undefined && s.main !== null )
                    ? ( s.main[ 'tools' ] || s.main[ 'routes' ] || {} )
                    : {}
                const schemaPath = typeof s.sourcePath === 'string'
                    ? FlowMcpCli.#toRepoRelativePath( { cwd, 'path': s.sourcePath } )
                    : `providers/${s.schemaName}`
                const fixtureNote = FlowMcpCli.#emitFixtureNote( { cwd, 'fixturePath': fixtureBySchema[ s.schemaName ] } )
                return Object.keys( toolMap )
                    .map( ( toolName ) => ( { toolName, 'schemaName': s.schemaName, schemaPath, fixtureNote } ) )
            } )
    }


    // Memo 112 — decompose a composed area blob into its parts using PromptBuilder's
    // constant headers. Strips leading YAML frontmatter (M1), drops the empty
    // `## Pre-Instructions` + duplicated `## Question(s)`/`## Questions` headers
    // (M2/M3), and lifts the per-area question list + question IDs. The full inline
    // output schema (M6) is intentionally NOT carried over — the contract lives once
    // in Zone 1. Pure string work; never throws (falls back to empty parts).
    static #emitAreaParts( { prompt } ) {
        const stripped = ( typeof prompt === 'string' ? prompt : '' )
            .replace( /^---\n[\s\S]*?\n---\n/, '' )

        const introMatch = stripped.match( /## Question\(s\)\n+([\s\S]*?)\n+## Questions/ )
        const intro = introMatch !== null ? introMatch[ 1 ].trim() : ''

        const questionsMatch = stripped.match( /## Questions\n+([\s\S]*?)(?:\n+## |$)/ )
        const questionsRaw = questionsMatch !== null ? questionsMatch[ 1 ].trim() : ''

        // Parse each "<n>. [<id>] <text>" line into a structured question so the
        // section can RE-number them inside the area's numbering tree (e.g. 1.2.1)
        // instead of restarting a flat 1..N inside an already-numbered section.
        const questions = questionsRaw
            .split( '\n' )
            .map( ( line ) => line.trim() )
            .filter( ( line ) => line.length > 0 )
            .map( ( line ) => {
                const match = line.match( /^\d+\.\s*\[([A-Za-z0-9-]+)\]\s*(.*)$/ )
                return match !== null ? { 'id': match[ 1 ], 'text': match[ 2 ].trim() } : null
            } )
            .filter( ( entry ) => entry !== null )

        const questionIds = questions.map( ( q ) => q.id )

        return { intro, questions, questionIds }
    }


    // Memo 112 Kap 4/5 — build the explicit per-schema steps with a fixture-size
    // gate (F3 = threshold). Schema paths are repo-relative (git-security). For each
    // schema the test fixture size decides inline-read vs. subagent-read so large
    // fixtures do not pollute the main context; the size is COMPUTED here, per the
    // user's requirement that the generator calculate the KB itself.
    static #emitSchemaSteps( { liveSchemas, pretests, cwd } ) {
        const schemas = Array.isArray( liveSchemas ) ? liveSchemas : []
        const tests = Array.isArray( pretests ) ? pretests : []

        const fixtureBySchema = tests
            .reduce( ( acc, p ) => {
                if( typeof p.summaryPath === 'string' && p.summaryPath.length > 0 ) { acc[ p.schemaName ] = p.summaryPath }
                return acc
            }, {} )

        return schemas
            .map( ( s ) => {
                const schemaPath = typeof s.sourcePath === 'string'
                    ? FlowMcpCli.#toRepoRelativePath( { cwd, 'path': s.sourcePath } )
                    : `providers/${s.schemaName}`
                const fixturePath = fixtureBySchema[ s.schemaName ]
                const fixtureNote = FlowMcpCli.#emitFixtureNote( { cwd, fixturePath } )
                return { 'schemaName': s.schemaName, schemaPath, fixtureNote }
            } )
    }


    // Memo 112 — fixture-size gate. Reads the fixture's size on disk and recommends
    // inline reading for small fixtures and a subagent read for large ones (the
    // threshold avoids content-pollution at scale). Missing fixture = read tests
    // from the schema directly.
    static #emitFixtureNote( { cwd, fixturePath } ) {
        const INLINE_LIMIT_KB = 16
        if( typeof fixturePath !== 'string' || fixturePath.length === 0 ) {
            return 'no saved fixture — read the schema\'s declared tests directly'
        }
        const relPath = FlowMcpCli.#toRepoRelativePath( { cwd, 'path': fixturePath } )
        const absPath = isAbsolute( fixturePath ) ? fixturePath : join( cwd, fixturePath )
        if( existsSync( absPath ) === false ) {
            return `fixture \`${relPath}\` (not on disk yet — read the schema's declared tests directly)`
        }
        const sizeKb = Math.max( 1, Math.round( statSync( absPath ).size / 1024 ) )
        const mode = sizeKb > INLINE_LIMIT_KB
            ? 'read it in a SUBAGENT to keep this context clean'
            : 'read it inline'
        return `fixture \`${relPath}\`, ~${sizeKb} KB → ${mode}`
    }


    // Stage 1 — deterministic: Phase-0/1 wiring -> DataPretest.run -> emit the
    // /goal handoff (prompts.json + state.json baton). The CLI does NOT run
    // Agent() — Stage 2 lives in the harness.
    static async #gradingEmitPrompts( { cwd, grading, gradingDataRoot, flow, tier, maxGrade, targetDir, target, scopeName = null, runId = null, areaSelector, conflict, maxIterations, maxTurns = 25, useKeys, dryRun = false, quiet = false, dependencyChain } ) {
        const namespace = basename( targetDir )
        const scoped = scopeName !== null && scopeName !== undefined
        // Memo 112 — schema-scoped emit (namespace/schema): the per-schema sub-skill
        // is written to an isolated subdir so parallel per-schema emits never clobber
        // the namespace handoff or each other. Namespace emit (scopeName null) writes
        // to the namespace dir exactly as before (byte-identical).
        // The scoped writeDir is created LATER — only after the schema name is
        // validated against the live schemas (so a typo'd `ns/wrong` never leaves an
        // empty _schema/<wrong>/ dir polluting `grading state`).
        const writeDir = scoped ? join( targetDir, '_schema', scopeName ) : targetDir
        const promptsPath = join( writeDir, 'prompts.json' )
        const statePath = join( writeDir, 'state.json' )

        // PRD-012 — --no-save (dryRun) means NO write happens. The --on-conflict
        // policy is ORTHOGONAL (it only decides HOW an actual write resolves a
        // collision), so when dryRun is set we never consult it: there is no write
        // that could collide. The conflict-gate below runs only for real writes.
        if( dryRun !== true && existsSync( promptsPath ) === true && conflict === 'abort' ) {
            return { 'result': CliOutput.error( { 'error': `NO-OVERWRITE conflict: ${promptsPath} already exists`, 'fix': 'Pass --on-conflict=skip to keep the existing handoff, or remove it deliberately.' } ) }
        }
        if( dryRun !== true && existsSync( promptsPath ) === true && conflict === 'skip' ) {
            // Skip the (slow) re-emit but still hand back the ALREADY-emitted skill, so
            // a second `--emit-prompts` keeps printing the skill text (no re-fetch). The
            // existing prompts.json is the source — read its emitSkill if present.
            const { data: existing } = await FsUtils.readJson( { 'filePath': promptsPath } )
            const existingSkill = existing !== null && typeof existing[ 'emitSkill' ] === 'string' ? existing[ 'emitSkill' ] : undefined
            return { 'result': { 'status': true, 'stage': 1, 'mode': 'emit-prompts', 'skipped': true, promptsPath, statePath, 'emitSkill': existingSkill, dependencyChain } }
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
                return { 'result': CliOutput.error( { 'error': resolvedSchemas.error, 'fix': resolvedSchemas.fix } ) }
            }
            liveSchemas = resolvedSchemas.schemas
        } else {
            // Selection flow: the schemas to pretest are the selection members. They
            // too are resolved LIVE from schemaFolders[] (PRD-003) via their
            // <namespace>.<schemaName> member IDs — never from the island snapshot.
            const resolvedMembers = await FlowMcpCli.#resolveSelectionSchemasLive( { targetDir } )
            if( resolvedMembers.status === false ) {
                return { 'result': CliOutput.error( { 'error': resolvedMembers.error, 'fix': resolvedMembers.fix } ) }
            }
            liveSchemas = resolvedMembers.schemas
        }

        // Memo 112 — schema-scoped emit: restrict the live schemas to the named schema
        // (the `namespace/schema` id). NO silent default — an unknown schema is a hard
        // error that lists the available schema names.
        if( scoped === true ) {
            const match = liveSchemas.filter( ( s ) => s.schemaName === scopeName )
            if( match.length === 0 ) {
                const available = liveSchemas.map( ( s ) => s.schemaName ).join( ', ' )
                return { 'result': CliOutput.error( { 'error': `Unknown schema "${scopeName}" in namespace "${namespace}".`, 'fix': `Use one of: ${available} — or grade the whole namespace with "${namespace}".` } ) }
            }
            liveSchemas = match
            // Schema validated — now safe to create the isolated scoped write dir.
            if( dryRun !== true ) {
                await mkdir( writeDir, { 'recursive': true } )
            }
        }
        schemaDirs = liveSchemas.map( ( s ) => s.schemaName )

        // PRD-006: the deterministic pretest runs for EVERY schema regardless of
        // the area selector — the per-schema/per-namespace requiredLevel is derived
        // from these results to gate the namespace areas. The selector filters the
        // emitted AREA prompts later, not the pretest pass.
        const pretestUnits = liveSchemas

        CliOutput.emitProgress( { quiet, 'message': `emit ${target}: data pretest over ${pretestUnits.length} schema(s)...` } )
        await pretestUnits
            .reduce( ( promise, unit, index ) => promise.then( async () => {
                const { schemaName, main, handlersFn, sourcePath } = unit
                CliOutput.emitProgress( { quiet, 'message': `[${index + 1}/${pretestUnits.length}] pretest ${schemaName}` } )
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
                    ? EnvResolver.buildServerParams( { 'envObject': ( await EnvResolver.resolveEnv( { cwd } ) ).envObject, requiredServerParams } ).serverParams
                    : {}
                const { sharedLists } = await ListsCommand.resolveSharedListsForSchema( { main, 'filePath': sourcePath } )

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
        // goalBlock. Neutral areas are composed deterministically here.
        // Memo 141: the persona-required Schema-Areas are now COMPOSED here too, with
        // the resolved technical Schema-Persona — about-namespace corpus-wide, and
        // namespace-skills only when the namespace declares skills (personaAreas gate).
        // The Selection/Task-B flow still defers (persona stays null below).
        // PRD-3.2: a substitution context fills the real schema path + tool/namespace
        // names into the composed prompts (no {{…}} torso). Repo-relative paths only —
        // never leak an absolute path into the emitted artifact.
        const substitutions = flow === 'provider'
            ? FlowMcpCli.#buildEmitSubstitutions( { cwd, grading, namespace, liveSchemas, pretests } )
            : null
        const persona = flow === 'provider'
            ? FlowMcpCli.#resolveSchemaPersona()
            : null
        // about-namespace composes for every provider (gated later by About-presence);
        // namespace-skills composes only when the namespace declares a skill, so its
        // {{SKILL_NAME}}/{{skillPath}} tokens always carry a real value.
        const personaAreas = flow === 'provider'
            ? [ 'about-namespace' ].concat(
                substitutions !== null && typeof substitutions.skillName === 'string' && substitutions.skillName.length > 0
                    ? [ 'namespace-skills' ]
                    : []
            )
            : null
        const { areas } = await FlowMcpCli.#composeGradingAreas( { grading, flow, persona, personaAreas, substitutions } )

        // PRD-005/006/004 — derive the FINAL emitted area set from the composed
        // areas: applicability pre-filter (optional-area precondition absent ->
        // skipped), dependency/Namespace-Gate (non-det namespace areas gated until
        // all schemas deterministic-green), then the caller's area selector. Each
        // partition is auditable; nothing is silently dropped.
        // PRD-005 — the About resource is live-read from schemaFolders[], so the
        // applicability probe needs the real SOURCE schema-file directories (where
        // <ns>/resources/about/ lives), not the island targetDir. Derive them from the
        // live schemas' sourcePath (unique dirnames).
        const sourceDirs = [ ...new Set( liveSchemas
            .map( ( s ) => s.sourcePath )
            .filter( ( p ) => typeof p === 'string' && p.length > 0 )
            .map( ( p ) => dirname( p ) ) ) ]
        const resolvedAreas = await FlowMcpCli.#resolveEmittedAreas( {
            grading, areas, targetDir, schemaDirs, pretests, areaSelector, sourceDirs
        } )
        if( resolvedAreas.status === false ) {
            return { 'result': CliOutput.error( { 'error': resolvedAreas.error, 'fix': resolvedAreas.fix } ) }
        }
        // Memo 112 (REV-05, F10) — a schema-scoped pass IS the per-schema sub-skill:
        // keep the per-tool area (single-test) AND the per-schema area
        // (tools-aggregate-schema). Namespace-level areas stay at the namespace pass.
        const emittedAreas = scoped === true
            ? resolvedAreas.emittedAreas.filter( ( a ) => [ 'tool', 'schema' ].includes( FlowMcpCli.#emitAreaUnit( { 'area': a.area } ) ) )
            : resolvedAreas.emittedAreas
        const skippedAreas = resolvedAreas.skippedAreas
        const gatedAreas = resolvedAreas.gatedAreas

        // PRD-007 — deterministic, order-independent Task-ID over the emitted set.
        // The set must be non-empty to carry a Task-ID; an empty set (everything
        // skipped/gated/filtered) is surfaced explicitly, not silently hashed.
        const emittedAreaSet = emittedAreas.map( ( a ) => a.area )
        // Memo 112 — a schema-scoped pass carries a schema-scoped slug in its Task-ID
        // (`namespace/schema--<hash>`) so consume-scores can match per-schema results.
        const taskIdSlug = scoped === true ? `${namespace}/${scopeName}` : namespace
        const taskResult = FlowMcpCli.#computeGradingTaskId( { grading, 'namespace': taskIdSlug, emittedAreaSet } )
        if( taskResult.status === false ) {
            return { 'result': CliOutput.error( { 'error': taskResult.error, 'fix': taskResult.fix } ) }
        }
        const taskId = taskResult.taskId
        const payloadSkeleton = { taskId, 'areas': emittedAreas.map( ( a ) => ( { 'area': a.area, 'results': [] } ) ) }

        // Memo 112 (F9/F10) — the expected result count per area drives consume-scores'
        // results.length check, and differs by iteration unit:
        //   tool   (single-test)            → one result per tool      → tool count
        //   schema (tools-aggregate-schema) → one result per schema    → schema count
        //   namespace (the rest)            → one result per question  → question count
        const namespaceToolCount = liveSchemas
            .reduce( ( total, s ) => {
                const toolMap = ( s.main !== undefined && s.main !== null )
                    ? ( s.main[ 'tools' ] || s.main[ 'routes' ] || {} )
                    : {}
                return total + Object.keys( toolMap ).length
            }, 0 )
        const schemaCount = liveSchemas.length
        const expectedResultsByArea = emittedAreas
            .filter( ( a ) => typeof a.questionCount === 'number' )
            .reduce( ( acc, a ) => {
                const unit = FlowMcpCli.#emitAreaUnit( { 'area': a.area } )
                acc[ a.area ] = unit === 'tool'
                    ? namespaceToolCount
                    : ( unit === 'schema' ? schemaCount : a.questionCount )
                return acc
            }, {} )

        // PRD-3.3/3.4 — assemble ONE self-contained Emit-Skill text: a self-describing
        // header, the bundled READY (non-null prompt) areas, and the Task-ID +
        // --consume-scores return contract IN THE TEXT (not only as JSON siblings).
        // Hard-gated stage-2 areas are named so the operator knows a follow-up emit
        // is needed once every schema is deterministic-green.
        // Run-ID (progress tracking): the ORCHESTRATOR (namespace) sets its OWN taskId
        // as the run-id and threads it into every per-schema dispatch command (--run);
        // a SCOPED emit receives that run-id via --run and records it, so `grading
        // state <ns>` can group every schema's progress under the same run.
        const emitRunId = scoped === true ? runId : taskId
        // Memo 112 P6.3 — the orchestrator dispatches ONLY the worklist (ungraded /
        // stale schemas); fresh ones (graded + schemaHash unchanged) are skipped.
        // Best-effort: any compute failure (or a non-provider flow) leaves the worklist
        // null → dispatch ALL (unchanged behavior, never blocks the emit). Default-on
        // per F12; an explicit per-schema emit (scoped) is the override.
        let emitWorklist = null
        if( scoped !== true && flow === 'provider' ) {
            const wl = await FlowMcpCli.#computeGradingWorklist( { cwd, grading, gradingDataRoot, namespace, 'targetGrade': null } )
            if( wl.status === true ) {
                emitWorklist = wl.worklist.map( ( entry ) => entry.schema )
            }
        }
        const emitSkill = FlowMcpCli.#buildEmitSkill( {
            target, flow, namespace, taskId, emittedAreas, gatedAreas, payloadSkeleton, liveSchemas, pretests, cwd, scopeName, 'runId': emitRunId, 'worklist': emitWorklist
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
            'runId': emitRunId,
            scopeName,
            emittedAreaSet,
            'askedByArea': expectedResultsByArea,
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

        // Write-safety: atomic + No-Overwrite. prompts AND state share the explicit
        // conflict policy so they stay in sync — a re-emit with --on-conflict=overwrite
        // refreshes BOTH (else a changed area-set leaves a stale state Task-ID that
        // consume-scores would then reject). The early skip/abort gates above already
        // handle the "keep existing" case before any write.
        const promptsWrite = await FsUtils.writeAtomic( { 'path': promptsPath, 'content': JSON.stringify( promptsDoc, null, 4 ), 'onConflict': conflict } )
        await FsUtils.writeAtomic( { 'path': statePath, 'content': JSON.stringify( stateDoc, null, 4 ), 'onConflict': conflict } )

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
    static async #resolveEmittedAreas( { grading, areas, targetDir, schemaDirs, pretests, areaSelector, sourceDirs = [] } ) {
        // --- PRD-005: optional-area applicability pre-filter ---------------------
        const aboutProbe = await FlowMcpCli.#detectAboutResourcePresent( { targetDir, schemaDirs, sourceDirs } )
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
    static async #detectAboutResourcePresent( { targetDir, schemaDirs, sourceDirs = [] } ) {
        // The About resource is declared by the schema's `resources.about` and resolves
        // relative to the schema-file directory in schemaFolders[] (live-read, no
        // import). In the flat v4 layout the schema file sits at <ns>/<schema>.mjs, so
        // the about page lives at <ns>/resources/about/ in the SOURCE tree — NOT in the
        // island targetDir. We probe the real source schema-file directories first; the
        // island targetDir (namespace level + <schema> subdir) is kept as an additive
        // fallback for grading-data trees that carry an imported about copy. Present if
        // ANY location exists (no silent default).
        const sourceHit = sourceDirs
            .some( ( dir ) => existsSync( join( dir, 'resources', 'about' ) ) )
        if( sourceHit === true ) {
            return { 'present': true }
        }
        const namespaceLevel = existsSync( join( targetDir, 'resources', 'about' ) )
        if( namespaceLevel === true ) {
            return { 'present': true }
        }
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
    // Memo 112 (REV-05) — convert validated per-tool single-test SCORES into the
    // on-disk _gradings/ entries RebuildIndex reads. One entry per tool, written to
    // `<schema>/tools/<tool>/_gradings/single-test--<ts>.json` (the tool's own dir, so
    // parallel per-schema consumes never collide). Reuses the grading Grading API so
    // the grade math (weighted sum → tier-trim) is identical to the harness path.
    static async #writeSchemaGradingsFromScores( { grading, scoresDoc, namespaceDir, schemaName } ) {
        const Grading = grading[ 'Grading' ]
        if( Grading === undefined || Grading === null ) {
            return { 'status': false, 'error': 'Grading module unavailable from flowmcp-grading.' }
        }
        const areas = Array.isArray( scoresDoc[ 'areas' ] ) ? scoresDoc[ 'areas' ] : []
        if( areas.length === 0 ) {
            return { 'status': true, 'written': 0 }
        }
        const now = new Date().toISOString()
        // Grading filename grammar wants `…THH-MM-SSZ` (no milliseconds, ':'→'-').
        const timestamp = now.replace( /\.\d+Z$/, 'Z' ).replace( /:/g, '-' )

        // Memo 112 P6.2 (Kap 7 open build point) — close the non-deterministic
        // schemaHash gap so `grading plan` can detect staleness for LLM-scored schemas
        // too. Best-effort: resolve the live schema once and compute its hash; stamp it
        // onto the tools-aggregate-schema entry (the entry `plan` reads). If the schema
        // can't be resolved or hashed, omit it (legacy behavior) — never block consume.
        const HashGenerator = grading[ 'HashGenerator' ]
        const aggregateSchemaHash = await FlowMcpCli.#liveSchemaHashFor( { HashGenerator, namespaceDir, schemaName } )

        // One _gradings entry per result. A result WITH a `tool` key → per-tool area
        // (single-test) → written to the tool's own dir. A result WITHOUT a tool →
        // per-schema area (tools-aggregate-schema) → written to the schema's dir. Both
        // are the paths RebuildIndex reads (F10).
        try {
            const written = await areas
                .reduce( ( areaPromise, areaEntry ) => areaPromise.then( async ( areaCount ) => {
                    const area = areaEntry.area
                    const results = Array.isArray( areaEntry.results ) ? areaEntry.results : []
                    const writtenForArea = await results
                        .reduce( ( promise, result ) => promise.then( async ( count ) => {
                            const toolName = typeof result.tool === 'string' && result.tool.length > 0 ? result.tool : null
                            const scores = result.scores !== undefined && result.scores !== null ? result.scores : {}
                            const reasoning = typeof result.reasoning === 'string' ? result.reasoning : ''
                            const label = toolName !== null ? `${area}/${toolName}` : area

                            const created = Grading.createEntry( { schemaId: schemaName, 'gradingTier': 'autonomous', 'grader': { 'kind': 'llm', 'llmModel': 'claude-code' }, area, 'harness': 'claude-code' } )
                            if( created.entry === null ) { throw new Error( `createEntry (${label}): ${created.errors.join( '; ' )}` ) }

                            const entry = Object.keys( scores )
                                .reduce( ( acc, questionId ) => {
                                    const added = Grading.addGrading( { 'entry': acc, 'grading': { 'dimension': questionId, 'score': scores[ questionId ], 'determinism': 'non-deterministic', 'weight': 1, reasoning, 'recordedAt': now, 'selectionContext': { 'personaIds': [ 'neutral' ] } } } )
                                    if( added.errors.length > 0 ) { throw new Error( `addGrading (${label}/${questionId}): ${added.errors.join( '; ' )}` ) }
                                    return added.entry
                                }, created.entry )

                            const agg = Grading.computeAggregateGrade( { entry } )
                            if( agg.aggregateGrade === null || agg.aggregateGrade === undefined ) {
                                throw new Error( `computeAggregateGrade (${label}): no scorable answers (${( agg.errors || [] ).join( '; ' )})` )
                            }
                            const stamped = Object.assign( {}, entry, { 'aggregateGrade': agg.aggregateGrade, 'grade': agg.aggregateGrade, 'rawGrade': agg.rawGrade, 'normalizedScore': agg.normalizedScore, 'gradingMode': 'full' } )
                            // Stamp the schemaHash onto the schema-level (tools-aggregate)
                            // entry — the one `grading plan` reads to compare against the
                            // live hash. Per-tool entries (toolName !== null) don't need it.
                            if( toolName === null && aggregateSchemaHash !== null ) {
                                stamped[ 'schemaHash' ] = aggregateSchemaHash
                            }

                            const { filename } = Grading.formatGradingFilename( { area, timestamp } )
                            const dir = toolName !== null
                                ? join( namespaceDir, schemaName, 'tools', toolName, '_gradings' )
                                : join( namespaceDir, schemaName, '_gradings' )
                            await mkdir( dir, { 'recursive': true } )
                            await FsUtils.writeAtomic( { 'path': join( dir, filename ), 'content': JSON.stringify( stamped, null, 4 ), 'onConflict': 'overwrite' } )
                            return count + 1
                        } ), Promise.resolve( 0 ) )
                    return areaCount + writtenForArea
                } ), Promise.resolve( 0 ) )

            return { 'status': true, written }
        } catch( err ) {
            return { 'status': false, 'error': `SCH-006 writeSchemaGradingsFromScores: ${err.message}` }
        }
    }


    // Namespace-level counterpart to #writeSchemaGradingsFromScores. The live-read
    // consume (Memo 099/102) dropped the old GradingImport writer; the per-schema
    // (scoped) branch was re-wired, but the namespace branch went straight to
    // RebuildIndex with no writer — so tools-aggregate-namespace / namespace-description
    // scores were verified+accepted then silently dropped and the aggregate stayed
    // pending forever. This writes them where RebuildIndex reads: ONE entry per area
    // under providers/<ns>/_gradings/<area>--<ts>.json (schemaId = namespace). Only the
    // two namespace-root areas are written here; about-namespace / namespace-skills are
    // schema/skill-scoped and per-schema areas belong to the scoped writer.
    static async #writeNamespaceGradingsFromScores( { grading, scoresDoc, namespaceDir, namespace } ) {
        const Grading = grading[ 'Grading' ]
        if( Grading === undefined || Grading === null ) {
            return { 'status': false, 'error': 'Grading module unavailable from flowmcp-grading.' }
        }
        const NAMESPACE_ROOT_AREAS = [ 'tools-aggregate-namespace', 'namespace-description' ]
        const areas = Array.isArray( scoresDoc[ 'areas' ] ) ? scoresDoc[ 'areas' ] : []
        const nsAreas = areas
            .filter( ( areaEntry ) => NAMESPACE_ROOT_AREAS.includes( areaEntry.area ) )
        if( nsAreas.length === 0 ) {
            return { 'status': true, 'written': 0 }
        }
        const now = new Date().toISOString()
        const timestamp = now.replace( /\.\d+Z$/, 'Z' ).replace( /:/g, '-' )
        const gradingsDir = join( namespaceDir, '_gradings' )

        // ONE entry per namespace area: each per-question result contributes its
        // dimension(s) into the same entry (namespace units emit one result per
        // question — #emitAreaUnit). reasoning = first non-empty per area.
        try {
            const written = await nsAreas
                .reduce( ( areaPromise, areaEntry ) => areaPromise.then( async ( areaCount ) => {
                    const area = areaEntry.area
                    const results = Array.isArray( areaEntry.results ) ? areaEntry.results : []
                    const firstReasoning = results
                        .map( ( result ) => ( typeof result.reasoning === 'string' ? result.reasoning : '' ) )
                        .find( ( reasoning ) => reasoning.length > 0 )
                    const areaReasoning = firstReasoning !== undefined ? firstReasoning : ''

                    const created = Grading.createEntry( { schemaId: namespace, 'gradingTier': 'autonomous', 'grader': { 'kind': 'llm', 'llmModel': 'claude-code' }, area, 'harness': 'claude-code' } )
                    if( created.entry === null ) { throw new Error( `createEntry (${area}): ${created.errors.join( '; ' )}` ) }

                    const entry = results
                        .reduce( ( entryForResults, result ) => {
                            const scores = result.scores !== undefined && result.scores !== null ? result.scores : {}
                            const resultReasoning = typeof result.reasoning === 'string' && result.reasoning.length > 0 ? result.reasoning : areaReasoning
                            return Object.keys( scores )
                                .reduce( ( acc, questionId ) => {
                                    const added = Grading.addGrading( { 'entry': acc, 'grading': { 'dimension': questionId, 'score': scores[ questionId ], 'determinism': 'non-deterministic', 'weight': 1, 'reasoning': resultReasoning, 'recordedAt': now, 'selectionContext': { 'personaIds': [ 'neutral' ] } } } )
                                    if( added.errors.length > 0 ) { throw new Error( `addGrading (${area}/${questionId}): ${added.errors.join( '; ' )}` ) }
                                    return added.entry
                                }, entryForResults )
                        }, created.entry )

                    const agg = Grading.computeAggregateGrade( { entry } )
                    if( agg.aggregateGrade === null || agg.aggregateGrade === undefined ) {
                        throw new Error( `computeAggregateGrade (${area}): no scorable answers (${( agg.errors || [] ).join( '; ' )})` )
                    }
                    const stamped = Object.assign( {}, entry, { 'aggregateGrade': agg.aggregateGrade, 'grade': agg.aggregateGrade, 'rawGrade': agg.rawGrade, 'normalizedScore': agg.normalizedScore, 'gradingMode': 'full' } )

                    const { filename } = Grading.formatGradingFilename( { area, timestamp } )
                    await mkdir( gradingsDir, { 'recursive': true } )
                    await FsUtils.writeAtomic( { 'path': join( gradingsDir, filename ), 'content': JSON.stringify( stamped, null, 4 ), 'onConflict': 'overwrite' } )
                    return areaCount + 1
                } ), Promise.resolve( 0 ) )

            return { 'status': true, written }
        } catch( err ) {
            return { 'status': false, 'error': `GRD-002 writeNamespaceGradingsFromScores: ${err.message}` }
        }
    }


    // Memo 141 — the persona-required namespace areas (about-namespace, namespace-skills)
    // are emitted in the namespace pass but their _gradings live SCHEMA-scoped, where
    // RebuildIndex reads them (#resolveAboutNamespace → <ns>/<schema>/resources/about/
    // _gradings/; #resolveNamespaceSkills → <ns>/<schema>/skills/<skill>/_gradings/).
    // Before this, the namespace consume writer only handled the two root areas, so
    // about-namespace / namespace-skills scores were verified+accepted then silently
    // DROPPED — every namespace stayed about:pending forever. This writes them where
    // RebuildIndex reads. The target schema is the first island schema dir (RebuildIndex
    // iterates schemas and takes the first about/skill grading it finds, so a single
    // deterministic schema dir is sufficient and conflict-free).
    static async #writePersonaNamespaceGradings( { grading, scoresDoc, namespaceDir } ) {
        const Grading = grading[ 'Grading' ]
        if( Grading === undefined || Grading === null ) {
            return { 'status': false, 'error': 'Grading module unavailable from flowmcp-grading.' }
        }
        const PERSONA_AREAS = [ 'about-namespace', 'namespace-skills' ]
        const areas = Array.isArray( scoresDoc[ 'areas' ] ) ? scoresDoc[ 'areas' ] : []
        const personaAreas = areas
            .filter( ( areaEntry ) => PERSONA_AREAS.includes( areaEntry.area ) )
        if( personaAreas.length === 0 ) {
            return { 'status': true, 'written': 0 }
        }

        // Resolve the first island schema dir (same filter as RebuildIndex.#listSchemaDirs:
        // exclude the `_`-prefixed meta dirs). No schema dir → nothing to scope under.
        const schemaDir = existsSync( namespaceDir ) === true
            ? readdirSync( namespaceDir, { 'withFileTypes': true } )
                .filter( ( e ) => e.isDirectory() === true && e.name.startsWith( '_' ) === false )
                .map( ( e ) => e.name )
                .sort()
                .find( ( name ) => true )
            : undefined
        if( schemaDir === undefined ) {
            return { 'status': false, 'error': `no island schema dir under ${namespaceDir} to scope persona gradings` }
        }

        const now = new Date().toISOString()
        const timestamp = now.replace( /\.\d+Z$/, 'Z' ).replace( /:/g, '-' )

        try {
            const written = await personaAreas
                .reduce( ( areaPromise, areaEntry ) => areaPromise.then( async ( areaCount ) => {
                    const area = areaEntry.area
                    const results = Array.isArray( areaEntry.results ) ? areaEntry.results : []

                    const created = Grading.createEntry( { 'schemaId': schemaDir, 'gradingTier': 'autonomous', 'grader': { 'kind': 'llm', 'llmModel': 'claude-code' }, area, 'harness': 'claude-code' } )
                    if( created.entry === null ) { throw new Error( `createEntry (${area}): ${created.errors.join( '; ' )}` ) }

                    const entry = results
                        .reduce( ( entryForResults, result ) => {
                            const scores = result.scores !== undefined && result.scores !== null ? result.scores : {}
                            const resultReasoning = typeof result.reasoning === 'string' ? result.reasoning : ''
                            return Object.keys( scores )
                                .reduce( ( acc, questionId ) => {
                                    const added = Grading.addGrading( { 'entry': acc, 'grading': { 'dimension': questionId, 'score': scores[ questionId ], 'determinism': 'non-deterministic', 'weight': 1, 'reasoning': resultReasoning, 'recordedAt': now, 'selectionContext': { 'personaIds': [ 'schema-maintainer--documentation-dx-reviewer' ] } } } )
                                    if( added.errors.length > 0 ) { throw new Error( `addGrading (${area}/${questionId}): ${added.errors.join( '; ' )}` ) }
                                    return added.entry
                                }, entryForResults )
                        }, created.entry )

                    const agg = Grading.computeAggregateGrade( { entry } )
                    if( agg.aggregateGrade === null || agg.aggregateGrade === undefined ) {
                        throw new Error( `computeAggregateGrade (${area}): no scorable answers (${( agg.errors || [] ).join( '; ' )})` )
                    }
                    const stamped = Object.assign( {}, entry, { 'aggregateGrade': agg.aggregateGrade, 'grade': agg.aggregateGrade, 'rawGrade': agg.rawGrade, 'normalizedScore': agg.normalizedScore, 'gradingMode': 'full' } )

                    const { filename } = Grading.formatGradingFilename( { area, timestamp } )
                    // about-namespace → <schema>/resources/about/_gradings/
                    // namespace-skills → <schema>/skills/<skill>/_gradings/ (first declared skill)
                    const dir = area === 'about-namespace'
                        ? join( namespaceDir, schemaDir, 'resources', 'about', '_gradings' )
                        : join( namespaceDir, schemaDir, 'skills', FlowMcpCli.#resolveIslandSkillName( { 'schemaDirPath': join( namespaceDir, schemaDir ) } ), '_gradings' )
                    await mkdir( dir, { 'recursive': true } )
                    await FsUtils.writeAtomic( { 'path': join( dir, filename ), 'content': JSON.stringify( stamped, null, 4 ), 'onConflict': 'overwrite' } )
                    return areaCount + 1
                } ), Promise.resolve( 0 ) )

            return { 'status': true, written }
        } catch( err ) {
            return { 'status': false, 'error': `GRD-003 writePersonaNamespaceGradings: ${err.message}` }
        }
    }


    // Memo 141 — the skill name for a namespace-skills grading dir. Prefer an existing
    // island skill dir under <schema>/skills/; else fall back to a stable 'default'
    // bucket (no silent drop — the grading is still written and RebuildIndex reads it).
    static #resolveIslandSkillName( { schemaDirPath } ) {
        const skillsRoot = join( schemaDirPath, 'skills' )
        if( existsSync( skillsRoot ) === false ) { return 'default' }
        const existing = readdirSync( skillsRoot, { 'withFileTypes': true } )
            .filter( ( e ) => e.isDirectory() === true )
            .map( ( e ) => e.name )
            .sort()
            .find( ( name ) => true )
        return existing !== undefined ? existing : 'default'
    }


    static async #gradingConsumeScores( { cwd, grading, gradingDataRoot, flow, targetDir, target, scopeName = null, consumeScores, conflict, gradingDataDir, gradingExportDir, dryRun = false, dependencyChain } ) {
        const scoped = scopeName !== null && scopeName !== undefined
        // Memo 112 — schema-scoped consume reads the ISOLATED per-schema emit
        // (_schema/<name>/state.json), so a sub-agent validates ONLY its own schema.
        const stateDir = scoped ? join( targetDir, '_schema', scopeName ) : targetDir
        const scoresPath = resolve( cwd, consumeScores )
        if( existsSync( scoresPath ) === false ) {
            return { 'result': CliOutput.error( { 'error': `Scores file not found: ${scoresPath}`, 'fix': 'Pass the path written by the harness Stage 2.' } ) }
        }

        const { data: scoresDoc } = await FsUtils.readJson( { 'filePath': scoresPath } )
        if( scoresDoc === null ) {
            return { 'result': CliOutput.error( { 'error': `Invalid JSON in scores file: ${scoresPath}`, 'fix': 'Fix the JSON syntax (a parser could not read it) and run the command again.' } ) }
        }
        if( Array.isArray( scoresDoc[ 'scores' ] ) === false ) {
            return { 'result': CliOutput.error( { 'error': 'Invalid scores format: "scores" must be an array.', 'fix': 'Keep the "scores": [] field from the template and run the command again.' } ) }
        }

        const statePath = join( stateDir, 'state.json' )
        const { data: prevState } = await FsUtils.readJson( { 'filePath': statePath } )

        // PRD-007 — verify the multi-area Task-ID payload (additive; legacy scores
        // without a taskId skip this and proceed). A mismatch is a hard Reject.
        const verify = FlowMcpCli.#verifyConsumePayload( { grading, scoresDoc, 'state': prevState } )
        if( verify.status === false ) {
            return { 'result': CliOutput.error( { 'error': `Consume rejected: ${verify.error}`, 'fix': 'Return the exact emitted Task-ID and area-set with matching per-area result counts, then run the command again.' } ) }
        }

        // Memo 112 — schema-scoped consume: validate this schema's scores against its
        // isolated emit (Task-ID + per-area result count), PERSIST them next to the
        // scoped state, and STOP. The namespace rollup (index + grade.json) runs ONCE
        // at namespace level — never per schema (that would race on the shared index).
        // This is the feedback the sub-agent's loop needs: a clear accept or a clear
        // parse/Task-ID/count error to fix and re-submit.
        if( scoped === true ) {
            if( dryRun === true ) {
                return { 'result': { 'status': true, 'stage': 3, 'mode': 'consume-scores', 'saved': false, scoped, flow, target, 'acceptedAreas': verify.acceptedAreas, 'taskComplete': verify.complete, 'scoreCount': scoresDoc[ 'scores' ].length, dependencyChain } }
            }
            // Convert the validated per-tool scores into the on-disk _gradings/ entries
            // that RebuildIndex reads (one single-test entry per tool, in the tool's own
            // _gradings dir — parallel-safe). The namespace rollup (RebuildIndex +
            // ProviderProof) runs ONCE at namespace level, never here.
            const gradingsWrite = await FlowMcpCli.#writeSchemaGradingsFromScores( { grading, scoresDoc, 'namespaceDir': targetDir, 'schemaName': scopeName } )
            if( gradingsWrite.status === false ) {
                return { 'result': CliOutput.error( { 'error': `Could not write gradings for ${scopeName}: ${gradingsWrite.error}`, 'fix': 'Fix the scores file (scores must be 1–5 or n/a per question) and run the command again.' } ) }
            }

            const now = new Date().toISOString()
            const savedPath = join( stateDir, 'scores.json' )
            await FsUtils.writeAtomic( { 'path': savedPath, 'content': JSON.stringify( scoresDoc, null, 4 ), 'onConflict': 'overwrite' } )
            const scopedState = prevState === null ? { target, scopeName } : prevState
            scopedState[ 'status' ] = 'scored'
            scopedState[ 'lastUpdatedAt' ] = now
            scopedState[ 'consumedAreas' ] = verify.acceptedAreas
            scopedState[ 'taskComplete' ] = verify.complete
            scopedState[ 'gradingsWritten' ] = gradingsWrite.written
            await FsUtils.writeAtomic( { 'path': statePath, 'content': JSON.stringify( scopedState, null, 4 ), 'onConflict': 'overwrite' } )
            return { 'result': { 'status': true, 'stage': 3, 'mode': 'consume-scores', 'saved': true, scoped, flow, target, 'scoresPath': FlowMcpCli.#toRepoRelativePath( { cwd, 'path': savedPath } ), 'gradingsWritten': gradingsWrite.written, 'acceptedAreas': verify.acceptedAreas, 'taskComplete': verify.complete, 'scoreCount': scoresDoc[ 'scores' ].length, dependencyChain } }
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

        // Persist the namespace-area scores BEFORE the rebuild — the missing
        // counterpart to the scoped per-schema writer. Without it the rebuild reads an
        // empty namespace _gradings/ and tools-aggregate-namespace / namespace-description
        // stay pending forever (accepted-but-dropped). Provider flow only; selection
        // areas are not namespace-root areas.
        if( flow === 'provider' ) {
            const nsWrite = await FlowMcpCli.#writeNamespaceGradingsFromScores( { grading, scoresDoc, 'namespaceDir': targetDir, 'namespace': basename( targetDir ) } )
            if( nsWrite.status === false ) {
                return { 'result': CliOutput.error( { 'error': `Could not write namespace gradings for ${target}: ${nsWrite.error}`, 'fix': 'Fix the scores file (scores must be 1–5 or "n/a" per question) and run the command again.' } ) }
            }
            // Memo 141 — persist the persona-required namespace areas (about-namespace,
            // namespace-skills) into their schema-scoped _gradings, where RebuildIndex
            // reads them. Without this they are accepted-but-dropped (every namespace
            // stays about:pending). about-namespace is the About-Persona-Scoring payoff.
            const personaWrite = await FlowMcpCli.#writePersonaNamespaceGradings( { grading, scoresDoc, 'namespaceDir': targetDir } )
            if( personaWrite.status === false ) {
                return { 'result': CliOutput.error( { 'error': `Could not write persona-area gradings for ${target}: ${personaWrite.error}`, 'fix': 'Ensure the namespace has an island schema dir and the scores carry 1–5 (or "n/a") per question, then run the command again.' } ) }
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
                return { 'result': CliOutput.error( { 'error': proof.error, 'fix': proof.fix } ) }
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

        await FsUtils.writeGuarded( { 'path': statePath, 'content': JSON.stringify( stateDoc, null, 4 ), 'onExists': 'overwrite' } )

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
        } catch( err ) {
            CliOutput.emitCoded( { 'code': 'SCH-007', 'location': 'listGradingSchemaDirs: target dir read failed', err } )
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
        const { sources } = await SchemaSource.listSources()
        const matched = []
        const loadErrors = []

        // Flatten (source, schemaInfo) pairs so the cheap namespace probe and the
        // expensive compile can be separated.
        const pairs = sources
            .reduce( ( acc, source ) => {
                const list = source[ 'schemas' ] === undefined ? [] : source[ 'schemas' ]
                list
                    .forEach( ( schemaInfo ) => { acc.push( { source, schemaInfo } ) } )
                return acc
            }, [] )

        // O(N^2) fix: grading one schema must not IMPORT every schema in
        // schemaFolders[] just to read main.namespace. Narrow the candidate set with
        // a cheap text probe first — read each file and regex its declared namespace
        // string(s). A file is a candidate when the target namespace appears OR when
        // no namespace string can be read (unknown -> compile to stay correct). This
        // catches folder != namespace and multi-folder namespaces without false
        // exclusions; main.namespace below remains the authoritative gate.
        const candidates = await pairs
            .reduce( ( promise, pair ) => promise.then( async ( acc ) => {
                const { source, schemaInfo } = pair
                const { filePath } = await SchemaSource.resolveSchemaPath( { 'schemaRef': `${source[ 'name' ]}/${schemaInfo[ 'file' ]}` } )
                let isCandidate = true
                try {
                    const text = await readFile( filePath, 'utf-8' )
                    const found = [ ...text.matchAll( /namespace\s*:\s*['"]([a-z][a-z0-9-]*)['"]/g ) ]
                        .map( ( match ) => match[ 1 ] )
                    isCandidate = found.length === 0 || found.includes( namespace )
                } catch( err ) {
                    CliOutput.emitCoded( { 'code': 'SCH-008', 'location': 'resolveSchemasForTarget: namespace probe read failed', err } )
                    isCandidate = true
                }
                if( isCandidate ) { acc.push( { source, schemaInfo, filePath } ) }
                return acc
            } ), Promise.resolve( [] ) )

        await candidates
            .reduce( ( promise, candidate ) => promise.then( async () => {
                const { source, schemaInfo, filePath } = candidate
                const { file } = schemaInfo
                const { main, handlersFn, error } = await SchemaLoaderBridge.loadSchema( { filePath } )

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
        const { data: index } = await FsUtils.readJson( { 'filePath': indexPath } )
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


    // Memo 112 P6.1 — `grading finalize <ns>`: the Austritts-Rollup. A thin wrapper
    // around the proven RebuildIndex -> ProviderProof sequence (`#deterministicRollup`),
    // PLUS the Recommendation (the same worklist `plan` reports). Bare namespace only
    // (no ns/schema): finalize rolls up a whole namespace. NO SILENT DEFAULT.
    static async gradingFinalize( { cwd, target, gradingDataDir, gradingExportDir = null, targetGrade = null, json } ) {
        const grading = await FlowMcpCli.#loadGradingModule()
        if( grading === null ) {
            return { 'result': CliOutput.error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }
        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': CliOutput.error( { 'error': 'Missing finalize target.', 'fix': `Usage: ${appConfig[ 'cliCommand' ]} grading finalize <namespace> [--target <grade>]` } ) }
        }
        if( target.includes( '/' ) ) {
            return { 'result': CliOutput.error( { 'error': `finalize operates on a bare namespace, not "${target}".`, 'fix': `Use the namespace only, e.g. ${appConfig[ 'cliCommand' ]} grading finalize ${target.split( '/' )[ 0 ]}` } ) }
        }

        const gradingDataRoot = await FlowMcpCli.#gradingDataRoot( { cwd, gradingDataDir } )
        const rollup = await FlowMcpCli.#deterministicRollup( { cwd, grading, gradingDataRoot, gradingExportDir, 'namespace': target } )
        if( rollup.status !== true ) {
            return { 'result': CliOutput.error( { 'error': rollup.error, 'fix': rollup.fix } ) }
        }

        const recommendation = await FlowMcpCli.#computeGradingWorklist( { cwd, grading, gradingDataRoot, 'namespace': target, targetGrade } )
        if( recommendation.status !== true ) {
            return { 'result': CliOutput.error( { 'error': recommendation.error, 'fix': recommendation.fix } ) }
        }

        return {
            'result': {
                'status': true,
                'mode': 'finalize',
                'namespace': target,
                'target': targetGrade,
                'indexPath': rollup.indexPath,
                'proofPath': rollup.proofPath,
                'rollupStatus': rollup.rollupStatus,
                'rollupGrade': rollup.rollupGrade,
                'recommendation': { 'worklist': recommendation.worklist, 'skip': recommendation.skip }
            }
        }
    }


    // Memo 112 P6.2 — `grading plan <ns>`: the read-only Eintritts-Worklist. Reports
    // the SAME worklist as finalize: which schemas need (re-)grading (ungraded OR the
    // schemaHash drifted OR — with --target — below the target grade), and which are
    // skipped (fresh / at-or-above target). Writes NOTHING. NO SILENT DEFAULT.
    static async gradingPlan( { cwd, target, gradingDataDir, targetGrade = null, json } ) {
        const grading = await FlowMcpCli.#loadGradingModule()
        if( grading === null ) {
            return { 'result': CliOutput.error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }
        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': CliOutput.error( { 'error': 'Missing plan target.', 'fix': `Usage: ${appConfig[ 'cliCommand' ]} grading plan <namespace> [--target <grade>]` } ) }
        }
        if( target.includes( '/' ) ) {
            return { 'result': CliOutput.error( { 'error': `plan operates on a bare namespace, not "${target}".`, 'fix': `Use the namespace only, e.g. ${appConfig[ 'cliCommand' ]} grading plan ${target.split( '/' )[ 0 ]}` } ) }
        }

        const gradingDataRoot = await FlowMcpCli.#gradingDataRoot( { cwd, gradingDataDir } )
        const worklist = await FlowMcpCli.#computeGradingWorklist( { cwd, grading, gradingDataRoot, 'namespace': target, targetGrade } )
        if( worklist.status !== true ) {
            return { 'result': CliOutput.error( { 'error': worklist.error, 'fix': worklist.fix } ) }
        }

        return {
            'result': {
                'status': true,
                'mode': 'plan',
                'namespace': target,
                'target': targetGrade,
                'worklist': worklist.worklist,
                'skip': worklist.skip
            }
        }
    }


    // Memo 112 P6.2 — the shared staleness worklist used by BOTH plan and finalize.
    // For every LIVE schema of the namespace it decides one of two buckets:
    //   worklist (needs grading): ungraded | stale (stored schemaHash != live) |
    //                             under-target (grade below --target)
    //   skip (no work):           fresh (stored hash == live) and at/above target
    // The stored hash is read from the latest tools-aggregate `_gradings` entry the
    // schema's index node references; the live hash via HashGenerator.computeSchemaHash.
    // A graded schema WITHOUT a stored hash (legacy grade) is NOT treated as stale —
    // re-grading is opt-in via edit (Quality-Bar not lowered) — but it is flagged.
    // NO SILENT DEFAULT: an unresolvable namespace is a coded error.
    static #gradeRank( { grade } ) {
        const ranks = { 'A': 5, 'B': 4, 'C': 3, 'D': 2, 'F': 1 }
        return typeof grade === 'string' && ranks[ grade ] !== undefined ? ranks[ grade ] : 0
    }


    static async #computeGradingWorklist( { cwd, grading, gradingDataRoot, namespace, targetGrade = null } ) {
        const HashGenerator = grading[ 'HashGenerator' ]
        if( HashGenerator === undefined || HashGenerator === null ) {
            return { 'status': false, 'error': 'flowmcp-grading too old: HashGenerator not exported; staleness cannot be computed.', 'fix': 'Update the flowmcp-grading dependency.' }
        }

        const resolved = await FlowMcpCli.#resolveSchemasForTarget( { namespace } )
        if( resolved.status !== true ) {
            return { 'status': false, 'error': resolved.error, 'fix': resolved.fix }
        }

        const namespaceDir = join( gradingDataRoot, 'providers', namespace )
        const { data: index } = await FsUtils.readJson( { 'filePath': join( namespaceDir, 'index.json' ) } )
        const indexSchemas = index !== null && index[ 'schemas' ] !== undefined ? index[ 'schemas' ] : {}
        const targetRank = targetGrade === null ? null : FlowMcpCli.#gradeRank( { 'grade': targetGrade } )

        const worklist = []
        const skip = []

        await resolved.schemas
            .reduce( ( promise, schema ) => promise.then( async () => {
                const node = indexSchemas[ schema.schemaName ] === undefined ? null : indexSchemas[ schema.schemaName ]
                const grade = node !== null && typeof node[ 'grade' ] === 'string' ? node[ 'grade' ] : null
                const isGraded = node !== null && node[ 'status' ] === 'graded' && grade !== null

                if( isGraded === false ) {
                    worklist.push( { 'schema': schema.schemaName, 'reason': 'ungraded', grade } )
                    return
                }

                const liveHash = HashGenerator.computeSchemaHash( { 'schema': schema.main } ).hash
                const storedHash = await FlowMcpCli.#readStoredSchemaHash( { namespaceDir, node } )
                const underTarget = targetRank !== null && FlowMcpCli.#gradeRank( { grade } ) < targetRank

                // Stale only when BOTH hashes are known and differ. A null live hash
                // (schema not canonicalizable) or a missing stored hash (legacy grade)
                // is treated as not-stale — never a silent re-grade of the whole island.
                if( storedHash !== null && liveHash !== null && storedHash !== liveHash ) {
                    worklist.push( { 'schema': schema.schemaName, 'reason': 'stale', grade } )
                    return
                }
                if( underTarget === true ) {
                    worklist.push( { 'schema': schema.schemaName, 'reason': 'under-target', grade } )
                    return
                }
                skip.push( { 'schema': schema.schemaName, grade, 'hashVerified': storedHash !== null } )
            } ), Promise.resolve() )

        return { 'status': true, worklist, skip }
    }


    // Read the schemaHash a schema's grade was recorded with, from the tools-aggregate
    // `_gradings` entry the index node points at. Returns null when the entry, the ref,
    // or the field is absent (legacy grade) — never a silent default.
    static async #readStoredSchemaHash( { namespaceDir, node } ) {
        const ref = node !== null
            && node[ 'toolsAggregate' ] !== undefined
            && node[ 'toolsAggregate' ] !== null
            && typeof node[ 'toolsAggregate' ][ 'ref' ] === 'string'
            ? node[ 'toolsAggregate' ][ 'ref' ]
            : null
        if( ref === null ) { return null }
        const { data: entry } = await FsUtils.readJson( { 'filePath': join( namespaceDir, ref ) } )
        if( entry === null ) { return null }
        return typeof entry[ 'schemaHash' ] === 'string' && entry[ 'schemaHash' ].length > 0 ? entry[ 'schemaHash' ] : null
    }


    // Memo 112 P6.2 — best-effort live schemaHash for one schema, used by the
    // non-deterministic consume path to persist the hash. The namespace is derived
    // from the island namespace dir (providers/<ns>). Returns null on any miss (module
    // absent, schema not resolvable, uncanonicalizable) — never throws into consume.
    static async #liveSchemaHashFor( { HashGenerator, namespaceDir, schemaName } ) {
        if( HashGenerator === undefined || HashGenerator === null ) { return null }
        const namespace = basename( namespaceDir )
        const resolved = await FlowMcpCli.#resolveSchemasForTarget( { namespace } )
        if( resolved.status !== true ) { return null }
        const match = resolved.schemas.find( ( s ) => s.schemaName === schemaName )
        if( match === undefined ) { return null }
        const computed = HashGenerator.computeSchemaHash( { 'schema': match.main } ).hash
        return typeof computed === 'string' && computed.length > 0 ? computed : null
    }


    static async gradingState( { cwd, target, gradingDataDir, json } ) {
        const grading = await FlowMcpCli.#loadGradingModule()
        if( grading === null ) {
            return { 'result': CliOutput.error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }

        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': CliOutput.error( { 'error': 'Missing state target.', 'fix': 'Usage: flowmcp grading state <namespace|selection>' } ) }
        }

        const gradingDataRoot = await FlowMcpCli.#gradingDataRoot( { cwd, gradingDataDir } )
        const detected = await FlowMcpCli.#resolveGradingTarget( { cwd, gradingDataRoot, target } )
        if( detected.status !== true ) {
            return { 'result': CliOutput.error( { 'error': detected.error, 'fix': detected.fix } ) }
        }

        const indexPath = join( detected.targetDir, 'index.json' )
        const statePath = join( detected.targetDir, 'state.json' )
        const { data: index } = await FsUtils.readJson( { 'filePath': indexPath } )
        const { data: state } = await FsUtils.readJson( { 'filePath': statePath } )

        // PRD-010 — the graph-driven nextAction block, identical on state + doctor.
        const nextAction = await FlowMcpCli.#computeNextAction( { grading, detected, target } )

        // Memo 112 — per-schema progress from the isolated `_schema/<name>/` states,
        // so a parallel per-schema grading run is checkable: which schemas are scored,
        // under which run-id, how many remain.
        const schemaProgress = await FlowMcpCli.#readSchemaProgress( { 'targetDir': detected.targetDir } )

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
                'runId': state === null ? null : ( state[ 'runId' ] || null ),
                'lastUpdatedAt': state === null ? null : state[ 'lastUpdatedAt' ],
                indexPath,
                statePath,
                'indexPresent': index !== null,
                'statePresent': state !== null,
                schemaProgress,
                nextAction
            }
        }
    }


    // Memo 112 — read the per-schema progress for a namespace from the isolated
    // `_schema/<name>/state.json` files the scoped emit/consume write. Returns each
    // schema's status + run-id, plus a scored/total tally. NO silent default: a
    // missing `_schema/` dir means "no per-schema run yet" (empty, total 0).
    static async #readSchemaProgress( { targetDir } ) {
        const schemaRoot = join( targetDir, '_schema' )
        if( existsSync( schemaRoot ) === false ) {
            return { 'schemas': [], 'scored': 0, 'total': 0 }
        }
        const entries = await readdir( schemaRoot, { 'withFileTypes': true } )
        const dirs = entries
            .filter( ( e ) => e.isDirectory() === true )
            .map( ( e ) => e.name )
            .sort()
        const schemas = await dirs
            .reduce( ( promise, name ) => promise.then( async ( acc ) => {
                const { data: st } = await FsUtils.readJson( { 'filePath': join( schemaRoot, name, 'state.json' ) } )
                acc.push( {
                    'schema': name,
                    'status': st === null ? 'pending' : ( st[ 'status' ] || 'pending' ),
                    'runId': st === null ? null : ( st[ 'runId' ] || null ),
                    'taskComplete': st !== null && st[ 'taskComplete' ] === true
                } )
                return acc
            } ), Promise.resolve( [] ) )
        const scored = schemas.filter( ( s ) => s.status === 'scored' ).length

        return { schemas, scored, 'total': schemas.length }
    }


    // Memo 097 Kap. 3 (PA-3) — flat, deduplicated error/improvement worklist for
    // one namespace. A sub-agent abarbeitet this list directly. Sources merged:
    //   - prompts.json -> pretests[].errors  (DPT-003 abort, DPT-004 test-fail /
    // `grading skill <ns|selection>` — print the emitted Emit-Skill TEXT (read-only).
    // The non-deterministic emit writes the self-contained skill into the island
    // prompts.json (field `emitSkill`); this command reads it back and returns the
    // raw text so the operator never has to dig the field out of the machine JSON by
    // hand. NO SILENT DEFAULT: a missing prompts.json (never emitted) or a stale
    // artifact without an `emitSkill` field is a clear coded error, not empty output.
    static async gradingSkill( { cwd, target, gradingDataDir } ) {
        const grading = await FlowMcpCli.#loadGradingModule()
        if( grading === null ) {
            return { 'result': CliOutput.error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }
        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': CliOutput.error( { 'error': 'Missing skill target.', 'fix': 'Usage: flowmcp grading skill <namespace|selection>' } ) }
        }

        const gradingDataRoot = await FlowMcpCli.#gradingDataRoot( { cwd, gradingDataDir } )
        const detected = await FlowMcpCli.#resolveGradingTarget( { cwd, gradingDataRoot, target } )
        if( detected.status !== true ) {
            return { 'result': CliOutput.error( { 'error': detected.error, 'fix': detected.fix } ) }
        }

        const promptsPath = join( detected.targetDir, 'prompts.json' )
        const { data: prompts } = await FsUtils.readJson( { 'filePath': promptsPath } )
        if( prompts === null ) {
            return { 'result': CliOutput.error( { 'error': `No emitted skill found for "${target}" (no prompts.json in the island).`, 'fix': `Emit it first: ${appConfig[ 'cliCommand' ]} grading non-deterministic ${target} --emit-prompts` } ) }
        }

        const skill = prompts[ 'emitSkill' ]
        if( typeof skill !== 'string' || skill.length === 0 ) {
            return { 'result': CliOutput.error( { 'error': `The emitted prompts.json for "${target}" carries no emit-skill (stale artifact from before the self-contained Emit-Skill).`, 'fix': `Re-emit to refresh it: ${appConfig[ 'cliCommand' ]} grading non-deterministic ${target} --emit-prompts --on-conflict=overwrite` } ) }
        }

        return {
            'result': {
                'status': true,
                target,
                'taskId': prompts[ 'taskId' ] === undefined ? null : prompts[ 'taskId' ],
                'emittedAreaSet': prompts[ 'emittedAreaSet' ] === undefined ? null : prompts[ 'emittedAreaSet' ],
                'promptsPath': FlowMcpCli.#toRepoRelativePath( { cwd, 'path': promptsPath } ),
                skill
            }
        }
    }


    //     not-downloadable, DPT-005 missing requiredServerParam — KEY NAME only,
    //     never the value; the emit stage already strips values)
    //   - index.json   -> blockers[]         (import / rebuild errors: {node,reason})
    // Output: a flat array [{ namespace, area|schema, code, message, hint? }].
    // NO SILENT DEFAULT: if the namespace has no prompts.json (never emitted), the
    // command returns a clear coded error instead of pretending an empty worklist.
    static async gradingWorklist( { cwd, target, gradingDataDir, json } ) {
        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': CliOutput.error( { 'error': 'Missing worklist target.', 'fix': 'Usage: flowmcp grading worklist <namespace> --json' } ) }
        }

        const gradingDataRoot = await FlowMcpCli.#gradingDataRoot( { cwd, gradingDataDir } )
        const detected = await FlowMcpCli.#resolveGradingTarget( { cwd, gradingDataRoot, target } )
        if( detected.status !== true ) {
            return { 'result': CliOutput.error( { 'error': detected.error, 'fix': detected.fix } ) }
        }

        // PRD-009 — `worklist` is subsumed into `doctor`: the deterministic
        // collection logic lives in ONE shared private collector. `worklist` is
        // retained as a thin wrapper (Never-delete-legacy) returning the same flat
        // array shape as before, OR the WL-001/WL-002 coded error unchanged.
        const collected = await FlowMcpCli.#collectDeterministicDefects( { detected, target } )
        if( collected.status !== true ) {
            return { 'result': CliOutput.error( { 'error': collected.error, 'fix': collected.fix } ) }
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

        const { data: prompts } = await FsUtils.readJson( { 'filePath': promptsPath } )
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
                const { code, message } = CliOutput.splitErrorCode( { raw } )
                items.push( { 'namespace': target, 'schema': schemaName, code, message } )
            } )
        } )

        // 2. Import / rebuild blockers (per-node), if present.
        const { data: index } = await FsUtils.readJson( { 'filePath': indexPath } )
        const blockers = index !== null && Array.isArray( index[ 'blockers' ] ) ? index[ 'blockers' ] : []
        blockers.forEach( ( blocker ) => {
            const node = typeof blocker[ 'node' ] === 'string' ? blocker[ 'node' ] : null
            const reason = typeof blocker[ 'reason' ] === 'string' ? blocker[ 'reason' ] : null
            if( reason === null ) { return }
            const { code, message } = CliOutput.splitErrorCode( { 'raw': reason } )
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
            return { 'result': CliOutput.error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }

        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': CliOutput.error( { 'error': 'Missing doctor target.', 'fix': 'Usage: flowmcp grading doctor <namespace>' } ) }
        }

        const gradingDataRoot = await FlowMcpCli.#gradingDataRoot( { cwd, gradingDataDir } )
        const detected = await FlowMcpCli.#resolveGradingTarget( { cwd, gradingDataRoot, target } )
        if( detected.status !== true ) {
            return { 'result': CliOutput.error( { 'error': detected.error, 'fix': detected.fix } ) }
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
                return { 'result': CliOutput.error( { 'error': collected.error, 'fix': collected.fix } ) }
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
                catch( err ) {
                    CliOutput.emitCoded( { 'code': 'CLI-027', 'location': 'collectLastTips: grading entry read failed', err } )
                    return
                }

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
        catch( err ) {
            CliOutput.emitCoded( { 'code': 'GRD-004', 'location': 'gradingsLogicalName: gradings dir read failed', err } )
            return ''
        }
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
        catch( err ) {
            CliOutput.emitCoded( { 'code': 'GRD-005', 'location': 'findGradingsDirs: dir read failed', err } )
            return []
        }

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
        const { data: prompts } = await FsUtils.readJson( { 'filePath': promptsPath } )
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

        // Split ready areas by their data-driven classification. Befund I-4: a
        // `both`-classified area carries a deterministic gate (done for free by the
        // CLI) AND a non-deterministic LLM round, so it appears in BOTH buckets — the
        // free det part is surfaced as deterministicNow, the descriptive questions
        // bundle into the non-det emit. `deterministic` -> det only, `non-deterministic`
        // -> nonDet only.
        const classified = readyAreas
            .reduce( ( acc, name ) => {
                const c = AreaDependencyGraph.classifyArea( { 'graph': loaded.graph, 'area': name } )
                if( c.errors.length > 0 ) { acc.errors.push( c.errors.join( '; ' ) ); return acc }
                if( c.classification === 'deterministic' || c.classification === 'both' ) { acc.det.push( name ) }
                if( c.classification === 'non-deterministic' || c.classification === 'both' ) { acc.nonDet.push( name ) }
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



    static async __testWriteGuarded( { path, content, onExists } ) {
        return FsUtils.writeGuarded( { path, content, onExists } )
    }




}


export { FlowMcpCli, CliError }
