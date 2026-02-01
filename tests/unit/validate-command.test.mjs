import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import { validSchema, invalidSchema } from '../helpers/mock-schema.mjs'


const TEST_DIR = join( tmpdir(), 'flowmcp-cli-validate-test' )
const SCHEMAS_DIR = join( TEST_DIR, 'schemas' )

beforeAll( async () => {
    await mkdir( SCHEMAS_DIR, { recursive: true } )

    const validSchemaContent = `export default ${JSON.stringify( validSchema, null, 4 )}\n`
    await writeFile( join( SCHEMAS_DIR, 'valid.mjs' ), validSchemaContent, 'utf-8' )

    const invalidSchemaContent = `export default ${JSON.stringify( invalidSchema, null, 4 )}\n`
    await writeFile( join( SCHEMAS_DIR, 'invalid.mjs' ), invalidSchemaContent, 'utf-8' )
} )

afterAll( async () => {
    await rm( TEST_DIR, { recursive: true, force: true } )
} )


describe( 'FlowMcpCli.validate', () => {
    it( 'returns error when schemaPath is missing and no cwd', async () => {
        const { result } = await FlowMcpCli.validate( { schemaPath: undefined } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
        expect( result[ 'messages' ].length ).toBeGreaterThan( 0 )
    } )


    it( 'returns error for non-existent path', async () => {
        const { result } = await FlowMcpCli.validate( { schemaPath: '/nonexistent/path/schema.mjs' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Path not found' )
    } )


    it( 'validates a single valid schema file', async () => {
        const schemaPath = join( SCHEMAS_DIR, 'valid.mjs' )
        const { result } = await FlowMcpCli.validate( { schemaPath } )

        expect( result[ 'total' ] ).toBe( 1 )
        expect( result[ 'results' ] ).toBeDefined()
        expect( result[ 'results' ][ 0 ][ 'namespace' ] ).toBe( 'testApi' )
        expect( result[ 'results' ][ 0 ][ 'file' ] ).toBe( 'valid.mjs' )
    } )


    it( 'validates a directory of schemas', async () => {
        const { result } = await FlowMcpCli.validate( { schemaPath: SCHEMAS_DIR } )

        expect( result[ 'total' ] ).toBe( 2 )
        expect( result[ 'results' ].length ).toBe( 2 )
    } )


    it( 'returns error for empty directory', async () => {
        const emptyDir = join( TEST_DIR, 'empty' )
        await mkdir( emptyDir, { recursive: true } )

        const { result } = await FlowMcpCli.validate( { schemaPath: emptyDir } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'No schema files' )
    } )


    it( 'includes passed and failed counts', async () => {
        const { result } = await FlowMcpCli.validate( { schemaPath: SCHEMAS_DIR } )

        expect( result ).toHaveProperty( 'passed' )
        expect( result ).toHaveProperty( 'failed' )
        expect( result[ 'passed' ] + result[ 'failed' ] ).toBe( result[ 'total' ] )
    } )


    it( 'returns error when no schemaPath and no default group', async () => {
        const emptyCwd = join( tmpdir(), 'flowmcp-validate-nogroup' )
        await mkdir( emptyCwd, { recursive: true } )

        const { result } = await FlowMcpCli.validate( { schemaPath: undefined, cwd: emptyCwd } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'No default group set' )

        await rm( emptyCwd, { recursive: true, force: true } )
    } )
} )
