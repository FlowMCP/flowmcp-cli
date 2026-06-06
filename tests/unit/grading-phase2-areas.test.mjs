import { describe, it, expect, afterEach, beforeAll } from '@jest/globals'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import * as realGrading from 'flowmcp-grading'
import { seedGradingSchemaFolder } from '../helpers/seed-grading-source.mjs'


const here = dirname( fileURLToPath( import.meta.url ) )
const providerFixture = join( here, '..', 'integration', 'fixtures', 'grading-provider' )


// Memo 102 Phase 2 / PRD-003 (B2): emit-prompts reads the schema LIVE from
// schemaFolders[]. Register the provider fixture so #resolveSchemasForTarget
// finds the `demoapi` namespace.
beforeAll( async () => {
    await seedGradingSchemaFolder( { providerFixture, namespace: 'demoapi' } )
} )


// Wrap the real grading module but stub DataPretest.run so emit-prompts never
// makes a live API call. `ok` drives the derived requiredLevel of the schema
// (ok -> deterministic-green; not ok -> structural-valid).
function gradingWithStubbedPretest( { ok = true } ) {
    const stub = {
        run: async ( params ) => ( {
            ok,
            passedDownloadable: ok ? 3 : 0,
            required: 3,
            toolsBelowThreshold: ok ? [] : [ 'getThing (0/3)' ],
            perTool: {},
            schemaDir: null,
            summaryPath: join( params.gradingDataDir, 'providers', params.namespace, params.toolName, 'summary.json' ),
            results: [],
            stopReason: ok ? null : 'no-downloadable-tools',
            errors: []
        } ),
        getVersion: () => ( { version: 'stub' } )
    }

    return { ...realGrading, DataPretest: stub }
}


async function freshCwd() {
    return mkdtemp( join( tmpdir(), 'grading-phase2-' ) )
}


async function emit( { cwd, phase, ok = true } ) {
    return FlowMcpCli.gradingRun( {
        cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi',
        phase, emitPrompts: true, consumeScores: null, onConflict: null, maxIterations: null, json: false
    } )
}


// ---- PRD-004: --phase multi-area selector --------------------------------------
describe( 'PRD-004 — --phase multi-area selector (3 modes, no silent default)', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'default (no --phase) resolves mode=default and emits all applicable areas', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const { result } = await emit( { cwd, phase: null } )
        expect( result.status ).toBe( true )
        expect( result.areaSelector.mode ).toBe( 'default' )
        expect( result.areaSelector.areas ).toBeNull()
    } )

    it( 'single token resolves mode=single', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const { result } = await emit( { cwd, phase: 'single-test' } )
        expect( result.status ).toBe( true )
        expect( result.areaSelector.mode ).toBe( 'single' )
        expect( result.emittedAreaSet ).toEqual( [ 'single-test' ] )
    } )

    it( 'comma-set resolves mode=subset and emits both named areas', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const { result } = await emit( { cwd, phase: 'single-test,tools-aggregate-schema' } )
        expect( result.status ).toBe( true )
        expect( result.areaSelector.mode ).toBe( 'subset' )
        expect( result.emittedAreaSet.sort() ).toEqual( [ 'single-test', 'tools-aggregate-schema' ] )
    } )

    it( 'rejects an unknown area token (lists allowed areas, no partial emit)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const { result } = await emit( { cwd, phase: 'not-a-real-area' } )
        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Unknown --phase area' )
        expect( result.error ).toContain( 'single-test' )
    } )

    it( 'rejects a duplicate token (no silent dedupe)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const { result } = await emit( { cwd, phase: 'single-test,single-test' } )
        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Duplicate --phase area' )
    } )

    it( 'rejects an empty member (a,,b or a,)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const { result } = await emit( { cwd, phase: 'single-test,' } )
        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Empty --phase member' )
    } )
} )


