import { describe, it, expect, beforeEach, afterEach, beforeAll } from '@jest/globals'
import { mkdir, mkdtemp, cp, readFile, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import { ModuleRegistry } from '../../src/lib/ModuleRegistry.mjs'
import { GradingTarget } from '../../src/commands/grading/GradingTarget.mjs'
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


// Memo 102 Phase 2 / PRD-006 — the `gradingImport — Stage 0 intake` describe block
// was removed: the CLI `grading import` command and FlowMcpCli.gradingImport method
// no longer exist (the run reads schemas live from schemaFolders[] and builds the
// island on first run). The GradingImport machinery itself is now covered by
// flowmcp-grading's own tests (GradingImport.test.mjs).


describe( 'gradingRun — flow detection (F29)', () => {
    afterEach( () => { ModuleRegistry.inject( { grading: null } ) } )

    it( 'errors when the target is in neither the island nor schemaFolders[]', async () => {
        const cwd = await freshCwd()
        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'ghost', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'found in neither' )
        // PRD-004 (B3): the fix points at schemaFolders[], not "grading import".
        expect( result.fix ).toContain( 'schemaFolders[]' )
    } )

    it( 'errors ambiguously when the target is in both trees', async () => {
        const cwd = await freshCwd()
        await mkdir( join( cwd, '.flowmcp', 'grading','providers', 'dup' ), { recursive: true } )
        await mkdir( join( cwd, '.flowmcp', 'grading','selections', 'dup' ), { recursive: true } )

        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'dup', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Ambiguous' )
        expect( result.fix ).toContain( 'explicit path' )
    } )

    it( 'detects the provider tier (autonomous, max B) on emit-prompts', async () => {
        const cwd = await freshCwd()
        ModuleRegistry.inject( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )

        expect( result.status ).toBe( true )
        expect( result.flow ).toBe( 'provider' )
        expect( result.tier ).toBe( 'autonomous' )
        expect( result.maxGrade ).toBe( 'B' )
    } )
} )


describe( 'gradingRun — mode + conflict guards (no silent defaults)', () => {
    afterEach( () => { ModuleRegistry.inject( { grading: null } ) } )

    it( 'requires exactly one mode flag', async () => {
        const cwd = await freshCwd()
        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: false, consumeScores: null, onConflict: null, json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Mode required' )
    } )

    it( 'rejects both modes at once', async () => {
        const cwd = await freshCwd()
        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: true, consumeScores: 'x.json', onConflict: null, json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'mutually exclusive' )
    } )

    it( 'rejects an invalid --on-conflict value', async () => {
        const cwd = await freshCwd()
        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: 'nuke', json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Invalid --on-conflict' )
    } )
} )


describe( 'gradingRun — F16 dependency resolver', () => {
    afterEach( () => { ModuleRegistry.inject( { grading: null } ) } )

    it( 'hard-aborts (coded, no silent skip) when index.json is missing and the namespace is not in schemaFolders[]', async () => {
        const cwd = await freshCwd()
        // A provider folder exists (F29 passes) but it has no index.json and the
        // `bare` namespace is not registered in schemaFolders[]. PRD-004 (B3): the
        // provider branch resolves live and surfaces the coded SRC-001 hard abort.
        await mkdir( join( cwd, '.flowmcp', 'grading','providers', 'bare' ), { recursive: true } )
        ModuleRegistry.inject( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'bare', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'SRC-001' )
        expect( result.error ).toContain( 'not found in any schemaFolders[]' )
        expect( Array.isArray( result.dependencyChain ) ).toBe( true )
    } )

    it( 'reports (does not block) when rollup quality is below stable', async () => {
        const cwd = await freshCwd()
        ModuleRegistry.inject( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        // First run auto-builds the island index from the live read (B3). The
        // second run sees an existing (below-stable) index -> the resolver's
        // quality-report branch fires (report only, no downgrade).
        await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: 'overwrite', json: false } )
        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: 'overwrite', json: false } )

        expect( result.status ).toBe( true )
        const reportStep = result.dependencyChain.find( ( s ) => s.step === 'quality-report' )
        expect( reportStep ).toBeDefined()
        expect( reportStep.note ).toContain( 'no downgrade' )
    } )
} )


