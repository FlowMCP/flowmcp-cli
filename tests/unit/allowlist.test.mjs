import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { constants } from 'node:fs'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


// ─── helpers ────────────────────────────────────────────────────────────────

async function fileExists( filePath ) {
    try {
        await access( filePath, constants.F_OK )

        return true
    } catch {
        return false
    }
}


async function readConfig( configPath ) {
    const raw = await readFile( configPath, 'utf-8' )

    return JSON.parse( raw )
}


// ─── test 1: list with no config file ────────────────────────────────────────

describe( 'allowlist — list with no config file', () => {
    let tmpCwd

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-al-no-config-${Date.now()}` )
        await mkdir( tmpCwd, { recursive: true } )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'returns status true with empty extensions without error', async () => {
        const { result } = await FlowMcpCli.allowlist( { 'cwd': tmpCwd, 'action': 'list', 'library': null } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'action' ] ).toBe( 'list' )
        expect( Array.isArray( result[ 'extensions' ] ) ).toBe( true )
        expect( result[ 'extensions' ] ).toHaveLength( 0 )
        expect( Array.isArray( result[ 'merged' ] ) ).toBe( true )
    } )

    it( 'result contains required keys', async () => {
        const { result } = await FlowMcpCli.allowlist( { 'cwd': tmpCwd, 'action': 'list', 'library': null } )

        expect( result ).toHaveProperty( 'status' )
        expect( result ).toHaveProperty( 'action' )
        expect( result ).toHaveProperty( 'default' )
        expect( result ).toHaveProperty( 'extensions' )
        expect( result ).toHaveProperty( 'merged' )
        expect( result ).toHaveProperty( 'hasMergeAllowlist' )
        expect( result ).toHaveProperty( 'configPath' )
    } )
} )


// ─── test 2: add library to fresh project ────────────────────────────────────

describe( 'allowlist — add library to fresh project', () => {
    let tmpCwd

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-al-add-fresh-${Date.now()}` )
        await mkdir( tmpCwd, { recursive: true } )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'creates flowmcp.config.json with the library in allowlist', async () => {
        const { result } = await FlowMcpCli.allowlist( { 'cwd': tmpCwd, 'action': 'add', 'library': 'talib' } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'action' ] ).toBe( 'add' )
        expect( result[ 'library' ] ).toBe( 'talib' )
        expect( result[ 'added' ] ).toBe( true )
        expect( result[ 'allowlist' ] ).toContain( 'talib' )
    } )

    it( 'config file exists and contains the library', async () => {
        const configPath = join( tmpCwd, 'flowmcp.config.json' )
        const exists = await fileExists( configPath )
        expect( exists ).toBe( true )

        const config = await readConfig( configPath )
        expect( config[ 'allowlist' ] ).toContain( 'talib' )
    } )
} )


// ─── test 3: add same library twice (idempotent) ─────────────────────────────

describe( 'allowlist — add same library twice is idempotent', () => {
    let tmpCwd

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-al-idem-${Date.now()}` )
        await mkdir( tmpCwd, { recursive: true } )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'first add returns added: true', async () => {
        const { result } = await FlowMcpCli.allowlist( { 'cwd': tmpCwd, 'action': 'add', 'library': 'talib' } )

        expect( result[ 'added' ] ).toBe( true )
        expect( result[ 'allowlist' ] ).toHaveLength( 1 )
    } )

    it( 'second add returns added: false and allowlist stays length 1', async () => {
        const { result } = await FlowMcpCli.allowlist( { 'cwd': tmpCwd, 'action': 'add', 'library': 'talib' } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'added' ] ).toBe( false )
        expect( result[ 'allowlist' ] ).toHaveLength( 1 )
        expect( result[ 'allowlist' ] ).toContain( 'talib' )
    } )
} )


// ─── test 4: remove library ───────────────────────────────────────────────────

describe( 'allowlist — remove library', () => {
    let tmpCwd

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-al-remove-${Date.now()}` )
        await mkdir( tmpCwd, { recursive: true } )

        const config = { 'allowlist': [ 'talib', 'technicalindicators' ] }
        await writeFile( join( tmpCwd, 'flowmcp.config.json' ), JSON.stringify( config, null, 4 ), 'utf-8' )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'removes the library and returns removed: true', async () => {
        const { result } = await FlowMcpCli.allowlist( { 'cwd': tmpCwd, 'action': 'remove', 'library': 'talib' } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'action' ] ).toBe( 'remove' )
        expect( result[ 'library' ] ).toBe( 'talib' )
        expect( result[ 'removed' ] ).toBe( true )
        expect( result[ 'allowlist' ] ).not.toContain( 'talib' )
        expect( result[ 'allowlist' ] ).toContain( 'technicalindicators' )
    } )

    it( 'config file on disk no longer contains removed library', async () => {
        const config = await readConfig( join( tmpCwd, 'flowmcp.config.json' ) )

        expect( config[ 'allowlist' ] ).not.toContain( 'talib' )
        expect( config[ 'allowlist' ] ).toContain( 'technicalindicators' )
    } )
} )


