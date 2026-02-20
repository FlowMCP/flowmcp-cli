import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const GLOBAL_SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
const TEST_CWD = join( tmpdir(), 'flowmcp-cli-validate-group-path' )
const LOCAL_CONFIG_DIR = join( TEST_CWD, '.flowmcp' )
const LOCAL_CONFIG_PATH = join( LOCAL_CONFIG_DIR, 'config.json' )
const ENV_PATH = join( GLOBAL_CONFIG_DIR, '.env' )
const SOURCE_NAME = 'valsrc'
const SOURCE_DIR = join( GLOBAL_SCHEMAS_DIR, SOURCE_NAME )

let originalGlobalConfig = null
let globalConfigExisted = false

const VALID_SCHEMA_CONTENT = `export const main = {
    namespace: 'valsrc',
    name: 'Val Source API',
    description: 'Schema for validate group tests',
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
            parameters: []
        }
    }
}
`

const VALID_REGISTRY = {
    'name': SOURCE_NAME,
    'version': '1.0.0',
    'description': 'Test source for validate group path',
    'schemaSpec': '2.0.0',
    'schemas': [
        {
            'namespace': SOURCE_NAME,
            'file': 'check.mjs',
            'name': 'Val Source API',
            'requiredServerParams': []
        }
    ]
}

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

const VALID_LOCAL_CONFIG = {
    'root': '~/.flowmcp',
    'defaultGroup': 'test-group',
    'groups': {
        'test-group': {
            'description': 'Test group for validate',
            'tools': [
                `${SOURCE_NAME}/check.mjs::ping`
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

    await mkdir( SOURCE_DIR, { recursive: true } )
    await writeFile( join( SOURCE_DIR, 'check.mjs' ), VALID_SCHEMA_CONTENT, 'utf-8' )
    await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( VALID_REGISTRY, null, 4 ), 'utf-8' )

    await writeFile( ENV_PATH, 'TEST_KEY=abc\n', 'utf-8' )

    await mkdir( LOCAL_CONFIG_DIR, { recursive: true } )
    await writeFile( LOCAL_CONFIG_PATH, JSON.stringify( VALID_LOCAL_CONFIG, null, 4 ), 'utf-8' )
} )

afterAll( async () => {
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    await rm( SOURCE_DIR, { recursive: true, force: true } )
    await rm( TEST_CWD, { recursive: true, force: true } )
} )


describe( 'FlowMcpCli.validate with cwd (group resolution path)', () => {
    it( 'resolves default group and returns validation results', async () => {
        const { result } = await FlowMcpCli.validate( { schemaPath: undefined, cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBeDefined()
        expect( result[ 'total' ] ).toBeGreaterThanOrEqual( 1 )
        expect( result ).toHaveProperty( 'passed' )
        expect( result ).toHaveProperty( 'failed' )
        expect( result[ 'passed' ] + result[ 'failed' ] ).toBe( result[ 'total' ] )
    } )


    it( 'returns error when cwd has no local config', async () => {
        const emptyCwd = join( tmpdir(), 'flowmcp-cli-validate-group-noconfig' )
        await mkdir( emptyCwd, { recursive: true } )

        const { result } = await FlowMcpCli.validate( { schemaPath: undefined, cwd: emptyCwd } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'No default group set' )

        await rm( emptyCwd, { recursive: true, force: true } )
    } )
} )


describe( 'FlowMcpCli.import validation error paths', () => {
    it( 'returns status false for undefined url', async () => {
        const { result } = await FlowMcpCli.import( { url: undefined, branch: 'main' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
        expect( result[ 'messages' ].length ).toBeGreaterThan( 0 )
    } )


    it( 'returns status false for non-GitHub url', async () => {
        const { result } = await FlowMcpCli.import( { url: 'https://gitlab.com/test/repo', branch: 'main' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
        expect( result[ 'messages' ][ 0 ] ).toContain( 'GitHub' )
    } )


    it( 'returns status false for non-string url', async () => {
        const { result } = await FlowMcpCli.import( { url: 42, branch: 'main' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
        expect( result[ 'messages' ].length ).toBeGreaterThan( 0 )
    } )
} )


describe( 'FlowMcpCli.importRegistry validation error paths', () => {
    it( 'returns status false for undefined registryUrl', async () => {
        const { result } = await FlowMcpCli.importRegistry( { registryUrl: undefined } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
        expect( result[ 'messages' ].length ).toBeGreaterThan( 0 )
    } )


    it( 'returns status false for non-string registryUrl', async () => {
        const { result } = await FlowMcpCli.importRegistry( { registryUrl: 42 } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
        expect( result[ 'messages' ].length ).toBeGreaterThan( 0 )
    } )
} )


describe( 'FlowMcpCli.update validation error paths', () => {
    it( 'returns status false for non-string sourceName', async () => {
        const { result } = await FlowMcpCli.update( { sourceName: 42 } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
        expect( result[ 'messages' ].length ).toBeGreaterThan( 0 )
    } )


    it( 'returns status false for empty sourceName', async () => {
        const { result } = await FlowMcpCli.update( { sourceName: '' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
        expect( result[ 'messages' ].length ).toBeGreaterThan( 0 )
    } )
} )


describe( 'FlowMcpCli.schemas', () => {
    it( 'returns status true with sources', async () => {
        const { result } = await FlowMcpCli.schemas()

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'sources' ] ).toBeDefined()
        expect( Array.isArray( result[ 'sources' ] ) ).toBe( true )
    } )
} )
