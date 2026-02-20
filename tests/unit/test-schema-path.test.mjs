import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const GLOBAL_SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
const TEST_BASE = join( tmpdir(), 'flowmcp-cli-test-schema-path' )
const SCHEMA_DIR = join( TEST_BASE, 'schemas' )
const ENV_PATH = join( TEST_BASE, '.env' )
const SOURCE_NAME = 'testsrc'
const SOURCE_DIR = join( GLOBAL_SCHEMAS_DIR, SOURCE_NAME )
const GROUP_CWD = join( TEST_BASE, 'group-cwd' )
const GROUP_LOCAL_CONFIG_DIR = join( GROUP_CWD, '.flowmcp' )
const GROUP_LOCAL_CONFIG_PATH = join( GROUP_LOCAL_CONFIG_DIR, 'config.json' )
const GROUP_ENV_CWD = join( TEST_BASE, 'group-env-cwd' )
const GROUP_ENV_LOCAL_CONFIG_DIR = join( GROUP_ENV_CWD, '.flowmcp' )
const GROUP_ENV_LOCAL_CONFIG_PATH = join( GROUP_ENV_LOCAL_CONFIG_DIR, 'config.json' )

let originalGlobalConfig = null
let globalConfigExisted = false

const VALID_SCHEMA_CONTENT = `export const main = {
    namespace: 'testpath',
    name: 'Test Path API',
    description: 'Schema for test path tests',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    routes: {
        ping: {
            method: 'GET',
            description: 'Ping',
            path: '/get',
            parameters: [],
            tests: [ { _description: 'Ping test' } ]
        }
    }
}
`

const ENV_REQUIRED_SCHEMA_CONTENT = `export const main = {
    namespace: 'testpathenv',
    name: 'Test Path Env API',
    description: 'Schema requiring env vars',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [ 'TEST_API_KEY' ],
    headers: {},
    routes: {
        ping: {
            method: 'GET',
            description: 'Ping',
            path: '/get',
            parameters: [],
            tests: [ { _description: 'Env ping test' } ]
        }
    }
}
`

const VALID_GLOBAL_CONFIG = {
    'envPath': ENV_PATH,
    'flowmcpCore': {
        'version': '2.0.0',
        'commit': 'abc123',
        'schemaSpec': '2.0.0'
    },
    'initialized': '2026-02-20T12:00:00.000Z',
    'sources': {
        [SOURCE_NAME]: {
            'type': 'local',
            'schemaCount': 1
        }
    }
}

const VALID_REGISTRY = {
    'name': SOURCE_NAME,
    'version': '1.0.0',
    'description': 'Test source for test schema path',
    'schemaSpec': '2.0.0',
    'schemas': [
        {
            'namespace': SOURCE_NAME,
            'file': 'api.mjs',
            'name': 'Test Path API',
            'requiredServerParams': []
        }
    ]
}

const ENV_REQUIRED_REGISTRY = {
    'name': 'testsrcenv',
    'version': '1.0.0',
    'description': 'Test source requiring env vars',
    'schemaSpec': '2.0.0',
    'schemas': [
        {
            'namespace': 'testsrcenv',
            'file': 'api.mjs',
            'name': 'Test Path Env API',
            'requiredServerParams': [ 'TEST_API_KEY' ]
        }
    ]
}

const GROUP_LOCAL_CONFIG = {
    'root': '~/.flowmcp',
    'defaultGroup': 'test-group',
    'groups': {
        'test-group': {
            'description': 'Test group for schema path tests',
            'tools': [
                `${SOURCE_NAME}/api.mjs::ping`
            ]
        }
    }
}

