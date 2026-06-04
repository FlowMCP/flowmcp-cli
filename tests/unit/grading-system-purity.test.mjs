/**
 * grading-system-purity.test.mjs — PRD-014 System-Reinheit (Purity) Gate, CLI side.
 *
 * One consolidated, auditable purity suite. Each describe block maps to one row of
 * the grading-handover guarantee table (G2..G4, plus G6b). Every guarantee has at
 * least one PASS-case and one REJECT-case, so the table is provable from the tests.
 *
 * Guarantee -> code anchor (re-located by symbol, not by line number):
 *   G2  Task-ID known (consume rejects an unknown taskId before rebuild/grade)
 *       -> FlowMcpCli.#verifyConsumePayload (src/task/FlowMcpCli.mjs), driven via
 *          FlowMcpCli.gradingRun consume-scores.
 *   G3  Area-Set complete / partial (full set -> taskComplete; subset -> per-area
 *       accept + pending + NOT complete)
 *       -> #verifyConsumePayload acceptedAreas / missingAreas / complete.
 *   G4  Per-area question-count (answered == asked; a mismatch rejects)
 *       -> #verifyConsumePayload per-area count check (#askedCountByArea).
 *   G6b kanban-readonly read-only invariant (the skill body contains NO write verb)
 *       -> .claude/skills/kanban-readonly/SKILL.md audit greps (workbench skill,
 *          reachable from the cli repo tree at ../../.claude/skills/...).
 *
 * G1/G5/G6a are pinned in the flowmcp-grading repo's system-purity suite
 * (AreaScorer.validateAnswers / SingleSchema HTTP-200 / ProviderProof single writer).
 *
 * NO SILENT DEFAULTS. All filesystem writes go into an OS temp dir, never a home
 * folder; the cli path-guard hard-blocks the real ~/.flowmcp.
 */

import { describe, it, expect, afterEach, beforeAll } from '@jest/globals'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import * as realGrading from 'flowmcp-grading'
import { seedGradingSchemaFolder } from '../helpers/seed-grading-source.mjs'


const here = dirname( fileURLToPath( import.meta.url ) )
const providerFixture = join( here, '..', 'integration', 'fixtures', 'grading-provider' )
const kanbanSkillPath = join( here, '..', '..', '..', '..', '.claude', 'skills', 'kanban-readonly', 'SKILL.md' )


// Memo 102 Phase 2 / PRD-003 (B2): emit-prompts reads the schema LIVE from
// schemaFolders[]. Register the provider fixture so #resolveSchemasForTarget
// finds the `demoapi` namespace.
beforeAll( async () => {
    await seedGradingSchemaFolder( { providerFixture, namespace: 'demoapi' } )
} )


// Wrap the real grading module but stub DataPretest.run so emit-prompts never
// makes a live API call (mirrors the PRD-007/008 suite).
function gradingWithStubbedPretest() {
    const stub = {
        run: async ( params ) => ( {
            ok: true,
            passedDownloadable: 3,
            required: 3,
            toolsBelowThreshold: [],
            perTool: {},
            schemaDir: null,
            summaryPath: join( params.gradingDataDir, 'providers', params.namespace, params.toolName, 'summary.json' ),
            results: [],
            stopReason: null,
            errors: []
        } ),
        getVersion: () => ( { version: 'stub' } )
    }
    return { ...realGrading, DataPretest: stub }
}


async function freshCwd() {
    return mkdtemp( join( tmpdir(), 'grading-purity-' ) )
}


// Memo 102 Phase 2 / PRD-006: the `grading import` step is gone. The schema is
// read live from schemaFolders[] (seeded in beforeAll) and the island is built on
// first run, so this seed is a no-op kept only for call-site readability.
async function importFixture( { cwd } ) {
    return { status: true }
}


async function emit( { cwd, phase } ) {
    return FlowMcpCli.gradingRun( {
        cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi',
        phase, emitPrompts: true, consumeScores: null, onConflict: null, maxIterations: null, json: false
    } )
}


async function consume( { cwd, scoresPath } ) {
    return FlowMcpCli.gradingRun( {
        cwd, gradingDataDir: '.flowmcp/grading', target: 'demoapi',
        phase: null, emitPrompts: false, consumeScores: scoresPath, onConflict: null, json: false
    } )
}


