import { describe, it, expect, afterEach, beforeAll } from '@jest/globals'
import { mkdtemp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import * as realGrading from 'flowmcp-grading'
import { seedGradingSchemaFolder } from '../helpers/seed-grading-source.mjs'


const here = dirname( fileURLToPath( import.meta.url ) )
const providerFixture = join( here, '..', 'integration', 'fixtures', 'grading-provider' )


// Memo 102 Phase 2 / PRD-003 (B2): grading deterministic reads the schema LIVE
// from schemaFolders[]. Register the provider fixture so #resolveSchemasForTarget
// finds the `demoapi` namespace.
beforeAll( async () => {
    await seedGradingSchemaFolder( { providerFixture, namespace: 'demoapi' } )
} )


// Wrap the real grading module but stub DataPretest.run so the deterministic
// single-mode never makes a live API call. The schema source comes LIVE from
// schemaFolders[] (PRD-003 B2); RebuildIndex/GradingImport stay real so the
// island OUTPUT store still builds.
function gradingWithStubbedPretest( { ok = true, results = null } = {} ) {
    let lastCall = null
    const defaultResults = ok
        ? [
            { 'primitive': 'tool', 'name': 'getThing', 'status': true, 'hasData': true, 'working': true, 'error': null },
            { 'primitive': 'tool', 'name': 'getThing', 'status': true, 'hasData': true, 'working': true, 'error': null },
            { 'primitive': 'tool', 'name': 'getThing', 'status': true, 'hasData': true, 'working': true, 'error': null }
        ]
        : [
            { 'primitive': 'tool', 'name': 'getThing', 'status': true, 'hasData': false, 'working': false, 'error': null }
        ]
    const stub = {
        run: async ( params ) => {
            lastCall = params
            return {
                ok,
                passedDownloadable: ok ? 3 : 0,
                required: 2,
                toolsBelowThreshold: ok ? [] : [ 'getThing (0/2)' ],
                perTool: {},
                schemaDir: null,
                summaryPath: join( params.gradingDataDir, 'providers', params.namespace, params.toolName, 'summary.json' ),
                results: results === null ? defaultResults : results,
                stopReason: ok ? null : 'tools-below-2-working-downloadable-tests',
                errors: ok ? [] : [ 'DPT-004: Test failed (not counted as a working download): getThing: empty data' ]
            }
        },
        getVersion: () => ( { version: 'stub' } ),
        get lastCall() { return lastCall }
    }

    return { ...realGrading, DataPretest: stub, __stub: stub }
}


async function freshCwd() {
    return mkdtemp( join( tmpdir(), 'grading-det-cwd-' ) )
}


// Memo 102 Phase 2 / PRD-006: the `grading import` step is gone. The schema is
// read live from schemaFolders[] (seeded in beforeAll); this helper now only
// injects the stubbed grading module. The island is built on first run.
async function importFixture( { cwd, grading } ) {
    FlowMcpCli.__testInjectGrading( { grading } )

    return { status: true }
}


describe( 'gradingDeterministic — module + input guards', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'aborts when the grading module is unavailable', async () => {
        FlowMcpCli.__testInjectGrading( { grading: {} } )
        const { result } = await FlowMcpCli.gradingDeterministic( { cwd: '/tmp', target: 'demoapi/demoapi', gradingDataDir: '.flowmcp/grading', withKeys: false, only: null, json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toBe( 'grading module unavailable' )
    } )

    it( 'reports a missing target', async () => {
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest() } )
        const { result } = await FlowMcpCli.gradingDeterministic( { cwd: '/tmp', target: '', gradingDataDir: '.flowmcp/grading', withKeys: false, only: null, json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Missing grading target' )
    } )

    it( 'rejects an unsupported Spec-ID type (e.g. resource-ID)', async () => {
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest() } )
        const { result } = await FlowMcpCli.gradingDeterministic( { cwd: '/tmp', target: 'demoapi/resource/foo', gradingDataDir: '.flowmcp/grading', withKeys: false, only: null, json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'not supported' )
    } )

    it( 'reports a namespace that is not in any schemaFolders[] source (SRC-001)', async () => {
        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest() } )
        const { result } = await FlowMcpCli.gradingDeterministic( { cwd, target: 'ghost/ghost', gradingDataDir: '.flowmcp/grading', withKeys: false, only: null, json: false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'SRC-001' )
        expect( result.error ).toContain( 'not found in any schemaFolders[]' )
        expect( result.fix ).toContain( 'schemaFolders[]' )
    } )
} )


