import { describe, it, expect, afterEach, beforeAll } from '@jest/globals'
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import * as realGrading from 'flowmcp-grading'
import { seedGradingSchemaFolder } from '../helpers/seed-grading-source.mjs'


const here = dirname( fileURLToPath( import.meta.url ) )
const providerFixture = join( here, '..', 'integration', 'fixtures', 'grading-provider' )


// Memo 102 Phase 4 / PRD-012 — --no-save (single flag -> single internal switch
// dryRun) must perform grading but write NOTHING to the island. These tests
// prove the island stays byte-identical on both entry points and that
// --on-conflict stays orthogonal (a write-policy, not a write-toggle).
beforeAll( async () => {
    await seedGradingSchemaFolder( { providerFixture, namespace: 'demoapi' } )
} )


// The real grading module with a stubbed DataPretest.run. The stub mirrors the
// real contract: when dryRun is forwarded it returns null paths + saved:false and
// performs NO disk write (the real DataPretest already does this — the stub just
// proves the flag is threaded through and never persists).
function gradingWithStubbedPretest( { ok = true } = {} ) {
    let lastCall = null
    const stub = {
        run: async ( params ) => {
            lastCall = params
            const persisted = params.dryRun === true
            return {
                ok,
                passedDownloadable: ok ? 3 : 0,
                required: 3,
                toolsBelowThreshold: ok ? [] : [ 'getThing (0/3)' ],
                perTool: {},
                schemaDir: persisted ? null : join( params.gradingDataDir, 'providers', params.namespace, params.toolName ),
                summaryPath: persisted ? null : join( params.gradingDataDir, 'providers', params.namespace, params.toolName, 'summary.json' ),
                saved: persisted === false,
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
    return mkdtemp( join( tmpdir(), 'grading-nosave-' ) )
}


// Snapshot a directory tree as a stable, content-aware fingerprint: every file's
// repo-relative path plus its exact bytes. Comparing two snapshots proves a
// byte-identical island (no new files, no mutations). A missing root yields the
// empty-snapshot marker.
async function snapshotTree( { root } ) {
    if( existsSync( root ) === false ) {
        return { '__absent__': true }
    }
    const acc = {}
    const walk = async ( { dir } ) => {
        const entries = await readdir( dir, { 'withFileTypes': true } )
        await entries
            .reduce( ( promise, entry ) => promise.then( async () => {
                const full = join( dir, entry.name )
                if( entry.isDirectory() === true ) {
                    await walk( { dir: full } )
                    return
                }
                const rel = relative( root, full )
                acc[ rel ] = await readFile( full, 'utf-8' )
            } ), Promise.resolve() )
    }
    await walk( { dir: root } )

    return acc
}


describe( 'grading deterministic --no-save — byte-identical island', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'writes NO files (provider dir not created) yet returns the pretest + hints', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        const islandRoot = join( cwd, '.flowmcp', 'grading' )
        const before = await snapshotTree( { root: islandRoot } )

        const { result } = await FlowMcpCli.gradingDeterministic( {
            cwd, target: 'demoapi/demoapi', gradingDataDir: '.flowmcp/grading',
            withKeys: false, only: null, dryRun: true, json: true
        } )

        const after = await snapshotTree( { root: islandRoot } )

        // Island byte-identical (here: never created at all).
        expect( after ).toEqual( before )

        // The result still carries the pretest result + hints + explicit saved:false.
        expect( result.mode ).toBe( 'deterministic' )
        expect( result.saved ).toBe( false )
        expect( result.pretest ).toBeDefined()
        expect( result.pretest.ok ).toBe( true )
        expect( Array.isArray( result.hints ) ).toBe( true )

        // No island artifacts of any kind.
        const provDir = join( islandRoot, 'providers', 'demoapi' )
        expect( existsSync( join( provDir, 'summary.json' ) ) ).toBe( false )
        expect( existsSync( join( provDir, 'prompts.json' ) ) ).toBe( false )
        expect( existsSync( join( provDir, 'state.json' ) ) ).toBe( false )
    } )

    it( 'WITHOUT --no-save the default still persists (saved:true, dryRun not set)', async () => {
        const cwd = await freshCwd()
        const grading = gradingWithStubbedPretest( { ok: true } )
        FlowMcpCli.__testInjectGrading( { grading } )

        const { result } = await FlowMcpCli.gradingDeterministic( {
            cwd, target: 'demoapi/demoapi', gradingDataDir: '.flowmcp/grading',
            withKeys: false, only: null, json: true
        } )

        expect( result.saved ).toBe( true )
        // The flag actually reached DataPretest.run as the single switch dryRun.
        expect( grading.__stub.lastCall.dryRun ).toBe( false )
    } )
} )


