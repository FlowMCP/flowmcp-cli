import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


// Memo 150 D3/F7 — the separate config allowlist is obsolete. `dev allowlist list` now reflects
// what is installed in allowed-libraries/node_modules (installed = allowed); `add`/`remove` are
// deprecated and only print the manual `npm install --prefix` command (F3=B: the CLI never
// installs). homedir() is mocked to a per-file test-home, so allowed-libraries resolves inside
// <repo>/.test-home (Memo 032 isolation) — no writes to the real ~/.flowmcp.

const ALLOWED_DIR = join( homedir(), '.flowmcp', 'allowed-libraries' )
const ALLOWED_NM = join( ALLOWED_DIR, 'node_modules' )


describe( 'allowlist list — reflects installed allowed-libraries (Memo 150 D3/F7)', () => {
    const CWD = join( tmpdir(), `flowmcp-al-list-${Date.now()}` )


    beforeEach( async () => {
        await rm( ALLOWED_NM, { recursive: true, force: true } ).catch( () => {} )
        await mkdir( CWD, { recursive: true } )
    } )


    afterEach( async () => {
        await rm( ALLOWED_NM, { recursive: true, force: true } ).catch( () => {} )
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'returns status true with empty installed when allowed-libraries is absent', async () => {
        const { result } = await FlowMcpCli.allowlist( { 'cwd': CWD, 'action': 'list', 'library': null } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'action' ] ).toBe( 'list' )
        expect( Array.isArray( result[ 'installed' ] ) ).toBe( true )
        expect( result[ 'installed' ] ).toHaveLength( 0 )
        expect( result[ 'count' ] ).toBe( 0 )
    } )


    it( 'lists installed top-level and scoped packages, filtering dotfiles', async () => {
        await mkdir( join( ALLOWED_NM, 'indicatorts' ), { recursive: true } )
        await mkdir( join( ALLOWED_NM, 'talib' ), { recursive: true } )
        await mkdir( join( ALLOWED_NM, '@scope', 'mylib' ), { recursive: true } )
        await mkdir( join( ALLOWED_NM, '.bin' ), { recursive: true } )

        const { result } = await FlowMcpCli.allowlist( { 'cwd': CWD, 'action': 'list', 'library': null } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'installed' ] ).toContain( 'indicatorts' )
        expect( result[ 'installed' ] ).toContain( 'talib' )
        expect( result[ 'installed' ] ).toContain( '@scope/mylib' )
        expect( result[ 'installed' ] ).not.toContain( '.bin' )
        expect( result[ 'count' ] ).toBe( result[ 'installed' ].length )
    } )


    it( 'carries allowedLibrariesBase + a note with the install hint', async () => {
        const { result } = await FlowMcpCli.allowlist( { 'cwd': CWD, 'action': 'list', 'library': null } )

        expect( result ).toHaveProperty( 'allowedLibrariesBase' )
        expect( typeof result[ 'note' ] ).toBe( 'string' )
        expect( result[ 'note' ] ).toContain( 'npm install --prefix' )
    } )
} )


describe( 'allowlist add/remove — deprecated, prints the manual command (Memo 150 F3=B)', () => {
    const CWD = join( tmpdir(), `flowmcp-al-dep-${Date.now()}` )


    beforeEach( async () => {
        await mkdir( CWD, { recursive: true } )
    } )


    afterEach( async () => {
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'add is deprecated and returns the npm install --prefix command', async () => {
        const { result } = await FlowMcpCli.allowlist( { 'cwd': CWD, 'action': 'add', 'library': 'talib' } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'deprecated' ] ).toBe( true )
        expect( result[ 'command' ] ).toContain( 'npm install --prefix' )
        expect( result[ 'command' ] ).toContain( 'talib' )
    } )


    it( 'remove is deprecated and returns the npm uninstall --prefix command', async () => {
        const { result } = await FlowMcpCli.allowlist( { 'cwd': CWD, 'action': 'remove', 'library': 'talib' } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'deprecated' ] ).toBe( true )
        expect( result[ 'command' ] ).toContain( 'npm uninstall --prefix' )
        expect( result[ 'command' ] ).toContain( 'talib' )
    } )


    it( 'accepts a valid scoped package name', async () => {
        const { result } = await FlowMcpCli.allowlist( { 'cwd': CWD, 'action': 'add', 'library': '@myorg/mylib' } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'deprecated' ] ).toBe( true )
    } )
} )


describe( 'allowlist — rejects invalid names + unknown actions', () => {
    const CWD = join( tmpdir(), `flowmcp-al-invalid-${Date.now()}` )


    beforeEach( async () => {
        await mkdir( CWD, { recursive: true } )
    } )


    afterEach( async () => {
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    const invalidNames = [ '../etc/passwd', '', '../../secrets', '/absolute/path' ]

    invalidNames
        .forEach( ( name ) => {
            it( `rejects invalid library name: "${name}"`, async () => {
                const { result } = await FlowMcpCli.allowlist( { 'cwd': CWD, 'action': 'add', 'library': name } )

                expect( result[ 'status' ] ).toBe( false )
                expect( typeof result[ 'error' ] ).toBe( 'string' )
            } )
        } )


    it( 'rejects an unknown action', async () => {
        const { result } = await FlowMcpCli.allowlist( { 'cwd': CWD, 'action': 'frobnicate', 'library': 'x' } )

        expect( result[ 'status' ] ).toBe( false )
    } )
} )
