import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import { validSchema, validV3Schema, validV3ToolsOnlySchema } from '../helpers/mock-schema.mjs'


const TEST_DIR = join( tmpdir(), `flowmcp-cli-v3-test-${Date.now()}` )
const SCHEMAS_DIR = join( TEST_DIR, 'schemas' )


beforeAll( async () => {
    await mkdir( SCHEMAS_DIR, { recursive: true } )

    const v2SchemaContent = `export const main = ${JSON.stringify( validSchema, null, 4 )}\n`
    await writeFile( join( SCHEMAS_DIR, 'v2-routes.mjs' ), v2SchemaContent, 'utf-8' )

    const v3FullContent = `export const main = ${JSON.stringify( validV3Schema, null, 4 )}\n`
    await writeFile( join( SCHEMAS_DIR, 'v3-full.mjs' ), v3FullContent, 'utf-8' )

    const v3ToolsOnlyContent = `export const main = ${JSON.stringify( validV3ToolsOnlySchema, null, 4 )}\n`
    await writeFile( join( SCHEMAS_DIR, 'v3-tools-only.mjs' ), v3ToolsOnlyContent, 'utf-8' )
} )


afterAll( async () => {
    await rm( TEST_DIR, { recursive: true, force: true } )
} )


describe( 'v3 extensions - validate with tools key', () => {
    it( 'processes a v3 schema with tools key without crashing', async () => {
        const schemaPath = join( SCHEMAS_DIR, 'v3-tools-only.mjs' )
        const { result } = await FlowMcpCli.validate( { schemaPath } )

        expect( result[ 'total' ] ).toBe( 1 )
        expect( result[ 'results' ] ).toBeDefined()
        expect( result[ 'results' ][ 0 ][ 'namespace' ] ).toBe( 'testtoolsonly' )
        expect( result[ 'results' ][ 0 ][ 'file' ] ).toBe( 'v3-tools-only.mjs' )
        expect( result[ 'results' ][ 0 ][ 'status' ] ).toBe( true )
    } )


    it( 'processes a v3 schema with all three primitives', async () => {
        const schemaPath = join( SCHEMAS_DIR, 'v3-full.mjs' )
        const { result } = await FlowMcpCli.validate( { schemaPath } )

        expect( result[ 'total' ] ).toBe( 1 )
        expect( result[ 'results' ] ).toBeDefined()
        expect( result[ 'results' ][ 0 ][ 'namespace' ] ).toBe( 'testapivsthree' )
        expect( result[ 'results' ][ 0 ][ 'file' ] ).toBe( 'v3-full.mjs' )
        expect( result[ 'results' ][ 0 ][ 'status' ] ).toBe( true )
    } )


    it( 'still processes v2 schemas with routes key (backwards compat)', async () => {
        const schemaPath = join( SCHEMAS_DIR, 'v2-routes.mjs' )
        const { result } = await FlowMcpCli.validate( { schemaPath } )

        expect( result[ 'total' ] ).toBe( 1 )
        expect( result[ 'results' ][ 0 ][ 'namespace' ] ).toBe( 'testApi' )
        expect( result[ 'results' ][ 0 ][ 'file' ] ).toBe( 'v2-routes.mjs' )
    } )
} )


describe( 'v3 extensions - validate metadata counts', () => {
    it( 'returns tools count for v3 schema with tools key', async () => {
        const schemaPath = join( SCHEMAS_DIR, 'v3-tools-only.mjs' )
        const { result } = await FlowMcpCli.validate( { schemaPath } )

        const entry = result[ 'results' ][ 0 ]

        expect( entry[ 'tools' ] ).toBe( 1 )
        expect( entry[ 'resources' ] ).toBe( 0 )
        expect( entry[ 'skills' ] ).toBe( 0 )
    } )


    it( 'returns tools, resources, and skills counts for full v3 schema', async () => {
        const schemaPath = join( SCHEMAS_DIR, 'v3-full.mjs' )
        const { result } = await FlowMcpCli.validate( { schemaPath } )

        const entry = result[ 'results' ][ 0 ]

        expect( entry[ 'tools' ] ).toBe( 1 )
        expect( entry[ 'resources' ] ).toBe( 1 )
        expect( entry[ 'skills' ] ).toBe( 1 )
    } )


    it( 'returns tools count for v2 schema with routes key', async () => {
        const schemaPath = join( SCHEMAS_DIR, 'v2-routes.mjs' )
        const { result } = await FlowMcpCli.validate( { schemaPath } )

        const entry = result[ 'results' ][ 0 ]

        expect( entry[ 'tools' ] ).toBe( 1 )
        expect( entry[ 'resources' ] ).toBe( 0 )
        expect( entry[ 'skills' ] ).toBe( 0 )
    } )


    it( 'processes a directory containing mixed v2 and v3 schemas', async () => {
        const { result } = await FlowMcpCli.validate( { schemaPath: SCHEMAS_DIR } )

        expect( result[ 'total' ] ).toBe( 3 )
        expect( result[ 'results' ].length ).toBe( 3 )
        expect( result[ 'passed' ] + result[ 'failed' ] ).toBe( 3 )
    } )
} )


describe( 'v3 extensions - validationValidate', () => {
    it( 'still accepts valid schemaPath strings', () => {
        const { status } = FlowMcpCli.validationValidate( { schemaPath: '/some/path.mjs' } )

        expect( status ).toBe( true )
    } )


    it( 'rejects missing schemaPath', () => {
        const { status, messages } = FlowMcpCli.validationValidate( { schemaPath: undefined } )

        expect( status ).toBe( false )
        expect( messages.length ).toBeGreaterThan( 0 )
    } )
} )


describe( 'v3 extensions - search result shape', () => {
    it( 'search returns results without crashing on v3 schemas', async () => {
        const { result } = await FlowMcpCli.search( { query: 'nonexistent-query-xyz-12345' } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'matchCount' ] ).toBe( 0 )

        const toolsArray = result[ 'tools' ]

        expect( Array.isArray( toolsArray ) ).toBe( true )
    }, 30000 )


    it( 'search result entries include type field when there are matches', async () => {
        const { result } = await FlowMcpCli.search( { query: 'get' } )

        expect( result[ 'status' ] ).toBe( true )

        if( result[ 'matchCount' ] > 0 ) {
            const firstTool = result[ 'tools' ][ 0 ]

            expect( firstTool ).toHaveProperty( 'type' )
            expect( firstTool ).toHaveProperty( 'name' )
            expect( firstTool ).toHaveProperty( 'description' )
            expect( firstTool ).toHaveProperty( 'add' )
        }
    } )
} )