describe( 'grading non-deterministic --emit-prompts --no-save — byte-identical island', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'emits NO prompts.json/state.json yet returns the Task-ID + area-set', async () => {
        const cwd = await freshCwd()
        const grading = gradingWithStubbedPretest( { ok: true } )
        FlowMcpCli.__testInjectGrading( { grading } )

        const islandRoot = join( cwd, '.flowmcp', 'grading' )
        const before = await snapshotTree( { root: islandRoot } )

        const { result } = await FlowMcpCli.gradingRun( {
            cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', phase: null,
            emitPrompts: true, consumeScores: null, onConflict: null, dryRun: true, json: false
        } )

        const after = await snapshotTree( { root: islandRoot } )
        expect( after ).toEqual( before )

        expect( result.status ).toBe( true )
        expect( result.stage ).toBe( 1 )
        expect( result.saved ).toBe( false )
        expect( result.promptsPath ).toBeNull()
        expect( result.statePath ).toBeNull()
        expect( typeof result.taskId ).toBe( 'string' )
        expect( Array.isArray( result.emittedAreaSet ) ).toBe( true )

        const provDir = join( islandRoot, 'providers', 'demoapi' )
        expect( existsSync( join( provDir, 'prompts.json' ) ) ).toBe( false )
        expect( existsSync( join( provDir, 'state.json' ) ) ).toBe( false )

        // The dryRun switch reached DataPretest.run.
        expect( grading.__stub.lastCall.dryRun ).toBe( true )
    } )
} )


describe( 'grading non-deterministic --consume-scores --no-save — byte-identical island', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'writes NO index.json/grade.json/state.json; island untouched; saved:false', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        // Build a real island first (default emit writes prompts.json + state.json).
        await FlowMcpCli.gradingRun( {
            cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', phase: null,
            emitPrompts: true, consumeScores: null, onConflict: null, json: false
        } )

        const scoresPath = join( cwd, 'scores.json' )
        await writeFile( scoresPath, JSON.stringify( { scoringProtocol: 'v1', scores: [ { dimension: 'whenToUse', score: 4.0 } ] } ), 'utf-8' )

        const islandRoot = join( cwd, '.flowmcp', 'grading' )
        const before = await snapshotTree( { root: islandRoot } )

        const { result } = await FlowMcpCli.gradingRun( {
            cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', phase: null,
            emitPrompts: false, consumeScores: scoresPath, onConflict: null, dryRun: true, json: false
        } )

        const after = await snapshotTree( { root: islandRoot } )
        // Island byte-identical: no index.json/grade.json written, state.json untouched.
        expect( after ).toEqual( before )

        expect( result.status ).toBe( true )
        expect( result.stage ).toBe( 3 )
        expect( result.saved ).toBe( false )
        // NO SILENT DEFAULT: rollup is honestly marked, never a guessed grade.
        expect( result.rollupStatus ).toBe( 'not-saved' )
        expect( result.rollupGrade ).toBeNull()
        expect( result.indexPath ).toBeNull()
        expect( result.proofPath ).toBeNull()
        expect( result.scoreCount ).toBe( 1 )

        // grade.json is NEVER written by the dry consume (the Provider-Proof writer
        // is skipped). index.json + state.json pre-exist from the prior real emit;
        // the byte-identity check above already proves the dry consume left them
        // untouched (no rebuild, no finalize).
        const provDir = join( islandRoot, 'providers', 'demoapi' )
        expect( existsSync( join( provDir, 'grade.json' ) ) ).toBe( false )

        // The state.json baton still reads 'prompts-emitted' (the dry consume did NOT
        // finalize it to 'graded' — proof the Stage-3 state write was skipped).
        const state = JSON.parse( await readFile( join( provDir, 'state.json' ), 'utf-8' ) )
        expect( state.status ).toBe( 'prompts-emitted' )
    } )
} )


describe( 'PRD-012 orthogonality — --on-conflict is a write-policy, not a write-toggle', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( '--on-conflict still behaves as the write-policy WITHOUT --no-save (abort on existing handoff)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        // First real emit writes prompts.json.
        await FlowMcpCli.gradingRun( {
            cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', phase: null,
            emitPrompts: true, consumeScores: null, onConflict: null, json: false
        } )

        // Second emit with --on-conflict abort: the policy fires (NO-OVERWRITE),
        // proving --on-conflict governs HOW a real write resolves a collision.
        const { result } = await FlowMcpCli.gradingRun( {
            cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', phase: null,
            emitPrompts: true, consumeScores: null, onConflict: 'abort', json: false
        } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'NO-OVERWRITE conflict' )
    } )

    it( '--no-save WITH --on-conflict abort does NOT error — the conflict gate is never consulted (no write)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest( { ok: true } ) } )

        // First real emit writes prompts.json (the file --on-conflict would collide with).
        await FlowMcpCli.gradingRun( {
            cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', phase: null,
            emitPrompts: true, consumeScores: null, onConflict: null, json: false
        } )

        const islandRoot = join( cwd, '.flowmcp', 'grading' )
        const before = await snapshotTree( { root: islandRoot } )

        // Same call, now --no-save + --on-conflict abort. With a real write this
        // would abort; --no-save wins so there is no write, hence no conflict.
        const { result } = await FlowMcpCli.gradingRun( {
            cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi', phase: null,
            emitPrompts: true, consumeScores: null, onConflict: 'abort', dryRun: true, json: false
        } )

        const after = await snapshotTree( { root: islandRoot } )

        expect( result.status ).toBe( true )
        expect( result.saved ).toBe( false )
        expect( result.error ).toBeUndefined()
        // Island byte-identical despite the existing handoff + abort policy.
        expect( after ).toEqual( before )
    } )
} )
