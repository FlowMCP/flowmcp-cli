import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import { VALID_GLOBAL_CONFIG } from '../helpers/config.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const CACHE_DIR = join( GLOBAL_CONFIG_DIR, 'cache' )

let originalGlobalConfig = null
let globalConfigExisted = false


beforeAll( async () => {
    try {
        originalGlobalConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        globalConfigExisted = true
    } catch {
        globalConfigExisted = false
    }

    await mkdir( GLOBAL_CONFIG_DIR, { recursive: true } )
    await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( VALID_GLOBAL_CONFIG, null, 4 ), 'utf-8' )
} )

afterAll( async () => {
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }
} )


describe( 'FlowMcpCli.cacheStatus', () => {
    it( 'returns status with empty cache', async () => {
        const { result } = await FlowMcpCli.cacheStatus()

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'cacheDir' ] ).toBeDefined()
        expect( typeof result[ 'totalEntries' ] ).toBe( 'number' )
        expect( typeof result[ 'totalSize' ] ).toBe( 'number' )
        expect( Array.isArray( result[ 'entries' ] ) ).toBe( true )
    } )


    it( 'reports cache entries when cache files exist', async () => {
        const testNamespace = 'testcache'
        const cacheDir = join( CACHE_DIR, testNamespace )
        await mkdir( cacheDir, { recursive: true } )

        const cacheEntry = {
            'meta': {
                'fetchedAt': new Date().toISOString(),
                'expiresAt': new Date( Date.now() + 3600000 ).toISOString(),
                'ttl': 3600,
                'size': 42
            },
            'data': { 'test': 'value' }
        }

        await writeFile(
            join( cacheDir, 'testRoute.json' ),
            JSON.stringify( cacheEntry, null, 2 ),
            'utf-8'
        )

        const { result } = await FlowMcpCli.cacheStatus()

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'totalEntries' ] ).toBeGreaterThan( 0 )

        const testEntry = result[ 'entries' ]
            .find( ( e ) => {
                const isTestEntry = e[ 'key' ].includes( testNamespace )

                return isTestEntry
            } )

        expect( testEntry ).toBeDefined()
        expect( testEntry[ 'ttl' ] ).toBe( 3600 )
        expect( testEntry[ 'expired' ] ).toBe( false )

        await rm( cacheDir, { recursive: true, force: true } )
    } )


    it( 'marks expired cache entries', async () => {
        const testNamespace = 'testexpired'
        const cacheDir = join( CACHE_DIR, testNamespace )
        await mkdir( cacheDir, { recursive: true } )

        const cacheEntry = {
            'meta': {
                'fetchedAt': '2024-01-01T00:00:00.000Z',
                'expiresAt': '2024-01-01T01:00:00.000Z',
                'ttl': 3600,
                'size': 10
            },
            'data': { 'old': true }
        }

        await writeFile(
            join( cacheDir, 'expired.json' ),
            JSON.stringify( cacheEntry, null, 2 ),
            'utf-8'
        )

        const { result } = await FlowMcpCli.cacheStatus()

        const expiredEntry = result[ 'entries' ]
            .find( ( e ) => {
                const isExpired = e[ 'key' ].includes( testNamespace )

                return isExpired
            } )

        expect( expiredEntry ).toBeDefined()
        expect( expiredEntry[ 'expired' ] ).toBe( true )

        await rm( cacheDir, { recursive: true, force: true } )
    } )
} )


describe( 'FlowMcpCli.cacheClear', () => {
    it( 'clears all cache', async () => {
        const testDir = join( CACHE_DIR, 'cleartest' )
        await mkdir( testDir, { recursive: true } )
        await writeFile( join( testDir, 'data.json' ), '{}', 'utf-8' )

        const { result } = await FlowMcpCli.cacheClear( {} )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'message' ] ).toContain( 'All cache cleared' )
    } )


    it( 'clears cache for specific namespace', async () => {
        const testDir = join( CACHE_DIR, 'nstest' )
        await mkdir( testDir, { recursive: true } )
        await writeFile( join( testDir, 'data.json' ), '{}', 'utf-8' )

        const { result } = await FlowMcpCli.cacheClear( { namespace: 'nstest' } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'message' ] ).toContain( 'nstest' )
    } )


    it( 'succeeds even when cache directory does not exist', async () => {
        const { result } = await FlowMcpCli.cacheClear( { namespace: 'nonexistent_namespace_xyz' } )

        expect( result[ 'status' ] ).toBe( true )
    } )
} )
