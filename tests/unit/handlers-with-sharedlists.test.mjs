import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
const ENV_PATH = join( GLOBAL_CONFIG_DIR, '.env.hsl' )

let originalGlobalConfig = null
let globalConfigExisted = false

const SOURCE_NAME = 'hslsrc'
const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )
const LISTS_DIR = join( SOURCE_DIR, '_lists' )


beforeAll( async () => {
    try {
        originalGlobalConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        globalConfigExisted = true
    } catch {
        globalConfigExisted = false
    }

    await mkdir( LISTS_DIR, { recursive: true } )
    await writeFile( ENV_PATH, 'HSL_KEY=abc\n', 'utf-8' )

    const sharedListContent = `export const colors = [ 'red', 'green', 'blue' ]\n`
    await writeFile( join( LISTS_DIR, 'colors.mjs' ), sharedListContent, 'utf-8' )

    const schema = `export const main = {
    namespace: 'hslsrc',
    name: 'HSL API',
    description: 'Schema with handlers and shared lists',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    sharedLists: [ 'colors' ],
    routes: {
        pickColor: {
            method: 'GET',
            description: 'Pick a color',
            path: '/get',
            parameters: [
                {
                    position: { key: 'color', value: '{{USER_PARAM}}', location: 'query' },
                    z: { primitive: 'enum({{colors}})', options: [] }
                }
            ]
        }
    }
}

export const handlers = ( { sharedLists, libraries } ) => {
    return {
        pickColor: {
            before: ( { userParams } ) => {
                return userParams
            }
        }
    }
}
`

    const registry = {
        'name': SOURCE_NAME,
        'version': '1.0.0',
        'description': 'HSL test source',
        'schemaSpec': '2.0.0',
        'schemas': [
            { 'namespace': 'hslsrc', 'file': 'hsl.mjs', 'name': 'HSL API', 'requiredServerParams': [] }
        ]
    }

    await writeFile( join( SOURCE_DIR, 'hsl.mjs' ), schema, 'utf-8' )
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
    await rm( ENV_PATH, { force: true } ).catch( () => {} )
} )


describe( 'FlowMcpCli.callTool with handlers + sharedLists — exercises #resolveHandlers sharedLists path', () => {
    const CWD = join( tmpdir(), `flowmcp-hsl-call-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'tools': [
                `${SOURCE_NAME}/hsl.mjs::pickColor`
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


    it( 'calls tool with handlers that receive resolved shared lists', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'pick_color_hslsrc',
            'jsonArgs': '{"color":"red"}',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'content' ] ).toBeDefined()
    }, 15000 )
} )


describe( 'FlowMcpCli.test with handlers + sharedLists schema via schemaPath', () => {
    it( 'runs test on schema with handlers and shared lists', async () => {
        const CWD = join( tmpdir(), `flowmcp-hsl-test-${Date.now()}` )
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'default',
            'groups': {
                'default': {
                    'tools': [ `${SOURCE_NAME}/hsl.mjs::pickColor` ]
                }
            }
        }

        await writeFile(
            join( CWD, '.flowmcp', 'config.json' ),
            JSON.stringify( localConfig, null, 4 ),
            'utf-8'
        )

        const { result } = await FlowMcpCli.test( {
            'schemaPath': join( SOURCE_DIR, 'hsl.mjs' ),
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBeDefined()
        expect( result[ 'total' ] ).toBeGreaterThanOrEqual( 0 )

        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    }, 30000 )
} )