const GROUP_ENV_LOCAL_CONFIG = {
    'root': '~/.flowmcp',
    'defaultGroup': 'env-group',
    'groups': {
        'env-group': {
            'description': 'Group with env-required schema',
            'tools': [
                'testsrcenv/api.mjs::ping'
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

    await mkdir( GLOBAL_CONFIG_DIR, { recursive: true } )
    await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( VALID_GLOBAL_CONFIG, null, 4 ), 'utf-8' )

    await mkdir( SCHEMA_DIR, { recursive: true } )
    await writeFile( join( SCHEMA_DIR, 'valid.mjs' ), VALID_SCHEMA_CONTENT, 'utf-8' )
    await writeFile( join( SCHEMA_DIR, 'env-required.mjs' ), ENV_REQUIRED_SCHEMA_CONTENT, 'utf-8' )

    await writeFile( ENV_PATH, 'SOME_OTHER_KEY=hello\n', 'utf-8' )

    await mkdir( SOURCE_DIR, { recursive: true } )
    await writeFile( join( SOURCE_DIR, 'api.mjs' ), VALID_SCHEMA_CONTENT, 'utf-8' )
    await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( VALID_REGISTRY, null, 4 ), 'utf-8' )

    const envSourceDir = join( GLOBAL_SCHEMAS_DIR, 'testsrcenv' )
    await mkdir( envSourceDir, { recursive: true } )
    await writeFile( join( envSourceDir, 'api.mjs' ), ENV_REQUIRED_SCHEMA_CONTENT, 'utf-8' )
    await writeFile( join( envSourceDir, '_registry.json' ), JSON.stringify( ENV_REQUIRED_REGISTRY, null, 4 ), 'utf-8' )

    await mkdir( GROUP_LOCAL_CONFIG_DIR, { recursive: true } )
    await writeFile( GROUP_LOCAL_CONFIG_PATH, JSON.stringify( GROUP_LOCAL_CONFIG, null, 4 ), 'utf-8' )

    await mkdir( GROUP_ENV_LOCAL_CONFIG_DIR, { recursive: true } )
    await writeFile( GROUP_ENV_LOCAL_CONFIG_PATH, JSON.stringify( GROUP_ENV_LOCAL_CONFIG, null, 4 ), 'utf-8' )
} )


afterAll( async () => {
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    await rm( SOURCE_DIR, { recursive: true, force: true } )
    await rm( join( GLOBAL_SCHEMAS_DIR, 'testsrcenv' ), { recursive: true, force: true } )
    await rm( TEST_BASE, { recursive: true, force: true } )
} )


describe( 'FlowMcpCli.test with schemaPath', () => {
    it( 'executes tests for a single schema file', async () => {
        const schemaFile = join( SCHEMA_DIR, 'valid.mjs' )
        const { result } = await FlowMcpCli.test( {
            'schemaPath': schemaFile,
            'route': undefined,
            'cwd': TEST_BASE
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'total' ] ).toBeGreaterThanOrEqual( 1 )
        expect( result[ 'passed' ] ).toBeGreaterThanOrEqual( 1 )
        expect( result[ 'failed' ] ).toBe( 0 )
    }, 30000 )


    it( 'returns test results with route names', async () => {
        const schemaFile = join( SCHEMA_DIR, 'valid.mjs' )
        const { result } = await FlowMcpCli.test( {
            'schemaPath': schemaFile,
            'route': undefined,
            'cwd': TEST_BASE
        } )

        const { results } = result

        expect( Array.isArray( results ) ).toBe( true )
        expect( results.length ).toBeGreaterThanOrEqual( 1 )

        results
            .forEach( ( entry ) => {
                expect( entry ).toHaveProperty( 'namespace' )
                expect( entry ).toHaveProperty( 'routeName' )
                expect( entry ).toHaveProperty( 'status' )
                expect( entry[ 'namespace' ] ).toBe( 'testpath' )
                expect( entry[ 'routeName' ] ).toBe( 'ping' )
            } )
    }, 30000 )


    it( 'returns missing env vars error for schema with required params', async () => {
        const schemaFile = join( SCHEMA_DIR, 'env-required.mjs' )
        const { result } = await FlowMcpCli.test( {
            'schemaPath': schemaFile,
            'route': undefined,
            'cwd': TEST_BASE
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'Missing env vars' )
    } )


    it( 'returns error for non-existent schemaPath', async () => {
        const fakePath = join( TEST_BASE, 'does-not-exist.mjs' )
        const { result } = await FlowMcpCli.test( {
            'schemaPath': fakePath,
            'route': undefined,
            'cwd': TEST_BASE
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
    } )
} )


describe( 'FlowMcpCli.test with cwd group', () => {
    it( 'executes tests for default group schemas', async () => {
        const { result } = await FlowMcpCli.test( {
            'schemaPath': undefined,
            'route': undefined,
            'cwd': GROUP_CWD
        } )

        expect( result[ 'status' ] ).toBeDefined()
        expect( result[ 'total' ] ).toBeGreaterThanOrEqual( 1 )
        expect( result ).toHaveProperty( 'passed' )
        expect( result ).toHaveProperty( 'failed' )
        expect( result[ 'results' ] ).toBeDefined()
        expect( Array.isArray( result[ 'results' ] ) ).toBe( true )
        expect( result[ 'results' ].length ).toBeGreaterThanOrEqual( 1 )
    }, 30000 )


    it( 'returns error when group has missing env vars', async () => {
        const { result } = await FlowMcpCli.test( {
            'schemaPath': undefined,
            'route': undefined,
            'cwd': GROUP_ENV_CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'Missing env vars' )
    } )
} )
