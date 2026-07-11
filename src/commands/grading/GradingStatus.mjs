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
import { GradingEmit } from './GradingEmit.mjs'
import { GradingDeterministic } from './GradingDeterministic.mjs'


class GradingStatus {
    // Memo 112 P6.1 — `grading finalize <ns>`: the Austritts-Rollup. A thin wrapper
    // around the proven RebuildIndex -> ProviderProof sequence (`#deterministicRollup`),
    // PLUS the Recommendation (the same worklist `plan` reports). Bare namespace only
    // (no ns/schema): finalize rolls up a whole namespace. NO SILENT DEFAULT.
    static async gradingFinalize( { cwd, target, gradingDataDir, gradingExportDir = null, targetGrade = null, json } ) {
        const grading = await GradingTarget.loadGrading()
        if( grading === null ) {
            return { 'result': CliOutput.error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }
        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': CliOutput.error( { 'error': 'Missing finalize target.', 'fix': `Usage: ${appConfig[ 'cliCommand' ]} grading finalize <namespace> [--target <grade>]` } ) }
        }
        if( target.includes( '/' ) ) {
            return { 'result': CliOutput.error( { 'error': `finalize operates on a bare namespace, not "${target}".`, 'fix': `Use the namespace only, e.g. ${appConfig[ 'cliCommand' ]} grading finalize ${target.split( '/' )[ 0 ]}` } ) }
        }

        const gradingDataRoot = await GradingTarget.gradingDataRoot( { cwd, gradingDataDir } )
        const rollup = await GradingDeterministic.deterministicRollup( { cwd, grading, gradingDataRoot, gradingExportDir, 'namespace': target } )
        if( rollup.status !== true ) {
            return { 'result': CliOutput.error( { 'error': rollup.error, 'fix': rollup.fix } ) }
        }

        const recommendation = await GradingStatus.computeGradingWorklist( { cwd, grading, gradingDataRoot, 'namespace': target, targetGrade } )
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
        const grading = await GradingTarget.loadGrading()
        if( grading === null ) {
            return { 'result': CliOutput.error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }
        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': CliOutput.error( { 'error': 'Missing plan target.', 'fix': `Usage: ${appConfig[ 'cliCommand' ]} grading plan <namespace> [--target <grade>]` } ) }
        }
        if( target.includes( '/' ) ) {
            return { 'result': CliOutput.error( { 'error': `plan operates on a bare namespace, not "${target}".`, 'fix': `Use the namespace only, e.g. ${appConfig[ 'cliCommand' ]} grading plan ${target.split( '/' )[ 0 ]}` } ) }
        }

        const gradingDataRoot = await GradingTarget.gradingDataRoot( { cwd, gradingDataDir } )
        const worklist = await GradingStatus.computeGradingWorklist( { cwd, grading, gradingDataRoot, 'namespace': target, targetGrade } )
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
    static gradeRank( { grade } ) {
        const ranks = { 'A': 5, 'B': 4, 'C': 3, 'D': 2, 'F': 1 }
        return typeof grade === 'string' && ranks[ grade ] !== undefined ? ranks[ grade ] : 0
    }


    static async computeGradingWorklist( { cwd, grading, gradingDataRoot, namespace, targetGrade = null } ) {
        const HashGenerator = grading[ 'HashGenerator' ]
        if( HashGenerator === undefined || HashGenerator === null ) {
            return { 'status': false, 'error': 'flowmcp-grading too old: HashGenerator not exported; staleness cannot be computed.', 'fix': 'Update the flowmcp-grading dependency.' }
        }

        const resolved = await GradingTarget.resolveSchemasForTarget( { namespace } )
        if( resolved.status !== true ) {
            return { 'status': false, 'error': resolved.error, 'fix': resolved.fix }
        }

        const namespaceDir = join( gradingDataRoot, 'providers', namespace )
        const { data: index } = await FsUtils.readJson( { 'filePath': join( namespaceDir, 'index.json' ) } )
        const indexSchemas = index !== null && index[ 'schemas' ] !== undefined ? index[ 'schemas' ] : {}
        const targetRank = targetGrade === null ? null : GradingStatus.gradeRank( { 'grade': targetGrade } )

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
                const storedHash = await GradingStatus.readStoredSchemaHash( { namespaceDir, node } )
                const underTarget = targetRank !== null && GradingStatus.gradeRank( { grade } ) < targetRank

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
    static async readStoredSchemaHash( { namespaceDir, node } ) {
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
    static async liveSchemaHashFor( { HashGenerator, namespaceDir, schemaName } ) {
        if( HashGenerator === undefined || HashGenerator === null ) { return null }
        const namespace = basename( namespaceDir )
        const resolved = await GradingTarget.resolveSchemasForTarget( { namespace } )
        if( resolved.status !== true ) { return null }
        const match = resolved.schemas.find( ( s ) => s.schemaName === schemaName )
        if( match === undefined ) { return null }
        const computed = HashGenerator.computeSchemaHash( { 'schema': match.main } ).hash
        return typeof computed === 'string' && computed.length > 0 ? computed : null
    }


    static async gradingState( { cwd, target, gradingDataDir, json } ) {
        const grading = await GradingTarget.loadGrading()
        if( grading === null ) {
            return { 'result': CliOutput.error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }

        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': CliOutput.error( { 'error': 'Missing state target.', 'fix': 'Usage: flowmcp grading state <namespace|selection>' } ) }
        }

        const gradingDataRoot = await GradingTarget.gradingDataRoot( { cwd, gradingDataDir } )
        const detected = await GradingTarget.resolveGradingTarget( { cwd, gradingDataRoot, target } )
        if( detected.status !== true ) {
            return { 'result': CliOutput.error( { 'error': detected.error, 'fix': detected.fix } ) }
        }

        const indexPath = join( detected.targetDir, 'index.json' )
        const statePath = join( detected.targetDir, 'state.json' )
        const { data: index } = await FsUtils.readJson( { 'filePath': indexPath } )
        const { data: state } = await FsUtils.readJson( { 'filePath': statePath } )

        // PRD-010 — the graph-driven nextAction block, identical on state + doctor.
        const nextAction = await GradingStatus.computeNextAction( { grading, detected, target } )

        // Memo 112 — per-schema progress from the isolated `_schema/<name>/` states,
        // so a parallel per-schema grading run is checkable: which schemas are scored,
        // under which run-id, how many remain.
        const schemaProgress = await GradingStatus.readSchemaProgress( { 'targetDir': detected.targetDir } )

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
    static async readSchemaProgress( { targetDir } ) {
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
        const grading = await GradingTarget.loadGrading()
        if( grading === null ) {
            return { 'result': CliOutput.error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }
        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': CliOutput.error( { 'error': 'Missing skill target.', 'fix': 'Usage: flowmcp grading skill <namespace|selection>' } ) }
        }

        const gradingDataRoot = await GradingTarget.gradingDataRoot( { cwd, gradingDataDir } )
        const detected = await GradingTarget.resolveGradingTarget( { cwd, gradingDataRoot, target } )
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
                'promptsPath': GradingTarget.toRepoRelativePath( { cwd, 'path': promptsPath } ),
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

        const gradingDataRoot = await GradingTarget.gradingDataRoot( { cwd, gradingDataDir } )
        const detected = await GradingTarget.resolveGradingTarget( { cwd, gradingDataRoot, target } )
        if( detected.status !== true ) {
            return { 'result': CliOutput.error( { 'error': detected.error, 'fix': detected.fix } ) }
        }

        // PRD-009 — `worklist` is subsumed into `doctor`: the deterministic
        // collection logic lives in ONE shared private collector. `worklist` is
        // retained as a thin wrapper (Never-delete-legacy) returning the same flat
        // array shape as before, OR the WL-001/WL-002 coded error unchanged.
        const collected = await GradingStatus.collectDeterministicDefects( { detected, target } )
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
    static async collectDeterministicDefects( { detected, target } ) {
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
        const grading = await GradingTarget.loadGrading()
        if( grading === null ) {
            return { 'result': CliOutput.error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }

        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': CliOutput.error( { 'error': 'Missing doctor target.', 'fix': 'Usage: flowmcp grading doctor <namespace>' } ) }
        }

        const gradingDataRoot = await GradingTarget.gradingDataRoot( { cwd, gradingDataDir } )
        const detected = await GradingTarget.resolveGradingTarget( { cwd, gradingDataRoot, target } )
        if( detected.status !== true ) {
            return { 'result': CliOutput.error( { 'error': detected.error, 'fix': detected.fix } ) }
        }

        // Deterministic defects (keeps WL-001/WL-002 — no empty-list fabrication).
        // Memo 107 PRD-013 — a deterministic-only island (migrated / det-graded, no LLM
        // emit round) has no prompts.json: WL-001 is then NOT a hard error but a soft
        // state — defects degrade to [] with an explicit note so the conformance guard
        // and state still surface. Any OTHER collection failure stays a hard error.
        const collected = await GradingStatus.collectDeterministicDefects( { detected, target } )
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
        const tipsResult = await GradingStatus.collectLastTips( { grading, detected } )
        const tips = tipsResult.tips
        const tipsNote = tipsResult.note

        // Self-contained per-namespace next loop (PRD-009).
        const nextLoop = GradingStatus.buildNextLoop( { defects, tips, target } )

        // Graph-driven next-action enumeration (PRD-010), identical on state + doctor.
        const nextAction = await GradingStatus.computeNextAction( { grading, detected, target } )

        // Memo 107 PRD-013 — conformance guard: a schema with summary.json (swept) but
        // no _gradings/ (not graded) is "sweep-only" / unfinished. The deterministic
        // path now writes the full structure by default, so this state is flagged, not
        // produced. No silent default — the swept/graded booleans are explicit per schema.
        const conformance = await GradingStatus.collectConformance( { targetDir: detected.targetDir } )

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
    static async collectConformance( { targetDir } ) {
        const schemaDirs = await GradingTarget.listGradingSchemaDirs( { targetDir } )
        const schemas = []
        await schemaDirs
            .reduce( ( promise, schemaName ) => promise.then( async () => {
                const schemaDir = join( targetDir, schemaName )
                const swept = existsSync( join( schemaDir, 'summary.json' ) )
                const schemaGradings = await GradingStatus.findGradingsDirs( { root: schemaDir } )
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
    static async collectLastTips( { grading, detected } ) {
        const Grading = grading[ 'Grading' ]
        const RebuildIndex = grading[ 'RebuildIndex' ]
        if( Grading === undefined || RebuildIndex === undefined ) {
            return { 'tips': [], 'note': 'Grading entry reader unavailable from flowmcp-grading; no tips could be read.' }
        }

        const gradingsDirs = await GradingStatus.findGradingsDirs( { root: detected.targetDir } )
        if( gradingsDirs.length === 0 ) {
            return { 'tips': [], 'note': 'No grading entries on disk yet — no LLM grading round has run for this namespace.' }
        }

        const tips = []
        await gradingsDirs
            .reduce( async ( prevPromise, gradingsDir ) => {
                await prevPromise
                const resolved = await RebuildIndex.resolveLatest( { 'dir': gradingsDir, 'logicalName': GradingStatus.gradingsLogicalName( { gradingsDir } ) } )
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

                const area = typeof read.entry.area === 'string' ? read.entry.area : GradingStatus.gradingsLogicalName( { gradingsDir } )
                const schema = GradingStatus.schemaOfGradingsDir( { root: detected.targetDir, gradingsDir } )
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
    static gradingsLogicalName( { gradingsDir } ) {
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
    static schemaOfGradingsDir( { root, gradingsDir } ) {
        const rel = relative( root, gradingsDir )
        const segments = rel.split( /[\\/]/ ).filter( ( s ) => s.length > 0 )
        if( segments.length === 0 ) { return null }
        if( segments[ 0 ] === '_gradings' ) { return null }
        return segments[ 0 ]
    }


    // Recursively find every `_gradings` directory under an island root. Read-only
    // directory walk (no for/while; reduce over readdir). Reserved/non-schema dirs
    // are still descended (About/skills gradings live deep), so we walk all dirs.
    static async findGradingsDirs( { root } ) {
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
                const nested = await GradingStatus.findGradingsDirs( { 'root': childPath } )
                return acc.concat( nested )
            }, Promise.resolve( [] ) )

        return found
    }


    // PRD-009 — the self-contained per-namespace next re-entry loop: which areas
    // still carry open defects/tips, and the single CLI action that resumes the
    // Kap. 7.3 loop. Plain language, no invented jargon. When nothing is open the
    // rationale says so explicitly (no silent empty).
    static buildNextLoop( { defects, tips, target } ) {
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
    static async computeNextAction( { grading, detected, target } ) {
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

        const schemaDirs = await GradingTarget.listGradingSchemaDirs( { 'targetDir': detected.targetDir } )
        const aboutProbe = await GradingEmit.detectAboutResourcePresent( { 'targetDir': detected.targetDir, schemaDirs } )

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
}


export { GradingStatus }
