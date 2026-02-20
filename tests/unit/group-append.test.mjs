import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )

let originalGlobalConfig = null
let globalConfigExisted = false

const DEMO_SCHEMA = `export const main = {
    namespace: 'appendtest',
    name: 'Append Test API',
    description: 'Schema for group append tests',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    routes: {
        routeA: {
            method: 'GET',
            description: 'Route A',
            path: '/a',
            parameters: []
        },
        routeB: {
            method: 'GET',
            description: 'Route B',
            path: '/b',
            parameters: []
        }
    }
}
`

const TEST_GLOBAL_CONFIG = {
    'envPath': '/tmp/test.env',
    'flowmcpCore': {
        'version': '2.0.0',
        'commit': 'abc123',
        'schemaSpec': '2.0.0'
    },
    'initialized': '2026-02-20T12:00:00.000Z',
    'sources': {
        'appendsrc': { 'type': 'builtin', 'schemaCount': 1 }
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

    const schemaDir = join( SCHEMAS_DIR, 'appendsrc' )
    await mkdir( schemaDir, { recursive: true } )
    await writeFile( join( schemaDir, 'test.mjs' ), DEMO_SCHEMA, 'utf-8' )
} )

afterAll( async () => {
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    await rm( join( SCHEMAS_DIR, 'appendsrc' ), { recursive: true, force: true } )
} )


describe( 'FlowMcpCli.groupAppend', () => {
    it( 'creates a new group when no local config exists', async () => {
        const cwd = join( tmpdir(), 'flowmcp-group-append-new' )
        await mkdir( cwd, { recursive: true } )

        const { result } = await FlowMcpCli.groupAppend( {
            name: 'my-group',
            tools: 'appendsrc/test.mjs::routeA',
            cwd
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'group' ] ).toBe( 'my-group' )
        expect( result[ 'toolCount' ] ).toBe( 1 )
        expect( result[ 'added' ] ).toHaveLength( 1 )
        expect( result[ 'isDefault' ] ).toBe( true )

        const configRaw = await readFile( join( cwd, '.flowmcp', 'config.json' ), 'utf-8' )
        const config = JSON.parse( configRaw )

        expect( config[ 'groups' ][ 'my-group' ] ).toBeDefined()
        expect( config[ 'groups' ][ 'my-group' ][ 'tools' ] ).toContain( 'appendsrc/test.mjs::routeA' )
        expect( config[ 'defaultGroup' ] ).toBe( 'my-group' )

        await rm( cwd, { recursive: true, force: true } )
    } )


    it( 'appends tools to an existing group', async () => {
        const cwd = join( tmpdir(), 'flowmcp-group-append-existing' )
        const configDir = join( cwd, '.flowmcp' )
        await mkdir( configDir, { recursive: true } )

        const existingConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'existing',
            'groups': {
                'existing': {
                    'description': '',
                    'tools': [ 'appendsrc/test.mjs::routeA' ]
                }
            }
        }

        await writeFile(
            join( configDir, 'config.json' ),
            JSON.stringify( existingConfig, null, 4 ),
            'utf-8'
        )

        const { result } = await FlowMcpCli.groupAppend( {
            name: 'existing',
            tools: 'appendsrc/test.mjs::routeB',
            cwd
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolCount' ] ).toBe( 2 )
        expect( result[ 'added' ] ).toHaveLength( 1 )
        expect( result[ 'added' ][ 0 ] ).toBe( 'appendsrc/test.mjs::routeB' )

        await rm( cwd, { recursive: true, force: true } )
    } )


    it( 'does not duplicate already existing tools', async () => {
        const cwd = join( tmpdir(), 'flowmcp-group-append-dup' )
        const configDir = join( cwd, '.flowmcp' )
        await mkdir( configDir, { recursive: true } )

        const existingConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'dup-test',
            'groups': {
                'dup-test': {
                    'description': '',
                    'tools': [ 'appendsrc/test.mjs::routeA' ]
                }
            }
        }

        await writeFile(
            join( configDir, 'config.json' ),
            JSON.stringify( existingConfig, null, 4 ),
            'utf-8'
        )

        const { result } = await FlowMcpCli.groupAppend( {
            name: 'dup-test',
            tools: 'appendsrc/test.mjs::routeA',
            cwd
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolCount' ] ).toBe( 1 )
        expect( result[ 'added' ] ).toHaveLength( 0 )

        await rm( cwd, { recursive: true, force: true } )
    } )


    it( 'accepts multiple comma-separated tools', async () => {
        const cwd = join( tmpdir(), 'flowmcp-group-append-multi' )
        await mkdir( cwd, { recursive: true } )

        const { result } = await FlowMcpCli.groupAppend( {
            name: 'multi-group',
            tools: 'appendsrc/test.mjs::routeA, appendsrc/test.mjs::routeB',
            cwd
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolCount' ] ).toBe( 2 )
        expect( result[ 'tools' ] ).toContain( 'appendsrc/test.mjs::routeA' )
        expect( result[ 'tools' ] ).toContain( 'appendsrc/test.mjs::routeB' )

        await rm( cwd, { recursive: true, force: true } )
    } )


    it( 'returns error for non-existent schema references', async () => {
        const cwd = join( tmpdir(), 'flowmcp-group-append-invalid' )
        await mkdir( cwd, { recursive: true } )

        const { result } = await FlowMcpCli.groupAppend( {
            name: 'invalid-group',
            tools: 'nonexistent/schema.mjs::someRoute',
            cwd
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'not found' )

        await rm( cwd, { recursive: true, force: true } )
    } )


    it( 'returns error for invalid route name in existing schema', async () => {
        const cwd = join( tmpdir(), 'flowmcp-group-append-badroute' )
        await mkdir( cwd, { recursive: true } )

        const { result } = await FlowMcpCli.groupAppend( {
            name: 'badroute-group',
            tools: 'appendsrc/test.mjs::nonexistentRoute',
            cwd
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'not found' )

        await rm( cwd, { recursive: true, force: true } )
    } )
} )