describe( 'gradingRun — Stage 1 emit-prompts (handoff + baton)', () => {
    afterEach( () => { ModuleRegistry.inject( { grading: null } ) } )

    it( 'emits prompts.json + state.json with a Goal-Block', async () => {
        const cwd = await freshCwd()
        ModuleRegistry.inject( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )

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

    it( 'Memo 097 PA-1: emits composed areas[] (not just a goalBlock) with maxIterations default 1', async () => {
        const cwd = await freshCwd()
        ModuleRegistry.inject( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, maxIterations: null, json: false } )

        const prompts = JSON.parse( await readFile( result.promptsPath, 'utf-8' ) )

        // maxIterations defaults to 1 (opt-in higher) — replaces the historical fixed 3.
        expect( prompts.maxIterations ).toBe( 1 )

        // areas[] is the new top-level contract: one entry per EMITTED provider
        // area. PRD-005: the demoapi fixture has no About resource, so
        // `about-namespace` is moved to skippedAreas (out-of-scope-resource) and is
        // NOT emitted — 6 composed areas minus the skipped About = 5 emitted.
        expect( Array.isArray( prompts.areas ) ).toBe( true )
        expect( prompts.areas.length ).toBe( 5 )
        expect( prompts.areas.map( ( a ) => a.area ) ).not.toContain( 'about-namespace' )
        const aboutSkip = prompts.skippedAreas.find( ( s ) => s.area === 'about-namespace' )
        expect( aboutSkip ).toBeDefined()
        expect( aboutSkip.naReason ).toBe( 'out-of-scope-resource' )

        // The neutral areas carry a fully composed prompt (PromptBuilder.build), not
        // merely the goalBlock — they include a rendered question block.
        const neutral = prompts.areas.filter( ( a ) => a.deferred === false )
        expect( neutral.length ).toBeGreaterThan( 0 )
        neutral.forEach( ( a ) => {
            expect( typeof a.prompt ).toBe( 'string' )
            expect( a.prompt.length ).toBeGreaterThan( 100 )
            expect( a.prompt.includes( '## Questions' ) ).toBe( true )
        } )

        // Backward-compatible: goal + pretests remain intact.
        expect( prompts.goal.goalBlock ).toContain( 'Goal-Block' )
        expect( Array.isArray( prompts.pretests ) ).toBe( true )
    } )


    it( 'Memo 097 PA-1: --max-iterations opt-in higher is threaded into prompts.json', async () => {
        const cwd = await freshCwd()
        ModuleRegistry.inject( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, maxIterations: '3', json: false } )

        const prompts = JSON.parse( await readFile( result.promptsPath, 'utf-8' ) )
        expect( prompts.maxIterations ).toBe( 3 )
    } )


    it( 'Memo 097 PA-1: rejects a non-integer --max-iterations (no silent default)', async () => {
        const cwd = await freshCwd()
        ModuleRegistry.inject( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, maxIterations: 'lots', json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'max-iterations' )
    } )


    it( 'F26: persisted pretest handoff carries no request field and no key value', async () => {
        const cwd = await freshCwd()
        ModuleRegistry.inject( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )
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
        ModuleRegistry.inject( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )

        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: 'abort', json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'NO-OVERWRITE' )
    } )

    it( 'second emit with --on-conflict=skip keeps the existing handoff', async () => {
        const cwd = await freshCwd()
        ModuleRegistry.inject( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )

        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: 'skip', json: false } )

        expect( result.status ).toBe( true )
        expect( result.skipped ).toBe( true )
    } )

    it( 'passes flat serverParams to DataPretest.run (CLI is the only env consumer)', async () => {
        const cwd = await freshCwd()
        const injected = gradingWithStubbedPretest( { ok: true } )
        ModuleRegistry.inject( { grading: injected } )

        await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )

        expect( injected.__stub.lastCall ).not.toBeNull()
        expect( typeof injected.__stub.lastCall.serverParams ).toBe( 'object' )
        expect( Array.isArray( injected.__stub.lastCall.serverParams ) ).toBe( false )
        expect( injected.__stub.lastCall.main ).toBeDefined()
    } )
} )


