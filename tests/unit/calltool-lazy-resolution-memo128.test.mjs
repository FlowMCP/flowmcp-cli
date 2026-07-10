import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createTestHome } from '../helpers/test-home.mjs'

const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


// Memo 128 Kap 10 — Lazy Schema-Resolution. A tool Spec-ID call must resolve via
// the prebuilt namespace-index (one schema import), and must transparently fall
// back to the full scan on a miss / stale index. Behaviour is identical to the
// old full-scan path; only the import count changes.

const ETHERSCAN_SCHEMA = `export const main = {
    namespace: 'etherscan',
    name: 'Etherscan API',
    description: 'Block explorer',
    version: '4.0.0',
    docs: [],
    tags: [ 'chain' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    tools: {
        getBalance: {
            method: 'GET',
            description: 'Get balance',
            path: '/get',
            parameters: [],
            tests: [ { _description: 'balance' } ]
        }
    }
}
`

const WEATHER_SCHEMA = `export const main = {
    namespace: 'weather',
    name: 'Weather API',
    description: 'Weather',
    version: '4.0.0',
    docs: [],
    tags: [ 'env' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    tools: {
        getForecast: {
            method: 'GET',
            description: 'Get forecast',
            path: '/get',
            parameters: [],
            tests: [ { _description: 'forecast' } ]
        }
    }
}
`


describe( 'Memo 128 Kap 10 — callTool lazy schema-resolution', () => {
    const testHome = createTestHome( { suite: 'lazy-resolution-m128' } )

    beforeAll( async () => {
        await testHome.setup()

        const globalConfig = {
            'envPath': join( testHome.globalConfigDir, '.env' ),
            'initialized': '2026-06-09T00:00:00.000Z',
            'schemaFolders': [
                { 'name': 'main', 'path': '~/schemas/v4.0.0' }
            ]
        }
        await writeFile( testHome.globalConfigPath, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
        await writeFile( join( testHome.globalConfigDir, '.env' ), '', 'utf-8' )

        const ethDir = join( testHome.root, 'schemas', 'v4.0.0', 'providers', 'etherscan' )
        const wxDir = join( testHome.root, 'schemas', 'v4.0.0', 'providers', 'weather' )
        await mkdir( ethDir, { recursive: true } )
        await mkdir( wxDir, { recursive: true } )
        await writeFile( join( ethDir, 'etherscan.mjs' ), ETHERSCAN_SCHEMA, 'utf-8' )
        await writeFile( join( wxDir, 'weather.mjs' ), WEATHER_SCHEMA, 'utf-8' )

        // Pre-build the namespace index so the lazy path has a cache to consult.
        await FlowMcpCli.getNamespaceIndex( { cwd: testHome.root, forceRebuild: true } )
    } )

    afterAll( async () => {
        await testHome.teardown()
    } )

    it( 'resolves a tool Spec-ID via the prebuilt index (lazy hit)', async () => {
        const { result } = await FlowMcpCli.callTool( {
            toolName: 'etherscan/tool/getBalance',
            jsonArgs: null,
            cwd: testHome.root
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolName' ] ).toBe( 'get_balance_etherscan' )
    } )

    it( 'falls back to the full scan when the index is stale (wrong file)', async () => {
        // Corrupt the index cache: point the etherscan tool entry at a missing file.
        const cachePath = join( testHome.globalConfigDir, 'namespace-index.json' )
        const raw = await readFile( cachePath, 'utf-8' )
        const index = JSON.parse( raw )
        index[ 'tools' ][ 'etherscan/tool/getBalance' ] = { 'file': 'etherscan/does-not-exist.mjs', 'source': 'main', 'routeName': 'getBalance' }
        await writeFile( cachePath, JSON.stringify( index, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.callTool( {
            toolName: 'etherscan/tool/getBalance',
            jsonArgs: null,
            cwd: testHome.root
        } )

        // Stale entry → lazy load misses the wire-name → full-scan fallback still resolves.
        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolName' ] ).toBe( 'get_balance_etherscan' )
    } )

    it( 'still resolves a bare wire-name (no Spec-ID → full scan)', async () => {
        const { result } = await FlowMcpCli.callTool( {
            toolName: 'get_forecast_weather',
            jsonArgs: null,
            cwd: testHome.root
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolName' ] ).toBe( 'get_forecast_weather' )
    } )

    it( 'an unknown tool Spec-ID is still a clean not-found error', async () => {
        const { result } = await FlowMcpCli.callTool( {
            toolName: 'etherscan/tool/doesNotExist',
            jsonArgs: null,
            cwd: testHome.root
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toMatch( /not found/ )
    } )
} )