describe( 'gradingDeterministic — schema-ID flow (validate + pretest, no emit)', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( '(a) runs structural validate + DataPretest and writes NO prompts.json/state.json', async () => {
        const cwd = await freshCwd()
        const grading = gradingWithStubbedPretest( { ok: true } )
        const imp = await importFixture( { cwd, grading } )
        expect( imp.status ).toBe( true )

        const { result } = await FlowMcpCli.gradingDeterministic( { cwd, target: 'demoapi/demoapi', gradingDataDir: '.flowmcp/grading', withKeys: false, only: null, json: true } )

        expect( result.mode ).toBe( 'deterministic' )
        expect( result.target ).toBe( 'demoapi/demoapi' )
        expect( result.validate ).toBeDefined()
        expect( result.validate.status ).toBe( true )
        expect( result.pretest ).toBeDefined()
        expect( result.pretest.ok ).toBe( true )
        expect( result.status ).toBe( true )

        // The deterministic single-mode emits NOTHING (no /goal handoff).
        const provDir = join( cwd, '.flowmcp', 'grading', 'providers', 'demoapi' )
        expect( existsSync( join( provDir, 'prompts.json' ) ) ).toBe( false )
        expect( existsSync( join( provDir, 'state.json' ) ) ).toBe( false )
    } )

    it( 'reports a schema folder that does not exist', async () => {
        const cwd = await freshCwd()
        const grading = gradingWithStubbedPretest( { ok: true } )
        await importFixture( { cwd, grading } )

        const { result } = await FlowMcpCli.gradingDeterministic( { cwd, target: 'demoapi/does-not-exist', gradingDataDir: '.flowmcp/grading', withKeys: false, only: null, json: true } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'not found in schemaFolders[]' )
    } )
} )


describe( 'gradingDeterministic — tool-ID flow (restricted to one tool)', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( '(b) restricts the pretest results to the addressed tool', async () => {
        const cwd = await freshCwd()
        const grading = gradingWithStubbedPretest( {
            ok: true,
            results: [
                { 'primitive': 'tool', 'name': 'getThing', 'status': true, 'hasData': true, 'working': true, 'error': null },
                { 'primitive': 'tool', 'name': 'getThing', 'status': true, 'hasData': true, 'working': true, 'error': null },
                { 'primitive': 'tool', 'name': 'other', 'status': true, 'hasData': true, 'working': true, 'error': null }
            ]
        } )
        await importFixture( { cwd, grading } )

        const { result } = await FlowMcpCli.gradingDeterministic( { cwd, target: 'demoapi/tool/getThing', gradingDataDir: '.flowmcp/grading', withKeys: false, only: null, json: true } )

        expect( result.status ).toBe( true )
        expect( result.pretest.results.length ).toBe( 2 )
        expect( result.pretest.results.every( ( r ) => r.name === 'getThing' ) ).toBe( true )
        expect( result.pretest.passedDownloadable ).toBe( 2 )
    } )

    it( 'reports a tool-ID that no schema declares', async () => {
        const cwd = await freshCwd()
        const grading = gradingWithStubbedPretest( { ok: true } )
        await importFixture( { cwd, grading } )

        const { result } = await FlowMcpCli.gradingDeterministic( { cwd, target: 'demoapi/tool/ghostTool', gradingDataDir: '.flowmcp/grading', withKeys: false, only: null, json: true } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'not found in any schema' )
    } )
} )


describe( 'gradingDeterministic — red pretest yields hints', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( '(c) FAIL on HTTP-200-but-empty-data carries DPT errors as hints', async () => {
        const cwd = await freshCwd()
        const grading = gradingWithStubbedPretest( { ok: false } )
        await importFixture( { cwd, grading } )

        const { result } = await FlowMcpCli.gradingDeterministic( { cwd, target: 'demoapi/demoapi', gradingDataDir: '.flowmcp/grading', withKeys: false, only: null, json: true } )

        expect( result.status ).toBe( false )
        expect( result.pretest.ok ).toBe( false )
        expect( result.hints.length ).toBeGreaterThan( 0 )
        expect( result.hints.some( ( h ) => h.includes( 'DPT-004' ) ) ).toBe( true )
        // Proof this is NOT the dev-test subset: status===true alone is not enough,
        // the empty-data check (#hasData) drove the FAIL.
        expect( result.pretest.results.some( ( r ) => r.status === true && r.working === false ) ).toBe( true )
    } )
} )