// ---- G2: Task-ID known (unknown taskId rejected before rebuild/grade) -----------
describe( 'G2 — Task-ID known (consume rejects an unknown taskId)', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'PASS — the exact emitted Task-ID is accepted', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest() } )
        await importFixture( { cwd } )
        const e = await emit( { cwd, phase: 'single-test' } )

        const scoresPath = join( cwd, 'scores.json' )
        await writeFile( scoresPath, JSON.stringify( {
            scoringProtocol: 'v1', taskId: e.result.taskId,
            areas: [ { area: 'single-test', results: [] } ],
            scores: [ { dimension: 'whenToUse', score: 4.0 } ]
        } ), 'utf-8' )

        const { result } = await consume( { cwd, scoresPath } )
        expect( result.status ).toBe( true )
        expect( result.acceptedAreas ).toContain( 'single-test' )
    } )

    it( 'REJECT — an unknown taskId is refused and never reaches rebuild (no proof written)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest() } )
        await importFixture( { cwd } )
        await emit( { cwd, phase: 'single-test' } )

        const scoresPath = join( cwd, 'scores.json' )
        await writeFile( scoresPath, JSON.stringify( {
            scoringProtocol: 'v1', taskId: 'demoapi--deadbeef',
            areas: [ { area: 'single-test', results: [] } ], scores: []
        } ), 'utf-8' )

        const { result } = await consume( { cwd, scoresPath } )
        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Unknown taskId' )
        // The reject happens before rebuild/proof — no grade.json is produced.
        expect( existsSync( join( cwd, '.flowmcp', 'grading', 'providers', 'demoapi', 'grade.json' ) ) ).toBe( false )
    } )

    it( 'REJECT — a taskId without an open emit is refused', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest() } )
        await importFixture( { cwd } )
        // Note: no emit -> no open emit/state taskId.

        const scoresPath = join( cwd, 'scores.json' )
        await writeFile( scoresPath, JSON.stringify( {
            scoringProtocol: 'v1', taskId: 'demoapi--cafef00d',
            areas: [ { area: 'single-test', results: [] } ], scores: []
        } ), 'utf-8' )

        const { result } = await consume( { cwd, scoresPath } )
        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Consume rejected' )
    } )
} )


// ---- G3: Area-Set complete / partial --------------------------------------------
describe( 'G3 — Area-Set complete / partial (full -> complete; subset -> pending)', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'PASS — the full emitted set marks taskComplete with no missing areas', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest() } )
        await importFixture( { cwd } )
        const e = await emit( { cwd, phase: 'single-test' } )

        const scoresPath = join( cwd, 'scores.json' )
        await writeFile( scoresPath, JSON.stringify( {
            scoringProtocol: 'v1', taskId: e.result.taskId,
            areas: [ { area: 'single-test', results: [] } ],
            scores: [ { dimension: 'whenToUse', score: 4.0 } ]
        } ), 'utf-8' )

        const { result } = await consume( { cwd, scoresPath } )
        expect( result.status ).toBe( true )
        expect( result.taskComplete ).toBe( true )
        expect( result.missingAreas ).toEqual( [] )
    } )

    it( 'REJECT (not complete) — a subset accepts per-area, leaves the rest pending, taskComplete false', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest() } )
        await importFixture( { cwd } )
        const e = await emit( { cwd, phase: 'single-test,tools-aggregate-schema' } )

        const scoresPath = join( cwd, 'scores.json' )
        await writeFile( scoresPath, JSON.stringify( {
            scoringProtocol: 'v1', taskId: e.result.taskId,
            areas: [ { area: 'single-test', results: [] } ],
            scores: [ { dimension: 'whenToUse', score: 4.0 } ]
        } ), 'utf-8' )

        const { result } = await consume( { cwd, scoresPath } )
        expect( result.status ).toBe( true )
        expect( result.taskComplete ).toBe( false )
        expect( result.acceptedAreas ).toEqual( [ 'single-test' ] )
        expect( result.missingAreas ).toContain( 'tools-aggregate-schema' )
    } )

    it( 'REJECT — an area outside the emitted set is refused', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest() } )
        await importFixture( { cwd } )
        const e = await emit( { cwd, phase: 'single-test' } )

        const scoresPath = join( cwd, 'scores.json' )
        await writeFile( scoresPath, JSON.stringify( {
            scoringProtocol: 'v1', taskId: e.result.taskId,
            areas: [ { area: 'tools-aggregate-schema', results: [] } ], scores: []
        } ), 'utf-8' )

        const { result } = await consume( { cwd, scoresPath } )
        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'not in the emitted set' )
    } )
} )


