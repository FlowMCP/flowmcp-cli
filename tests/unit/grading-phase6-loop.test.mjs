import { describe, it, expect, afterEach, beforeAll } from '@jest/globals'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import * as realGrading from 'flowmcp-grading'
import { main as demoMain } from '../integration/fixtures/grading-provider/demoapi.mjs'
import { seedGradingSchemaFolder } from '../helpers/seed-grading-source.mjs'


// Memo 112 Phase 6 — the targeted selective loop: `grading plan` (Eintritts-Worklist
// via Staleness) and `grading finalize` (Austritts-Rollup + Recommendation), plus the
// orchestrator-emit worklist filter (P6.3) and the outer-loop doc (P6.4).
const here = dirname( fileURLToPath( import.meta.url ) )
const providerFixture = join( here, '..', 'integration', 'fixtures', 'grading-provider' )
const GRADING_DIR = '.flowmcp/grading'
const LIVE_HASH = realGrading.HashGenerator.computeSchemaHash( { schema: demoMain } ).hash


beforeAll( async () => {
    await seedGradingSchemaFolder( { providerFixture, namespace: 'demoapi' } )
} )


async function freshCwd() {
    return mkdtemp( join( tmpdir(), 'grading-phase6-' ) )
}


// Seed the island index.json for namespace `demoapi` with one graded schema, and —
// when `schemaHash` is non-null — the tools-aggregate `_gradings` entry the index
// node references (the entry `plan` reads the stored hash from). A null `schemaHash`
// seeds a graded-but-hashless (legacy) state.
async function seedGradedIsland( { cwd, schemaHash, grade = 'B' } ) {
    const nsDir = join( cwd, GRADING_DIR, 'providers', 'demoapi' )
    const ref = 'demoapi/_gradings/tools-aggregate-schema--2026-06-06T00-00-00Z.json'
    if( schemaHash !== null ) {
        await mkdir( join( nsDir, 'demoapi', '_gradings' ), { recursive: true } )
        await writeFile( join( nsDir, ref ), JSON.stringify( { area: 'tools-aggregate-schema', grade, schemaHash }, null, 4 ) )
    } else {
        await mkdir( nsDir, { recursive: true } )
    }
    const index = {
        namespace: 'demoapi',
        status: 'partial',
        grade,
        schemas: {
            demoapi: {
                status: 'graded',
                grade,
                toolsAggregate: { status: 'graded', grade, ref }
            }
        }
    }
    await writeFile( join( nsDir, 'index.json' ), JSON.stringify( index, null, 4 ) )
}


describe( 'Memo 112 P6.2 — grading plan: staleness worklist', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'ungraded namespace (no index.json) → schema is in the worklist', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: realGrading } )

        const { result } = await FlowMcpCli.gradingPlan( { cwd, target: 'demoapi', gradingDataDir: GRADING_DIR, targetGrade: null, json: false } )
        expect( result.status ).toBe( true )
        expect( result.mode ).toBe( 'plan' )
        expect( result.worklist.map( ( w ) => w.schema ) ).toContain( 'demoapi' )
        expect( result.worklist.find( ( w ) => w.schema === 'demoapi' ).reason ).toBe( 'ungraded' )
        expect( result.skip ).toEqual( [] )
    } )

    it( 'graded + stored hash == live hash → fresh, skipped (not stale)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: realGrading } )
        await seedGradedIsland( { cwd, schemaHash: LIVE_HASH } )

        const { result } = await FlowMcpCli.gradingPlan( { cwd, target: 'demoapi', gradingDataDir: GRADING_DIR, targetGrade: null, json: false } )
        expect( result.status ).toBe( true )
        expect( result.worklist ).toEqual( [] )
        expect( result.skip.map( ( s ) => s.schema ) ).toContain( 'demoapi' )
        expect( result.skip.find( ( s ) => s.schema === 'demoapi' ).hashVerified ).toBe( true )
    } )

    it( 'graded + stored hash != live hash → stale, in the worklist', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: realGrading } )
        await seedGradedIsland( { cwd, schemaHash: 'deadbeef' } )

        const { result } = await FlowMcpCli.gradingPlan( { cwd, target: 'demoapi', gradingDataDir: GRADING_DIR, targetGrade: null, json: false } )
        expect( result.status ).toBe( true )
        expect( result.worklist.find( ( w ) => w.schema === 'demoapi' ).reason ).toBe( 'stale' )
    } )

    it( 'graded fresh but below --target → under-target, in the worklist', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: realGrading } )
        await seedGradedIsland( { cwd, schemaHash: LIVE_HASH, grade: 'B' } )

        const { result } = await FlowMcpCli.gradingPlan( { cwd, target: 'demoapi', gradingDataDir: GRADING_DIR, targetGrade: 'A', json: false } )
        expect( result.status ).toBe( true )
        expect( result.worklist.find( ( w ) => w.schema === 'demoapi' ).reason ).toBe( 'under-target' )
    } )

    it( 'graded fresh at/above --target → skipped (no work)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: realGrading } )
        await seedGradedIsland( { cwd, schemaHash: LIVE_HASH, grade: 'B' } )

        const { result } = await FlowMcpCli.gradingPlan( { cwd, target: 'demoapi', gradingDataDir: GRADING_DIR, targetGrade: 'B', json: false } )
        expect( result.status ).toBe( true )
        expect( result.worklist ).toEqual( [] )
        expect( result.skip.map( ( s ) => s.schema ) ).toContain( 'demoapi' )
    } )

    it( 'legacy grade (no stored hash) is NOT treated as stale', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: realGrading } )
        await seedGradedIsland( { cwd, schemaHash: null, grade: 'B' } )

        const { result } = await FlowMcpCli.gradingPlan( { cwd, target: 'demoapi', gradingDataDir: GRADING_DIR, targetGrade: null, json: false } )
        expect( result.status ).toBe( true )
        expect( result.worklist ).toEqual( [] )
        expect( result.skip.find( ( s ) => s.schema === 'demoapi' ).hashVerified ).toBe( false )
    } )

    it( 'rejects ns/schema and a missing target (no silent default)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: realGrading } )

        const sub = await FlowMcpCli.gradingPlan( { cwd, target: 'demoapi/demoapi', gradingDataDir: GRADING_DIR, targetGrade: null, json: false } )
        expect( sub.result.status ).toBe( false )
        expect( sub.result.error ).toContain( 'bare namespace' )

        const none = await FlowMcpCli.gradingPlan( { cwd, target: '', gradingDataDir: GRADING_DIR, targetGrade: null, json: false } )
        expect( none.result.status ).toBe( false )
        expect( none.result.error ).toContain( 'Missing plan target' )
    } )
} )