// ---- PRD-005: emit-time applicability + skippedAreas ---------------------------
describe( 'PRD-005 — emit-time About applicability skip', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'About absent -> about-namespace skipped (out-of-scope-resource), not a blocker', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const { result } = await emit( { cwd, phase: null } )
        expect( result.status ).toBe( true )
        const skip = result.skippedAreas.find( ( s ) => s.area === 'about-namespace' )
        expect( skip ).toBeDefined()
        expect( skip.naReason ).toBe( 'out-of-scope-resource' )

        const prompts = JSON.parse( await readFile( result.promptsPath, 'utf-8' ) )
        expect( prompts.areas.map( ( a ) => a.area ) ).not.toContain( 'about-namespace' )
        // The other areas still emit (no abort, no blocked namespace).
        expect( prompts.areas.length ).toBeGreaterThan( 0 )
    } )

    it( 'About present -> about-namespace emitted normally', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        // Create the About resource at the source level for the single schema.
        await mkdir( join( cwd, '.flowmcp', 'grading', 'providers', 'demoapi', 'demoapi', 'resources', 'about' ), { recursive: true } )

        const { result } = await emit( { cwd, phase: null } )
        expect( result.status ).toBe( true )
        expect( result.skippedAreas.find( ( s ) => s.area === 'about-namespace' ) ).toBeUndefined()
        expect( result.emittedAreaSet ).toContain( 'about-namespace' )
    } )
} )


// ---- PRD-006: Namespace-Gate (non-det areas gated below deterministic-green) ---
describe( 'PRD-006 — Provider-Namespace-Gate at emit', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'schema below deterministic-green gates the non-det namespace areas', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: false } ) } )

        const { result } = await emit( { cwd, phase: null } )
        expect( result.status ).toBe( true )
        const gatedNames = result.gatedAreas.map( ( g ) => g.area )
        expect( gatedNames ).toContain( 'namespace-description' )
        expect( gatedNames ).toContain( 'namespace-skills' )
        expect( gatedNames ).toContain( 'tools-aggregate-namespace' )
        // schema-areas (kind none) still emit.
        expect( result.emittedAreaSet ).toContain( 'single-test' )
        // gated areas are NOT in the emitted prompt list and NOT in skippedAreas.
        const prompts = JSON.parse( await readFile( result.promptsPath, 'utf-8' ) )
        expect( prompts.areas.map( ( a ) => a.area ) ).not.toContain( 'namespace-skills' )
        expect( result.skippedAreas.map( ( s ) => s.area ) ).not.toContain( 'namespace-skills' )
    } )

    it( 'all schemas deterministic-green -> namespace areas emitted (gate open)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const { result } = await emit( { cwd, phase: null } )
        expect( result.status ).toBe( true )
        expect( result.emittedAreaSet ).toContain( 'namespace-description' )
        expect( result.emittedAreaSet ).toContain( 'namespace-skills' )
        expect( result.gatedAreas.length ).toBe( 0 )
    } )
} )


