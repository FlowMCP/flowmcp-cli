import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import { VALID_GLOBAL_CONFIG_WITH_SOURCES, VALID_REGISTRY } from '../helpers/config.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
const TEST_CWD = join( tmpdir(), 'flowmcp-cli-search-add-test' )

let originalGlobalConfig = null
let globalConfigExisted = false

const DEMO_SCHEMA_CONTENT = `export const main = {
    namespace: 'testdemo',
    name: 'Test Demo API',
    description: 'Simple demo schema for CLI testing',
    version: '2.0.0',
    docs: [ 'https://example.com/docs' ],
    tags: [ 'demo', 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: { 'Accept': 'application/json' },
    routes: {
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
    version: '2.0.0',
    docs: [],
    tags: [ 'crypto', 'price' ],
    root: 'https://api.example.com',
    requiredServerParams: [ 'CRYPTO_KEY' ],
    headers: { 'Authorization': 'Bearer {{CRYPTO_KEY}}' },
    routes: {
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
    'schemaSpec': '2.0.0',
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
        'schemaSpec': '2.0.0'
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
    try {
        originalGlobalConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        globalConfigExisted = true
    } catch {
        globalConfigExisted = false
    }

    await mkdir( GLOBAL_CONFIG_DIR, { recursive: true } )
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
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    await rm( join( SCHEMAS_DIR, 'test-source' ), { recursive: true, force: true } )
    await rm( TEST_CWD, { recursive: true, force: true } )
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
        expect( firstTool ).toHaveProperty( 'add' )
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


describe( 'FlowMcpCli.add', () => {
    it( 'returns error when toolName is missing', async () => {
        const { result } = await FlowMcpCli.add( { toolName: undefined, cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Missing tool name' )
    } )


    it( 'returns error when toolName is empty', async () => {
        const { result } = await FlowMcpCli.add( { toolName: '  ', cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Missing tool name' )
    } )


    it( 'returns error for unknown tool', async () => {
        const { result } = await FlowMcpCli.add( { toolName: 'nonexistent_tool_xyz', cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'not found' )
    } )


    it( 'adds a valid tool successfully', async () => {
        const addCwd = join( tmpdir(), 'flowmcp-cli-add-test' )
        await mkdir( addCwd, { recursive: true } )

        const { result: searchResult } = await FlowMcpCli.search( { query: 'ping testdemo' } )
        const pingTool = searchResult[ 'tools' ]
            .find( ( t ) => {
                const match = t[ 'name' ].includes( 'ping' ) && t[ 'namespace' ] === 'testdemo'

                return match
            } )

        expect( pingTool ).toBeDefined()

        const { result } = await FlowMcpCli.add( { toolName: pingTool[ 'name' ], cwd: addCwd } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'added' ] ).toBe( pingTool[ 'name' ] )

        const configPath = join( addCwd, '.flowmcp', 'config.json' )
        const configRaw = await readFile( configPath, 'utf-8' )
        const config = JSON.parse( configRaw )

        expect( config[ 'tools' ] ).toBeDefined()
        expect( config[ 'tools' ].length ).toBe( 1 )

        await rm( addCwd, { recursive: true, force: true } )
    } )


    it( 'adds tool with parameters extracted', async () => {
        const addCwd = join( tmpdir(), 'flowmcp-cli-add-params-test' )
        await mkdir( addCwd, { recursive: true } )

        const { result: searchResult } = await FlowMcpCli.search( { query: 'price cryptotest' } )
        const priceTool = searchResult[ 'tools' ]
            .find( ( t ) => {
                const match = t[ 'name' ].includes( 'price' ) && t[ 'namespace' ] === 'cryptotest'

                return match
            } )

        expect( priceTool ).toBeDefined()

        const { result } = await FlowMcpCli.add( { toolName: priceTool[ 'name' ], cwd: addCwd } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'parameters' ] ).toBeDefined()
        expect( result[ 'parameters' ][ 'symbol' ] ).toBeDefined()
        expect( result[ 'parameters' ][ 'symbol' ][ 'type' ] ).toBe( 'string' )
        expect( result[ 'parameters' ][ 'symbol' ][ 'required' ] ).toBe( true )

        await rm( addCwd, { recursive: true, force: true } )
    } )


    it( 'reports already active tool without duplicating', async () => {
        const addCwd = join( tmpdir(), 'flowmcp-cli-add-dup-test' )
        await mkdir( addCwd, { recursive: true } )

        const { result: searchResult } = await FlowMcpCli.search( { query: 'ping testdemo' } )
        const pingTool = searchResult[ 'tools' ]
            .find( ( t ) => {
                const match = t[ 'name' ].includes( 'ping' ) && t[ 'namespace' ] === 'testdemo'

                return match
            } )

        await FlowMcpCli.add( { toolName: pingTool[ 'name' ], cwd: addCwd } )
        const { result } = await FlowMcpCli.add( { toolName: pingTool[ 'name' ], cwd: addCwd } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'message' ] ).toContain( 'already active' )

        const configRaw = await readFile( join( addCwd, '.flowmcp', 'config.json' ), 'utf-8' )
        const config = JSON.parse( configRaw )

        expect( config[ 'tools' ].length ).toBe( 1 )

        await rm( addCwd, { recursive: true, force: true } )
    } )
} )


describe( 'FlowMcpCli.list', () => {
    it( 'returns empty tools when no local config exists', async () => {
        const emptyCwd = join( tmpdir(), 'flowmcp-cli-list-empty' )
        await mkdir( emptyCwd, { recursive: true } )

        const { result } = await FlowMcpCli.list( { cwd: emptyCwd } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolCount' ] ).toBe( 0 )
        expect( result[ 'tools' ] ).toHaveLength( 0 )

        await rm( emptyCwd, { recursive: true, force: true } )
    } )


    it( 'returns active tools after add', async () => {
        const listCwd = join( tmpdir(), 'flowmcp-cli-list-test' )
        await mkdir( listCwd, { recursive: true } )
        await writeFile( join( listCwd, '.env' ), 'CRYPTO_KEY=test\n', 'utf-8' )

        const { result: searchResult } = await FlowMcpCli.search( { query: 'ping testdemo' } )
        const pingTool = searchResult[ 'tools' ]
            .find( ( t ) => {
                const match = t[ 'name' ].includes( 'ping' ) && t[ 'namespace' ] === 'testdemo'

                return match
            } )

        await FlowMcpCli.add( { toolName: pingTool[ 'name' ], cwd: listCwd } )

        const { result } = await FlowMcpCli.list( { cwd: listCwd } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolCount' ] ).toBeGreaterThan( 0 )
        expect( result[ 'tools' ].length ).toBeGreaterThan( 0 )

        const toolNames = result[ 'tools' ]
            .map( ( t ) => {
                const name = t[ 'name' ]

                return name
            } )

        const hasPing = toolNames
            .some( ( n ) => {
                const includes = n.includes( 'ping' )

                return includes
            } )

        expect( hasPing ).toBe( true )

        await rm( listCwd, { recursive: true, force: true } )
    } )


    it( 'returns tool entries with parameters', async () => {
        const listCwd = join( tmpdir(), 'flowmcp-cli-list-params-test' )
        await mkdir( listCwd, { recursive: true } )

        const { result: searchResult } = await FlowMcpCli.search( { query: 'headers testdemo' } )
        const headersTool = searchResult[ 'tools' ]
            .find( ( t ) => {
                const match = t[ 'name' ].includes( 'headers' ) && t[ 'namespace' ] === 'testdemo'

                return match
            } )

        expect( headersTool ).toBeDefined()
        await FlowMcpCli.add( { toolName: headersTool[ 'name' ], cwd: listCwd } )

        const { result } = await FlowMcpCli.list( { cwd: listCwd } )

        expect( result[ 'status' ] ).toBe( true )

        const listedTool = result[ 'tools' ]
            .find( ( t ) => {
                const match = t[ 'name' ].includes( 'get_headers' )

                return match
            } )

        expect( listedTool ).toBeDefined()
        expect( listedTool[ 'parameters' ] ).toBeDefined()

        await rm( listCwd, { recursive: true, force: true } )
    } )
} )


describe( 'FlowMcpCli.remove', () => {
    it( 'returns error when toolName is missing', async () => {
        const { result } = await FlowMcpCli.remove( { toolName: undefined, cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Missing tool name' )
    } )


    it( 'returns error when toolName is empty', async () => {
        const { result } = await FlowMcpCli.remove( { toolName: '', cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Missing tool name' )
    } )


    it( 'returns error when no active tools', async () => {
        const emptyCwd = join( tmpdir(), 'flowmcp-cli-remove-empty' )
        await mkdir( emptyCwd, { recursive: true } )

        const { result } = await FlowMcpCli.remove( { toolName: 'some_tool', cwd: emptyCwd } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'No active tools' )

        await rm( emptyCwd, { recursive: true, force: true } )
    } )


    it( 'removes a previously added tool', async () => {
        const removeCwd = join( tmpdir(), 'flowmcp-cli-remove-test' )
        await mkdir( removeCwd, { recursive: true } )

        const { result: searchResult } = await FlowMcpCli.search( { query: 'ping testdemo' } )
        const pingTool = searchResult[ 'tools' ]
            .find( ( t ) => {
                const match = t[ 'name' ].includes( 'ping' ) && t[ 'namespace' ] === 'testdemo'

                return match
            } )

        await FlowMcpCli.add( { toolName: pingTool[ 'name' ], cwd: removeCwd } )

        const { result: listBefore } = await FlowMcpCli.list( { cwd: removeCwd } )

        expect( listBefore[ 'toolCount' ] ).toBeGreaterThan( 0 )

        const { result } = await FlowMcpCli.remove( { toolName: pingTool[ 'name' ], cwd: removeCwd } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'removed' ] ).toBe( pingTool[ 'name' ] )

        await rm( removeCwd, { recursive: true, force: true } )
    } )


    it( 'returns error for tool not in active list', async () => {
        const removeCwd = join( tmpdir(), 'flowmcp-cli-remove-notactive' )
        await mkdir( removeCwd, { recursive: true } )

        const { result: searchResult } = await FlowMcpCli.search( { query: 'ping testdemo' } )
        const pingTool = searchResult[ 'tools' ]
            .find( ( t ) => {
                const match = t[ 'name' ].includes( 'ping' ) && t[ 'namespace' ] === 'testdemo'

                return match
            } )

        await FlowMcpCli.add( { toolName: pingTool[ 'name' ], cwd: removeCwd } )

        const { result: searchResult2 } = await FlowMcpCli.search( { query: 'price cryptotest' } )
        const priceTool = searchResult2[ 'tools' ]
            .find( ( t ) => {
                const match = t[ 'name' ].includes( 'price' ) && t[ 'namespace' ] === 'cryptotest'

                return match
            } )

        expect( priceTool ).toBeDefined()

        const { result } = await FlowMcpCli.remove( { toolName: priceTool[ 'name' ], cwd: removeCwd } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'not in active tools' )

        await rm( removeCwd, { recursive: true, force: true } )
    } )
} )