describe( 'gradingRun — Stage 3 consume-scores', () => {
    afterEach( () => { ModuleRegistry.inject( { grading: null } ) } )

    it( 'consumes a scores fixture, rebuilds the 5-status index, finalizes state', async () => {
        const cwd = await freshCwd()
        ModuleRegistry.inject( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )

        const scoresPath = join( cwd, 'scores.json' )
        await writeFile( scoresPath, JSON.stringify( { scoringProtocol: 'v1', scores: [ { dimension: 'whenToUse', score: 4.0 } ] } ), 'utf-8' )

        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: false, consumeScores: scoresPath, onConflict: null, json: false } )

        expect( result.status ).toBe( true )
        expect( result.stage ).toBe( 3 )
        expect( result.indexPath ).toContain( 'index.json' )
        expect( typeof result.rollupStatus ).toBe( 'string' )

        const state = JSON.parse( await readFile( result.statePath || join( cwd, '.flowmcp', 'grading','providers', 'demoapi', 'state.json' ), 'utf-8' ) )
        expect( state.status ).toBe( 'graded' )
        expect( state.phases.indexRebuilt ).not.toBeNull()
    } )

    it( 'reports a missing scores file', async () => {
        const cwd = await freshCwd()
        ModuleRegistry.inject( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: false, consumeScores: 'nope.json', onConflict: null, json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Scores file not found' )
    } )
} )


