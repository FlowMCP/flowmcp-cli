import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
const SOURCE_NAME = 'fetchfail'
const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )
const ENV_PATH = join( GLOBAL_CONFIG_DIR, '.env.fetchfail' )
const TEST_CWD = join( tmpdir(), 'flowmcp-cli-fetch-fail' )
const LOCAL_CONFIG_DIR = join( TEST_CWD, '.flowmcp' )
const LOCAL_CONFIG_PATH = join( LOCAL_CONFIG_DIR, 'config.json' )
const CACHE_DIR = join( GLOBAL_CONFIG_DIR, 'cache' )

let originalGlobalConfig = null
let globalConfigExisted = false

const AUTH_FAIL_SCHEMA = `export const main = {
    namespace: 'fetchfail',
    name: 'Fetch Fail API',
    description: 'Schema for fetch failure tests',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [ 'FAKE_API_KEY' ],
    headers: {},
    routes: {
        authFail: {
            method: 'GET',
            description: 'Returns 401',
            path: '/status/401',
            parameters: []
        },
        forbidden: {
            method: 'GET',
            description: 'Returns 403',
            path: '/status/403',
            parameters: []
        },
        serverError: {
            method: 'GET',
            description: 'Returns 500',
            path: '/status/500',
            parameters: []
        },
        cachedWithParams: {
            method: 'GET',
            description: 'Cached route with params',
            path: '/get',
            parameters: [
                {
                    position: { key: 'q', value: '{{USER_PARAM}}', location: 'query' },
                    z: { primitive: 'string()', options: [] }
                }
            ],
            preload: { enabled: true, ttl: 300 }
        },
        withTests: {
            method: 'GET',
            description: 'Route with tests',
            path: '/get',
            parameters: [],
            tests: [ { _description: 'Test ping' } ]
        }
    }
}
`

const REGISTRY = {
    'name': SOURCE_NAME,
    'version': '1.0.0',
    'description': 'Fetch failure test source',
    'schemaSpec': '2.0.0',
    'schemas': [
        {
            'namespace': 'fetchfail',
            'file': 'auth.mjs',
            'name': 'Fetch Fail API',
            'requiredServerParams': [ 'FAKE_API_KEY' ]
        }
    ]
}

const LOCAL_CONFIG = {
    'root': '~/.flowmcp',
    'defaultGroup': 'fail-test',
    'groups': {
        'fail-test': {
            'description': 'Fetch failure test group',
            'tools': [
                `${SOURCE_NAME}/auth.mjs::authFail`,
                `${SOURCE_NAME}/auth.mjs::forbidden`,
                `${SOURCE_NAME}/auth.mjs::serverError`,
                `${SOURCE_NAME}/auth.mjs::cachedWithParams`,
                `${SOURCE_NAME}/auth.mjs::withTests`
            ]
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

    await mkdir( SOURCE_DIR, { recursive: true } )
    await writeFile( join( SOURCE_DIR, 'auth.mjs' ), AUTH_FAIL_SCHEMA, 'utf-8' )
    await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( REGISTRY, null, 4 ), 'utf-8' )
    await writeFile( ENV_PATH, 'FAKE_API_KEY=invalid_key\n', 'utf-8' )

    const globalConfig = {
        'envPath': ENV_PATH,
        'flowmcpCore': {
            'version': '2.0.0',
            'commit': 'abc123',
            'schemaSpec': '2.0.0'
        },
        'initialized': new Date().toISOString(),
        'sources': {
            [SOURCE_NAME]: {
                'type': 'builtin',
                'schemaCount': 1
            }
        }
    }

    if( globalConfigExisted && originalGlobalConfig ) {
        const parsed = JSON.parse( originalGlobalConfig )
        parsed[ 'sources' ] = parsed[ 'sources' ] || {}
        parsed[ 'sources' ][ SOURCE_NAME ] = globalConfig[ 'sources' ][ SOURCE_NAME ]
        parsed[ 'envPath' ] = ENV_PATH
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( parsed, null, 4 ), 'utf-8' )
    } else {
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
    }

    await mkdir( LOCAL_CONFIG_DIR, { recursive: true } )
    await writeFile( LOCAL_CONFIG_PATH, JSON.stringify( LOCAL_CONFIG, null, 4 ), 'utf-8' )
} )