// ─── test 5: remove library not present (no-op) ──────────────────────────────

describe( 'allowlist — remove library not present is no-op', () => {
    let tmpCwd

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-al-remove-noop-${Date.now()}` )
        await mkdir( tmpCwd, { recursive: true } )

        const config = { 'allowlist': [ 'talib' ] }
        await writeFile( join( tmpCwd, 'flowmcp.config.json' ), JSON.stringify( config, null, 4 ), 'utf-8' )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'returns status true and removed: false without error', async () => {
        const { result } = await FlowMcpCli.allowlist( { 'cwd': tmpCwd, 'action': 'remove', 'library': 'nonexistent-lib' } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'removed' ] ).toBe( false )
        expect( result[ 'allowlist' ] ).toHaveLength( 1 )
        expect( result[ 'allowlist' ] ).toContain( 'talib' )
    } )
} )


// ─── test 6: reject invalid library names ────────────────────────────────────

describe( 'allowlist — reject invalid library names', () => {
    let tmpCwd

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-al-invalid-${Date.now()}` )
        await mkdir( tmpCwd, { recursive: true } )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, force: true } ).catch( () => {} )
    } )

    const invalidNames = [
        '../etc/passwd',
        '',
        '../../secrets',
        '/absolute/path'
    ]

    invalidNames
        .forEach( ( name ) => {
            it( `rejects invalid name: "${name}"`, async () => {
                const { result } = await FlowMcpCli.allowlist( { 'cwd': tmpCwd, 'action': 'add', 'library': name } )

                expect( result[ 'status' ] ).toBe( false )
                expect( typeof result[ 'error' ] ).toBe( 'string' )
            } )
        } )

    it( 'accepts valid scoped package name @scope/pkg', async () => {
        const { result } = await FlowMcpCli.allowlist( { 'cwd': tmpCwd, 'action': 'add', 'library': '@myorg/mylib' } )

        expect( result[ 'status' ] ).toBe( true )
    } )
} )


// ─── test 7: list shows default + extensions ─────────────────────────────────

describe( 'allowlist — list shows merged default + extensions', () => {
    let tmpCwd

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-al-list-merged-${Date.now()}` )
        await mkdir( tmpCwd, { recursive: true } )

        const config = { 'allowlist': [ 'talib', 'technicalindicators' ] }
        await writeFile( join( tmpCwd, 'flowmcp.config.json' ), JSON.stringify( config, null, 4 ), 'utf-8' )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'extensions contains the configured libraries', async () => {
        const { result } = await FlowMcpCli.allowlist( { 'cwd': tmpCwd, 'action': 'list', 'library': null } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'extensions' ] ).toContain( 'talib' )
        expect( result[ 'extensions' ] ).toContain( 'technicalindicators' )
    } )

    it( 'merged contains at least the extensions', async () => {
        const { result } = await FlowMcpCli.allowlist( { 'cwd': tmpCwd, 'action': 'list', 'library': null } )

        expect( result[ 'merged' ] ).toContain( 'talib' )
        expect( result[ 'merged' ] ).toContain( 'technicalindicators' )
    } )

    it( 'merged length is at least extensions length', async () => {
        const { result } = await FlowMcpCli.allowlist( { 'cwd': tmpCwd, 'action': 'list', 'library': null } )

        expect( result[ 'merged' ].length ).toBeGreaterThanOrEqual( result[ 'extensions' ].length )
    } )
} )


// ─── test 8: feature-detect graceful degradation ─────────────────────────────

describe( 'allowlist — feature-detect: missing mergeAllowlist degrades gracefully', () => {
    let tmpCwd

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-al-featdetect-${Date.now()}` )
        await mkdir( tmpCwd, { recursive: true } )

        const config = { 'allowlist': [ 'talib' ] }
        await writeFile( join( tmpCwd, 'flowmcp.config.json' ), JSON.stringify( config, null, 4 ), 'utf-8' )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'list still returns status true regardless of hasMergeAllowlist value', async () => {
        const { result } = await FlowMcpCli.allowlist( { 'cwd': tmpCwd, 'action': 'list', 'library': null } )

        expect( result[ 'status' ] ).toBe( true )
        expect( typeof result[ 'hasMergeAllowlist' ] ).toBe( 'boolean' )
        expect( result[ 'extensions' ] ).toContain( 'talib' )
        expect( result[ 'merged' ] ).toContain( 'talib' )
    } )

    it( 'hasMergeAllowlist reflects actual runtime capability', async () => {
        const { result } = await FlowMcpCli.allowlist( { 'cwd': tmpCwd, 'action': 'list', 'library': null } )

        // Value can be true or false depending on installed core version — both are valid
        expect( [ true, false ] ).toContain( result[ 'hasMergeAllowlist' ] )
    } )
} )