// Memo 102 Phase 5 — the deterministic output must SURFACE the new classes:
// key-gated (PRD-014, not a FAIL), parameterless Bar=1 + needs-tests (PRD-013),
// and broken tests with their real HTTP status (PRD-015). The CLI is the surfacing
// layer: it carries keyGated / perTool / toolsBelowThreshold through result.pretest.
function gradingWithRawPretest( { raw } ) {
    const stub = {
        run: async ( params ) => ( { ...raw, summaryPath: join( params.gradingDataDir, 'providers', params.namespace, params.toolName, 'summary.json' ), schemaDir: null } ),
        getVersion: () => ( { version: 'stub' } )
    }
    return { ...realGrading, DataPretest: stub }
}


describe( 'gradingDeterministic — Phase 5 surfacing (key-gated / parameterless / broken)', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'PRD-014: a key-gated schema surfaces its own class (keyGated) — NOT a generic FAIL', async () => {
        const cwd = await freshCwd()
        const raw = {
            ok: false,
            keyGated: true,
            passedDownloadable: 0,
            required: 2,
            toolsBelowThreshold: [],
            perTool: { getThing: { working: 0, total: 3, bar: 2, parameterless: false, class: 'key-gated', level: 'unavailable' } },
            results: [],
            stopReason: 'key-gated-not-evaluable-without-key',
            errors: [ 'DPT-007: Key-gated — not evaluable without key (missing requiredServerParam): DEMO_API_KEY' ]
        }
        await importFixture( { cwd, grading: gradingWithRawPretest( { raw } ) } )

        const { result } = await FlowMcpCli.gradingDeterministic( { cwd, target: 'demoapi/demoapi', gradingDataDir: '.flowmcp/grading', withKeys: false, only: null, json: true } )

        expect( result.pretest.keyGated ).toBe( true )
        expect( result.pretest.stopReason ).toBe( 'key-gated-not-evaluable-without-key' )
        expect( result.pretest.perTool.getThing.class ).toBe( 'key-gated' )
        // The diagnostic key name is visible in hints; no DPT-003/DPT-004 from key-gating.
        expect( result.hints.some( ( h ) => h.includes( 'DPT-007' ) && h.includes( 'DEMO_API_KEY' ) ) ).toBe( true )
        expect( result.hints.some( ( h ) => h.includes( 'DPT-003' ) || h.includes( 'DPT-004' ) ) ).toBe( false )
    } )

    it( 'PRD-013: a parameterless tool (Bar=1) and a 0-test tool (needs-tests) are both visible in perTool', async () => {
        const cwd = await freshCwd()
        const raw = {
            ok: true,
            keyGated: false,
            passedDownloadable: 1,
            required: 2,
            toolsBelowThreshold: [],
            perTool: {
                getStations: { working: 1, total: 1, bar: 1, parameterless: true, class: 'parameterless', level: 'reachable' },
                noTests: { working: 0, total: 0, bar: 2, parameterless: false, class: 'needs-tests', level: 'unavailable' }
            },
            results: [ { primitive: 'tool', name: 'getStations', status: true, hasData: true, working: true, error: null } ],
            stopReason: null,
            errors: [ 'DPT-006: Parameterless tool (no user-input vector) — own class, Bar=1: getStations (1/1)' ]
        }
        await importFixture( { cwd, grading: gradingWithRawPretest( { raw } ) } )

        const { result } = await FlowMcpCli.gradingDeterministic( { cwd, target: 'demoapi/demoapi', gradingDataDir: '.flowmcp/grading', withKeys: false, only: null, json: true } )

        // The parameterless tool is its own Bar=1 class.
        expect( result.pretest.perTool.getStations ).toMatchObject( { class: 'parameterless', bar: 1, parameterless: true } )
        // The 0-test tool is VISIBLE (not invisible) as needs-tests.
        expect( result.pretest.perTool.noTests ).toMatchObject( { class: 'needs-tests', total: 0 } )
    } )

    it( 'PRD-015: a broken test surfaces DPT-004 carrying the real HTTP status', async () => {
        const cwd = await freshCwd()
        const raw = {
            ok: false,
            keyGated: false,
            passedDownloadable: 0,
            required: 2,
            toolsBelowThreshold: [ 'getThing (0/2)' ],
            perTool: { getThing: { working: 0, total: 2, bar: 2, parameterless: false, class: 'normal', level: 'unavailable' } },
            results: [ { primitive: 'tool', name: 'getThing', status: false, hasData: false, working: false, httpStatus: 400, error: 'HTTP 400: Bad Request' } ],
            stopReason: 'tools-below-2-working-downloadable-tests',
            errors: [ 'DPT-004: Test failed (not counted as a working download): getThing: HTTP 400: Bad Request (HTTP 400)' ]
        }
        await importFixture( { cwd, grading: gradingWithRawPretest( { raw } ) } )

        const { result } = await FlowMcpCli.gradingDeterministic( { cwd, target: 'demoapi/demoapi', gradingDataDir: '.flowmcp/grading', withKeys: false, only: null, json: true } )

        expect( result.pretest.ok ).toBe( false )
        expect( result.hints.some( ( h ) => h.includes( 'DPT-004' ) && h.includes( 'HTTP 400' ) ) ).toBe( true )
        expect( result.pretest.results.some( ( r ) => r.httpStatus === 400 ) ).toBe( true )
    } )
} )


