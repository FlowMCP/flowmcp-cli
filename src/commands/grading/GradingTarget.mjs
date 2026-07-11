/**
 * FlowMCP — MIT License
 *
 * Memo 152 / PRD-019 (D-10) — grading-bridge module split. Extracted VERBATIM
 * from FlowMcpCli.mjs; bodies are byte-identical, cross-module references route
 * through the sibling grading modules / core (public statics). FlowMcpCli keeps
 * thin delegation facades for the routed entry points (F12=A).
 */

import { readFile, writeFile, mkdir, readdir, stat, access, unlink, rename } from 'node:fs/promises'
import { join, resolve, basename, extname, dirname, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'

import chalk from 'chalk'
import { FlowMCP, SkillValidator, SelectionValidator, CatalogIndex, IdResolver } from 'flowmcp'

import { appConfig } from '../../data/config.mjs'
import { PathVariableResolver } from '../../path/resolvePathVariables.mjs'
import { SqliteGtfsRuntime } from '../../addons/SqliteGtfsRuntime.mjs'
import { ModuleRegistry } from '../../lib/ModuleRegistry.mjs'
import { CliOutput, CliError } from '../../lib/CliOutput.mjs'
import { FsUtils } from '../../lib/FsUtils.mjs'
import { ConfigStore } from '../../lib/ConfigStore.mjs'
import { SchemaSource } from '../../lib/SchemaSource.mjs'
import { EnvResolver } from '../../lib/EnvResolver.mjs'
import { NamespaceIndex } from '../../lib/NamespaceIndex.mjs'
import { HandlerResolver } from '../../lib/HandlerResolver.mjs'
import { SchemaLoaderBridge } from '../../lib/SchemaLoaderBridge.mjs'
import { ValidateCommand } from '../ValidateCommand.mjs'
import { ListsCommand } from '../ListsCommand.mjs'
import { GradingConsume } from './GradingConsume.mjs'
import { GradingEmit } from './GradingEmit.mjs'
import { GradingDeterministic } from './GradingDeterministic.mjs'
import { GradingStatus } from './GradingStatus.mjs'


class GradingTarget {
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
    static async gradingDataRoot( { cwd, gradingDataDir } ) {
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
    static async gradingUseKeys( { withKeys } ) {
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
        const resolvedDataRoot = await GradingTarget.gradingDataRoot( { cwd, 'gradingDataDir': null } )
        const resolvedExportRoot = await GradingTarget.gradingExportRoot( { cwd, 'gradingExportDir': null, 'gradingDataRoot': resolvedDataRoot } )

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
    static async gradingExportRoot( { cwd, gradingExportDir, gradingDataRoot } ) {
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
    static toRepoRelativePath( { cwd, path } ) {
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
    static relativizeMessagePaths( { cwd, message } ) {
        if( typeof message !== 'string' || message.length === 0 ) { return message }
        return message
            .split( ' ' )
            .map( ( token ) => {
                const stripped = token.replace( /[.,;:]+$/, '' )
                const trailing = token.slice( stripped.length )
                if( !isAbsolute( stripped ) ) { return token }
                return `${GradingTarget.toRepoRelativePath( { cwd, path: stripped } )}${trailing}`
            } )
            .join( ' ' )
    }


    // F29 flow detection — provider vs selection by which island tree holds the
    // target. Ambiguity (in both / in neither) is a hard error with a copyable
    // fix (an explicit path). No silent default.
    static async detectGradingFlow( { gradingDataRoot, target } ) {
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
            const resolved = await GradingTarget.resolveSchemasForTarget( { 'namespace': target } )
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
    static async resolveGradingTarget( { cwd, gradingDataRoot, target } ) {
        const parsed = IdResolver.parseSpecId( { 'specId': target } )

        if( parsed.valid === false ) {
            return { 'status': false, 'error': parsed.error, 'fix': 'Pass a target as <namespace>, <namespace>/<schema-name> (1 slash = schema), <namespace>/tool/<name> (2 slashes = tool) or <namespace>/selection/<name>. Optional prefix "<source>:".' }
        }

        const { type, namespace, name, source } = parsed

        // selection stays a first-class grading target (F12 = A): route on the
        // selection name, NOT on the namespace.
        if( type === 'selection' ) {
            const detected = await GradingTarget.detectGradingFlow( { gradingDataRoot, 'target': name } )

            return { ...detected, 'specType': 'selection', 'scopeName': name, source }
        }

        // namespace or schema: the grading granularity is the namespace. For a schema
        // id the schema-name is carried as scope (no behavioural change in the island).
        if( type === 'namespace' || type === 'schema' ) {
            const detected = await GradingTarget.detectGradingFlow( { gradingDataRoot, 'target': namespace } )

            return { ...detected, 'specType': type, 'scopeName': type === 'schema' ? name : null, source }
        }

        // tool: resolve the tool id back to its namespace via the namespace index.
        if( type === 'tool' ) {
            const specId = `${namespace}/tool/${name}`
            const { index } = await NamespaceIndex.get( { cwd } )
            const toolEntry = index && index[ 'tools' ] ? index[ 'tools' ][ specId ] : undefined

            if( toolEntry === undefined ) {
                return {
                    'status': false,
                    'error': `Unknown tool id "${target}": no tool "${specId}" is registered in the configured schemaFolders[].`,
                    'fix': `Use the 2-slash tool form "<namespace>/tool/<name>" with a tool that exists (run "${appConfig[ 'cliCommand' ]} list" to see registered tools), or grade the whole provider with "${appConfig[ 'cliCommand' ]} grading deterministic ${namespace}".`
                }
            }

            const detected = await GradingTarget.detectGradingFlow( { gradingDataRoot, 'target': namespace } )
            const { warnings: collisionWarnings } = CatalogIndex.formatCollisionWarnings( { 'collisions': index ? index[ 'collisions' ] : [] } )

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
    static async resolveGradingDependencies( { gradingDataRoot, flow, target, targetDir, providerPath, dryRun = false } ) {
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
                const resolvedSchemas = await GradingTarget.resolveSchemasForTarget( { namespace } )
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
                const resolvedSchemas = await GradingTarget.resolveSchemasForTarget( { namespace } )
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
                const grading = await GradingTarget.loadGrading()
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
                const grading = await GradingTarget.loadGrading()
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
    static async resolveMissingSelectionMembers( { cwd, grading, gradingDataRoot, targetDir, target, memberSource, chain } ) {
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
                    const resolved = await GradingTarget.resolveSchemasForTarget( { 'namespace': memberNamespace } )
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


    // List the schema sub-folders of a provider/selection island (skip _gradings,
    // _exports, resources, skills, selection and JSON files at the root).
    static async listGradingSchemaDirs( { targetDir } ) {
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
    static async resolveSchemasForTarget( { namespace } ) {
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
    static async resolveSelectionSchemasLive( { targetDir } ) {
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
                    const resolved = await GradingTarget.resolveSchemasForTarget( { 'namespace': memberNamespace } )
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

    // Memo 152 / PRD-019 (D-10) — shared grading-module loader (GRD-001 wrapper),
    // formerly FlowMcpCli.#loadGradingModule. Returns null on import failure so
    // every grading entry point keeps the null-on-failure contract.
    static async loadGrading() {
        try {
            return await ModuleRegistry.getGrading()
        } catch( err ) {
            CliOutput.emitCoded( { 'code': 'GRD-001', 'location': 'loadGradingModule: flowmcp-grading import failed', err } )
            return null
        }
    }
}


export { GradingTarget }
