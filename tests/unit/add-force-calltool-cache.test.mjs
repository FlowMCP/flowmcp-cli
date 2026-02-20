import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
const SOURCE_NAME = 'forcesrc'
const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )
const ENV_FILE_PATH = join( GLOBAL_CONFIG_DIR, '.env.forcetest' )

let originalGlobalConfig = null


beforeAll( async () => {
    if( existsSync( GLOBAL_CONFIG_PATH ) ) {
        originalGlobalConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
    }

    await mkdir( SOURCE_DIR, { recursive: true } )

    const simpleSchema = `export const main = {
    namespace: 'forcesimple',
    name: 'Force Simple API',
    description: 'Simple schema for force add tests',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    routes: {
        ping: {
            method: 'GET',
            description: 'Ping endpoint',
            path: '/get',
            parameters: []
        }
    }
}
`

    const paramsSchema = `export const main = {
    namespace: 'forceparams',
    name: 'Force Params API',
    description: 'Schema with parameters for force tests',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    routes: {
        getData: {
            method: 'GET',
            description: 'Get data with required param',
            path: '/get',
            parameters: [
                {
                    position: { key: 'query', value: '{{USER_PARAM}}', location: 'query' },
                    z: { primitive: 'string()', options: [] }
                }
            ]
        }
    }
}
`

    const registry = {
        'name': 'forcesrc',
        'version': '1.0.0',
        'description': 'Test source for force tests',
        'schemaSpec': '2.0.0',
        'schemas': [
            { 'namespace': 'forcesimple', 'file': 'simple.mjs', 'name': 'Force Simple API', 'requiredServerParams': [] },
            { 'namespace': 'forceparams', 'file': 'params.mjs', 'name': 'Force Params API', 'requiredServerParams': [] }
        ]
    }

    await writeFile( join( SOURCE_DIR, 'simple.mjs' ), simpleSchema, 'utf-8' )
    await writeFile( join( SOURCE_DIR, 'params.mjs' ), paramsSchema, 'utf-8' )
    await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( registry, null, 4 ), 'utf-8' )
    await writeFile( ENV_FILE_PATH, 'FORCE_TEST=true\n', 'utf-8' )

    const globalConfig = {
        'envPath': ENV_FILE_PATH,
        'flowmcpCore': {
            'version': '2.0.0',
            'commit': 'abc123',
            'schemaSpec': '2.0.0'
        },
        'initialized': new Date().toISOString(),
        'sources': {
            'forcesrc': {
                'type': 'builtin',
                'schemaCount': 2
            }
        }
    }

    if( originalGlobalConfig ) {
        const parsed = JSON.parse( originalGlobalConfig )
        parsed[ 'sources' ] = parsed[ 'sources' ] || {}
        parsed[ 'sources' ][ 'forcesrc' ] = globalConfig[ 'sources' ][ 'forcesrc' ]
        parsed[ 'envPath' ] = ENV_FILE_PATH
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( parsed, null, 4 ), 'utf-8' )
    } else {
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
    }
} )


