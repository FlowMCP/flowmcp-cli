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
import { constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'

import chalk from 'chalk'
import { FlowMCP, SkillValidator, SelectionValidator, CatalogIndex, IdResolver } from 'flowmcp'

import { appConfig } from '../data/config.mjs'
import { PathVariableResolver } from '../path/resolvePathVariables.mjs'
import { SqliteGtfsRuntime } from '../addons/SqliteGtfsRuntime.mjs'
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
import { SearchCommand } from '../commands/SearchCommand.mjs'
import { ListCommand } from '../commands/ListCommand.mjs'
import { CallCommand } from '../commands/CallCommand.mjs'
import { ServeCommand } from '../commands/ServeCommand.mjs'
import { ValidateCommand } from '../commands/ValidateCommand.mjs'
import { MigrateCommand } from '../commands/MigrateCommand.mjs'
import { InitCommand } from '../commands/InitCommand.mjs'
import { GradingTarget } from '../commands/grading/GradingTarget.mjs'
import { GradingDeterministic } from '../commands/grading/GradingDeterministic.mjs'
import { GradingEmit } from '../commands/grading/GradingEmit.mjs'
import { GradingConsume } from '../commands/grading/GradingConsume.mjs'
import { GradingStatus } from '../commands/grading/GradingStatus.mjs'


// TODO(next major): remove this delegation facade — the command/lib modules live
// in src/lib + src/commands (Memo 152 Phase 4). The facade is retained (F12=A) so
// the 80+ test suites that bind FlowMcpCli statically stay green through the split.
class FlowMcpCli {
    // Memo 152 / PRD-019 (D-08 cluster "init-install") — init + health/install helpers
    // moved to src/commands/InitCommand.mjs. init stays a public delegation (index.mjs).
    static async init( { cwd } ) {
        return InitCommand.init( { cwd } )
    }


    static async help( { cwd } ) {
        InitCommand.printHeadline()
        console.log( '' )

        const { checks } = await InitCommand.healthCheck( { cwd } )
        const { warnings } = InitCommand.formatHealthWarnings( { checks } )

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
        return ValidateCommand.schemas()
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
        return ValidateCommand.validate( { schemaPath, cwd } )
    }


    static async migrate( { schemaPath, cwd, all = false, dryRun = false } ) {
        return MigrateCommand.migrate( { schemaPath, cwd, all, dryRun } )
    }


    static validationMigrate( { schemaPath, all } ) {
        return MigrateCommand.validationMigrate( { schemaPath, all } )
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
        const { checks, healthy } = await InitCommand.healthCheck( { cwd } )

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


    // Memo 152 / PRD-019 (D-09 clusters "serve-mcp"+"group-resolution") — run + the group-
    // resolution helpers moved UNCHANGED to src/commands/ServeCommand.mjs (F18=A: --group ->
    // selection is PRD-020). run stays a public delegation (index.mjs + tests call it).
    static async run( { group, cwd } ) {
        return ServeCommand.run( { group, cwd } )
    }


    // Memo 152 / PRD-019 (D-09 cluster "call") — callListTools + callTool (and the private
    // helpers #isSpecId / #callResourceQuery / #resolveSchemaByIndex / #resolveSchemasForCall /
    // #matchToolInSchemas) moved to src/commands/CallCommand.mjs. Both stay public delegations
    // (index.mjs + tests call them).
    static async callListTools( { group, cwd } ) {
        return CallCommand.callListTools( { group, cwd } )
    }


    static async callTool( { toolName, jsonArgs, group, cwd, noCache = false, refresh = false } ) {
        return CallCommand.callTool( { toolName, jsonArgs, group, cwd, noCache, refresh } )
    }


    // Memo 152 / PRD-019 (D-09 cluster "search-list") — search + the schema-discovery/
    // enrichment helpers moved to src/commands/SearchCommand.mjs. search stays a public
    // delegation (index.mjs + tests call FlowMcpCli.search).
    static async search( { query } ) {
        return SearchCommand.search( { query } )
    }




    // Memo 152 / PRD-019 (D-09 cluster "search-list") — list moved to
    // src/commands/ListCommand.mjs. Stays a public delegation (index.mjs + tests call it).
    static async list( { cwd } ) {
        return ListCommand.list( { cwd } )
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


    // Memo 152 / PRD-019 (D-08) — generateCatalog moved to CatalogCommand.mjs.
    static async generateCatalog( { cwd } ) {
        return CatalogCommand.generateCatalog( { cwd } )
    }


    // Memo 152 / PRD-019 (D-08) — generateSkill moved to CatalogCommand.mjs.
    static async generateSkill( { toolId } ) {
        return CatalogCommand.generateSkill( { toolId } )
    }


    static validationValidate( { schemaPath } ) {
        return ValidateCommand.validationValidate( { schemaPath } )
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




    // Memo 152 / PRD-019 (D-08) — #healthCheck moved to src/commands/InitCommand.mjs.











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

    // Memo 152 / PRD-019 (D-09) — #parseToolRef moved to src/commands/ServeCommand.mjs.


    // Memo 152 / PRD-019 (D-09 cluster "call") — #isSpecId moved to CallCommand.

    // Memo 152 / PRD-019 (D-09) — #filterMainRoutes moved to src/commands/ServeCommand.mjs.


    // Memo 152 / PRD-019 (D-09 cluster "search-list") — #listAvailableTools /
    // #loadSharedAliases / #scoreToolMatch / #extractMetaFlags / #extractParameterDetails /
    // #generateCallExample moved to src/commands/SearchCommand.mjs (public static where call/
    // list/catalog share them). #extractParameters moved there too.


    // Memo 152 / PRD-012 (B-04) — buildToolName is now the public core v4 API
    // (FlowMCP.buildToolName), byte-identical to the former CLI copy. The MCP tool
    // name is `<route>_<namespace>` (snake_case, 63-char cap); the optional `source`
    // (schemaFolders[] name) is appended ONLY when `disambiguate === true`. Tool
    // names are a Wire-Contract — no silent rename.

    // Memo 152 / PRD-019 (D-09) — #disambiguateToolName moved to src/commands/ServeCommand.mjs.


    // Memo 152 / PRD-019 (D-08) — #createDemoSchema moved to src/commands/InitCommand.mjs.











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


    // Memo 152 / PRD-019 (D-09) — #resolveDefaultGroupSchemas moved to src/commands/ServeCommand.mjs.


    // Memo 152 / PRD-019 (D-09) — #resolveGroupName moved to src/commands/ServeCommand.mjs.


    // Memo 152 / PRD-019 (D-09) — #resolveGroupSchemas moved to src/commands/ServeCommand.mjs.


    // Memo 152 / PRD-019 (D-09) — #resolveToolRefs moved to src/commands/ServeCommand.mjs.





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


    // Memo 152 / PRD-019 (D-08) — #printHeadline moved to src/commands/InitCommand.mjs.



    // Memo 152 / PRD-019 (D-08) — #formatHealthWarnings moved to src/commands/InitCommand.mjs.


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


    // internal: test access only — PRD-006. validateOnlyFilter stays CLI-side (a pure
    // --only flag validator); Memo 152 / PRD-019 (F20) moved the test-runner
    // (getAllTestsTyped / executeTest / runTypedTests / computeDeclared /
    // aggregateByPrimitive) to flowmcp-grading DataPretest — those hooks are gone with it.
    static _testHook_validateOnlyFilter( { only } ) {
        return GradingDeterministic.validateOnlyFilter( { only } )
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


    // Memo 152 / PRD-019 (D-09) — #resolveActiveToolRefs moved to src/commands/ServeCommand.mjs.


    // Memo 152 / PRD-019 (D-09) — #resolveAgentSchemas moved to src/commands/ServeCommand.mjs.





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



    // Memo 152 / PRD-019 (D-10) — grading split; delegation facade (F12=A).
    static printDeterministicSummary( args ) {
        return GradingDeterministic.printDeterministicSummary( args )
    }

    // Memo 152 / PRD-019 (D-08) — #collectRequiredModules moved to src/commands/InitCommand.mjs.


    // Memo 152 / PRD-019 (D-08) — #buildInstallCommand moved to src/commands/InitCommand.mjs.


    // Memo 152 / PRD-019 (D-08) — #verifyModules moved to src/commands/InitCommand.mjs.


    // Memo 152 / PRD-019 (D-09) — #validateEnvParams moved to src/commands/ServeCommand.mjs.



    // Memo 152 / PRD-019 (D-08) — #findSchemaFiles moved to FsUtils.findSchemaFiles
    // (shared by the validate/schema-check and resource-migrate paths).


    // Memo 152 / PRD-019 (D-10) — the v4-surface access (#v4Module) and the grading
    // module loader (#loadGradingModule) moved out of the facade: grading modules
    // call ModuleRegistry.getV4() directly and GradingTarget.loadGrading() (the
    // GRD-001 wrapper). The __testInject* hooks below still route ModuleRegistry.inject.


    // Memo 152 / PRD-019 (D-08) — #enrichV4WithRuntimeMeta moved to src/commands/ValidateCommand.mjs.


    // Memo 152 / PRD-019 (D-08) — #v4ConsistencyErrors moved to src/commands/ValidateCommand.mjs.


    // Memo 152 / PRD-019 (D-08) — #validateSingleSchema moved to src/commands/ValidateCommand.mjs.


    // Memo 152 / PRD-019 (D-08) — #runSqliteGtfsResourceChecks moved to src/commands/ValidateCommand.mjs.






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


    // Memo 152 / PRD-019 (D-09 cluster "call") — #callResourceQuery moved to
    // src/commands/CallCommand.mjs.


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


    // Memo 152 / PRD-019 (D-09 cluster "call") — #resolveSchemaByIndex / #resolveSchemasForCall /
    // #matchToolInSchemas moved to src/commands/CallCommand.mjs.


    static __testOnly_parseSpecId( { specId } ) {
        return IdResolver.parseSpecId( { specId } )
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
                const decided = ServeCommand.disambiguateToolName( { baseName, routeName, namespace, source, registeredToolNames } )

                return { baseName, 'finalName': decided.finalName, 'skip': decided.skip, 'note': decided.note }
            } )

        return { plan, 'registeredNames': [ ...registeredToolNames ] }
    }


    static __testOnly_formatCollisions( { collisions } ) {
        return CatalogIndex.formatCollisionWarnings( { collisions } )
    }


    static async __testOnly_buildIndex( { schemas } ) {
        return CatalogIndex.build( { schemas } )
    }


    static async migrateConfig( { cwd, isGlobal = false, dryRun = false } ) {
        return MigrateCommand.migrateConfig( { cwd, isGlobal, dryRun } )
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


    // Test-only accessors (Memo 097 PA-5/PA-6). Do not use in production code.
    static async __testGradingUseKeys( { withKeys } ) {
        return GradingTarget.gradingUseKeys( { withKeys } )
    }


    static async __testGradingDataRoot( { cwd, gradingDataDir } ) {
        const root = await GradingTarget.gradingDataRoot( { cwd, gradingDataDir } )

        return { root }
    }


    // Memo 152 / PRD-019 (D-10) — grading split; delegation facade (F12=A).
    static async gradingConfig( args ) {
        return await GradingTarget.gradingConfig( args )
    }

    // Memo 152 / PRD-019 (D-10) — grading split; delegation facade (F12=A).
    static async gradingExport( args ) {
        return await GradingConsume.gradingExport( args )
    }

    // Memo 152 / PRD-019 (D-10) — grading split; delegation facade (F12=A).
    static async gradingRun( args ) {
        return await GradingEmit.gradingRun( args )
    }

    // Memo 152 / PRD-019 (D-10) — grading split; delegation facade (F12=A).
    static async gradingDeterministic( args ) {
        return await GradingDeterministic.gradingDeterministic( args )
    }

    // Memo 152 / PRD-019 (D-10) — grading split; delegation facade (F12=A).
    static async gradingReload( args ) {
        return await GradingDeterministic.gradingReload( args )
    }

    // Memo 152 / PRD-019 (D-10) — grading split; delegation facade (F12=A).
    static async gradingFinalize( args ) {
        return await GradingStatus.gradingFinalize( args )
    }

    // Memo 152 / PRD-019 (D-10) — grading split; delegation facade (F12=A).
    static async gradingPlan( args ) {
        return await GradingStatus.gradingPlan( args )
    }

    // Memo 152 / PRD-019 (D-10) — grading split; delegation facade (F12=A).
    static async gradingState( args ) {
        return await GradingStatus.gradingState( args )
    }

    // Memo 152 / PRD-019 (D-10) — grading split; delegation facade (F12=A).
    static async gradingSkill( args ) {
        return await GradingStatus.gradingSkill( args )
    }

    // Memo 152 / PRD-019 (D-10) — grading split; delegation facade (F12=A).
    static async gradingWorklist( args ) {
        return await GradingStatus.gradingWorklist( args )
    }

    // Memo 152 / PRD-019 (D-10) — grading split; delegation facade (F12=A).
    static async gradingDoctor( args ) {
        return await GradingStatus.gradingDoctor( args )
    }

    static async __testWriteGuarded( { path, content, onExists } ) {
        return FsUtils.writeGuarded( { path, content, onExists } )
    }




}


export { FlowMcpCli, CliError }
