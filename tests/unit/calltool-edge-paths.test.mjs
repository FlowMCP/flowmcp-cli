import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
const SOURCE_NAME = 'calledgesrc'
const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )
const ENV_PATH = join( GLOBAL_CONFIG_DIR, '.env.calledge' )

let originalGlobalConfig = null
let globalConfigExisted = false

const SCHEMA_CONTENT = `export const main = {
    namespace: 'calledgesrc',
    name: 'CallEdge API',
    description: 'Schema for callTool edge case tests',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    routes: {
        ping: {
            method: 'GET',
            description: 'Simple ping',
            path: '/get',
            parameters: []
        },
        withRequired: {
            method: 'GET',
            description: 'Route with required param',
            path: '/get',
            parameters: [
                {
                    position: { key: 'name', value: '{{USER_PARAM}}', location: 'query' },
                    z: { primitive: 'string()', options: [] }
                }
            ]
        }
    }
}
`

const REGISTRY = {
    'name': SOURCE_NAME,
    'version': '1.0.0',
    'description': 'CallEdge test source',
    'schemaSpec': '2.0.0',
    'schemas': [
        {
            'namespace': 'calledgesrc',
            'file': 'edge.mjs',
            'name': 'CallEdge API',
            'requiredServerParams': []
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

    await mkdir( SOURCE_DIR, { recursive: true } )
    await writeFile( join( SOURCE_DIR, 'edge.mjs' ), SCHEMA_CONTENT, 'utf-8' )
    await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( REGISTRY, null, 4 ), 'utf-8' )
    await writeFile( ENV_PATH, 'CALLEDGE_KEY=abc\n', 'utf-8' )

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
} )


afterAll( async () => {
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    await rm( SOURCE_DIR, { recursive: true, force: true } ).catch( () => {} )
    await rm( ENV_PATH, { force: true } ).catch( () => {} )
} )


describe( 'FlowMcpCli.callTool — missing tool name', () => {
    it( 'returns error when toolName is empty', async () => {
        const CWD = join( tmpdir(), `flowmcp-calledge-notool-${Date.now()}` )
        await mkdir( CWD, { recursive: true } )

        const { result } = await FlowMcpCli.callTool( { 'toolName': '', 'cwd': CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Missing tool name' )

        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )
} )


describe( 'FlowMcpCli.callTool — invalid JSON args', () => {
    const CWD = join( tmpdir(), `flowmcp-calledge-badjson-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'tools': [
                `${SOURCE_NAME}/edge.mjs::ping`
            ]
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


    it( 'returns error for invalid JSON argument', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'ping_calledgesrc',
            'jsonArgs': '{invalid json}',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Invalid JSON' )
    } )
} )


describe( 'FlowMcpCli.callTool — tool not found in active tools', () => {
    const CWD = join( tmpdir(), `flowmcp-calledge-notfound-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'tools': [
                `${SOURCE_NAME}/edge.mjs::ping`
            ]
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


    it( 'returns error when tool name does not match any active tool', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'nonexistent_tool_xyz',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'not found' )
    } )
} )


describe( 'FlowMcpCli.callTool — missing required parameters', () => {
    const CWD = join( tmpdir(), `flowmcp-calledge-missingparam-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'tools': [
                `${SOURCE_NAME}/edge.mjs::withRequired`
            ]
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


    it( 'returns error when required params are missing', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'with_required_calledgesrc',
            'jsonArgs': '{}',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Missing required parameter' )
    } )
} )


describe( 'FlowMcpCli.callTool — with group param for non-existent group', () => {
    const CWD = join( tmpdir(), `flowmcp-calledge-badgroup-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'real-group',
            'groups': {
                'real-group': {
                    'tools': [ `${SOURCE_NAME}/edge.mjs::ping` ]
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


    it( 'returns error for nonexistent group name', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'ping_calledgesrc',
            'group': 'nonexistent-group',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
    } )
} )


describe( 'FlowMcpCli.callTool — env file missing', () => {
    const CWD = join( tmpdir(), `flowmcp-calledge-noenv-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'tools': [
                `${SOURCE_NAME}/edge.mjs::ping`
            ]
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


    it( 'returns error when env file cannot be read', async () => {
        const savedConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        const parsed = JSON.parse( savedConfig )
        parsed[ 'envPath' ] = '/tmp/nonexistent-calledge-env.env'
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( parsed, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'ping_calledgesrc',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Cannot read .env' )

        await writeFile( GLOBAL_CONFIG_PATH, savedConfig, 'utf-8' )
    } )
} )


describe( 'FlowMcpCli.callTool — successful call exercises cacheable write path', () => {
    const CWD = join( tmpdir(), `flowmcp-calledge-success-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'tools': [
                `${SOURCE_NAME}/edge.mjs::ping`
            ]
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


    it( 'successfully calls tool and returns content', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'ping_calledgesrc',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'content' ] ).toBeDefined()
    }, 15000 )
} )


describe( 'FlowMcpCli.callListTools — with group param exercises resolveGroupSchemas', () => {
    const CWD = join( tmpdir(), `flowmcp-calledge-listgroup-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'list-group',
            'groups': {
                'list-group': {
                    'tools': [ `${SOURCE_NAME}/edge.mjs::ping` ]
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


    it( 'lists tools using explicit group param', async () => {
        const { result } = await FlowMcpCli.callListTools( {
            'group': 'list-group',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolCount' ] ).toBeGreaterThanOrEqual( 1 )
    } )
} )


describe( 'FlowMcpCli.callTool — with explicit group exercises group schema resolution', () => {
    const CWD = join( tmpdir(), `flowmcp-calledge-groupcall-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'call-group',
            'groups': {
                'call-group': {
                    'tools': [ `${SOURCE_NAME}/edge.mjs::ping` ]
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


    it( 'calls tool using explicit group param', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'ping_calledgesrc',
            'group': 'call-group',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'content' ] ).toBeDefined()
    }, 15000 )
} )
