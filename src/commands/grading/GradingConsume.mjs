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
import { GradingEmit } from './GradingEmit.mjs'
import { GradingDeterministic } from './GradingDeterministic.mjs'
import { GradingStatus } from './GradingStatus.mjs'


class GradingConsume {
    // Memo 102 Phase 2 / PRD-006 — the grading-intake sub-command and its
    // FlowMcpCli intake method were removed: the grading run reads the schema live
    // from schemaFolders[] (B2) and builds the island skeleton from that live read
    // (B3), so no internal importer remains. The GradingImport class in
    // flowmcp-grading is KEPT (still exported + consumed by that module's own
    // tests) — see PRD-006 keep-decision.


    static async gradingExport( { cwd, target, onConflict, gradingDataDir, gradingExportDir, json } ) {
        const grading = await GradingTarget.loadGrading()
        if( grading === null || grading[ 'GradingExport' ] === undefined ) {
            return { 'result': CliOutput.error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }

        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': CliOutput.error( { 'error': 'Missing export target.', 'fix': 'Usage: flowmcp grading export <namespace|selection>' } ) }
        }

        const gradingDataRoot = await GradingTarget.gradingDataRoot( { cwd, gradingDataDir } )
        const detected = await GradingTarget.resolveGradingTarget( { cwd, gradingDataRoot, target } )
        if( detected.status !== true ) {
            return { 'result': CliOutput.error( { 'error': detected.error, 'fix': detected.fix } ) }
        }

        const exportRoot = await GradingTarget.gradingExportRoot( { cwd, gradingExportDir, gradingDataRoot } )
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
                .map( ( e ) => GradingTarget.relativizeMessagePaths( { cwd, message: e } ) )
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
                'indexExportPath': GradingTarget.toRepoRelativePath( { cwd, path: run.indexExportPath } ),
                'schemaExports': ( run.schemaExports || [] )
                    .map( ( s ) => ( { ...s, 'exportPath': GradingTarget.toRepoRelativePath( { cwd, path: s.exportPath } ) } ) ),
                'exportDir': GradingTarget.toRepoRelativePath( { cwd, path: exportDir } )
            }
        }
    }


    // PRD-007 — verify a consume payload against the open emit recorded in
    // state.json. Ordered checks (no silent default): taskId known, area-set
    // subset of the emitted set, per-area answered==asked count. Partial-Set
    // (F11=A): areas present-and-valid are accepted; emitted areas absent from the
    // payload stay pending; the Task-ID is complete ONLY at the full set. Any
    // mismatch -> Reject. The check is ADDITIVE: a scores doc that carries no
    // `taskId` follows the legacy rebuild path unchanged (backward-compatible).
    static verifyConsumePayload( { grading, scoresDoc, state } ) {
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
        const askedByArea = GradingConsume.askedCountByArea( { state } )
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
    static askedCountByArea( { state } ) {
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
    static async writeSchemaGradingsFromScores( { grading, scoresDoc, namespaceDir, schemaName } ) {
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
        const aggregateSchemaHash = await GradingStatus.liveSchemaHashFor( { HashGenerator, namespaceDir, schemaName } )

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
    static async writeNamespaceGradingsFromScores( { grading, scoresDoc, namespaceDir, namespace } ) {
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
    static async writePersonaNamespaceGradings( { grading, scoresDoc, namespaceDir } ) {
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
                        : join( namespaceDir, schemaDir, 'skills', GradingConsume.resolveIslandSkillName( { 'schemaDirPath': join( namespaceDir, schemaDir ) } ), '_gradings' )
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
    static resolveIslandSkillName( { schemaDirPath } ) {
        const skillsRoot = join( schemaDirPath, 'skills' )
        if( existsSync( skillsRoot ) === false ) { return 'default' }
        const existing = readdirSync( skillsRoot, { 'withFileTypes': true } )
            .filter( ( e ) => e.isDirectory() === true )
            .map( ( e ) => e.name )
            .sort()
            .find( ( name ) => true )
        return existing !== undefined ? existing : 'default'
    }


    static async gradingConsumeScores( { cwd, grading, gradingDataRoot, flow, targetDir, target, scopeName = null, consumeScores, conflict, gradingDataDir, gradingExportDir, dryRun = false, dependencyChain } ) {
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
        const verify = GradingConsume.verifyConsumePayload( { grading, scoresDoc, 'state': prevState } )
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
            const gradingsWrite = await GradingConsume.writeSchemaGradingsFromScores( { grading, scoresDoc, 'namespaceDir': targetDir, 'schemaName': scopeName } )
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
            return { 'result': { 'status': true, 'stage': 3, 'mode': 'consume-scores', 'saved': true, scoped, flow, target, 'scoresPath': GradingTarget.toRepoRelativePath( { cwd, 'path': savedPath } ), 'gradingsWritten': gradingsWrite.written, 'acceptedAreas': verify.acceptedAreas, 'taskComplete': verify.complete, 'scoreCount': scoresDoc[ 'scores' ].length, dependencyChain } }
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
            const nsWrite = await GradingConsume.writeNamespaceGradingsFromScores( { grading, scoresDoc, 'namespaceDir': targetDir, 'namespace': basename( targetDir ) } )
            if( nsWrite.status === false ) {
                return { 'result': CliOutput.error( { 'error': `Could not write namespace gradings for ${target}: ${nsWrite.error}`, 'fix': 'Fix the scores file (scores must be 1–5 or "n/a" per question) and run the command again.' } ) }
            }
            // Memo 141 — persist the persona-required namespace areas (about-namespace,
            // namespace-skills) into their schema-scoped _gradings, where RebuildIndex
            // reads them. Without this they are accepted-but-dropped (every namespace
            // stays about:pending). about-namespace is the About-Persona-Scoring payoff.
            const personaWrite = await GradingConsume.writePersonaNamespaceGradings( { grading, scoresDoc, 'namespaceDir': targetDir } )
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
            const proof = await GradingConsume.writeProviderProof( {
                cwd, grading, gradingDataRoot, gradingExportDir, target, 'namespaceIndex': rebuilt.index
            } )
            if( proof.status === false ) {
                return { 'result': CliOutput.error( { 'error': proof.error, 'fix': proof.fix } ) }
            }
            proofPathRel = GradingTarget.toRepoRelativePath( { cwd, 'path': proof.proofPath } )
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
    static async writeProviderProof( { cwd, grading, gradingDataRoot, gradingExportDir, target, namespaceIndex } ) {
        const ProviderProof = grading[ 'ProviderProof' ]
        if( ProviderProof === undefined || ProviderProof === null ) {
            return { 'status': false, 'error': 'ProviderProof unavailable from flowmcp-grading.', 'fix': 'Update the flowmcp-grading dependency.' }
        }

        const exportRoot = await GradingTarget.gradingExportRoot( { cwd, gradingExportDir, gradingDataRoot } )
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
}


export { GradingConsume }