// ---- PRD-007: Task-ID emit + consume verification / partial-set ----------------
describe( 'PRD-007 — Task-ID emit payload + consume verification', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'emit writes taskId + payloadSkeleton (prompts.json) and taskId + emittedAreaSet (state.json)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const { result } = await emit( { cwd, phase: null } )
        expect( typeof result.taskId ).toBe( 'string' )
        expect( result.taskId ).toMatch( /^demoapi--[0-9a-f]{8}$/ )

        const prompts = JSON.parse( await readFile( result.promptsPath, 'utf-8' ) )
        expect( prompts.taskId ).toBe( result.taskId )
        expect( prompts.payloadSkeleton.taskId ).toBe( result.taskId )
        expect( Array.isArray( prompts.payloadSkeleton.areas ) ).toBe( true )
        prompts.payloadSkeleton.areas.forEach( ( a ) => {
            expect( typeof a.area ).toBe( 'string' )
            expect( a.results ).toEqual( [] )
        } )

        const state = JSON.parse( await readFile( result.statePath, 'utf-8' ) )
        expect( state.taskId ).toBe( result.taskId )
        expect( Array.isArray( state.emittedAreaSet ) ).toBe( true )
    } )

    it( 'Task-ID is order-independent over the area-set', async () => {
        const a = await freshCwd()
        const b = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const r1 = await emit( { cwd: a, phase: 'single-test,tools-aggregate-schema' } )
        const r2 = await emit( { cwd: b, phase: 'tools-aggregate-schema,single-test' } )
        expect( r1.result.taskId ).toBe( r2.result.taskId )
    } )

    it( 'consume with the full emitted set marks taskComplete', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        const e = await emit( { cwd, phase: 'single-test' } )

        const scoresPath = join( cwd, 'scores.json' )
        await writeFile( scoresPath, JSON.stringify( {
            scoringProtocol: 'v1',
            taskId: e.result.taskId,
            areas: [ { area: 'single-test', results: [] } ],
            scores: [ { dimension: 'whenToUse', score: 4.0 } ]
        } ), 'utf-8' )

        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', phase: null, emitPrompts: false, consumeScores: scoresPath, onConflict: null, json: false } )
        expect( result.status ).toBe( true )
        expect( result.taskComplete ).toBe( true )
        expect( result.acceptedAreas ).toContain( 'single-test' )
        expect( result.missingAreas ).toEqual( [] )
    } )

    it( 'consume with a subset accepts per-area, leaves the rest pending, not complete', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        const e = await emit( { cwd, phase: 'single-test,tools-aggregate-schema' } )

        const scoresPath = join( cwd, 'scores.json' )
        await writeFile( scoresPath, JSON.stringify( {
            scoringProtocol: 'v1',
            taskId: e.result.taskId,
            areas: [ { area: 'single-test', results: [] } ],
            scores: [ { dimension: 'whenToUse', score: 4.0 } ]
        } ), 'utf-8' )

        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', phase: null, emitPrompts: false, consumeScores: scoresPath, onConflict: null, json: false } )
        expect( result.status ).toBe( true )
        expect( result.taskComplete ).toBe( false )
        expect( result.acceptedAreas ).toEqual( [ 'single-test' ] )
        expect( result.missingAreas ).toContain( 'tools-aggregate-schema' )
    } )

    it( 'consume rejects an unknown taskId', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        await emit( { cwd, phase: 'single-test' } )

        const scoresPath = join( cwd, 'scores.json' )
        await writeFile( scoresPath, JSON.stringify( {
            scoringProtocol: 'v1', taskId: 'demoapi--deadbeef',
            areas: [ { area: 'single-test', results: [] } ], scores: []
        } ), 'utf-8' )

        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', phase: null, emitPrompts: false, consumeScores: scoresPath, onConflict: null, json: false } )
        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Unknown taskId' )
    } )

    it( 'consume rejects an area outside the emitted set', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        const e = await emit( { cwd, phase: 'single-test' } )

        const scoresPath = join( cwd, 'scores.json' )
        await writeFile( scoresPath, JSON.stringify( {
            scoringProtocol: 'v1', taskId: e.result.taskId,
            areas: [ { area: 'tools-aggregate-schema', results: [] } ], scores: []
        } ), 'utf-8' )

        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', phase: null, emitPrompts: false, consumeScores: scoresPath, onConflict: null, json: false } )
        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'not in the emitted set' )
    } )

    it( 'consume rejects a per-area question-count mismatch', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        const e = await emit( { cwd, phase: 'single-test' } )

        // The emit recorded a per-area asked count (>0) for single-test; an answered
        // count that differs must Reject.
        const state = JSON.parse( await readFile( e.result.statePath, 'utf-8' ) )
        const asked = state.askedByArea[ 'single-test' ]
        expect( typeof asked ).toBe( 'number' )

        const scoresPath = join( cwd, 'scores.json' )
        const wrongResults = Array.from( { length: asked + 1 }, ( _, i ) => ( { id: `q${i}` } ) )
        await writeFile( scoresPath, JSON.stringify( {
            scoringProtocol: 'v1', taskId: e.result.taskId,
            areas: [ { area: 'single-test', results: wrongResults } ], scores: []
        } ), 'utf-8' )

        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', phase: null, emitPrompts: false, consumeScores: scoresPath, onConflict: null, json: false } )
        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'question-count mismatch' )
    } )

    it( 'legacy scores without a taskId still consume (backward-compatible)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        await emit( { cwd, phase: null } )

        const scoresPath = join( cwd, 'scores.json' )
        await writeFile( scoresPath, JSON.stringify( { scoringProtocol: 'v1', scores: [ { dimension: 'whenToUse', score: 4.0 } ] } ), 'utf-8' )

        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', phase: null, emitPrompts: false, consumeScores: scoresPath, onConflict: null, json: false } )
        expect( result.status ).toBe( true )
        expect( result.taskComplete ).toBeNull()
    } )
} )


