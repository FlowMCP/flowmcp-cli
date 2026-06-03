import { describe, it, expect, afterEach } from '@jest/globals'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import * as realGrading from 'flowmcp-grading'


const here = dirname( fileURLToPath( import.meta.url ) )
const providerFixture = join( here, '..', 'integration', 'fixtures', 'grading-provider' )


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
    return mkdtemp( join( tmpdir(), 'grading-phase3-' ) )
}


async function importAndEmit( { cwd, ok = true } ) {
    FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok } ) } )
    await FlowMcpCli.gradingImport( { cwd, gradingDataDir: '.flowmcp/grading', path: providerFixture, onConflict: null, json: false } )
    await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, maxIterations: null, json: false } )
}


// ---- PRD-009: grading doctor <ns> ---------------------------------------------
describe( 'PRD-009 — grading doctor <ns> (defects + tips + nextLoop, read-only)', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'returns ONE merged read-only result: defects + tips + nextLoop + nextAction, online:false', async () => {
        const cwd = await freshCwd()
        await importAndEmit( { cwd, ok: true } )

        const { result } = await FlowMcpCli.gradingDoctor( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', json: true } )

        expect( result.status ).toBe( true )
        expect( result.namespace ).toBe( 'demoapi' )
        expect( result.online ).toBe( false )
        expect( Array.isArray( result.defects ) ).toBe( true )
        expect( Array.isArray( result.tips ) ).toBe( true )
        expect( typeof result.nextLoop ).toBe( 'object' )
        expect( typeof result.nextAction ).toBe( 'object' )
        expect( Array.isArray( result.nextLoop.openAreas ) ).toBe( true )
        expect( typeof result.nextLoop.nextAction ).toBe( 'string' )
        expect( typeof result.nextLoop.rationale ).toBe( 'string' )
    } )

    it( 'merges injected pretest defects into the doctor defects list', async () => {
        const cwd = await freshCwd()
        await importAndEmit( { cwd, ok: true } )

        const promptsPath = join( cwd, '.flowmcp', 'grading', 'providers', 'demoapi', 'prompts.json' )
        const prompts = JSON.parse( await readFile( promptsPath, 'utf-8' ) )
        prompts.pretests = [ { schemaName: 'demoapi', ok: false, errors: [
            'DPT-005: Required server parameter absent from serverParams: DEMO_API_KEY',
            'DPT-004: Test failed (not counted as a working download): getThing: HTTP 404: Not Found'
        ] } ]
        await writeFile( promptsPath, JSON.stringify( prompts, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.gradingDoctor( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', json: true } )
        const codes = result.defects.map( ( d ) => d.code )
        expect( codes ).toContain( 'DPT-005' )
        expect( codes ).toContain( 'DPT-004' )
        // KEY NAME only, never a value.
        const dpt005 = result.defects.find( ( d ) => d.code === 'DPT-005' )
        expect( dpt005.message ).toContain( 'DEMO_API_KEY' )
    } )

    it( 'NO SILENT DEFAULT: no prompts.json -> WL-001 coded error (no empty fabrication)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        await FlowMcpCli.gradingImport( { cwd, gradingDataDir: '.flowmcp/grading', path: providerFixture, onConflict: null, json: false } )

        const { result } = await FlowMcpCli.gradingDoctor( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', json: true } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'WL-001' )
        expect( result.fix ).toContain( '--emit-prompts' )
    } )

    it( 'no grading entries -> tips:[] WITH an explicit note (never silently dropped)', async () => {
        const cwd = await freshCwd()
        await importAndEmit( { cwd, ok: true } )

        const { result } = await FlowMcpCli.gradingDoctor( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', json: true } )

        expect( result.tips ).toEqual( [] )
        expect( typeof result.tipsNote ).toBe( 'string' )
        expect( result.tipsNote.length ).toBeGreaterThan( 0 )
    } )

    it( 'collects the latest improvementHints[] per schema/area with iteration', async () => {
        const cwd = await freshCwd()
        await importAndEmit( { cwd, ok: true } )

        // Seed a grading entry with improvementHints under a schema _gradings dir.
        const gradingsDir = join( cwd, '.flowmcp', 'grading', 'providers', 'demoapi', 'demoapi', '_gradings' )
        await mkdir( gradingsDir, { recursive: true } )
        const entry = {
            schemaId: 'demoapi',
            gradingTier: 'autonomous',
            gradings: [],
            area: 'single-test',
            iteration: 2,
            improvementHints: [ 'Add an example to getThing', 'Document the rate limit' ]
        }
        await writeFile( join( gradingsDir, 'single-test--2026-01-01T00-00-00.000Z.json' ), JSON.stringify( entry, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.gradingDoctor( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', json: true } )

        expect( result.tips.length ).toBeGreaterThan( 0 )
        const tip = result.tips.find( ( t ) => t.area === 'single-test' )
        expect( tip ).toBeDefined()
        expect( tip.iteration ).toBe( 2 )
        expect( tip.hints ).toContain( 'Add an example to getThing' )
        expect( tip.schema ).toBe( 'demoapi' )
    } )

    it( 'reports a missing target', async () => {
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        const { result } = await FlowMcpCli.gradingDoctor( { cwd: '/tmp', gradingDataDir: '.flowmcp/grading', target: '', json: true } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Missing doctor target' )
    } )
} )


// ---- PRD-009: worklist subsumed into the shared collector (regression) --------
describe( 'PRD-009 — worklist is a thin wrapper over the shared collector', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'worklist still returns a flat array and doctor.defects equals it', async () => {
        const cwd = await freshCwd()
        await importAndEmit( { cwd, ok: true } )

        const promptsPath = join( cwd, '.flowmcp', 'grading', 'providers', 'demoapi', 'prompts.json' )
        const prompts = JSON.parse( await readFile( promptsPath, 'utf-8' ) )
        prompts.pretests = [ { schemaName: 'demoapi', ok: false, errors: [ 'DPT-003: Data-pretest abort: below threshold' ] } ]
        await writeFile( promptsPath, JSON.stringify( prompts, null, 4 ), 'utf-8' )

        const wl = await FlowMcpCli.gradingWorklist( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', json: true } )
        const doc = await FlowMcpCli.gradingDoctor( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', json: true } )

        expect( Array.isArray( wl.result ) ).toBe( true )
        expect( wl.result ).toEqual( doc.result.defects )
    } )

    it( 'worklist keeps the WL-001 guard (no prompts.json -> coded error)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        await FlowMcpCli.gradingImport( { cwd, gradingDataDir: '.flowmcp/grading', path: providerFixture, onConflict: null, json: false } )

        const { result } = await FlowMcpCli.gradingWorklist( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', json: true } )
        expect( Array.isArray( result ) ).toBe( false )
        expect( result.error ).toContain( 'WL-001' )
    } )
} )


// ---- PRD-010: nextAction (deterministic-now / one non-det set / gated) --------
describe( 'PRD-010 — nextAction split (graph-driven, read-only, no emission)', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'below deterministic-green: namespace areas are gated (cost guard), nonDeterministic is null', async () => {
        const cwd = await freshCwd()
        await importAndEmit( { cwd, ok: false } )

        const { result } = await FlowMcpCli.gradingState( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', json: true } )
        const na = result.nextAction
        expect( na.status ).toBe( true )
        expect( na.nonDeterministic ).toBeNull()
        const gatedAreas = na.gated.map( ( g ) => g.area )
        expect( gatedAreas ).toContain( 'namespace-description' )
        expect( gatedAreas ).toContain( 'namespace-skills' )
        na.gated.forEach( ( g ) => { expect( typeof g.reason ).toBe( 'string' ); expect( g.reason.length ).toBeGreaterThan( 0 ) } )
    } )

    it( 'deterministic-green: non-det areas collapse into ONE area-set with ONE Task-ID preview', async () => {
        const cwd = await freshCwd()
        await importAndEmit( { cwd, ok: true } )

        const { result } = await FlowMcpCli.gradingDoctor( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', json: true } )
        const na = result.nextAction
        expect( na.nonDeterministic ).not.toBeNull()
        expect( Array.isArray( na.nonDeterministic.areaSet ) ).toBe( true )
        expect( na.nonDeterministic.areaSet.length ).toBeGreaterThan( 0 )
        expect( typeof na.nonDeterministic.taskIdPreview ).toBe( 'string' )
        expect( na.nonDeterministic.taskIdPreview ).toContain( 'demoapi--' )
        expect( na.nonDeterministic.skill ).toBe( 'grade-score-single' )
        expect( na.nonDeterministic.free ).toBe( false )
    } )

    it( 'deterministic-remaining areas appear in deterministicNow with a free:true command', async () => {
        const cwd = await freshCwd()
        await importAndEmit( { cwd, ok: true } )

        const { result } = await FlowMcpCli.gradingDoctor( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', json: true } )
        const det = result.nextAction.deterministicNow
        expect( det.free ).toBe( true )
        expect( det.areas ).toContain( 'single-test' )
        expect( det.areas ).toContain( 'tools-aggregate-schema' )
        expect( typeof det.command ).toBe( 'string' )
    } )

    it( 'an inapplicable optional area (About absent) is excluded from ready buckets (it is gated)', async () => {
        const cwd = await freshCwd()
        await importAndEmit( { cwd, ok: true } )

        const { result } = await FlowMcpCli.gradingDoctor( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', json: true } )
        const na = result.nextAction
        expect( na.deterministicNow.areas ).not.toContain( 'about-namespace' )
        if( na.nonDeterministic !== null ) {
            expect( na.nonDeterministic.areaSet ).not.toContain( 'about-namespace' )
        }
        const gatedAreas = na.gated.map( ( g ) => g.area )
        expect( gatedAreas ).toContain( 'about-namespace' )
    } )

    it( 'nextAction is identical on state and doctor', async () => {
        const cwd = await freshCwd()
        await importAndEmit( { cwd, ok: true } )

        const s = await FlowMcpCli.gradingState( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', json: true } )
        const d = await FlowMcpCli.gradingDoctor( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', json: true } )
        expect( s.result.nextAction ).toEqual( d.result.nextAction )
    } )

    it( 'no prompts.json: nextAction is explicit (empty det areas + note), never a fabricated graph', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        await FlowMcpCli.gradingImport( { cwd, gradingDataDir: '.flowmcp/grading', path: providerFixture, onConflict: null, json: false } )

        const { result } = await FlowMcpCli.gradingState( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', json: true } )
        const na = result.nextAction
        expect( na.status ).toBe( true )
        expect( na.deterministicNow.areas ).toEqual( [] )
        expect( na.nonDeterministic ).toBeNull()
        expect( typeof na.note ).toBe( 'string' )
    } )
} )
