import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )

let originalGlobalConfig = null
let globalConfigExisted = false

const SCHEMA_CONTENT = `export const main = {
    namespace: 'healthTest',
    name: 'Health Test API',
    description: 'Schema for health check tests',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [ 'HEALTH_KEY' ],
    headers: {},
    routes: {
        check: { method: 'GET', description: 'Check', path: '/get', parameters: [] }
    }
}
`

const TEST_REGISTRY = {
    'name': 'healthsrc',
    'version': '1.0.0',
    'description': 'Health test registry',
    'schemaSpec': '2.0.0',
    'schemas': [
        {
            'namespace': 'healthTest',
            'file': 'health/check.mjs',
            'name': 'Health Test API',
            'requiredServerParams': [ 'HEALTH_KEY' ]
        }
    ]
}


beforeAll( async () => {
    try {
        originalGlobalConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        globalConfigExisted = true
    } catch {
        globalConfigExisted = false
    }
} )

afterAll( async () => {
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    await rm( join( SCHEMAS_DIR, 'healthsrc' ), { recursive: true, force: true } )
} )


describe( 'FlowMcpCli.status with full health checks', () => {
    it( 'reports global config, env, schemas, and local config checks', async () => {
        const testCwd = join( tmpdir(), 'flowmcp-health-full' )
        const envPath = join( testCwd, '.env' )
        await mkdir( testCwd, { recursive: true } )
        await writeFile( envPath, 'HEALTH_KEY=test-value\n', 'utf-8' )

        const healthSchemaDir = join( SCHEMAS_DIR, 'healthsrc', 'health' )
        await mkdir( healthSchemaDir, { recursive: true } )
        await writeFile( join( healthSchemaDir, 'check.mjs' ), SCHEMA_CONTENT, 'utf-8' )
        await writeFile(
            join( SCHEMAS_DIR, 'healthsrc', '_registry.json' ),
            JSON.stringify( TEST_REGISTRY, null, 4 ),
            'utf-8'
        )

        const config = {
            'envPath': envPath,
            'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc', 'schemaSpec': '2.0.0' },
            'initialized': '2026-02-20T12:00:00.000Z',
            'sources': {
                'healthsrc': { 'type': 'github', 'schemaCount': 1 }
            }
        }

        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( config, null, 4 ), 'utf-8' )

        const localConfigDir = join( testCwd, '.flowmcp' )
        await mkdir( localConfigDir, { recursive: true } )
        await writeFile(
            join( localConfigDir, 'config.json' ),
            JSON.stringify( {
                'root': '~/.flowmcp',
                'defaultGroup': 'health-group',
                'groups': {
                    'health-group': {
                        'description': 'Health test group',
                        'tools': [ 'healthsrc/health/check.mjs::check' ]
                    }
                }
            }, null, 4 ),
            'utf-8'
        )

        const { result } = await FlowMcpCli.status( { cwd: testCwd } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'config' ] ).toBeDefined()
        expect( result[ 'config' ][ 'envPath' ] ).toBe( envPath )
        expect( result[ 'config' ][ 'flowmcpCore' ][ 'version' ] ).toBe( '2.0.0' )
        expect( result[ 'config' ] ).toHaveProperty( 'envExists' )

        await rm( testCwd, { recursive: true, force: true } )
    } )


    it( 'reports missing env file', async () => {
        const testCwd = join( tmpdir(), 'flowmcp-health-noenv' )
        await mkdir( testCwd, { recursive: true } )

        const config = {
            'envPath': join( testCwd, 'nonexistent.env' ),
            'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc', 'schemaSpec': '2.0.0' },
            'initialized': '2026-02-20T12:00:00.000Z'
        }

        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( config, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.status( { cwd: testCwd } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'config' ][ 'envExists' ] ).toBe( false )

        await rm( testCwd, { recursive: true, force: true } )
    } )


    it( 'works when env file exists', async () => {
        const testCwd = join( tmpdir(), 'flowmcp-health-envexists' )
        const envPath = join( testCwd, '.env' )
        await mkdir( testCwd, { recursive: true } )
        await writeFile( envPath, 'KEY=value\n', 'utf-8' )

        const config = {
            'envPath': envPath,
            'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc', 'schemaSpec': '2.0.0' },
            'initialized': '2026-02-20T12:00:00.000Z'
        }

        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( config, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.status( { cwd: testCwd } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'config' ][ 'envExists' ] ).toBe( true )

        await rm( testCwd, { recursive: true, force: true } )
    } )
} )


describe( 'FlowMcpCli.help', () => {
    it( 'returns help result', async () => {
        const cwd = join( tmpdir(), 'flowmcp-help-test' )
        await mkdir( cwd, { recursive: true } )

        const config = {
            'envPath': '/tmp/test.env',
            'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc', 'schemaSpec': '2.0.0' },
            'initialized': '2026-02-20T12:00:00.000Z'
        }

        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( config, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.help( { cwd } )

        expect( result[ 'status' ] ).toBe( true )

        await rm( cwd, { recursive: true, force: true } )
    } )
} )
