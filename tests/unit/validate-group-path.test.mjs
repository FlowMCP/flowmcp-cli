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
const ENV_PATH = join( GLOBAL_CONFIG_DIR, '.env.vgpath' )
const SOURCE_NAME = 'valsrc'
const SOURCE_DIR = join( GLOBAL_SCHEMAS_DIR, SOURCE_NAME )

let originalGlobalConfig = null
let globalConfigExisted = false
let originalEnvContent = null
let envExisted = false

const VALID_SCHEMA_CONTENT = `export const main = {
    namespace: 'valsrc',
    name: 'Val Source API',
    description: 'Schema for validate group tests',
    version: '4.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    tools: {
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
    'schemaSpec': '4.0.0',
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
        'schemaSpec': '4.0.0'
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

    try {
        originalEnvContent = await readFile( ENV_PATH, 'utf-8' )
        envExisted = true
    } catch {
        envExisted = false
    }

    await mkdir( GLOBAL_CONFIG_DIR, { recursive: true } )

    if( globalConfigExisted && originalGlobalConfig ) {
        const parsed = JSON.parse( originalGlobalConfig )
        parsed[ 'sources' ] = parsed[ 'sources' ] || {}
        parsed[ 'sources' ][ SOURCE_NAME ] = VALID_GLOBAL_CONFIG[ 'sources' ][ SOURCE_NAME ]
        parsed[ 'envPath' ] = ENV_PATH
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( parsed, null, 4 ), 'utf-8' )
    } else {
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( VALID_GLOBAL_CONFIG, null, 4 ), 'utf-8' )
    }

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

    if( envExisted && originalEnvContent ) {
        await writeFile( ENV_PATH, originalEnvContent, 'utf-8' )
    } else {
        await rm( ENV_PATH, { force: true } ).catch( () => {} )
    }

    await rm( SOURCE_DIR, { recursive: true, force: true } ).catch( () => {} )
    await rm( TEST_CWD, { recursive: true, force: true } ).catch( () => {} )
} )


// Memo 152 / PRD-020 (D-12 / F18=A) — `schema-check`/validate no longer resolves a default
// group when no path is given; a schema path is required (no silent default). The --group flag
// is removed (groups -> named selections, Memo 099).
describe( 'FlowMcpCli.validate — no schema path (D-12)', () => {
    it( 'requires a schema path (no default-group fallback)', async () => {
        const { result } = await FlowMcpCli.validate( { schemaPath: undefined, cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ].join( ' ' ) ).toContain( 'Missing value' )
    } )


    it( 'validates a given schema path', async () => {
        const { result } = await FlowMcpCli.validate( { schemaPath: join( SOURCE_DIR, 'check.mjs' ), cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBeDefined()
        expect( result[ 'total' ] ).toBeGreaterThanOrEqual( 1 )
        expect( result[ 'passed' ] + result[ 'failed' ] ).toBe( result[ 'total' ] )
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
