import { describe, it, expect } from '@jest/globals'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { writeFile, mkdir } from 'node:fs/promises'


// This file deliberately binds homedir() at MODULE level and does NOT import
// the test-home helper — the exact anti-pattern from the incident. It proves
// the structural guarantees of PRD-001 (Memo 068 R1).
const MODULE_LEVEL_HOME = join( homedir(), '.flowmcp' )


describe( 'PRD-001 — global home/tmp mock', () => {
    it( 'module-level homedir() resolves inside <repo>/.test-home', () => {
        expect( MODULE_LEVEL_HOME ).toContain( '.test-home' )
        expect( MODULE_LEVEL_HOME.startsWith( globalThis.__FLOWMCP_REPO_ROOT__ ) ).toBe( true )
    } )

    it( 'runtime homedir() is mocked into the repo', () => {
        expect( homedir().startsWith( globalThis.__FLOWMCP_REPO_ROOT__ ) ).toBe( true )
    } )

    it( 'tmpdir() is redirected inside the repo', () => {
        expect( tmpdir().startsWith( globalThis.__FLOWMCP_REPO_ROOT__ ) ).toBe( true )
        expect( tmpdir() ).toContain( '.test-home' )
    } )
} )


describe( 'PRD-001 — path-guard (negative test)', () => {
    it( 'rejects a write OUTSIDE the repo root', async () => {
        const outside = '/tmp/flowmcp-pathguard-must-not-be-written.txt'
        await expect( writeFile( outside, 'should never be written' ) )
            .rejects.toThrow( /path-guard/ )
    } )

    it( 'rejects mkdir OUTSIDE the repo root', async () => {
        const outside = join( '/', 'flowmcp-pathguard-must-not-exist' )
        await expect( mkdir( outside, { recursive: true } ) )
            .rejects.toThrow( /path-guard/ )
    } )

    it( 'allows a write INSIDE the mocked home', async () => {
        const inside = join( homedir(), '.flowmcp', 'guard-allows.txt' )
        await mkdir( join( homedir(), '.flowmcp' ), { recursive: true } )
        await expect( writeFile( inside, 'ok' ) ).resolves.toBeUndefined()
    } )
} )
