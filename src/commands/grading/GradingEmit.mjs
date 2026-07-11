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
import { GradingTarget } from './GradingTarget.mjs'
import { GradingConsume } from './GradingConsume.mjs'
import { GradingDeterministic } from './GradingDeterministic.mjs'
import { GradingStatus } from './GradingStatus.mjs'


class GradingEmit {
    // Memo 152 / PRD-019 (F21) — CLI-flag parsers stay in the bridge (they run
    // before the grading module is required, so gradingRun's flag-validation error
    // paths never depend on the grading module surface). The Emit-Skill textbau
    // itself lives in flowmcp-grading (grading.GradingEmit.*).
    static resolveMaxIterations( { maxIterations } ) {
        if( maxIterations === null || maxIterations === undefined ) {
            return { 'maxIterations': 1, 'error': null }
        }
        const parsed = Number( maxIterations )
        if( Number.isInteger( parsed ) === false || parsed < 1 ) {
            return { 'maxIterations': null, 'error': `Invalid --max-iterations value: ${maxIterations}` }
        }

        return { 'maxIterations': parsed, 'error': null }
    }


    static resolveMaxTurns( { maxTurns } ) {
        if( maxTurns === null || maxTurns === undefined ) {
            return { 'maxTurns': 25, 'error': null }
        }
        const parsed = Number( maxTurns )
        if( Number.isInteger( parsed ) === false || parsed < 1 ) {
            return { 'maxTurns': null, 'error': `Invalid --max-turns value: ${maxTurns}` }
        }

        return { 'maxTurns': parsed, 'error': null }
    }


    static async gradingRun( { cwd, target, phase, runId = null, emitPrompts, consumeScores, onConflict, memberSource, gradingDataDir, gradingExportDir, maxIterations, maxTurns = null, withKeys, dryRun = false, quiet = false, json } ) {
        const grading = await GradingTarget.loadGrading()
        if( grading === null ) {
            return { 'result': CliOutput.error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }

        // NO SILENT DEFAULT: maxIterations is opt-in. Absent → 1 (single pass, the
        // documented default). A supplied value must parse to a positive integer.
        const { maxIterations: maxIterationsResolved, error: maxIterationsError } = GradingEmit.resolveMaxIterations( { maxIterations } )
        if( maxIterationsError !== null ) {
            return { 'result': CliOutput.error( { 'error': maxIterationsError, 'fix': 'Pass --max-iterations as a positive integer (default 1).' } ) }
        }

        // PRD-3.5 — the Goal-Block turn bound is configurable (was hardcoded 25). NO
        // SILENT DEFAULT: absent -> 25 (the documented default); a supplied value must
        // parse to a positive integer.
        const { maxTurns: maxTurnsResolved, error: maxTurnsError } = GradingEmit.resolveMaxTurns( { maxTurns } )
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
        const areaSelector = grading.GradingEmit.resolveAreaSelector( { phase, grading } )
        if( areaSelector.status === false ) {
            return { 'result': CliOutput.error( { 'error': areaSelector.error, 'fix': 'Pass --phase as a comma-separated set of known areas, or omit it for all applicable areas.' } ) }
        }

        const gradingDataRoot = await GradingTarget.gradingDataRoot( { cwd, gradingDataDir } )

        // F29 flow detection.
        const detected = await GradingTarget.resolveGradingTarget( { cwd, gradingDataRoot, target } )
        if( detected.status !== true ) {
            return { 'result': CliOutput.error( { 'error': detected.error, 'fix': detected.fix } ) }
        }

        // F16 dependency resolver (auto-chain / report / abort). The chain is
        // always returned in the result so the orchestration is auditable.
        const deps = await GradingTarget.resolveGradingDependencies( {
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
            const resolvedMembers = await GradingTarget.resolveMissingSelectionMembers( {
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
            const { useKeys } = await GradingTarget.gradingUseKeys( { withKeys } )

            return GradingEmit.gradingEmitPrompts( { cwd, grading, gradingDataRoot, 'flow': detected.flow, 'tier': detected.tier, 'maxGrade': detected.maxGrade, 'targetDir': detected.targetDir, target, 'scopeName': detected.scopeName, runId, areaSelector, conflict, 'maxIterations': maxIterationsResolved, 'maxTurns': maxTurnsResolved, useKeys, dryRun, quiet, 'dependencyChain': deps.chain } )
        }

        return GradingConsume.gradingConsumeScores( { cwd, grading, gradingDataRoot, 'flow': detected.flow, 'targetDir': detected.targetDir, target, 'scopeName': detected.scopeName, consumeScores, conflict, gradingDataDir, gradingExportDir, dryRun, 'dependencyChain': deps.chain } )
    }


    // Stage 1 — deterministic: Phase-0/1 wiring -> DataPretest.run -> emit the
    // /goal handoff (prompts.json + state.json baton). The CLI does NOT run
    // Agent() — Stage 2 lives in the harness.
    static async gradingEmitPrompts( { cwd, grading, gradingDataRoot, flow, tier, maxGrade, targetDir, target, scopeName = null, runId = null, areaSelector, conflict, maxIterations, maxTurns = 25, useKeys, dryRun = false, quiet = false, dependencyChain } ) {
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
            const resolvedSchemas = await GradingTarget.resolveSchemasForTarget( { namespace } )
            if( resolvedSchemas.status === false ) {
                return { 'result': CliOutput.error( { 'error': resolvedSchemas.error, 'fix': resolvedSchemas.fix } ) }
            }
            liveSchemas = resolvedSchemas.schemas
        } else {
            // Selection flow: the schemas to pretest are the selection members. They
            // too are resolved LIVE from schemaFolders[] (PRD-003) via their
            // <namespace>.<schemaName> member IDs — never from the island snapshot.
            const resolvedMembers = await GradingTarget.resolveSelectionSchemasLive( { targetDir } )
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
            ? grading.GradingEmit.buildEmitSubstitutions( { cwd, grading, namespace, liveSchemas, pretests } )
            : null
        const persona = flow === 'provider'
            ? grading.GradingEmit.resolveSchemaPersona()
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
        const { areas } = await grading.GradingEmit.composeGradingAreas( { grading, flow, persona, personaAreas, substitutions } )

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
        const resolvedAreas = await grading.GradingEmit.resolveEmittedAreas( {
            grading, areas, targetDir, schemaDirs, pretests, areaSelector, sourceDirs
        } )
        if( resolvedAreas.status === false ) {
            return { 'result': CliOutput.error( { 'error': resolvedAreas.error, 'fix': resolvedAreas.fix } ) }
        }
        // Memo 112 (REV-05, F10) — a schema-scoped pass IS the per-schema sub-skill:
        // keep the per-tool area (single-test) AND the per-schema area
        // (tools-aggregate-schema). Namespace-level areas stay at the namespace pass.
        const emittedAreas = scoped === true
            ? resolvedAreas.emittedAreas.filter( ( a ) => [ 'tool', 'schema' ].includes( grading.GradingEmit.emitAreaUnit( { 'area': a.area } ) ) )
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
        const taskResult = grading.GradingEmit.computeGradingTaskId( { grading, 'namespace': taskIdSlug, emittedAreaSet } )
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
                const unit = grading.GradingEmit.emitAreaUnit( { 'area': a.area } )
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
            const wl = await GradingStatus.computeGradingWorklist( { cwd, grading, gradingDataRoot, namespace, 'targetGrade': null } )
            if( wl.status === true ) {
                emitWorklist = wl.worklist.map( ( entry ) => entry.schema )
            }
        }
        const emitSkill = grading.GradingEmit.buildEmitSkill( {
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


}


export { GradingEmit }