// ---- PRD-008: ProviderProof.write wired from consume ---------------------------
describe( 'PRD-008 — grade.json produced from the consume-scores success path', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    async function emitThenConsume( { cwd, exportDir } ) {
        await emit( { cwd, phase: 'single-test' } )
        const e = JSON.parse( await readFile( join( cwd, '.flowmcp', 'grading', 'providers', 'demoapi', 'state.json' ), 'utf-8' ) )
        const scoresPath = join( cwd, 'scores.json' )
        await writeFile( scoresPath, JSON.stringify( {
            scoringProtocol: 'v1', taskId: e.taskId,
            areas: [ { area: 'single-test', results: [] } ],
            scores: [ { dimension: 'whenToUse', score: 4.0 } ]
        } ), 'utf-8' )
        return FlowMcpCli.gradingRun( {
            cwd, gradingDataDir: '.flowmcp/grading', gradingExportDir: exportDir,
            target: 'demoapi', phase: null, emitPrompts: false, consumeScores: scoresPath, onConflict: null, json: false
        } )
    }

    it( 'writes exactly one grade.json under <exportRoot>/providers/<ns>/ with the proof shape', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const { result } = await emitThenConsume( { cwd, exportDir: 'out/exports' } )
        expect( result.status ).toBe( true )
        expect( result.proofPath ).toContain( join( 'out', 'exports', 'providers', 'demoapi', 'grade.json' ) )

        const gradeJsonPath = join( cwd, 'out', 'exports', 'providers', 'demoapi', 'grade.json' )
        expect( existsSync( gradeJsonPath ) ).toBe( true )
        const proof = JSON.parse( await readFile( gradeJsonPath, 'utf-8' ) )
        expect( proof.namespace ).toBe( 'demoapi' )
        expect( proof.namespaceAggregate ).toBeDefined()
        expect( proof.schemas ).toBeDefined()
        expect( Array.isArray( proof.blockers ) ).toBe( true )
        expect( proof.monitoring ).toEqual( { githubIssue: null, boardColumn: null } )
    } )

    it( 'a re-run preserves a non-null monitoring.githubIssue (idempotent)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        await emitThenConsume( { cwd, exportDir: 'out/exports' } )
        const gradeJsonPath = join( cwd, 'out', 'exports', 'providers', 'demoapi', 'grade.json' )
        const proof = JSON.parse( await readFile( gradeJsonPath, 'utf-8' ) )
        proof.monitoring.githubIssue = 4242
        await writeFile( gradeJsonPath, JSON.stringify( proof, null, 4 ), 'utf-8' )

        // Re-emit (overwrite) then consume again.
        await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', phase: 'single-test', emitPrompts: true, consumeScores: null, onConflict: 'overwrite', json: false } )
        const { result: reran } = await emitThenConsume( { cwd, exportDir: 'out/exports' } )
        expect( reran.status ).toBe( true )
        const after = JSON.parse( await readFile( gradeJsonPath, 'utf-8' ) )
        expect( after.monitoring.githubIssue ).toBe( 4242 )
    } )
} )


// ---- Memo 110 P3: self-contained Emit-Skill + configurable maxTurns ------------
describe( 'Memo 110 P3 — Emit-Skill text (PRD-3.3/3.4) + maxTurns (PRD-3.5)', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'emits the namespace ORCHESTRATOR with Task-ID + per-schema dispatch commands', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const { result } = await emit( { cwd, phase: 'single-test,tools-aggregate-schema' } )
        expect( result.status ).toBe( true )
        expect( typeof result.emitSkill ).toBe( 'string' )
        // Memo 112 (REV-05): the namespace emit is the ORCHESTRATOR — self-describing
        // header + Task-ID, dispatching per-schema sub-skills via the schema-scoped
        // --emit-prompts command (consume is delegated to each sub-agent).
        expect( result.emitSkill ).toContain( 'Grading orchestrator' )
        expect( result.emitSkill ).toContain( result.taskId )
        expect( result.emitSkill ).toContain( 'demoapi/' )
        expect( result.emitSkill ).toContain( '--emit-prompts' )
        // no NAME torso survives anywhere in the orchestrator text
        expect( result.emitSkill.includes( '{{NAMESPACE}}' ) ).toBe( false )
        expect( result.emitSkill.includes( '{{TOOL_NAME}}' ) ).toBe( false )
        expect( result.emitSkill.includes( '{{OUTPUT_SCHEMA_REF}}' ) ).toBe( false )
    } )

    it( 'maxTurns is configurable (flows into the Goal-Block condition)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        await FlowMcpCli.gradingRun( {
            cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi',
            phase: 'single-test', emitPrompts: true, consumeScores: null, onConflict: null,
            maxIterations: null, maxTurns: '7', json: false
        } )
        const prompts = JSON.parse( await readFile( join( cwd, '.flowmcp/grading/providers/demoapi/prompts.json' ), 'utf-8' ) )
        expect( prompts.goal.maxTurns ).toBe( 7 )
        expect( prompts.goal.condition ).toContain( 'stop after 7 turns' )
    } )

    it( 'rejects a malformed --max-turns (no silent fallback to 25)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const { result } = await FlowMcpCli.gradingRun( {
            cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi',
            phase: 'single-test', emitPrompts: true, consumeScores: null, onConflict: null,
            maxIterations: null, maxTurns: 'lots', json: false
        } )
        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Invalid --max-turns' )
    } )
} )