afterAll( async () => {
    if( originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    await rm( SOURCE_DIR, { recursive: true, force: true } ).catch( () => {} )
    await rm( ENV_FILE_PATH, { force: true } ).catch( () => {} )
} )


describe( 'FlowMcpCli.add with force', () => {
    const CWD = join( tmpdir(), `flowmcp-force-add-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )
    } )


    afterAll( async () => {
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    test( 'force-adds a tool that is already active', async () => {
        const firstAdd = await FlowMcpCli.add( {
            'toolName': 'ping_forcesimple',
            'cwd': CWD
        } )
        const firstResult = firstAdd[ 'result' ]

        expect( firstResult[ 'status' ] ).toBe( true )
        expect( firstResult[ 'added' ] ).toBe( 'ping_forcesimple' )

        const forceAdd = await FlowMcpCli.add( {
            'toolName': 'ping_forcesimple',
            'cwd': CWD,
            'force': true
        } )
        const forceResult = forceAdd[ 'result' ]

        expect( forceResult[ 'status' ] ).toBe( true )
        expect( forceResult[ 'message' ] ).toContain( 'reloaded' )
    } )


    test( 'force-adds and returns updated parameters', async () => {
        const { result } = await FlowMcpCli.add( {
            'toolName': 'get_data_forceparams',
            'cwd': CWD,
            'force': true
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'parameters' ] ).toBeDefined()
        expect( result[ 'parameters' ][ 'query' ] ).toBeDefined()
        expect( result[ 'parameters' ][ 'query' ][ 'type' ] ).toBe( 'string' )
        expect( result[ 'parameters' ][ 'query' ][ 'required' ] ).toBe( true )
    } )
} )


describe( 'FlowMcpCli.callTool error paths', () => {
    const CWD = join( tmpdir(), `flowmcp-calltool-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'default',
            'groups': {
                'default': {
                    'tools': [
                        'forcesrc/simple.mjs::ping',
                        'forcesrc/params.mjs::getData'
                    ]
                }
            }
        }

        await writeFile(
            join( CWD, '.flowmcp', 'config.json' ),
            JSON.stringify( localConfig, null, 4 ),
            'utf-8'
        )
    } )


    afterAll( async () => {
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    test( 'returns error for missing tool name', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': undefined,
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Missing tool name' )
    } )


    test( 'returns error for tool not found in active tools', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'nonexistent_tool',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'not found' )
    } )


    test( 'returns error for invalid JSON args', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'get_data_forceparams',
            'jsonArgs': 'not-json',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Invalid JSON' )
    } )


    test( 'returns error for missing required parameters', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'get_data_forceparams',
            'jsonArgs': '{}',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Missing required parameter' )
    } )


    test( 'executes tool call successfully with correct params', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'ping_forcesimple',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'content' ] ).toBeDefined()
    }, 15000 )
} )


describe( 'FlowMcpCli.callListTools with group override', () => {
    const CWD = join( tmpdir(), `flowmcp-listtools-group-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'default',
            'groups': {
                'default': {
                    'tools': [
                        'forcesrc/simple.mjs::ping'
                    ]
                },
                'alternate-group': {
                    'tools': [
                        'forcesrc/params.mjs::getData'
                    ]
                }
            }
        }

        await writeFile(
            join( CWD, '.flowmcp', 'config.json' ),
            JSON.stringify( localConfig, null, 4 ),
            'utf-8'
        )
    } )


    afterAll( async () => {
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    test( 'lists tools from specified group', async () => {
        const { result } = await FlowMcpCli.callListTools( {
            'group': 'alternate-group',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'group' ] ).toBe( 'alternate-group' )
        expect( result[ 'toolCount' ] ).toBeGreaterThan( 0 )

        const toolNames = result[ 'tools' ]
            .map( ( t ) => {
                const name = t[ 'toolName' ]

                return name
            } )

        expect( toolNames ).toContain( 'get_data_forceparams' )
    } )


    test( 'returns error for non-existent group', async () => {
        const { result } = await FlowMcpCli.callListTools( {
            'group': 'nonexistent',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'not found' )
    } )
} )


describe( 'FlowMcpCli.list from group-based config', () => {
    const CWD = join( tmpdir(), `flowmcp-list-group-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'main',
            'groups': {
                'main': {
                    'tools': [
                        'forcesrc/simple.mjs::ping',
                        'forcesrc/params.mjs::getData'
                    ]
                }
            }
        }

        await writeFile(
            join( CWD, '.flowmcp', 'config.json' ),
            JSON.stringify( localConfig, null, 4 ),
            'utf-8'
        )
    } )


    afterAll( async () => {
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    test( 'returns tools from default group', async () => {
        const { result } = await FlowMcpCli.list( { 'cwd': CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolCount' ] ).toBeGreaterThan( 0 )

        const toolNames = result[ 'tools' ]
            .map( ( t ) => {
                const name = t[ 'name' ]

                return name
            } )

        expect( toolNames ).toContain( 'ping_forcesimple' )
        expect( toolNames ).toContain( 'get_data_forceparams' )
    } )
} )
