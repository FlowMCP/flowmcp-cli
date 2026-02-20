import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
const SOURCE_NAME = 'slsrc'
const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )
const LISTS_DIR = join( SOURCE_DIR, '_lists' )
const ENV_PATH = join( GLOBAL_CONFIG_DIR, '.env.sltest' )
const CACHE_DIR = join( GLOBAL_CONFIG_DIR, 'cache' )

let originalGlobalConfig = null
let globalConfigExisted = false

const SHARED_LIST_CONTENT = `export const items = [ 'alpha', 'beta', 'gamma' ]\n`

const SCHEMA_WITH_SHARED_LISTS = `export const main = {
    namespace: 'slsrc',
    name: 'SharedList API',
    description: 'Schema with shared lists for coverage tests',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    sharedLists: [ 'items' ],
    routes: {
        selectItem: {
            method: 'GET',
            description: 'Select item from shared list',
            path: '/get',
            parameters: [
                {
                    position: { key: 'item', value: '{{USER_PARAM}}', location: 'query' },
                    z: { primitive: 'enum({{items}})', options: [] }
                }
            ]
        },
        plainRoute: {
            method: 'GET',
            description: 'Plain route without params',
            path: '/get',
            parameters: []
        }
    }
}
`

const SCHEMA_SIMPLE = `export const main = {
    namespace: 'slsimple',
    name: 'SL Simple API',
    description: 'Simple schema',
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

const REGISTRY = {
    'name': SOURCE_NAME,
    'version': '1.0.0',
    'description': 'SharedList test source',
    'schemaSpec': '2.0.0',
    'schemas': [
        {
            'namespace': 'slsrc',
            'file': 'withLists.mjs',
            'name': 'SharedList API',
            'requiredServerParams': []
        },
        {
            'namespace': 'slsimple',
            'file': 'simple.mjs',
            'name': 'SL Simple API',
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

    await mkdir( LISTS_DIR, { recursive: true } )
    await writeFile( join( SOURCE_DIR, 'withLists.mjs' ), SCHEMA_WITH_SHARED_LISTS, 'utf-8' )
    await writeFile( join( SOURCE_DIR, 'simple.mjs' ), SCHEMA_SIMPLE, 'utf-8' )
    await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( REGISTRY, null, 4 ), 'utf-8' )
    await writeFile( join( LISTS_DIR, 'items.mjs' ), SHARED_LIST_CONTENT, 'utf-8' )
    await writeFile( ENV_PATH, 'SL_KEY=abc\n', 'utf-8' )

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
                'schemaCount': 2
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
    await rm( CACHE_DIR, { recursive: true, force: true } ).catch( () => {} )
} )


describe( 'FlowMcpCli.list with sharedLists — exercises resolveSharedListsForSchema and findListsDir', () => {
    const CWD = join( tmpdir(), `flowmcp-sharedlist-list-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'sl-group',
            'groups': {
                'sl-group': {
                    'tools': [
                        `${SOURCE_NAME}/withLists.mjs::selectItem`,
                        `${SOURCE_NAME}/withLists.mjs::plainRoute`,
                        `${SOURCE_NAME}/simple.mjs::ping`
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


    it( 'lists tools including shared list parameters', async () => {
        const { result } = await FlowMcpCli.list( { 'cwd': CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolCount' ] ).toBeGreaterThanOrEqual( 3 )

        const selectTool = result[ 'tools' ]
            .find( ( t ) => {
                const isMatch = t[ 'name' ] === 'select_item_slsrc'

                return isMatch
            } )

        expect( selectTool ).toBeDefined()
        expect( selectTool[ 'parameters' ] ).toBeDefined()
        expect( selectTool[ 'parameters' ][ 'item' ] ).toBeDefined()
        expect( selectTool[ 'parameters' ][ 'item' ][ 'type' ] ).toBe( 'enum' )
    } )
} )


describe( 'FlowMcpCli.add with sharedLists — exercises extractParameters interpolation', () => {
    const CWD = join( tmpdir(), `flowmcp-sharedlist-add-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )
    } )


    afterAll( async () => {
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'adds tool with enum interpolated from shared list', async () => {
        const { result } = await FlowMcpCli.add( {
            'toolName': 'select_item_slsrc',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'parameters' ] ).toBeDefined()
        expect( result[ 'parameters' ][ 'item' ] ).toBeDefined()
        expect( result[ 'parameters' ][ 'item' ][ 'type' ] ).toBe( 'enum' )
    } )
} )


describe( 'FlowMcpCli.callTool with sharedLists schema', () => {
    const CWD = join( tmpdir(), `flowmcp-sharedlist-call-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'sl-call',
            'groups': {
                'sl-call': {
                    'tools': [
                        `${SOURCE_NAME}/withLists.mjs::selectItem`,
                        `${SOURCE_NAME}/withLists.mjs::plainRoute`
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


    it( 'executes tool call for shared list route', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'select_item_slsrc',
            'jsonArgs': '{"item":"alpha"}',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'content' ] ).toBeDefined()
    }, 15000 )
} )


describe( 'FlowMcpCli.cacheClear error path', () => {
    it( 'clears specific namespace cache', async () => {
        const { result } = await FlowMcpCli.cacheClear( { 'namespace': 'nonexistent_namespace_xyz' } )

        expect( result[ 'status' ] ).toBe( true )
    } )


    it( 'clears all cache', async () => {
        const { result } = await FlowMcpCli.cacheClear( {} )

        expect( result[ 'status' ] ).toBe( true )
    } )
} )


describe( 'FlowMcpCli.status with group-based config', () => {
    const CWD = join( tmpdir(), `flowmcp-status-groups-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'status-group',
            'groups': {
                'status-group': {
                    'tools': [
                        `${SOURCE_NAME}/simple.mjs::ping`
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


    it( 'returns status with groups info and default group', async () => {
        const { result } = await FlowMcpCli.status( { 'cwd': CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'groups' ] ).toBeDefined()
        expect( result[ 'groups' ][ 'status-group' ] ).toBeDefined()
        expect( result[ 'defaultGroup' ] ).toBe( 'status-group' )
    } )
} )


describe( 'FlowMcpCli.remove — successful flat tools removal', () => {
    const CWD = join( tmpdir(), `flowmcp-remove-flat-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'tools': [
                `${SOURCE_NAME}/simple.mjs::ping`
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


    it( 'removes tool from flat tools array', async () => {
        const { result } = await FlowMcpCli.remove( {
            'toolName': 'ping_slsimple',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'removed' ] ).toBe( 'ping_slsimple' )
    } )
} )


describe( 'FlowMcpCli.add — tool already exists without force', () => {
    const CWD = join( tmpdir(), `flowmcp-add-exists-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )
    } )


    afterAll( async () => {
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'returns already active message on second add without force', async () => {
        await FlowMcpCli.add( {
            'toolName': 'ping_slsimple',
            'cwd': CWD
        } )

        const { result } = await FlowMcpCli.add( {
            'toolName': 'ping_slsimple',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'message' ] ).toContain( 'already' )
    } )
} )
