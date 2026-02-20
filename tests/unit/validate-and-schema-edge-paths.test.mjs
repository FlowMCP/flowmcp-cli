import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const ENV_PATH = join( GLOBAL_CONFIG_DIR, '.env.vedge' )

let originalGlobalConfig = null
let globalConfigExisted = false


beforeAll( async () => {
    try {
        originalGlobalConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        globalConfigExisted = true
    } catch {
        globalConfigExisted = false
    }

    await writeFile( ENV_PATH, 'VEDGE_KEY=abc\n', 'utf-8' )

    const globalConfig = {
        'envPath': ENV_PATH,
        'flowmcpCore': {
            'version': '2.0.0',
            'commit': 'abc123',
            'schemaSpec': '2.0.0'
        },
        'initialized': new Date().toISOString(),
        'sources': {}
    }

    if( globalConfigExisted && originalGlobalConfig ) {
        const parsed = JSON.parse( originalGlobalConfig )
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

    await rm( ENV_PATH, { force: true } ).catch( () => {} )
} )


describe( 'FlowMcpCli.validate — schemaPath not found exercises line 5572', () => {
    it( 'returns error when schemaPath does not exist', async () => {
        const { result } = await FlowMcpCli.validate( {
            'schemaPath': '/tmp/nonexistent-vedge-schema-path-xyz'
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Path not found' )
    } )
} )


describe( 'FlowMcpCli.validate — single file schemaPath with no main export', () => {
    const NO_MAIN_FILE = join( tmpdir(), `flowmcp-vedge-nomain-${Date.now()}.mjs` )


    beforeAll( async () => {
        await writeFile( NO_MAIN_FILE, 'export const other = { hello: true }\n', 'utf-8' )
    } )


    afterAll( async () => {
        await rm( NO_MAIN_FILE, { force: true } ).catch( () => {} )
    } )


    it( 'returns error for single file without main export', async () => {
        const { result } = await FlowMcpCli.validate( {
            'schemaPath': NO_MAIN_FILE
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'No main export' )
    } )
} )


describe( 'FlowMcpCli.validate — single valid schema file via schemaPath', () => {
    const VALID_FILE = join( tmpdir(), `flowmcp-vedge-valid-${Date.now()}.mjs` )


    beforeAll( async () => {
        const schema = `export const main = {
    namespace: 'vedgesingle',
    name: 'VEdge Single API',
    description: 'Valid single schema',
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

        await writeFile( VALID_FILE, schema, 'utf-8' )
    } )


    afterAll( async () => {
        await rm( VALID_FILE, { force: true } ).catch( () => {} )
    } )


    it( 'validates a single schema file successfully', async () => {
        const { result } = await FlowMcpCli.validate( {
            'schemaPath': VALID_FILE
        } )

        expect( result[ 'total' ] ).toBe( 1 )
        expect( result[ 'results' ] ).toBeDefined()
        expect( result[ 'results' ][ 0 ][ 'status' ] ).toBe( true )
    } )
} )


describe( 'FlowMcpCli.validate — directory with empty schemas', () => {
    const EMPTY_DIR = join( tmpdir(), `flowmcp-vedge-emptydir-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( EMPTY_DIR, { recursive: true } )
    } )


    afterAll( async () => {
        await rm( EMPTY_DIR, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'returns error for directory with no schema files', async () => {
        const { result } = await FlowMcpCli.validate( {
            'schemaPath': EMPTY_DIR
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'No schema files' )
    } )
} )


describe( 'FlowMcpCli.validate — directory with valid and no-main schema', () => {
    const MIX_DIR = join( tmpdir(), `flowmcp-vedge-mixdir-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( MIX_DIR, { recursive: true } )

        const validSchema = `export const main = {
    namespace: 'vedgemix',
    name: 'VEdge Mix API',
    description: 'Valid schema',
    version: '2.0.0',
    docs: [],
    tags: [],
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

        await writeFile( join( MIX_DIR, 'valid.mjs' ), validSchema, 'utf-8' )
        await writeFile( join( MIX_DIR, 'nomain.mjs' ), 'export const other = {}\n', 'utf-8' )
    } )


    afterAll( async () => {
        await rm( MIX_DIR, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'processes directory with mixed valid and no-main schemas', async () => {
        const { result } = await FlowMcpCli.validate( {
            'schemaPath': MIX_DIR
        } )

        expect( result[ 'total' ] ).toBeGreaterThanOrEqual( 2 )
        expect( result[ 'results' ] ).toBeDefined()
        expect( result[ 'results' ].length ).toBeGreaterThanOrEqual( 2 )
    } )
} )


describe( 'FlowMcpCli.validate — without schemaPath and without cwd defaults', () => {
    it( 'returns error when no schemaPath and no cwd provided', async () => {
        const { result } = await FlowMcpCli.validate( {} )

        expect( result[ 'status' ] ).toBe( false )
    } )
} )


describe( 'FlowMcpCli.test — schemaPath not found', () => {
    it( 'returns error for nonexistent schemaPath', async () => {
        const CWD = join( tmpdir(), `flowmcp-vedge-test-nopath-${Date.now()}` )
        await mkdir( CWD, { recursive: true } )

        const { result } = await FlowMcpCli.test( {
            'schemaPath': '/tmp/nonexistent-vedge-test-path-xyz',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( false )

        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )
} )


describe( 'FlowMcpCli.schemas — exercises source listing', () => {
    it( 'returns schemas list with status true', async () => {
        const { result } = await FlowMcpCli.schemas()

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'sources' ] ).toBeDefined()
    } )
} )


describe( 'FlowMcpCli.add — tool not found in schemas', () => {
    it( 'returns error for nonexistent tool name', async () => {
        const CWD = join( tmpdir(), `flowmcp-vedge-add-notfound-${Date.now()}` )
        await mkdir( CWD, { recursive: true } )

        const { result } = await FlowMcpCli.add( {
            'toolName': 'completely_nonexistent_tool_xyz',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'not found' )

        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )
} )


describe( 'FlowMcpCli.add — missing tool name', () => {
    it( 'returns error for empty tool name', async () => {
        const CWD = join( tmpdir(), `flowmcp-vedge-add-empty-${Date.now()}` )
        await mkdir( CWD, { recursive: true } )

        const { result } = await FlowMcpCli.add( {
            'toolName': '',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Missing tool name' )

        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )
} )


describe( 'FlowMcpCli.remove — tool not in active list', () => {
    const CWD = join( tmpdir(), `flowmcp-vedge-remove-notactive-${Date.now()}` )
    const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
    const SOURCE_NAME = 'vedgerem'
    const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )
        await mkdir( SOURCE_DIR, { recursive: true } )

        const schema = `export const main = {
    namespace: 'vedgerem',
    name: 'VEdge Remove API',
    description: 'Schema for remove test',
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
            'description': 'VEdge Remove source',
            'schemaSpec': '2.0.0',
            'schemas': [
                { 'namespace': 'vedgerem', 'file': 'rem.mjs', 'name': 'VEdge Remove API', 'requiredServerParams': [] }
            ]
        }

        await writeFile( join( SOURCE_DIR, 'rem.mjs' ), schema, 'utf-8' )
        await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( registry, null, 4 ), 'utf-8' )

        const savedConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        const parsed = JSON.parse( savedConfig )
        parsed[ 'sources' ] = parsed[ 'sources' ] || {}
        parsed[ 'sources' ][ SOURCE_NAME ] = { 'type': 'local', 'schemaCount': 1 }
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( parsed, null, 4 ), 'utf-8' )

        const localConfig = {
            'root': '~/.flowmcp',
            'tools': [
                `${SOURCE_NAME}/rem.mjs::ping`
            ]
        }

        await writeFile(
            join( CWD, '.flowmcp', 'config.json' ),
            JSON.stringify( localConfig, null, 4 ),
            'utf-8'
        )
    } )


    afterAll( async () => {
        if( globalConfigExisted && originalGlobalConfig ) {
            await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
        }

        await rm( SOURCE_DIR, { recursive: true, force: true } ).catch( () => {} )
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'returns error when tool is recognized but not in active list', async () => {
        const { result: firstRemove } = await FlowMcpCli.remove( {
            'toolName': 'ping_vedgerem',
            'cwd': CWD
        } )

        expect( firstRemove[ 'status' ] ).toBe( true )

        const { result: secondRemove } = await FlowMcpCli.remove( {
            'toolName': 'ping_vedgerem',
            'cwd': CWD
        } )

        expect( secondRemove[ 'status' ] ).toBe( false )
    } )
} )
