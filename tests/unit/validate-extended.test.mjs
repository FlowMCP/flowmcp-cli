import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const TEST_DIR = join( tmpdir(), 'flowmcp-cli-validate-extended' )
const SCHEMAS_DIR = join( TEST_DIR, 'schemas' )
const NESTED_DIR = join( SCHEMAS_DIR, 'provider' )

let originalGlobalConfig = null
let globalConfigExisted = false

const VALID_SCHEMA = `export const main = {
    namespace: 'validateext',
    name: 'Validate Test API',
    description: 'Schema for validate tests',
    version: '2.0.0',
    docs: [ 'https://docs.example.com' ],
    tags: [ 'test' ],
    root: 'https://api.example.com',
    requiredServerParams: [],
    headers: { 'Accept': 'application/json' },
    routes: {
        getItems: {
            method: 'GET',
            description: 'Get items list',
            path: '/items',
            parameters: [
                {
                    position: { key: 'page', value: '{{USER_PARAM}}', location: 'query' },
                    z: { primitive: 'number()', options: [ 'optional()', 'default(1)' ] }
                },
                {
                    position: { key: 'limit', value: '{{USER_PARAM}}', location: 'query' },
                    z: { primitive: 'number()', options: [ 'min(1)', 'max(100)', 'default(10)' ] }
                }
            ],
            tests: [ { _description: 'Get first page' } ]
        },
        getItem: {
            method: 'GET',
            description: 'Get single item by ID',
            path: '/items/:id',
            parameters: [
                {
                    position: { key: 'id', value: '{{USER_PARAM}}', location: 'insert' },
                    z: { primitive: 'string()', options: [] }
                }
            ],
            tests: [ { _description: 'Get item 1', id: 'item-1' } ]
        }
    }
}
`

const INVALID_SCHEMA = `export const main = {
    namespace: '',
    name: 42
}
`

const MINIMAL_SCHEMA = `export const main = {
    namespace: 'minimal',
    name: 'Minimal',
    description: 'Minimal schema',
    version: '2.0.0',
    docs: [],
    tags: [],
    root: 'https://example.com',
    requiredServerParams: [],
    routes: {
        ping: {
            method: 'GET',
            description: 'Ping',
            path: '/ping',
            parameters: []
        }
    }
}
`


beforeAll( async () => {
    try {
        originalGlobalConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        globalConfigExisted = true
    } catch {
        globalConfigExisted = false
    }

    await mkdir( GLOBAL_CONFIG_DIR, { recursive: true } )
    await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( {
        'envPath': '/tmp/test.env',
        'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc', 'schemaSpec': '2.0.0' },
        'initialized': '2026-02-20T12:00:00.000Z'
    }, null, 4 ), 'utf-8' )

    await mkdir( NESTED_DIR, { recursive: true } )
    await writeFile( join( SCHEMAS_DIR, 'valid.mjs' ), VALID_SCHEMA, 'utf-8' )
    await writeFile( join( SCHEMAS_DIR, 'invalid.mjs' ), INVALID_SCHEMA, 'utf-8' )
    await writeFile( join( SCHEMAS_DIR, 'minimal.mjs' ), MINIMAL_SCHEMA, 'utf-8' )
    await writeFile( join( NESTED_DIR, 'nested.mjs' ), VALID_SCHEMA, 'utf-8' )
} )

afterAll( async () => {
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    await rm( TEST_DIR, { recursive: true, force: true } )
} )