describe( 'gradingDeterministic — det alias parity (dispatch level)', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( '(d) the "det" alias resolves to the same method via dispatch', async () => {
        const { execFile } = await import( 'node:child_process' )
        const cliBin = join( here, '..', '..', 'src', 'index.mjs' )

        const runCli = ( { args } ) => new Promise( ( res ) => {
            execFile( process.execPath, [ cliBin, ...args ], { 'encoding': 'utf8' }, ( error, stdout ) => {
                res( { stdout } )
            } )
        } )

        const full = await runCli( { args: [ 'grading', 'deterministic' ] } )
        const alias = await runCli( { args: [ 'grading', 'det' ] } )
        const parsedFull = JSON.parse( full.stdout )
        const parsedAlias = JSON.parse( alias.stdout )

        // Both reach the METHOD (missing-target), not the unknown-sub-command error.
        expect( parsedFull.error ).toContain( 'Missing grading target' )
        expect( parsedAlias.error ).toContain( 'Missing grading target' )
        expect( parsedAlias.error ).toBe( parsedFull.error )
    } )
} )


describe( 'gradingDeterministic — force / read-cache surfacing (Memo 110 P2)', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'threads --force into DataPretest.run (cache bypass)', async () => {
        const cwd = await freshCwd()
        const grading = gradingWithStubbedPretest( { ok: true } )
        await importFixture( { cwd, grading } )

        await FlowMcpCli.gradingDeterministic( { cwd, target: 'demoapi/demoapi', gradingDataDir: '.flowmcp/grading', withKeys: false, only: null, force: true, json: true } )
        expect( grading.__stub.lastCall.force ).toBe( true )
    } )

    it( 'defaults force to false (read-cache reuse is the default)', async () => {
        const cwd = await freshCwd()
        const grading = gradingWithStubbedPretest( { ok: true } )
        await importFixture( { cwd, grading } )

        await FlowMcpCli.gradingDeterministic( { cwd, target: 'demoapi/demoapi', gradingDataDir: '.flowmcp/grading', withKeys: false, only: null, json: true } )
        expect( grading.__stub.lastCall.force ).toBe( false )
    } )

    it( 'surfaces the data stamp (fromCache + dataAt) from the pretest', async () => {
        const cwd = await freshCwd()
        const grading = { ...realGrading, DataPretest: {
            getVersion: () => ( { version: 'stub' } ),
            run: async ( params ) => ( {
                ok: true,
                passedDownloadable: 3,
                required: 2,
                toolsBelowThreshold: [],
                perTool: {},
                fromCache: true,
                dataAt: '2026-06-05T10:00:00.000Z',
                schemaDir: null,
                summaryPath: join( params.gradingDataDir, 'providers', params.namespace, params.toolName, 'summary.json' ),
                results: [
                    { primitive: 'tool', name: 'getThing', status: true, hasData: true, working: true, error: null },
                    { primitive: 'tool', name: 'getThing', status: true, hasData: true, working: true, error: null }
                ],
                stopReason: null,
                errors: []
            } )
        } }
        await importFixture( { cwd, grading } )

        const { result } = await FlowMcpCli.gradingDeterministic( { cwd, target: 'demoapi/demoapi', gradingDataDir: '.flowmcp/grading', withKeys: false, only: null, json: true } )
        expect( result.pretest.fromCache ).toBe( true )
        expect( result.pretest.dataAt ).toBe( '2026-06-05T10:00:00.000Z' )
    } )
} )


