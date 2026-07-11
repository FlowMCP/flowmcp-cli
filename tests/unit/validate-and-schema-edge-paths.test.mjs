import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createTestHome } from '../helpers/test-home.mjs'

const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


const testHome = createTestHome( { suite: 'vedge' } )
const GLOBAL_CONFIG_DIR = testHome.globalConfigDir
const GLOBAL_CONFIG_PATH = testHome.globalConfigPath
const ENV_PATH = testHome.envPath( '.vedge' )


beforeAll( async () => {
    await testHome.setup()

    await writeFile( ENV_PATH, 'VEDGE_KEY=abc\n', 'utf-8' )

    const globalConfig = {
        'envPath': ENV_PATH,
        'flowmcpCore': {
            'version': '2.0.0',
            'commit': 'abc123',
            'schemaSpec': '4.0.0'
        },
        'initialized': new Date().toISOString(),
        'sources': {}
    }

    await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
} )


afterAll( async () => {
    await testHome.teardown()
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
    version: '4.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    tools: {
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
    version: '4.0.0',
    docs: [],
    tags: [],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    tools: {
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


// Memo 102 / PRD-002 — "FlowMcpCli.test — schemaPath not found" describe block
// removed with FlowMcpCli.test. The not-found case for the deterministic path is
// covered by grading-deterministic.test.mjs (namespace/schema not in island).


describe( 'FlowMcpCli.schemas — exercises source listing', () => {
    it( 'returns schemas list with status true', async () => {
        const { result } = await FlowMcpCli.schemas()

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'sources' ] ).toBeDefined()
    } )
} )