describe( 'FlowMcpCli.validate extended', () => {
    it( 'validates a single valid schema with multiple routes', async () => {
        const { result } = await FlowMcpCli.validate( { schemaPath: join( SCHEMAS_DIR, 'valid.mjs' ) } )

        expect( result[ 'total' ] ).toBe( 1 )
        expect( result[ 'results' ] ).toBeDefined()
        expect( result[ 'results' ][ 0 ][ 'namespace' ] ).toBe( 'validateext' )
        expect( result[ 'results' ][ 0 ][ 'status' ] ).toBe( true )
    } )


    it( 'validates a directory including nested schemas', async () => {
        const { result } = await FlowMcpCli.validate( { schemaPath: SCHEMAS_DIR } )

        expect( result[ 'total' ] ).toBeGreaterThanOrEqual( 3 )
        expect( result[ 'results' ].length ).toBeGreaterThanOrEqual( 3 )
    } )


    it( 'reports failed count for invalid schemas', async () => {
        const { result } = await FlowMcpCli.validate( { schemaPath: SCHEMAS_DIR } )

        expect( result[ 'failed' ] ).toBeGreaterThan( 0 )
    } )


    it( 'validates minimal schema successfully', async () => {
        const { result } = await FlowMcpCli.validate( { schemaPath: join( SCHEMAS_DIR, 'minimal.mjs' ) } )

        expect( result[ 'total' ] ).toBe( 1 )
        expect( result[ 'passed' ] ).toBe( 1 )
        expect( result[ 'results' ][ 0 ][ 'namespace' ] ).toBe( 'minimal' )
    } )


    it( 'returns validation messages for invalid schema', async () => {
        const { result } = await FlowMcpCli.validate( { schemaPath: join( SCHEMAS_DIR, 'invalid.mjs' ) } )

        expect( result[ 'total' ] ).toBe( 1 )
        expect( result[ 'failed' ] ).toBe( 1 )

        const invalidResult = result[ 'results' ][ 0 ]

        expect( invalidResult[ 'messages' ] ).toBeDefined()
        expect( invalidResult[ 'messages' ].length ).toBeGreaterThan( 0 )
    } )


    it( 'returns results with messages array for each schema', async () => {
        const { result } = await FlowMcpCli.validate( { schemaPath: SCHEMAS_DIR } )

        const resultsWithMessages = result[ 'results' ]
            .filter( ( r ) => {
                const hasMessages = Array.isArray( r[ 'messages' ] )

                return hasMessages
            } )

        expect( resultsWithMessages.length ).toBeGreaterThan( 0 )
    } )
} )


describe( 'FlowMcpCli.test extended', () => {
    it( 'returns validation error for non-string schemaPath', async () => {
        const { result } = await FlowMcpCli.test( { schemaPath: 42, route: undefined, cwd: '/tmp' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
    } )


    it( 'returns validation error for null schemaPath', async () => {
        const { result } = await FlowMcpCli.test( { schemaPath: null, route: undefined, cwd: undefined } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
    } )
} )


describe( 'FlowMcpCli.validationImportRegistry', () => {
    it( 'rejects missing registryUrl', () => {
        const { status, messages } = FlowMcpCli.validationImportRegistry( { registryUrl: undefined } )

        expect( status ).toBe( false )
        expect( messages.length ).toBeGreaterThan( 0 )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'rejects non-string registryUrl', () => {
        const { status, messages } = FlowMcpCli.validationImportRegistry( { registryUrl: 42 } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'rejects registryUrl without valid protocol', () => {
        const { status, messages } = FlowMcpCli.validationImportRegistry( { registryUrl: 'ftp://not-http.com/reg.json' } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( 'URL' )
    } )


    it( 'accepts valid https URL', () => {
        const { status, messages } = FlowMcpCli.validationImportRegistry( { registryUrl: 'https://example.com/registry.json' } )

        expect( status ).toBe( true )
        expect( messages ).toHaveLength( 0 )
    } )
} )


describe( 'FlowMcpCli.validationUpdate', () => {
    it( 'rejects empty sourceName', () => {
        const { status, messages } = FlowMcpCli.validationUpdate( { sourceName: '   ' } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( 'Must not be empty' )
    } )


    it( 'rejects non-string sourceName', () => {
        const { status, messages } = FlowMcpCli.validationUpdate( { sourceName: 42 } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'accepts valid sourceName', () => {
        const { status, messages } = FlowMcpCli.validationUpdate( { sourceName: 'flowmcp-community' } )

        expect( status ).toBe( true )
        expect( messages ).toHaveLength( 0 )
    } )
} )
