import { describe, it, expect, afterEach, beforeEach } from '@jest/globals'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import * as realGrading from 'flowmcp-grading'
import { seedGradingSchemaFolder } from '../helpers/seed-grading-source.mjs'


const here = dirname( fileURLToPath( import.meta.url ) )
const perfFixture = join( here, '..', 'integration', 'fixtures', 'grading-perfprobe' )


// Memo 119 P1 / PRD-1.1 — Performance guard for the O(N^2) -> O(matched) resolver
// fix (commit 7d6463c, PR #110). `#resolveSchemasForTarget` is expected to COMPILE
// (#loadSchema -> dynamic import) only the file(s) that declare the target
// namespace; all other files are excluded by the cheap regex namespace probe.
//
// #loadSchema is a private static method and cannot be spied directly. Instead the
// fixtures record their own module evaluation (the expensive compile) into a side-
// channel log named by PERF_COMPILE_LOG. The fixture set is 1 target ('perfprobe')
// + 3 decoys (distinct namespaces). Asserting the log contains ONLY the target —
// and at most 2 compiles total — is the faithful perf guarantee: if the regex
// narrowing regressed to compile-everything, the decoys would appear in the log.


function gradingWithStubbedPretest() {
    const stub = {
        run: async ( params ) => ( {
            ok: true,
            passedDownloadable: 2,
            required: 2,
            toolsBelowThreshold: [],
            perTool: {},
            schemaDir: null,
            summaryPath: join( params.gradingDataDir, 'providers', params.namespace, params.toolName, 'summary.json' ),
            results: [
                { 'primitive': 'tool', 'name': 'getThing', 'status': true, 'hasData': true, 'working': true, 'error': null },
                { 'primitive': 'tool', 'name': 'getThing', 'status': true, 'hasData': true, 'working': true, 'error': null }
            ],
            stopReason: null,
            errors: []
        } ),
        getVersion: () => ( { version: 'stub' } )
    }

    return { ...realGrading, DataPretest: stub }
}


async function freshCwd() {
    return mkdtemp( join( tmpdir(), 'grading-perf-cwd-' ) )
}


describe( 'gradingDeterministic — perf guard (compile only the target namespace)', () => {
    let logPath = null

    beforeEach( async () => {
        const dir = await mkdtemp( join( tmpdir(), 'perf-compile-log-' ) )
        logPath = join( dir, 'compiles.log' )
        await writeFile( logPath, '', 'utf-8' )
        process.env.PERF_COMPILE_LOG = logPath
    } )

    afterEach( () => {
        FlowMcpCli.__testInjectGrading( { grading: null } )
        delete process.env.PERF_COMPILE_LOG
    } )

    it( 'compiles only the target file, never the decoys (<=2 compiles, 0 decoys)', async () => {
        await seedGradingSchemaFolder( { providerFixture: perfFixture, namespace: 'perfprobe', sourceName: 'perfprobe-src' } )

        const cwd = await freshCwd()
        FlowMcpCli.__testInjectGrading( { grading: gradingWithStubbedPretest() } )

        const { result } = await FlowMcpCli.gradingDeterministic( { cwd, target: 'perfprobe/target', gradingDataDir: '.flowmcp/grading', withKeys: false, only: null, dryRun: true, json: true } )

        expect( result.validate.status ).toBe( true )

        expect( existsSync( logPath ) ).toBe( true )
        const compiled = ( await readFile( logPath, 'utf-8' ) )
            .split( '\n' )
            .map( ( line ) => line.trim() )
            .filter( ( line ) => line.length > 0 )

        const decoys = compiled
            .filter( ( ns ) => ns !== 'perfprobe' )
        const targetCompiles = compiled
            .filter( ( ns ) => ns === 'perfprobe' )

        // The resolver must NOT compile any decoy file (would prove O(N) regression).
        expect( decoys ).toEqual( [] )
        // The target is compiled once (resolver), at most twice — never O(N).
        expect( targetCompiles.length ).toBeGreaterThanOrEqual( 1 )
        expect( targetCompiles.length ).toBeLessThanOrEqual( 2 )
    } )
} )