describe( 'Memo 112 P6.1 — grading finalize: guards', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'rejects a ns/schema target (finalize is namespace-level)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: realGrading } )

        const { result } = await FlowMcpCli.gradingFinalize( { cwd, target: 'demoapi/demoapi', gradingDataDir: GRADING_DIR, gradingExportDir: null, targetGrade: null, json: false } )
        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'bare namespace' )
    } )

    it( 'rejects a missing target', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: realGrading } )

        const { result } = await FlowMcpCli.gradingFinalize( { cwd, target: '', gradingDataDir: GRADING_DIR, gradingExportDir: null, targetGrade: null, json: false } )
        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Missing finalize target' )
    } )
} )


describe( 'Memo 112 P6.3/P6.4 — orchestrator emit: worklist filter + outer-loop doc', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    function gradingStub() {
        const stub = {
            run: async ( params ) => ( {
                ok: true, passedDownloadable: 3, required: 3, toolsBelowThreshold: [],
                perTool: {}, schemaDir: null,
                summaryPath: join( params.gradingDataDir, 'providers', params.namespace, params.toolName, 'summary.json' ),
                results: [], stopReason: null, errors: []
            } ),
            getVersion: () => ( { version: 'stub' } )
        }
        return { ...realGrading, DataPretest: stub }
    }

    async function emit( { cwd } ) {
        return FlowMcpCli.gradingRun( {
            cwd, gradingDataDir: GRADING_DIR, target: 'demoapi',
            phase: 'single-test,tools-aggregate-schema', emitPrompts: true, consumeScores: null,
            onConflict: null, maxIterations: null, json: false
        } )
    }

    it( 'P6.4 — the orchestrator carries the outer loop: state → re-dispatch → finalize', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingStub() } )

        const { result } = await emit( { cwd } )
        expect( result.status ).toBe( true )
        expect( result.emitSkill ).toContain( 'grading state demoapi' )
        expect( result.emitSkill ).toContain( 'grading finalize demoapi' )
        expect( result.emitSkill ).toContain( 'Outer loop' )
    } )

    it( 'P6.3 — a fresh schema is skipped (not dispatched) by the orchestrator', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingStub() } )
        // Mark demoapi as graded + fresh (stored hash == live) BEFORE the emit.
        await seedGradedIsland( { cwd, schemaHash: LIVE_HASH } )

        const { result } = await emit( { cwd } )
        expect( result.status ).toBe( true )
        expect( result.emitSkill ).toContain( 'Skipped (fresh' )
        expect( result.emitSkill ).toContain( 'nothing to grade this pass' )
    } )

    it( 'P6.3 — an ungraded schema IS dispatched (worklist non-empty)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingStub() } )

        const { result } = await emit( { cwd } )
        expect( result.status ).toBe( true )
        expect( result.emitSkill ).toContain( 'demoapi/demoapi --emit-prompts' )
    } )
} )
