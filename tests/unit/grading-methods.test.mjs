import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdir, mkdtemp, cp, readFile, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import * as realGrading from 'flowmcp-grading'


const here = dirname( fileURLToPath( import.meta.url ) )
const providerFixture = join( here, '..', 'integration', 'fixtures', 'grading-provider' )


// Wrap the real grading module but stub DataPretest.run so the emit-prompts
// stage never makes a live API call (live runs are P5). Everything else
// (GradingImport, RebuildIndex, PromptBuilder, GradingExport) is the real code.
function gradingWithStubbedPretest( { ok = true } ) {
    let lastCall = null
    const stub = {
        run: async ( params ) => {
            lastCall = params
            return {
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
            }
        },
        getVersion: () => ( { version: 'stub' } ),
        get lastCall() { return lastCall }
    }

    return { ...realGrading, DataPretest: stub, __stub: stub }
}


async function freshCwd() {
    const base = await mkdtemp( join( tmpdir(), 'grading-cwd-' ) )
    return base
}


describe( 'gradingImport — Stage 0 intake (real module)', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'imports a fixture provider into the island + builds index.json', async () => {
        const cwd = await freshCwd()
        const { result } = await FlowMcpCli.gradingImport( { cwd, path: providerFixture, onConflict: null, json: false } )

        expect( result.status ).toBe( true )
        expect( result.namespace ).toBe( 'demoapi' )
        expect( result.indexPath ).toContain( 'index.json' )
        expect( existsSync( result.indexPath ) ).toBe( true )

        const islandSchema = join( cwd, 'grading-data', 'providers', 'demoapi', 'demoapi', 'schema' )
        expect( existsSync( islandSchema ) ).toBe( true )
        const snapshots = await readdir( islandSchema )
        expect( snapshots.some( ( n ) => n.endsWith( '.mjs' ) ) ).toBe( true )
    } )

    it( 'never writes outside cwd/grading-data (no ~/.flowmcp touch)', async () => {
        const cwd = await freshCwd()
        const { result } = await FlowMcpCli.gradingImport( { cwd, path: providerFixture, onConflict: null, json: false } )

        expect( result.status ).toBe( true )
        expect( result.indexPath.startsWith( join( cwd, 'grading-data' ) ) ).toBe( true )
    } )

    it( 'skips an unchanged schema on a second import (same hash, no overwrite)', async () => {
        const cwd = await freshCwd()
        await FlowMcpCli.gradingImport( { cwd, path: providerFixture, onConflict: null, json: false } )
        const { result } = await FlowMcpCli.gradingImport( { cwd, path: providerFixture, onConflict: null, json: false } )

        expect( result.status ).toBe( true )
        expect( result.skipped.length ).toBeGreaterThan( 0 )
        expect( result.imported.length ).toBe( 0 )
    } )

    it( 'aborts when the grading module is unavailable', async () => {
        FlowMcpCli.__testInjectGrading( { grading: {} } )
        const cwd = await freshCwd()
        const { result } = await FlowMcpCli.gradingImport( { cwd, path: providerFixture, onConflict: null, json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toBe( 'grading module unavailable' )
    } )

    it( 'reports a non-existent provider path', async () => {
        const cwd = await freshCwd()
        const { result } = await FlowMcpCli.gradingImport( { cwd, path: 'does/not/exist', onConflict: null, json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'not found' )
    } )
} )


describe( 'gradingRun — flow detection (F29)', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'errors when the target is in neither providers nor selections', async () => {
        const cwd = await freshCwd()
        const { result } = await FlowMcpCli.gradingRun( { cwd, target: 'ghost', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'found in neither' )
        expect( result.fix ).toContain( 'grading import' )
    } )

    it( 'errors ambiguously when the target is in both trees', async () => {
        const cwd = await freshCwd()
        await mkdir( join( cwd, 'grading-data', 'providers', 'dup' ), { recursive: true } )
        await mkdir( join( cwd, 'grading-data', 'selections', 'dup' ), { recursive: true } )

        const { result } = await FlowMcpCli.gradingRun( { cwd, target: 'dup', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Ambiguous' )
        expect( result.fix ).toContain( 'explicit path' )
    } )

    it( 'detects the provider tier (autonomous, max B) on emit-prompts', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        await FlowMcpCli.gradingImport( { cwd, path: providerFixture, onConflict: null, json: false } )

        const { result } = await FlowMcpCli.gradingRun( { cwd, target: 'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )

        expect( result.status ).toBe( true )
        expect( result.flow ).toBe( 'provider' )
        expect( result.tier ).toBe( 'autonomous' )
        expect( result.maxGrade ).toBe( 'B' )
    } )
} )


describe( 'gradingRun — mode + conflict guards (no silent defaults)', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'requires exactly one mode flag', async () => {
        const cwd = await freshCwd()
        const { result } = await FlowMcpCli.gradingRun( { cwd, target: 'demoapi', phase: null, emitPrompts: false, consumeScores: null, onConflict: null, json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Mode required' )
    } )

    it( 'rejects both modes at once', async () => {
        const cwd = await freshCwd()
        const { result } = await FlowMcpCli.gradingRun( { cwd, target: 'demoapi', phase: null, emitPrompts: true, consumeScores: 'x.json', onConflict: null, json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'mutually exclusive' )
    } )

    it( 'rejects an invalid --on-conflict value', async () => {
        const cwd = await freshCwd()
        const { result } = await FlowMcpCli.gradingRun( { cwd, target: 'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: 'nuke', json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Invalid --on-conflict' )
    } )
} )


describe( 'gradingRun — F16 dependency resolver', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'hard-aborts when index.json is missing and no source is available', async () => {
        const cwd = await freshCwd()
        // A provider folder exists (F29 passes) but it has no index.json.
        await mkdir( join( cwd, 'grading-data', 'providers', 'bare' ), { recursive: true } )
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const { result } = await FlowMcpCli.gradingRun( { cwd, target: 'bare', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'No index.json' )
        expect( Array.isArray( result.dependencyChain ) ).toBe( true )
    } )

    it( 'reports (does not block) when rollup quality is below stable', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        await FlowMcpCli.gradingImport( { cwd, path: providerFixture, onConflict: null, json: false } )

        const { result } = await FlowMcpCli.gradingRun( { cwd, target: 'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )

        expect( result.status ).toBe( true )
        const reportStep = result.dependencyChain.find( ( s ) => s.step === 'quality-report' )
        expect( reportStep ).toBeDefined()
        expect( reportStep.note ).toContain( 'no downgrade' )
    } )
} )


describe( 'gradingRun — Stage 1 emit-prompts (handoff + baton)', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'emits prompts.json + state.json with a Goal-Block', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        await FlowMcpCli.gradingImport( { cwd, path: providerFixture, onConflict: null, json: false } )

        const { result } = await FlowMcpCli.gradingRun( { cwd, target: 'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )

        expect( result.status ).toBe( true )
        expect( result.stage ).toBe( 1 )
        expect( existsSync( result.promptsPath ) ).toBe( true )
        expect( existsSync( result.statePath ) ).toBe( true )

        const prompts = JSON.parse( await readFile( result.promptsPath, 'utf-8' ) )
        expect( prompts.goal.goalBlock ).toContain( 'Goal-Block' )
        expect( prompts.goal.condition ).toContain( 'stop after' )

        const state = JSON.parse( await readFile( result.statePath, 'utf-8' ) )
        expect( state.status ).toBe( 'prompts-emitted' )
        expect( state.phases.promptsEmitted ).not.toBeNull()
    } )

    it( 'F26: persisted pretest handoff carries no request field and no key value', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        await FlowMcpCli.gradingImport( { cwd, path: providerFixture, onConflict: null, json: false } )

        const { result } = await FlowMcpCli.gradingRun( { cwd, target: 'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )
        const raw = await readFile( result.promptsPath, 'utf-8' )

        expect( raw ).not.toContain( '"request"' )
        expect( raw ).not.toContain( '_allParams' )
        const prompts = JSON.parse( raw )
        prompts.pretests.forEach( ( p ) => {
            expect( p.request ).toBeUndefined()
        } )
    } )

    it( 'second emit with --on-conflict=abort returns a NO-OVERWRITE error', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        await FlowMcpCli.gradingImport( { cwd, path: providerFixture, onConflict: null, json: false } )
        await FlowMcpCli.gradingRun( { cwd, target: 'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )

        const { result } = await FlowMcpCli.gradingRun( { cwd, target: 'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: 'abort', json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'NO-OVERWRITE' )
    } )

    it( 'second emit with --on-conflict=skip keeps the existing handoff', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        await FlowMcpCli.gradingImport( { cwd, path: providerFixture, onConflict: null, json: false } )
        await FlowMcpCli.gradingRun( { cwd, target: 'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )

        const { result } = await FlowMcpCli.gradingRun( { cwd, target: 'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: 'skip', json: false } )

        expect( result.status ).toBe( true )
        expect( result.skipped ).toBe( true )
    } )

    it( 'passes flat serverParams to DataPretest.run (CLI is the only env consumer)', async () => {
        const cwd = await freshCwd()
        const injected = gradingWithStubbedPretest( { ok: true } )
        FlowMcpCli.__testInjectGrading( { grading: injected } )
        await FlowMcpCli.gradingImport( { cwd, path: providerFixture, onConflict: null, json: false } )

        await FlowMcpCli.gradingRun( { cwd, target: 'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )

        expect( injected.__stub.lastCall ).not.toBeNull()
        expect( typeof injected.__stub.lastCall.serverParams ).toBe( 'object' )
        expect( Array.isArray( injected.__stub.lastCall.serverParams ) ).toBe( false )
        expect( injected.__stub.lastCall.main ).toBeDefined()
    } )
} )


describe( 'gradingRun — Stage 3 consume-scores', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'consumes a scores fixture, rebuilds the 5-status index, finalizes state', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        await FlowMcpCli.gradingImport( { cwd, path: providerFixture, onConflict: null, json: false } )
        await FlowMcpCli.gradingRun( { cwd, target: 'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )

        const scoresPath = join( cwd, 'scores.json' )
        await writeFile( scoresPath, JSON.stringify( { scoringProtocol: 'v1', scores: [ { dimension: 'whenToUse', score: 4.0 } ] } ), 'utf-8' )

        const { result } = await FlowMcpCli.gradingRun( { cwd, target: 'demoapi', phase: null, emitPrompts: false, consumeScores: scoresPath, onConflict: null, json: false } )

        expect( result.status ).toBe( true )
        expect( result.stage ).toBe( 3 )
        expect( result.indexPath ).toContain( 'index.json' )
        expect( typeof result.rollupStatus ).toBe( 'string' )

        const state = JSON.parse( await readFile( result.statePath || join( cwd, 'grading-data', 'providers', 'demoapi', 'state.json' ), 'utf-8' ) )
        expect( state.status ).toBe( 'graded' )
        expect( state.phases.indexRebuilt ).not.toBeNull()
    } )

    it( 'reports a missing scores file', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        await FlowMcpCli.gradingImport( { cwd, path: providerFixture, onConflict: null, json: false } )

        const { result } = await FlowMcpCli.gradingRun( { cwd, target: 'demoapi', phase: null, emitPrompts: false, consumeScores: 'nope.json', onConflict: null, json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Scores file not found' )
    } )
} )


describe( 'gradingState — read-only rollup', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'returns the rollup state for an imported namespace (read-only)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        await FlowMcpCli.gradingImport( { cwd, path: providerFixture, onConflict: null, json: false } )

        const { result } = await FlowMcpCli.gradingState( { cwd, target: 'demoapi', json: false } )

        expect( result.status ).toBe( true )
        expect( result.flow ).toBe( 'provider' )
        expect( result.indexPresent ).toBe( true )
        expect( typeof result.rollupStatus ).toBe( 'string' )
    } )

    it( 'errors for an unknown target', async () => {
        const cwd = await freshCwd()
        const { result } = await FlowMcpCli.gradingState( { cwd, target: 'unknown', json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'found in neither' )
    } )
} )


describe( 'gradingExport — OUT round-trip (never overwrites source)', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'exports index.json into a fresh folder, source untouched', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        const imp = await FlowMcpCli.gradingImport( { cwd, path: providerFixture, onConflict: null, json: false } )
        const sourceIndex = imp.result.indexPath

        const { result } = await FlowMcpCli.gradingExport( { cwd, target: 'demoapi', onConflict: null, json: false } )

        expect( result.status ).toBe( true )
        expect( result.flow ).toBe( 'namespace' )
        expect( existsSync( result.indexExportPath ) ).toBe( true )
        // The fresh export folder must be distinct from the source index folder.
        expect( dirname( result.indexExportPath ) ).not.toBe( dirname( sourceIndex ) )
        expect( existsSync( sourceIndex ) ).toBe( true )
    } )
} )
