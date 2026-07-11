import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { VALID_GLOBAL_CONFIG_WITH_SOURCES, VALID_REGISTRY } from '../helpers/config.mjs'
import { createTestHome } from '../helpers/test-home.mjs'

const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


const testHome = createTestHome( { suite: 'search-add' } )
const GLOBAL_CONFIG_PATH = testHome.globalConfigPath
const SCHEMAS_DIR = testHome.schemasDir
const TEST_CWD = join( tmpdir(), 'flowmcp-cli-search-add-test' )

const DEMO_SCHEMA_CONTENT = `export const main = {
    namespace: 'testdemo',
    name: 'Test Demo API',
    description: 'Simple demo schema for CLI testing',
    version: '4.0.0',
    docs: [ 'https://example.com/docs' ],
    tags: [ 'demo', 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: { 'Accept': 'application/json' },
    tools: {
        ping: {
            method: 'GET',
            description: 'Simple ping endpoint for testing',
            path: '/get',
            parameters: [],
            tests: [ { _description: 'Ping test' } ]
        },
        getHeaders: {
            method: 'GET',
            description: 'Returns request headers',
            path: '/headers',
            parameters: [
                {
                    position: { key: 'limit', value: '{{USER_PARAM}}', location: 'query' },
                    z: { primitive: 'number()', options: [ 'optional()', 'default(10)' ] }
                }
            ],
            tests: [ { _description: 'Headers test' } ]
        }
    }
}
`

const SECOND_SCHEMA_CONTENT = `export const main = {
    namespace: 'cryptotest',
    name: 'Crypto Test API',
    description: 'Crypto price data for testing',
    version: '4.0.0',
    docs: [],
    tags: [ 'crypto', 'price' ],
    root: 'https://api.example.com',
    requiredServerParams: [ 'CRYPTO_KEY' ],
    headers: { 'Authorization': 'Bearer {{CRYPTO_KEY}}' },
    tools: {
        getPrice: {
            method: 'GET',
            description: 'Get token price by symbol',
            path: '/price/:symbol',
            parameters: [
                {
                    position: { key: 'symbol', value: '{{USER_PARAM}}', location: 'insert' },
                    z: { primitive: 'string()', options: [] }
                }
            ],
            tests: [ { _description: 'Get BTC price', symbol: 'BTC' } ]
        }
    }
}
`

const TEST_REGISTRY = {
    'name': 'test-source',
    'version': '1.0.0',
    'description': 'Test registry',
    'schemaSpec': '4.0.0',
    'baseDir': 'schemas/v2.0.0',
    'schemas': [
        {
            'namespace': 'testdemo',
            'file': 'testdemo/demo.mjs',
            'name': 'Test Demo API',
            'requiredServerParams': []
        },
        {
            'namespace': 'cryptotest',
            'file': 'cryptotest/prices.mjs',
            'name': 'Crypto Test API',
            'requiredServerParams': [ 'CRYPTO_KEY' ]
        }
    ]
}

const TEST_GLOBAL_CONFIG = {
    'envPath': join( TEST_CWD, '.env' ),
    'flowmcpCore': {
        'version': '2.0.0',
        'commit': 'abc123',
        'schemaSpec': '4.0.0'
    },
    'initialized': '2026-02-20T12:00:00.000Z',
    'sources': {
        'demo': {
            'type': 'builtin',
            'schemaCount': 1
        },
        'test-source': {
            'type': 'github',
            'repository': 'https://github.com/test/test-schemas',
            'schemaCount': 2,
            'importedAt': '2026-02-20T12:00:00.000Z'
        }
    }
}