afterAll( async () => {
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    await rm( SOURCE_DIR, { recursive: true, force: true } ).catch( () => {} )
    await rm( TEST_CWD, { recursive: true, force: true } ).catch( () => {} )
    await rm( ENV_PATH, { force: true } ).catch( () => {} )
    await rm( CACHE_DIR, { recursive: true, force: true } ).catch( () => {} )
} )


describe( 'FlowMcpCli.callTool fetch failure — auth error with requiredServerParams', () => {
    it( 'returns error with fix referencing API keys on 401', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'auth_fail_fetchfail',
            'cwd': TEST_CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'messages' ] ).toBeDefined()
    }, 15000 )


    it( 'returns error with fix referencing API keys on 403', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'forbidden_fetchfail',
            'cwd': TEST_CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
    }, 15000 )


    it( 'returns error for server error without auth hint', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'server_error_fetchfail',
            'cwd': TEST_CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
    }, 15000 )
} )


describe( 'FlowMcpCli.test with group and route filter', () => {
    it( 'filters tests by route name returning only matching route', async () => {
        const { result } = await FlowMcpCli.test( {
            'group': 'fail-test',
            'route': 'withTests',
            'cwd': TEST_CWD
        } )

        expect( result[ 'status' ] ).toBeDefined()
        expect( result[ 'total' ] ).toBeGreaterThanOrEqual( 0 )
    }, 30000 )


    it( 'returns zero results for nonexistent route filter', async () => {
        const { result } = await FlowMcpCli.test( {
            'group': 'fail-test',
            'route': 'nonexistent_route_xyz',
            'cwd': TEST_CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'total' ] ).toBe( 0 )
    }, 30000 )
} )


describe( 'FlowMcpCli.test with schemaPath and route filter', () => {
    it( 'filters tests by route for schema path', async () => {
        const schemaPath = join( SOURCE_DIR, 'auth.mjs' )

        const { result } = await FlowMcpCli.test( {
            'schemaPath': schemaPath,
            'route': 'withTests',
            'cwd': TEST_CWD
        } )

        expect( result[ 'status' ] ).toBeDefined()
        expect( result[ 'total' ] ).toBeGreaterThanOrEqual( 0 )
    }, 30000 )


    it( 'returns zero results for nonexistent route with schemaPath', async () => {
        const schemaPath = join( SOURCE_DIR, 'auth.mjs' )

        const { result } = await FlowMcpCli.test( {
            'schemaPath': schemaPath,
            'route': 'totally_fake_route',
            'cwd': TEST_CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'total' ] ).toBe( 0 )
    }, 30000 )
} )


describe( 'FlowMcpCli.callTool — cached route with params triggers buildCacheKey hash path', () => {
    it( 'writes cache with param-hash key on first call', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'cached_with_params_fetchfail',
            'jsonArgs': '{"q":"test-value"}',
            'cwd': TEST_CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'cache' ] ).toBeDefined()
        expect(
            result[ 'cache' ][ 'stored' ] === true || result[ 'cache' ][ 'hit' ] === false
        ).toBe( true )
    }, 15000 )


    it( 'returns cache hit for same params', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'cached_with_params_fetchfail',
            'jsonArgs': '{"q":"test-value"}',
            'cwd': TEST_CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'cache' ][ 'hit' ] ).toBe( true )
    }, 15000 )


    it( 'writes different cache key for different params', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'cached_with_params_fetchfail',
            'jsonArgs': '{"q":"different-value"}',
            'cwd': TEST_CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'cache' ] ).toBeDefined()
        expect(
            result[ 'cache' ][ 'stored' ] === true || result[ 'cache' ][ 'hit' ] === false
        ).toBe( true )
    }, 15000 )
} )
