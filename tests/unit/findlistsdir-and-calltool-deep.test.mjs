import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
const ENV_PATH = join( GLOBAL_CONFIG_DIR, '.env.findlist' )

let originalGlobalConfig = null
let globalConfigExisted = false


beforeAll( async () => {
    try {
        originalGlobalConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        globalConfigExisted = true
    } catch {
        globalConfigExisted = false
    }

    await writeFile( ENV_PATH, 'FINDLIST_KEY=abc\n', 'utf-8' )
} )


afterAll( async () => {
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    await rm( ENV_PATH, { force: true } ).catch( () => {} )
} )


describe( 'FlowMcpCli.list — shared lists in parent dir exercises #findListsDir parent path', () => {
    const SOURCE_NAME = 'parentlistsrc'
    const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )
    const SUB_DIR = join( SOURCE_DIR, 'sub' )
    const LISTS_DIR = join( SOURCE_DIR, '_lists' )
    const CWD = join( tmpdir(), `flowmcp-findlist-parent-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( SUB_DIR, { recursive: true } )
        await mkdir( LISTS_DIR, { recursive: true } )
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const sharedListContent = `export const items = [ 'one', 'two', 'three' ]\n`
        await writeFile( join( LISTS_DIR, 'items.mjs' ), sharedListContent, 'utf-8' )

        const schema = `export const main = {
    namespace: 'parentlistsrc',
    name: 'Parent List API',
    description: 'Schema in subdir with shared lists in parent',
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
            description: 'Select item',
            path: '/get',
            parameters: [
                {
                    position: { key: 'item', value: '{{USER_PARAM}}', location: 'query' },
                    z: { primitive: 'enum({{items}})', options: [] }
                }
            ]
        }
    }
}
`

        const registry = {
            'name': SOURCE_NAME,
            'version': '1.0.0',
            'description': 'Parent list test',
            'schemaSpec': '2.0.0',
            'schemas': [
                {
                    'namespace': 'parentlistsrc',
                    'file': 'sub/nested.mjs',
                    'name': 'Parent List API',
                    'requiredServerParams': []
                }
            ]
        }

        await writeFile( join( SUB_DIR, 'nested.mjs' ), schema, 'utf-8' )
        await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( registry, null, 4 ), 'utf-8' )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'plist-group',
            'groups': {
                'plist-group': {
                    'tools': [
                        `${SOURCE_NAME}/sub/nested.mjs::selectItem`
                    ]
                }
            }
        }

        await writeFile(
            join( CWD, '.flowmcp', 'config.json' ),
            JSON.stringify( localConfig, null, 4 ),
            'utf-8'
        )

        const globalConfig = {
            'envPath': ENV_PATH,
            'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc', 'schemaSpec': '2.0.0' },
            'initialized': new Date().toISOString(),
            'sources': { [SOURCE_NAME]: { 'type': 'local', 'schemaCount': 1 } }
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
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'resolves shared list from parent directory when schema is in subdir', async () => {
        const { result } = await FlowMcpCli.list( { 'cwd': CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolCount' ] ).toBeGreaterThanOrEqual( 1 )

        const selectTool = result[ 'tools' ]
            .find( ( t ) => {
                const isMatch = t[ 'name' ] === 'select_item_parentlistsrc'

                return isMatch
            } )

        expect( selectTool ).toBeDefined()
        expect( selectTool[ 'parameters' ] ).toBeDefined()
        expect( selectTool[ 'parameters' ][ 'item' ] ).toBeDefined()
        expect( selectTool[ 'parameters' ][ 'item' ][ 'type' ] ).toBe( 'enum' )
    } )
} )


describe( 'FlowMcpCli.callTool — with group and nonexistent group schema', () => {
    const CWD = join( tmpdir(), `flowmcp-findlist-groupschema-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'empty-group',
            'groups': {
                'empty-group': {
                    'tools': []
                }
            }
        }

        await writeFile(
            join( CWD, '.flowmcp', 'config.json' ),
            JSON.stringify( localConfig, null, 4 ),
            'utf-8'
        )

        if( !globalConfigExisted ) {
            const globalConfig = {
                'envPath': ENV_PATH,
                'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc', 'schemaSpec': '2.0.0' },
                'initialized': new Date().toISOString(),
                'sources': {}
            }

            await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
        }
    } )


    afterAll( async () => {
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'returns error when group has empty tools list', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'some_nonexistent_tool',
            'group': 'empty-group',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
    } )
} )