beforeAll( async () => {
    await testHome.setup()
    await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( TEST_GLOBAL_CONFIG, null, 4 ), 'utf-8' )

    const demoDir = join( SCHEMAS_DIR, 'demo' )
    await mkdir( demoDir, { recursive: true } )
    await writeFile( join( demoDir, 'ping.mjs' ), DEMO_SCHEMA_CONTENT, 'utf-8' )

    const testSourceDir = join( SCHEMAS_DIR, 'test-source' )
    const testDemoDir = join( testSourceDir, 'testdemo' )
    const cryptoDir = join( testSourceDir, 'cryptotest' )
    await mkdir( testDemoDir, { recursive: true } )
    await mkdir( cryptoDir, { recursive: true } )

    await writeFile(
        join( testSourceDir, '_registry.json' ),
        JSON.stringify( TEST_REGISTRY, null, 4 ),
        'utf-8'
    )

    await writeFile( join( testDemoDir, 'demo.mjs' ), DEMO_SCHEMA_CONTENT, 'utf-8' )
    await writeFile( join( cryptoDir, 'prices.mjs' ), SECOND_SCHEMA_CONTENT, 'utf-8' )

    await mkdir( TEST_CWD, { recursive: true } )
    await writeFile( join( TEST_CWD, '.env' ), 'CRYPTO_KEY=test-key-123\n', 'utf-8' )
} )

afterAll( async () => {
    await rm( TEST_CWD, { recursive: true, force: true } )
    await testHome.teardown()
} )


describe( 'FlowMcpCli.search', () => {
    it( 'returns error when query is missing', async () => {
        const { result } = await FlowMcpCli.search( { query: undefined } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Missing search query' )
    } )


    it( 'returns error when query is empty string', async () => {
        const { result } = await FlowMcpCli.search( { query: '   ' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Missing search query' )
    } )


    it( 'returns error when query is non-string', async () => {
        const { result } = await FlowMcpCli.search( { query: 42 } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Missing search query' )
    } )


    it( 'returns matching tools for a valid query', async () => {
        const { result } = await FlowMcpCli.search( { query: 'testdemo' } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'query' ] ).toBe( 'testdemo' )
        expect( result[ 'matchCount' ] ).toBeGreaterThan( 0 )
        expect( result[ 'tools' ].length ).toBeGreaterThan( 0 )
    } )


    it( 'returns tool entries with expected shape', async () => {
        const { result } = await FlowMcpCli.search( { query: 'ping' } )

        expect( result[ 'status' ] ).toBe( true )

        const firstTool = result[ 'tools' ][ 0 ]

        expect( firstTool ).toHaveProperty( 'name' )
        expect( firstTool ).toHaveProperty( 'description' )
        expect( firstTool ).toHaveProperty( 'namespace' )
        expect( firstTool ).toHaveProperty( 'score' )
        expect( firstTool ).toHaveProperty( 'call' )
        expect( firstTool[ 'score' ] ).toBeGreaterThan( 0 )
    } )


    it( 'returns zero matches for unrelated query', async () => {
        const { result } = await FlowMcpCli.search( { query: 'zzz_nonexistent_xyz' } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'matchCount' ] ).toBe( 0 )
        expect( result[ 'tools' ] ).toHaveLength( 0 )
        expect( result[ 'hint' ] ).toContain( 'No matches' )
    } )


    it( 'searches by namespace', async () => {
        const { result } = await FlowMcpCli.search( { query: 'cryptotest' } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'matchCount' ] ).toBeGreaterThan( 0 )

        const names = result[ 'tools' ]
            .map( ( t ) => {
                const name = t[ 'name' ]

                return name
            } )

        const hasMatch = names
            .some( ( n ) => {
                const includes = n.includes( 'cryptotest' )

                return includes
            } )

        expect( hasMatch ).toBe( true )
    } )


    it( 'searches by tags', async () => {
        const { result } = await FlowMcpCli.search( { query: 'crypto' } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'matchCount' ] ).toBeGreaterThan( 0 )
    } )


    it( 'limits results to max 10', async () => {
        const { result } = await FlowMcpCli.search( { query: 'test' } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'showing' ] ).toBeLessThanOrEqual( 10 )
        expect( result[ 'tools' ].length ).toBeLessThanOrEqual( 10 )
    } )
} )



describe( 'FlowMcpCli.list', () => {
    // Memo 099 Kap 5 — list shows ALL tools from the schemaFolders, independent
    // of any local config. A missing local config no longer yields an empty list.
    it( 'lists all folder tools regardless of local config', async () => {
        const emptyCwd = join( tmpdir(), 'flowmcp-cli-list-empty' )
        await mkdir( emptyCwd, { recursive: true } )

        const { result } = await FlowMcpCli.list( { cwd: emptyCwd } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolCount' ] ).toBeGreaterThan( 0 )

        await rm( emptyCwd, { recursive: true, force: true } )
    } )



} )