// ---- G4: Per-area question-count (answered == asked) ----------------------------
describe( 'G4 — Per-area question-count (answered == asked, else reject)', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'PASS — an answered area matching the asked count is accepted', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest() } )
        await importFixture( { cwd } )
        const e = await emit( { cwd, phase: 'single-test' } )

        const state = JSON.parse( await readFile( e.result.statePath, 'utf-8' ) )
        const asked = state.askedByArea[ 'single-test' ]
        expect( typeof asked ).toBe( 'number' )

        const matchingResults = Array.from( { length: asked }, ( _, i ) => ( { id: `q${i}` } ) )
        const scoresPath = join( cwd, 'scores.json' )
        await writeFile( scoresPath, JSON.stringify( {
            scoringProtocol: 'v1', taskId: e.result.taskId,
            areas: [ { area: 'single-test', results: matchingResults } ],
            scores: [ { dimension: 'whenToUse', score: 4.0 } ]
        } ), 'utf-8' )

        const { result } = await consume( { cwd, scoresPath } )
        expect( result.status ).toBe( true )
        expect( result.acceptedAreas ).toContain( 'single-test' )
    } )

    it( 'REJECT — an answered count that differs from the asked count is refused', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest() } )
        await importFixture( { cwd } )
        const e = await emit( { cwd, phase: 'single-test' } )

        const state = JSON.parse( await readFile( e.result.statePath, 'utf-8' ) )
        const asked = state.askedByArea[ 'single-test' ]
        expect( typeof asked ).toBe( 'number' )

        const wrongResults = Array.from( { length: asked + 1 }, ( _, i ) => ( { id: `q${i}` } ) )
        const scoresPath = join( cwd, 'scores.json' )
        await writeFile( scoresPath, JSON.stringify( {
            scoringProtocol: 'v1', taskId: e.result.taskId,
            areas: [ { area: 'single-test', results: wrongResults } ], scores: []
        } ), 'utf-8' )

        const { result } = await consume( { cwd, scoresPath } )
        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'question-count mismatch' )
    } )
} )


// ---- G6b: kanban-readonly read-only invariant (structural, by grep) -------------
describe( 'G6b — kanban-readonly contains NO write verb (read-only invariant)', () => {
    const writeVerbPatterns = [
        /gh (issue|label) (create|edit|close|delete|comment|reopen|transfer)/i,
        /gh project item-(add|edit|delete)/i,
        /git (commit|push)/i,
        /gh pr (create|merge)/i
    ]

    // kanban-readonly is a WORKBENCH skill ( .claude/skills/ ), not a flowmcp-cli
    // repo artifact. It is reachable in the local workbench checkout but NOT when
    // this repo is checked out standalone in CI. The read-only / Board #2 invariant
    // is therefore enforced here only when the skill file is present; in a
    // standalone CI checkout these cases are explicitly skipped — visible in the
    // test output, never a silent pass.
    const kanbanAvailable = existsSync( kanbanSkillPath )
    const itIfKanban = kanbanAvailable ? it : it.skip

    itIfKanban( 'REJECT-case proven negative — every write-verb audit grep returns empty', async () => {
        const body = await readFile( kanbanSkillPath, 'utf-8' )
        const lines = body.split( '\n' )
        const hits = writeVerbPatterns
            .flatMap( ( pattern ) => {
                return lines
                    .map( ( line, idx ) => ( { lineNo: idx + 1, line } ) )
                    .filter( ( entry ) => pattern.test( entry.line ) )
                    .map( ( entry ) => `${entry.lineNo}: ${entry.line.trim()}` )
            } )
        expect( hits ).toEqual( [] )
    } )

    itIfKanban( 'the skill points at Board #2 (Grading), not Board #1', async () => {
        const body = await readFile( kanbanSkillPath, 'utf-8' )
        // The GraphQL node id used for the board query must be Board #2.
        expect( body ).toContain( 'node(id: "PVT_kwDODLB50c4BZc6F")' )
    } )
} )