describe( 'gradingReload — data reload only (Memo 110 PRD-2.3)', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'reloads a schema with force:true and writes no grade.json', async () => {
        const cwd = await freshCwd()
        const grading = gradingWithStubbedPretest( { ok: true } )
        await importFixture( { cwd, grading } )

        const { result } = await FlowMcpCli.gradingReload( { cwd, target: 'demoapi/demoapi', gradingDataDir: '.flowmcp/grading', withKeys: false, json: true } )
        expect( result.status ).toBe( true )
        expect( result.mode ).toBe( 'reload' )
        expect( result.schemaCount ).toBeGreaterThanOrEqual( 1 )
        expect( grading.__stub.lastCall.force ).toBe( true )
        // reload never writes grade.json / index.json (no rollup fields)
        expect( result.indexPath ).toBeUndefined()
        expect( result.proofPath ).toBeUndefined()
    } )

    it( 'rejects a tool-ID target (namespace or schema only)', async () => {
        const cwd = await freshCwd()
        const grading = gradingWithStubbedPretest( { ok: true } )
        await importFixture( { cwd, grading } )

        const { result } = await FlowMcpCli.gradingReload( { cwd, target: 'demoapi/tool/getThing', gradingDataDir: '.flowmcp/grading', withKeys: false, json: true } )
        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'namespace or a schema-ID' )
    } )
} )


describe( 'gradingDeterministic — progress + summary (Memo 110 P4)', () => {
    afterEach( () => { FlowMcpCli.__testInjectGrading( { grading: null } ) } )

    it( 'ticks progress to STDERR by default, suppressed by --quiet', async () => {
        const cwd = await freshCwd()
        const grading = gradingWithStubbedPretest( { ok: true } )
        await importFixture( { cwd, grading } )

        const writes = []
        const spy = ( chunk ) => { writes.push( String( chunk ) ); return true }
        const original = process.stderr.write
        process.stderr.write = spy
        try {
            await FlowMcpCli.gradingDeterministic( { cwd, target: 'demoapi/demoapi', gradingDataDir: '.flowmcp/grading', withKeys: false, only: null, json: true } )
            const loud = writes.join( '' )
            writes.length = 0
            await FlowMcpCli.gradingDeterministic( { cwd, target: 'demoapi/demoapi', gradingDataDir: '.flowmcp/grading', withKeys: false, only: null, quiet: true, json: true } )
            const quiet = writes.join( '' )

            expect( loud ).toContain( '[grading]' )
            expect( loud ).toContain( 'demoapi/demoapi' )
            expect( quiet ).toBe( '' )
        } finally {
            process.stderr.write = original
        }
    } )

    it( 'printDeterministicSummary writes to stderr only when not quiet/json', () => {
        const result = { status: true, mode: 'deterministic', target: 'demoapi/demoapi', validate: { status: true }, pretest: { ok: true, fromCache: true, dataAt: '2026-06-05T10:00:00.000Z', toolsBelowThreshold: [] } }
        const writes = []
        const original = process.stderr.write
        process.stderr.write = ( chunk ) => { writes.push( String( chunk ) ); return true }
        try {
            FlowMcpCli.printDeterministicSummary( { result, quiet: false, json: false } )
            FlowMcpCli.printDeterministicSummary( { result, quiet: true, json: false } )
            FlowMcpCli.printDeterministicSummary( { result, quiet: false, json: true } )
        } finally {
            process.stderr.write = original
        }
        const out = writes.join( '' )
        expect( out ).toContain( 'demoapi/demoapi — PASS' )
        expect( out ).toContain( 'cached' )
        // only the first call (not quiet, not json) emitted -> exactly one summary block
        expect( out.match( /— PASS/g ).length ).toBe( 1 )
    } )
} )
