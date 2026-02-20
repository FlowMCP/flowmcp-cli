import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
const TEST_CWD = join( tmpdir(), 'flowmcp-cli-call-list-tools-test' )

let originalGlobalConfig = null
let globalConfigExisted = false

const CALL_SCHEMA_CONTENT = `export const main = {
    namespace: 'callapi',
    name: 'Call Test API',
    description: 'Schema for callListTools tests',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    routes: {
        getStatus: {
            method: 'GET',
            description: 'Get status',
            path: '/get',
            parameters: []
        },
        postData: {
            method: 'POST',
            description: 'Post data',
            path: '/post',
            parameters: []
        }
    }
}
`

const TEST_REGISTRY = {
    'name': 'callsrc',
    'version': '1.0.0',
    'description': 'Test registry for call commands',
    'schemaSpec': '2.0.0',
    'baseDir': 'schemas/v2.0.0',
    'schemas': [
        {
            'namespace': 'callapi',
            'file': 'api.mjs',
            'name': 'Call Test API',
            'requiredServerParams': []
        }
    ]
}

const TEST_GLOBAL_CONFIG = {
    'envPath': join( TEST_CWD, '.env' ),
    'flowmcpCore': {
        'version': '2.0.0',
        'commit': 'abc123def',
        'schemaSpec': '2.0.0'
    },
    'initialized': '2026-02-20T12:00:00.000Z',
    'sources': {
        'callsrc': {
            'type': 'builtin',
            'schemaCount': 1
        }
    }
}

const TEST_LOCAL_CONFIG = {
    'root': '~/.flowmcp',
    'defaultGroup': 'test-group',
    'groups': {
        'test-group': {
            'description': 'Test group',
            'tools': [
                'callsrc/api.mjs::getStatus',
                'callsrc/api.mjs::postData'
            ]
        },
        'named-group': {
            'description': 'Named group',
            'tools': [
                'callsrc/api.mjs::getStatus'
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
    await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( TEST_GLOBAL_CONFIG, null, 4 ), 'utf-8' )

    const callsrcDir = join( SCHEMAS_DIR, 'callsrc' )
    await mkdir( callsrcDir, { recursive: true } )

    await writeFile(
        join( callsrcDir, '_registry.json' ),
        JSON.stringify( TEST_REGISTRY, null, 4 ),
        'utf-8'
    )

    await writeFile( join( callsrcDir, 'api.mjs' ), CALL_SCHEMA_CONTENT, 'utf-8' )

    const localConfigDir = join( TEST_CWD, '.flowmcp' )
    await mkdir( localConfigDir, { recursive: true } )
    await writeFile(
        join( localConfigDir, 'config.json' ),
        JSON.stringify( TEST_LOCAL_CONFIG, null, 4 ),
        'utf-8'
    )

    await writeFile( join( TEST_CWD, '.env' ), 'TEST_KEY=abc123\n', 'utf-8' )
} )


afterAll( async () => {
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    await rm( join( SCHEMAS_DIR, 'callsrc' ), { recursive: true, force: true } )
    await rm( TEST_CWD, { recursive: true, force: true } )
} )


describe( 'FlowMcpCli.callListTools', () => {
    it( 'returns tools for the default group', async () => {
        const { result } = await FlowMcpCli.callListTools( { group: undefined, cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolCount' ] ).toBe( 2 )
        expect( result[ 'tools' ].length ).toBe( 2 )

        const toolNames = result[ 'tools' ]
            .map( ( tool ) => {
                const name = tool[ 'toolName' ]

                return name
            } )

        expect( toolNames ).toContain( 'get_status_callapi' )
        expect( toolNames ).toContain( 'post_data_callapi' )
    } )


    it( 'returns correct tool metadata', async () => {
        const { result } = await FlowMcpCli.callListTools( { group: undefined, cwd: TEST_CWD } )

        const getStatusTool = result[ 'tools' ]
            .find( ( tool ) => {
                const isGetStatus = tool[ 'toolName' ] === 'get_status_callapi'

                return isGetStatus
            } )

        expect( getStatusTool ).toBeDefined()
        expect( getStatusTool[ 'namespace' ] ).toBe( 'callapi' )
        expect( getStatusTool[ 'routeName' ] ).toBe( 'getStatus' )
        expect( getStatusTool[ 'description' ] ).toBe( 'Get status' )
    } )


    it( 'returns tools for a named group', async () => {
        const { result } = await FlowMcpCli.callListTools( { group: 'named-group', cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'group' ] ).toBe( 'named-group' )
        expect( result[ 'toolCount' ] ).toBe( 1 )
        expect( result[ 'tools' ].length ).toBe( 1 )
        expect( result[ 'tools' ][ 0 ][ 'toolName' ] ).toBe( 'get_status_callapi' )
    } )


    it( 'returns error when env file is missing', async () => {
        const noEnvCwd = join( tmpdir(), 'flowmcp-cli-call-no-env-test' )
        const noEnvLocalDir = join( noEnvCwd, '.flowmcp' )
        await mkdir( noEnvLocalDir, { recursive: true } )

        const noEnvGlobalConfig = {
            ...TEST_GLOBAL_CONFIG,
            'envPath': join( noEnvCwd, 'nonexistent.env' )
        }

        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( noEnvGlobalConfig, null, 4 ), 'utf-8' )
        await writeFile(
            join( noEnvLocalDir, 'config.json' ),
            JSON.stringify( TEST_LOCAL_CONFIG, null, 4 ),
            'utf-8'
        )

        const { result } = await FlowMcpCli.callListTools( { group: undefined, cwd: noEnvCwd } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Cannot read .env file' )

        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( TEST_GLOBAL_CONFIG, null, 4 ), 'utf-8' )
        await rm( noEnvCwd, { recursive: true, force: true } )
    } )
} )


describe( 'FlowMcpCli.callTool', () => {
    it( 'returns error for missing tool name', async () => {
        const { result } = await FlowMcpCli.callTool( { toolName: undefined, jsonArgs: undefined, group: undefined, cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Missing tool name' )
    } )


    it( 'returns error when no local config exists', async () => {
        const emptyCwd = join( tmpdir(), 'flowmcp-cli-call-empty-cwd' )
        await mkdir( emptyCwd, { recursive: true } )

        const { result } = await FlowMcpCli.callTool( { toolName: 'get_status_callapi', jsonArgs: undefined, group: undefined, cwd: emptyCwd } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()

        await rm( emptyCwd, { recursive: true, force: true } )
    } )


    it( 'returns error for non-existent tool name', async () => {
        const { result } = await FlowMcpCli.callTool( { toolName: 'nonexistent_tool_xyz', jsonArgs: undefined, group: undefined, cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'not found' )
    } )


    it( 'returns error for invalid JSON args', async () => {
        const { result } = await FlowMcpCli.callTool( { toolName: 'get_status_callapi', jsonArgs: '{invalid json', group: undefined, cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Invalid JSON' )
    } )
} )


describe( 'FlowMcpCli.schemas', () => {
    it( 'returns sources list with callsrc', async () => {
        const { result } = await FlowMcpCli.schemas()

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'sources' ] ).toBeDefined()

        const callSource = result[ 'sources' ]
            .find( ( source ) => {
                const isCallSrc = source[ 'name' ] === 'callsrc'

                return isCallSrc
            } )

        expect( callSource ).toBeDefined()
        expect( callSource[ 'type' ] ).toBe( 'builtin' )
    } )
} )
