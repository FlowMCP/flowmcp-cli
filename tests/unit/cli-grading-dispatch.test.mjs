import { describe, it, expect, afterEach } from '@jest/globals'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import { ModuleRegistry } from '../../src/lib/ModuleRegistry.mjs'


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
        // PRD-006: `import` is no longer a grading sub-command.
        expect( parsed[ 'fix' ] ).not.toContain( 'import' )
        expect( parsed[ 'fix' ] ).toContain( 'deterministic' )
        expect( parsed[ 'fix' ] ).toContain( 'export' )
        // PRD-010: the user-facing non-deterministic command replaces `run`.
        expect( parsed[ 'fix' ] ).toContain( 'non-deterministic' )
        expect( parsed[ 'fix' ] ).toContain( 'state' )
    } )

    it( 'returns an allowlist error for an unknown sub-command', async () => {
        const { stdout } = await runCli( { 'args': [ 'grading', 'bogus' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'status' ] ).toBe( false )
        expect( parsed[ 'error' ] ).toBe( 'Missing or unknown grading sub-command.' )
    } )

    it( 'PRD-006: `grading import` is now an unknown sub-command (removed)', async () => {
        const { stdout } = await runCli( { 'args': [ 'grading', 'import', 'some/path' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'status' ] ).toBe( false )
        expect( parsed[ 'error' ] ).toBe( 'Missing or unknown grading sub-command.' )
        expect( parsed[ 'fix' ] ).not.toContain( 'import' )
    } )

    it( 'reuses the same block via the dev-prefix-strip (flowmcp dev grading)', async () => {
        const { stdout } = await runCli( { 'args': [ 'dev', 'grading' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'status' ] ).toBe( false )
        expect( parsed[ 'error' ] ).toBe( 'Missing or unknown grading sub-command.' )
        // PRD-006: `import` removed; the allowlist now leads with `deterministic`.
        expect( parsed[ 'fix' ] ).toContain( 'deterministic' )
    } )

    it( 'does not fall through to the unknown-command fallback for grading', async () => {
        const { stdout } = await runCli( { 'args': [ 'grading' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'error' ] ).not.toContain( 'Unknown command' )
    } )

    it( 'routes a valid sub-command to its method (run)', async () => {
        // PRD-011: the method now requires a mode flag. Without --emit-prompts /
        // --consume-scores it returns the no-default-mode error (not a stub).
        const { stdout } = await runCli( { 'args': [ 'grading', 'run', 'demo/ns', '--phase', 'P1' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'status' ] ).toBe( false )
        expect( parsed[ 'error' ] ).toContain( 'Mode required' )
    } )

    it( 'PRD-010: `non-deterministic` routes to gradingRun (same mode mechanic)', async () => {
        const { stdout } = await runCli( { 'args': [ 'grading', 'non-deterministic', 'demo/ns', '--phase', 'P1' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'status' ] ).toBe( false )
        expect( parsed[ 'error' ] ).toContain( 'Mode required' )
    } )

    it( 'PRD-010: `nondet` alias routes to gradingRun', async () => {
        const { stdout } = await runCli( { 'args': [ 'grading', 'nondet', 'demo/ns', '--phase', 'P1' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'status' ] ).toBe( false )
        expect( parsed[ 'error' ] ).toContain( 'Mode required' )
    } )

    it( 'PA-3: lists worklist in the allowlist fix text', async () => {
        const { stdout } = await runCli( { 'args': [ 'grading' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'fix' ] ).toContain( 'worklist' )
    } )

    it( 'PA-3: routes grading worklist to its method (missing prompts -> coded error)', async () => {
        const { stdout } = await runCli( { 'args': [ 'grading', 'worklist', 'does-not-exist', '--json' ] } )
        const parsed = JSON.parse( stdout )

        // Flow detection fails for a non-imported namespace -> structured error,
        // never the unknown-command fallback.
        expect( parsed[ 'status' ] ).toBe( false )
        expect( JSON.stringify( parsed ) ).not.toContain( 'Unknown command' )
    } )

    it( 'PRD-009: lists doctor in the allowlist fix text', async () => {
        const { stdout } = await runCli( { 'args': [ 'grading' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'fix' ] ).toContain( 'doctor' )
    } )

    it( 'PRD-009: routes grading doctor to its method (missing flow -> structured error, not fallback)', async () => {
        const { stdout } = await runCli( { 'args': [ 'grading', 'doctor', 'does-not-exist', '--json' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'status' ] ).toBe( false )
        expect( JSON.stringify( parsed ) ).not.toContain( 'Unknown command' )
    } )
} )


describe( 'grading methods — module guard + input validation', () => {
    afterEach( () => {
        ModuleRegistry.inject( { 'grading': null } )
    } )

    // PRD-006: the gradingImport method was removed (no `grading import` command);
    // its module-guard / input-validation tests are dropped here. The GradingImport
    // machinery is covered by flowmcp-grading's own tests.

    it( 'gradingExport reports a missing target', async () => {
        ModuleRegistry.inject( { 'grading': { 'GradingExport': { 'run': async () => ( {} ) } } } )
        const { result } = await FlowMcpCli.gradingExport( { 'cwd': '/tmp', 'target': '', 'onConflict': null, 'json': false } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Missing export target' )
    } )

    it( 'gradingRun requires a mode flag (no silent default)', async () => {
        ModuleRegistry.inject( { 'grading': { 'RebuildIndex': {} } } )
        const { result } = await FlowMcpCli.gradingRun( { 'cwd': '/tmp', 'target': 'ns', 'phase': null, 'emitPrompts': false, 'consumeScores': null, 'onConflict': null, 'json': false } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Mode required' )
    } )

    it( 'gradingState reports a missing target', async () => {
        ModuleRegistry.inject( { 'grading': { 'ModuleApi': {} } } )
        const { result } = await FlowMcpCli.gradingState( { 'cwd': '/tmp', 'target': '', 'json': false } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Missing state target' )
    } )

    it( 'resolves the real flowmcp-grading module via lazy import (no injection)', async () => {
        // No injection -> the lazy import resolves the real module. With a
        // nonexistent target the flow-detection error proves the module loaded
        // and the method ran past the module guard.
        const { result } = await FlowMcpCli.gradingState( { 'cwd': '/tmp', 'target': 'does-not-exist', 'json': false } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'found in neither' )
    } )
} )
