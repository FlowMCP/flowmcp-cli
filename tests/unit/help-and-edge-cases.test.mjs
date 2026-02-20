import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
const ENV_PATH = join( GLOBAL_CONFIG_DIR, '.env.helptest' )
const SOURCE_NAME = 'helpsrc'
const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )

let originalGlobalConfig = null
let globalConfigExisted = false


beforeAll( async () => {
    try {
        originalGlobalConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        globalConfigExisted = true
    } catch {
        globalConfigExisted = false
    }

    await mkdir( SOURCE_DIR, { recursive: true } )

    const schema = `export const main = {
    namespace: 'helpsrc',
    name: 'Help Test API',
    description: 'Schema for help tests',
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

    const registry = {
        'name': SOURCE_NAME,
        'version': '1.0.0',
        'description': 'Help test source',
        'schemaSpec': '2.0.0',
        'schemas': [
            {
                'namespace': 'helpsrc',
                'file': 'simple.mjs',
                'name': 'Help Test API',
                'requiredServerParams': []
            }
        ]
    }

    await writeFile( join( SOURCE_DIR, 'simple.mjs' ), schema, 'utf-8' )
    await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( registry, null, 4 ), 'utf-8' )
    await writeFile( ENV_PATH, 'HELP_KEY=abc\n', 'utf-8' )

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


describe( 'FlowMcpCli.help — exercises printHeadline, formatHealthWarnings, printHelpText', () => {
    it( 'returns status true and prints help', async () => {
        const CWD = join( tmpdir(), `flowmcp-help-${Date.now()}` )
        await mkdir( CWD, { recursive: true } )

        const { result } = await FlowMcpCli.help( { 'cwd': CWD } )

        expect( result[ 'status' ] ).toBe( true )

        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'shows warnings when env file is missing', async () => {
        const CWD = join( tmpdir(), `flowmcp-help-warn-${Date.now()}` )
        await mkdir( CWD, { recursive: true } )

        const savedConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        const parsed = JSON.parse( savedConfig )
        parsed[ 'envPath' ] = '/tmp/nonexistent-env-help-test.env'
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( parsed, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.help( { 'cwd': CWD } )

        expect( result[ 'status' ] ).toBe( true )

        await writeFile( GLOBAL_CONFIG_PATH, savedConfig, 'utf-8' )
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )
} )


describe( 'FlowMcpCli.add — creates tools key when local config has groups but no tools', () => {
    const CWD = join( tmpdir(), `flowmcp-add-no-tools-key-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'test-group',
            'groups': {
                'test-group': {
                    'tools': []
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


    it( 'adds tools key to existing config that lacks it', async () => {
        const { result } = await FlowMcpCli.add( {
            'toolName': 'ping_helpsrc',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'added' ] ).toBe( 'ping_helpsrc' )
    } )
} )


describe( 'FlowMcpCli.status — exercises formatHealthWarnings with bad env path', () => {
    it( 'returns health warnings when env file is missing', async () => {
        const CWD = join( tmpdir(), `flowmcp-status-warn-${Date.now()}` )
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'warn-group',
            'groups': {
                'warn-group': {
                    'tools': [ `${SOURCE_NAME}/simple.mjs::ping` ]
                }
            }
        }

        await writeFile(
            join( CWD, '.flowmcp', 'config.json' ),
            JSON.stringify( localConfig, null, 4 ),
            'utf-8'
        )

        const savedConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        const parsed = JSON.parse( savedConfig )
        parsed[ 'envPath' ] = '/tmp/nonexistent-status-warn.env'
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( parsed, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.status( { 'cwd': CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'healthy' ] ).toBe( false )

        const envCheck = result[ 'checks' ]
            .find( ( c ) => {
                const isEnv = c[ 'name' ] === 'envFile'

                return isEnv
            } )

        expect( envCheck[ 'ok' ] ).toBe( false )

        await writeFile( GLOBAL_CONFIG_PATH, savedConfig, 'utf-8' )
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )
} )


describe( 'FlowMcpCli.callListTools — group fallback to default from local config', () => {
    it( 'uses default group when group param is undefined', async () => {
        const CWD = join( tmpdir(), `flowmcp-listtools-default-${Date.now()}` )
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'fallback-group',
            'groups': {
                'fallback-group': {
                    'tools': [ `${SOURCE_NAME}/simple.mjs::ping` ]
                }
            }
        }

        await writeFile(
            join( CWD, '.flowmcp', 'config.json' ),
            JSON.stringify( localConfig, null, 4 ),
            'utf-8'
        )

        const { result } = await FlowMcpCli.callListTools( { 'cwd': CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'tools' ] ).toBeDefined()
        expect( result[ 'toolCount' ] ).toBeGreaterThanOrEqual( 1 )

        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )
} )


describe( 'FlowMcpCli.remove — missing tool name validation', () => {
    it( 'returns error for empty string tool name', async () => {
        const CWD = join( tmpdir(), `flowmcp-remove-empty-${Date.now()}` )
        await mkdir( CWD, { recursive: true } )

        const { result } = await FlowMcpCli.remove( { 'toolName': '', 'cwd': CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Missing tool name' )

        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'returns error for no active tools', async () => {
        const CWD = join( tmpdir(), `flowmcp-remove-noactive-${Date.now()}` )
        await mkdir( CWD, { recursive: true } )

        const { result } = await FlowMcpCli.remove( { 'toolName': 'some_tool', 'cwd': CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'No active tools' )

        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )
} )


describe( 'FlowMcpCli.search — validation', () => {
    it( 'returns error for empty query', async () => {
        const { result } = await FlowMcpCli.search( { 'query': '' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Missing search query' )
    } )


    it( 'returns results for valid query', async () => {
        const { result } = await FlowMcpCli.search( { 'query': 'httpbin' } )

        expect( result[ 'status' ] ).toBe( true )
    } )
} )