describe( 'gradingState — read-only rollup', () => {
    afterEach( () => { ModuleRegistry.inject( { grading: null } ) } )

    it( 'returns the rollup state for a built namespace (read-only)', async () => {
        const cwd = await freshCwd()
        ModuleRegistry.inject( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        // PRD-006: the island is built by the first emit run (no import).
        await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, maxIterations: null, json: false } )

        const { result } = await FlowMcpCli.gradingState( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', json: false } )

        expect( result.status ).toBe( true )
        expect( result.flow ).toBe( 'provider' )
        expect( result.indexPresent ).toBe( true )
        expect( typeof result.rollupStatus ).toBe( 'string' )
    } )

    it( 'errors for an unknown target', async () => {
        const cwd = await freshCwd()
        const { result } = await FlowMcpCli.gradingState( { cwd, gradingDataDir: '.flowmcp/grading', target:'unknown', json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'found in neither' )
    } )
} )


describe( 'gradingExport — OUT round-trip (never overwrites source)', () => {
    afterEach( () => { ModuleRegistry.inject( { grading: null } ) } )

    it( 'exports index.json into a fresh folder, source untouched', async () => {
        const cwd = await freshCwd()
        ModuleRegistry.inject( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        // PRD-006: the island (and its index.json) is built by the first emit run
        // from the live schemaFolders[] read — no import step.
        await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, maxIterations: null, json: false } )
        const sourceIndex = join( cwd, '.flowmcp', 'grading', 'providers', 'demoapi', 'index.json' )
        expect( existsSync( sourceIndex ) ).toBe( true )

        const { result } = await FlowMcpCli.gradingExport( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', onConflict: null, json: false } )

        expect( result.status ).toBe( true )
        expect( result.flow ).toBe( 'namespace' )
        // Returned paths are repo-relative (path-hardening §3.7): resolve against cwd
        // to hit the filesystem.
        expect( existsSync( join( cwd, result.indexExportPath ) ) ).toBe( true )
        // The fresh export folder must be distinct from the source index folder.
        expect( dirname( join( cwd, result.indexExportPath ) ) ).not.toBe( dirname( sourceIndex ) )
        expect( existsSync( sourceIndex ) ).toBe( true )
    } )
} )


describe( 'gradingExport — config-driven destination (#gradingExportRoot, PRD-007)', () => {
    afterEach( () => {
        ModuleRegistry.inject( { grading: null } )
        delete process.env[ 'FLOWMCP_GRADING_EXPORT' ]
    } )


    // PRD-006: the island is built by the first emit run from the live
    // schemaFolders[] read (no import). Emit so export has an index.json to export.
    async function seedImportedNamespace() {
        const cwd = await freshCwd()
        ModuleRegistry.inject( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, maxIterations: null, json: false } )
        return cwd
    }


    it( 'T1 — default: export lands under <island>/_exports (backward-compat)', async () => {
        const cwd = await seedImportedNamespace()

        const { result } = await FlowMcpCli.gradingExport( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', onConflict: null, gradingExportDir: null, json: false } )

        expect( result.status ).toBe( true )
        // Relative path under cwd: .flowmcp/grading/_exports/demoapi--<stamp>
        expect( result.exportDir.startsWith( join( '.flowmcp', 'grading', '_exports' ) ) ).toBe( true )
        expect( existsSync( join( cwd, result.exportDir ) ) ).toBe( true )
    } )


    it( 'T2 — --export-dir flag wins (resolve cwd, flag)', async () => {
        const cwd = await seedImportedNamespace()

        const { result } = await FlowMcpCli.gradingExport( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', onConflict: null, gradingExportDir: 'out/exports', json: false } )

        expect( result.status ).toBe( true )
        expect( result.exportDir.startsWith( join( 'out', 'exports' ) ) ).toBe( true )
        expect( existsSync( join( cwd, result.exportDir ) ) ).toBe( true )
    } )


    it( 'T3 — FLOWMCP_GRADING_EXPORT env resolves the destination', async () => {
        const cwd = await seedImportedNamespace()
        process.env[ 'FLOWMCP_GRADING_EXPORT' ] = 'env-exports'

        const { result } = await FlowMcpCli.gradingExport( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', onConflict: null, gradingExportDir: null, json: false } )

        expect( result.status ).toBe( true )
        expect( result.exportDir.startsWith( 'env-exports' ) ).toBe( true )
    } )


    it( 'T5 — precedence flag > env > default', async () => {
        const cwd = await seedImportedNamespace()
        process.env[ 'FLOWMCP_GRADING_EXPORT' ] = 'env-exports'

        const { result } = await FlowMcpCli.gradingExport( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', onConflict: null, gradingExportDir: 'flag-exports', json: false } )

        expect( result.status ).toBe( true )
        // Flag wins over env.
        expect( result.exportDir.startsWith( 'flag-exports' ) ).toBe( true )
    } )


    it( 'T7 — returned exportDir / indexExportPath are repo-relative (no /Users/, no abs)', async () => {
        const cwd = await seedImportedNamespace()

        const { result } = await FlowMcpCli.gradingExport( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', onConflict: null, gradingExportDir: null, json: false } )

        expect( result.status ).toBe( true )
        const blob = JSON.stringify( result )
        // No absolute path, no username/home leak anywhere in the returned object.
        expect( blob ).not.toContain( '/Users/' )
        expect( result.exportDir.startsWith( '/' ) ).toBe( false )
        expect( result.indexExportPath.startsWith( '/' ) ).toBe( false )
        result.schemaExports.forEach( ( s ) => {
            expect( s.exportPath.startsWith( '/' ) ).toBe( false )
            expect( s.exportPath ).not.toContain( '/Users/' )
        } )
    } )


    it( 'T8 — EXP-003 surfaced message is relativized (deterministic, injected module)', async () => {
        const cwd = await freshCwd()
        // Inject a grading module whose GradingExport.run returns an EXP-003 error
        // that embeds an ABSOLUTE home path. The CLI must relativize it before
        // surfacing it (no /Users/, ~-collapsed).
        const home = ( await import( 'node:os' ) ).homedir()
        const absLeak = join( home, '.flowmcp', 'grading', '_exports', 'demoapi--x' )
        const injected = {
            ...realGrading,
            GradingExport: {
                run: async () => ( {
                    status: false,
                    flow: 'namespace',
                    indexExportPath: null,
                    schemaExports: [],
                    errors: [ `EXP-003: export folder already exists (no overwrite): ${absLeak}` ]
                } )
            }
        }
        ModuleRegistry.inject( { grading: injected } )
        // F29 needs a real provider folder to pass flow detection.
        await mkdir( join( cwd, '.flowmcp', 'grading', 'providers', 'demoapi', 'demoapi' ), { recursive: true } )

        const { result } = await FlowMcpCli.gradingExport( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', onConflict: null, gradingExportDir: null, json: false } )

        expect( result.status ).toBe( false )
        const blob = JSON.stringify( result )
        expect( blob ).not.toContain( '/Users/' )
        expect( blob ).not.toContain( home )
        // The home prefix is collapsed to ~.
        expect( result.error ).toContain( '~/.flowmcp/grading/_exports/demoapi--x' )
    } )


    it( 'T9 — malformed (non-string) config gradingExportDir does not collapse; falls through', async () => {
        const cwd = await seedImportedNamespace()
        // A non-string flag value (number) must NOT be treated as a path. The
        // resolver's explicit type check skips it and falls through to the default
        // (level 4), not a silent collapse.
        const { result } = await FlowMcpCli.gradingExport( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', onConflict: null, gradingExportDir: 12345, json: false } )

        expect( result.status ).toBe( true )
        // Fell through to the level-4 default <island>/_exports.
        expect( result.exportDir.startsWith( join( '.flowmcp', 'grading', '_exports' ) ) ).toBe( true )
    } )
} )


// Memo 097 PA-3 — grading worklist <ns> --json (flat, deduplicated error list).
describe( 'gradingWorklist — flat dedup error list (PA-3)', () => {
    afterEach( () => { ModuleRegistry.inject( { grading: null } ) } )


    async function seedEmitted( { ok } ) {
        const cwd = await freshCwd()
        ModuleRegistry.inject( { grading: gradingWithStubbedPretest( { ok } ) } )
        await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )
        return cwd
    }


    it( 'returns a flat array of { namespace, schema, code, message } from pretest errors', async () => {
        const cwd = await freshCwd()
        ModuleRegistry.inject( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )

        // Inject deterministic pretest errors into the emitted handoff.
        const promptsPath = join( cwd, '.flowmcp', 'grading', 'providers', 'demoapi', 'prompts.json' )
        const prompts = JSON.parse( await readFile( promptsPath, 'utf-8' ) )
        prompts.pretests = [
            { schemaName: 'demoapi', ok: false, errors: [
                'DPT-005: Required server parameter absent from serverParams: DEMO_API_KEY',
                'DPT-004: Test failed (not counted as a working download): getThing: HTTP 404: Not Found'
            ] }
        ]
        await writeFile( promptsPath, JSON.stringify( prompts, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.gradingWorklist( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', json: true } )

        expect( Array.isArray( result ) ).toBe( true )
        const codes = result.map( ( item ) => item.code )
        expect( codes ).toContain( 'DPT-005' )
        expect( codes ).toContain( 'DPT-004' )
        result.forEach( ( item ) => {
            expect( item.namespace ).toBe( 'demoapi' )
            expect( typeof item.schema ).toBe( 'string' )
            expect( typeof item.message ).toBe( 'string' )
        } )
        // DPT-005 surfaces the KEY NAME only, never a value.
        const dpt005 = result.find( ( item ) => item.code === 'DPT-005' )
        expect( dpt005.message ).toContain( 'DEMO_API_KEY' )
    } )


    it( 'deduplicates identical (schema, code, message) tuples', async () => {
        const cwd = await freshCwd()
        ModuleRegistry.inject( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, json: false } )

        const promptsPath = join( cwd, '.flowmcp', 'grading', 'providers', 'demoapi', 'prompts.json' )
        const prompts = JSON.parse( await readFile( promptsPath, 'utf-8' ) )
        prompts.pretests = [
            { schemaName: 'demoapi', ok: false, errors: [
                'DPT-003: Data-pretest abort: tool(s) below 3 working downloadable tests',
                'DPT-003: Data-pretest abort: tool(s) below 3 working downloadable tests'
            ] }
        ]
        await writeFile( promptsPath, JSON.stringify( prompts, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.gradingWorklist( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', json: true } )

        const dpt003 = result.filter( ( item ) => item.code === 'DPT-003' )
        expect( dpt003.length ).toBe( 1 )
    } )


    it( 'merges index.json blockers (import errors) into the worklist', async () => {
        const cwd = await seedEmitted( { ok: true } )

        const { result } = await FlowMcpCli.gradingWorklist( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', json: true } )

        // The stubbed-ok fixture import leaves no blockers, but the call must
        // still return a flat array (never throw, never null).
        expect( Array.isArray( result ) ).toBe( true )
    } )


    it( 'NO SILENT DEFAULT: missing prompts.json returns a coded error, not an empty list', async () => {
        const cwd = await freshCwd()
        ModuleRegistry.inject( { grading: gradingWithStubbedPretest( { ok: true } ) } )
        // Import only — never emit, so prompts.json does not exist.

        const { result } = await FlowMcpCli.gradingWorklist( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', json: true } )

        expect( Array.isArray( result ) ).toBe( false )
        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'WL-001' )
        expect( result.fix ).toContain( '--emit-prompts' )
    } )


    it( 'reports a missing target', async () => {
        const { result } = await FlowMcpCli.gradingWorklist( { cwd: '/tmp', gradingDataDir: '.flowmcp/grading', target: '', json: true } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Missing worklist target' )
    } )
} )


// Memo 097 PA-5 — grading.useKeys dev-flag (DEFAULT OFF).
describe( 'gradingRun useKeys gate (PA-5, default OFF)', () => {
    afterEach( () => {
        ModuleRegistry.inject( { grading: null } )
        delete process.env[ 'FLOWMCP_GRADING_USE_KEYS' ]
    } )


    it( 'default OFF: passes an EMPTY serverParams object to DataPretest (no live keys)', async () => {
        const cwd = await freshCwd()
        const injected = gradingWithStubbedPretest( { ok: true } )
        ModuleRegistry.inject( { grading: injected } )

        const { result } = await FlowMcpCli.gradingRun( { cwd, gradingDataDir: '.flowmcp/grading', target:'demoapi', phase: null, emitPrompts: true, consumeScores: null, onConflict: null, maxIterations: null, withKeys: false, json: false } )

        // serverParams is an object with zero keys — key-gated tools fail with DPT-005.
        expect( injected.__stub.lastCall ).not.toBeNull()
        const sp = injected.__stub.lastCall.serverParams
        expect( typeof sp ).toBe( 'object' )
        expect( Object.keys( sp ).length ).toBe( 0 )
        expect( result.useKeys ).toBe( false )
    } )


    it( 'env FLOWMCP_GRADING_USE_KEYS=1 opts in (serverParams populated when keys exist)', async () => {
        process.env[ 'FLOWMCP_GRADING_USE_KEYS' ] = '1'
        const { useKeys } = await GradingTarget.gradingUseKeys( { withKeys: false } )
        expect( useKeys ).toBe( true )
    } )


    it( '--with-keys flag opts in regardless of env/config', async () => {
        const { useKeys } = await GradingTarget.gradingUseKeys( { withKeys: true } )
        expect( useKeys ).toBe( true )
    } )


    it( 'default (no flag, no env, no config) resolves to false', async () => {
        const { useKeys } = await GradingTarget.gradingUseKeys( { withKeys: false } )
        expect( useKeys ).toBe( false )
    } )
} )


// Memo 097 PA-6 — island resolution precedence (one global config).
describe( 'island resolution precedence (PA-6)', () => {
    afterEach( () => { delete process.env[ 'FLOWMCP_GRADING_DATA' ] } )


    it( '--grading-data flag wins (cwd-relative)', async () => {
        const cwd = await freshCwd()
        const root = await GradingTarget.gradingDataRoot( { cwd, gradingDataDir: 'custom/island' } )
        expect( root ).toBe( join( cwd, 'custom', 'island' ) )
    } )


    it( 'env FLOWMCP_GRADING_DATA wins when no flag', async () => {
        const cwd = await freshCwd()
        process.env[ 'FLOWMCP_GRADING_DATA' ] = 'env/island'
        const root = await GradingTarget.gradingDataRoot( { cwd, gradingDataDir: null } )
        expect( root ).toBe( join( cwd, 'env', 'island' ) )
    } )
} )