// ---- writeAtomic overwrite fix: --on-conflict=overwrite must actually rewrite ----
describe( 'emit --on-conflict — skip keeps, overwrite rewrites (writeAtomic fix)', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    async function emitConflict( { cwd, onConflict } ) {
        return FlowMcpCli.gradingRun( {
            cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi',
            phase: null, emitPrompts: true, consumeScores: null, onConflict,
            maxIterations: null, json: false
        } )
    }

    it( 'default (skip) keeps the existing prompts.json but still hands back the skill (round-trip read-back)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        const first = await emitConflict( { cwd, onConflict: null } )
        const { result } = await emitConflict( { cwd, onConflict: 'skip' } )
        expect( result.skipped ).toBe( true )
        // a second --emit-prompts must still surface the already-emitted skill, so the
        // default skill-text stdout keeps working on re-run without a re-fetch
        expect( typeof result.emitSkill ).toBe( 'string' )
        expect( result.emitSkill ).toContain( first.result.taskId )
    } )

    it( 'overwrite rewrites the prompts.json (skipped:false) instead of keeping a stale one', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        const first = await emitConflict( { cwd, onConflict: null } )
        const promptsPath = join( cwd, '.flowmcp/grading/providers/demoapi/prompts.json' )

        // Corrupt the on-disk file to a sentinel, then overwrite-emit must replace it.
        await writeFile( promptsPath, JSON.stringify( { sentinel: 'STALE' } ), 'utf-8' )
        const { result } = await emitConflict( { cwd, onConflict: 'overwrite' } )
        expect( result.skipped ).toBe( false )

        const rewritten = JSON.parse( await readFile( promptsPath, 'utf-8' ) )
        expect( rewritten.sentinel ).toBeUndefined()
        expect( rewritten.taskId ).toBe( first.result.taskId )
        // the rewritten artifact carries the filled emit-skill (Memo 110)
        expect( typeof rewritten.emitSkill ).toBe( 'string' )
        expect( rewritten.emitSkill.includes( '{{TOOL_NAME}}' ) ).toBe( false )
    } )
} )


// ---- `grading skill <ns>` — read-only printer of the emitted Emit-Skill ---------
describe( 'gradingSkill — print the emitted Emit-Skill text', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'returns the filled skill text after an emit', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        const emitted = await emit( { cwd, phase: null } )

        const { result } = await FlowMcpCli.gradingSkill( { cwd, target: 'demoapi', gradingDataDir: '.flowmcp/grading' } )
        expect( result.status ).toBe( true )
        expect( typeof result.skill ).toBe( 'string' )
        // Memo 112 (REV-05): namespace skill = orchestrator (dispatch via --emit-prompts)
        expect( result.skill ).toContain( 'Grading orchestrator' )
        expect( result.skill ).toContain( emitted.result.taskId )
        expect( result.skill ).toContain( '--emit-prompts' )
        expect( result.skill.includes( '{{TOOL_NAME}}' ) ).toBe( false )
        expect( result.taskId ).toBe( emitted.result.taskId )
    } )

    it( 'errors clearly when nothing was emitted yet (no prompts.json)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const { result } = await FlowMcpCli.gradingSkill( { cwd, target: 'demoapi', gradingDataDir: '.flowmcp/grading' } )
        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'No emitted skill' )
        expect( result.fix ).toContain( '--emit-prompts' )
    } )
} )