describe( 'FlowMcpCli.list — with schemasDir in local config exercises line 4737', () => {
    const SOURCE_NAME = 'schemadirtest'
    const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )
    const CWD = join( tmpdir(), `flowmcp-schemasdir-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( SOURCE_DIR, { recursive: true } )
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const schema = `export const main = {
    namespace: 'schemadirtest',
    name: 'SchemasDir API',
    description: 'Test schemasDir config',
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
            'description': 'SchemasDir test',
            'schemaSpec': '2.0.0',
            'schemas': [
                { 'namespace': 'schemadirtest', 'file': 'sdtest.mjs', 'name': 'SchemasDir API', 'requiredServerParams': [] }
            ]
        }

        await writeFile( join( SOURCE_DIR, 'sdtest.mjs' ), schema, 'utf-8' )
        await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( registry, null, 4 ), 'utf-8' )

        const localConfig = {
            'root': '~/.flowmcp',
            'schemasDir': join( GLOBAL_CONFIG_DIR, 'schemas' ),
            'tools': [
                `${SOURCE_NAME}/sdtest.mjs::ping`
            ]
        }

        await writeFile(
            join( CWD, '.flowmcp', 'config.json' ),
            JSON.stringify( localConfig, null, 4 ),
            'utf-8'
        )

        const globalConfig = {
            'envPath': ENV_PATH,
            'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc', 'schemaSpec': '2.0.0' },
            'initialized': new Date().toISOString(),
            'sources': { [SOURCE_NAME]: { 'type': 'local', 'schemaCount': 1 } }
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
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'lists tools when schemasDir is set in local config', async () => {
        const { result } = await FlowMcpCli.list( { 'cwd': CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolCount' ] ).toBeGreaterThanOrEqual( 1 )
    } )
} )


describe( 'FlowMcpCli.add — with force flag exercises bustCache', () => {
    const SOURCE_NAME = 'forcesrc'
    const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )
    const CWD = join( tmpdir(), `flowmcp-force-add-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( SOURCE_DIR, { recursive: true } )
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const schema = `export const main = {
    namespace: 'forcesrc',
    name: 'Force API',
    description: 'Force test',
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
            'description': 'Force test source',
            'schemaSpec': '2.0.0',
            'schemas': [
                { 'namespace': 'forcesrc', 'file': 'force.mjs', 'name': 'Force API', 'requiredServerParams': [] }
            ]
        }

        await writeFile( join( SOURCE_DIR, 'force.mjs' ), schema, 'utf-8' )
        await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( registry, null, 4 ), 'utf-8' )

        const globalConfig = {
            'envPath': ENV_PATH,
            'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc', 'schemaSpec': '2.0.0' },
            'initialized': new Date().toISOString(),
            'sources': { [SOURCE_NAME]: { 'type': 'local', 'schemaCount': 1 } }
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
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'adds tool first time, then force-adds to replace', async () => {
        const { result: firstAdd } = await FlowMcpCli.add( {
            'toolName': 'ping_forcesrc',
            'cwd': CWD
        } )

        expect( firstAdd[ 'status' ] ).toBe( true )
        expect( firstAdd[ 'added' ] ).toBe( 'ping_forcesrc' )

        const { result: forceAdd } = await FlowMcpCli.add( {
            'toolName': 'ping_forcesrc',
            'cwd': CWD,
            'force': true
        } )

        expect( forceAdd[ 'status' ] ).toBe( true )
        expect( forceAdd[ 'added' ] ).toBe( 'ping_forcesrc' )
    } )
} )
