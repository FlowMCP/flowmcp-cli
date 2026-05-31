import { describe, it, expect, afterEach } from '@jest/globals'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const here = dirname( fileURLToPath( import.meta.url ) )
const cliBin = join( here, '..', '..', 'src', 'index.mjs' )


const runCli = ( { args } ) => {
    return new Promise( ( resolve ) => {
        execFile( process.execPath, [ cliBin, ...args ], { 'encoding': 'utf8' }, ( error, stdout, stderr ) => {
            resolve( { stdout, stderr, error } )
        } )
    } )
}


describe( 'grading dispatch — allowlist + dev-prefix-strip', () => {
    it( 'returns an allowlist error when no sub-command is given', async () => {
        const { stdout } = await runCli( { 'args': [ 'grading' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'status' ] ).toBe( false )
        expect( parsed[ 'error' ] ).toBe( 'Missing or unknown grading sub-command.' )
        expect( parsed[ 'fix' ] ).toContain( 'import' )
        expect( parsed[ 'fix' ] ).toContain( 'export' )
        expect( parsed[ 'fix' ] ).toContain( 'run' )
        expect( parsed[ 'fix' ] ).toContain( 'state' )
    } )

    it( 'returns an allowlist error for an unknown sub-command', async () => {
        const { stdout } = await runCli( { 'args': [ 'grading', 'bogus' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'status' ] ).toBe( false )
        expect( parsed[ 'error' ] ).toBe( 'Missing or unknown grading sub-command.' )
    } )

    it( 'reuses the same block via the dev-prefix-strip (flowmcp dev grading)', async () => {
        const { stdout } = await runCli( { 'args': [ 'dev', 'grading' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'status' ] ).toBe( false )
        expect( parsed[ 'error' ] ).toBe( 'Missing or unknown grading sub-command.' )
        expect( parsed[ 'fix' ] ).toContain( 'import' )
    } )

    it( 'does not fall through to the unknown-command fallback for grading', async () => {
        const { stdout } = await runCli( { 'args': [ 'grading' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'error' ] ).not.toContain( 'Unknown command' )
    } )

    it( 'routes a valid sub-command to its method (run)', async () => {
        const { stdout } = await runCli( { 'args': [ 'grading', 'run', 'demo/ns', '--phase', 'P1' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'status' ] ).toBe( false )
        expect( parsed[ 'error' ] ).toContain( 'grading run is not implemented yet' )
    } )
} )


describe( 'grading methods — module injection + argument pass-through', () => {
    afterEach( () => {
        FlowMcpCli.__testInjectGrading( { 'grading': null } )
    } )

    it( 'loads the injected grading module for gradingImport', async () => {
        FlowMcpCli.__testInjectGrading( { 'grading': { 'GradingImport': {} } } )
        const { result } = await FlowMcpCli.gradingImport( { 'cwd': '/tmp', 'path': 'x', 'onConflict': null, 'json': false } )

        expect( result[ 'moduleLoaded' ] ).toBe( true )
        expect( result[ 'status' ] ).toBe( false )
    } )

    it( 'loads the injected grading module for gradingExport', async () => {
        FlowMcpCli.__testInjectGrading( { 'grading': { 'GradingExport': {} } } )
        const { result } = await FlowMcpCli.gradingExport( { 'cwd': '/tmp', 'target': 'ns', 'onConflict': null, 'json': false } )

        expect( result[ 'moduleLoaded' ] ).toBe( true )
    } )

    it( 'loads the injected grading module for gradingRun', async () => {
        FlowMcpCli.__testInjectGrading( { 'grading': { 'gradeSelection': () => {} } } )
        const { result } = await FlowMcpCli.gradingRun( { 'cwd': '/tmp', 'target': 'ns', 'phase': 'P1', 'emitPrompts': false, 'consumeScores': null, 'onConflict': null, 'json': false } )

        expect( result[ 'moduleLoaded' ] ).toBe( true )
    } )

    it( 'loads the injected grading module for gradingState', async () => {
        FlowMcpCli.__testInjectGrading( { 'grading': { 'ModuleApi': {} } } )
        const { result } = await FlowMcpCli.gradingState( { 'cwd': '/tmp', 'target': 'ns', 'json': false } )

        expect( result[ 'moduleLoaded' ] ).toBe( true )
    } )

    it( 'resolves the real flowmcp-grading module via lazy import (no injection)', async () => {
        const { result } = await FlowMcpCli.gradingState( { 'cwd': '/tmp', 'target': 'ns', 'json': false } )

        expect( result[ 'moduleLoaded' ] ).toBe( true )
    } )
} )
