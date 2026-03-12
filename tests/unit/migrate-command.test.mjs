import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const TEST_DIR = join( tmpdir(), 'flowmcp-cli-migrate-test' )
const SCHEMAS_DIR = join( TEST_DIR, 'schemas' )
const NESTED_DIR = join( SCHEMAS_DIR, 'provider-a' )

const V2_SCHEMA_CONTENT = `export const main = {
    'namespace': 'testApi',
    'name': 'Test API',
    'description': 'Test API for migration',
    'version': '2.0.0',
    'docs': [ 'https://test.example.com/docs' ],
    'tags': [ 'test' ],
    'root': 'https://test.example.com',
    'requiredServerParams': [],
    'headers': {
        'Accept': 'application/json'
    },
    'routes': {
        'getData': {
            'method': 'GET',
            'description': 'Get test data',
            'path': '/data',
            'parameters': [],
            'tests': []
        }
    }
}
`

const V2_SCHEMA_CONTENT_CUSTOM_VERSION = `export const main = {
    'namespace': 'customApi',
    'name': 'Custom API',
    'description': 'Schema with version 2.1.3',
    'version': '2.1.3',
    'docs': [],
    'tags': [],
    'root': 'https://custom.example.com',
    'requiredServerParams': [],
    'headers': {},
    'routes': {
        'ping': {
            'method': 'GET',
            'description': 'Ping endpoint',
            'path': '/ping',
            'parameters': [],
            'tests': []
        }
    }
}
`

const V3_SCHEMA_CONTENT = `export const main = {
    'namespace': 'alreadyV3',
    'name': 'Already V3 API',
    'description': 'Schema already at v3',
    'version': '3.0.0',
    'docs': [],
    'tags': [],
    'root': 'https://v3.example.com',
    'requiredServerParams': [],
    'headers': {},
    'tools': {
        'getData': {
            'method': 'GET',
            'description': 'Get data',
            'path': '/data',
            'parameters': [],
            'tests': []
        }
    }
}
`

const NON_SCHEMA_CONTENT = `export const helper = {
    'name': 'not-a-schema',
    'value': 42
}
`


beforeAll( async () => {
    await mkdir( NESTED_DIR, { recursive: true } )

    await writeFile( join( SCHEMAS_DIR, 'v2-schema.mjs' ), V2_SCHEMA_CONTENT, 'utf-8' )
    await writeFile( join( SCHEMAS_DIR, 'v3-schema.mjs' ), V3_SCHEMA_CONTENT, 'utf-8' )
    await writeFile( join( SCHEMAS_DIR, 'non-schema.mjs' ), NON_SCHEMA_CONTENT, 'utf-8' )
    await writeFile( join( NESTED_DIR, 'nested-v2.mjs' ), V2_SCHEMA_CONTENT_CUSTOM_VERSION, 'utf-8' )
} )

afterAll( async () => {
    await rm( TEST_DIR, { recursive: true, force: true } )
} )


describe( 'FlowMcpCli.validationMigrate', () => {
    it( 'returns error when schemaPath is missing and all is false', () => {
        const { status, messages } = FlowMcpCli.validationMigrate( { 'schemaPath': undefined, 'all': false } )

        expect( status ).toBe( false )
        expect( messages.length ).toBeGreaterThan( 0 )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'returns error when schemaPath is not a string', () => {
        const { status, messages } = FlowMcpCli.validationMigrate( { 'schemaPath': 123, 'all': false } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'passes when all is true and schemaPath is missing', () => {
        const { status, messages } = FlowMcpCli.validationMigrate( { 'schemaPath': undefined, 'all': true } )

        expect( status ).toBe( true )
        expect( messages.length ).toBe( 0 )
    } )


    it( 'passes when schemaPath is a valid string', () => {
        const { status, messages } = FlowMcpCli.validationMigrate( { 'schemaPath': '/some/path.mjs', 'all': false } )

        expect( status ).toBe( true )
        expect( messages.length ).toBe( 0 )
    } )
} )


describe( 'FlowMcpCli.migrate', () => {
    it( 'migrates a single v2 file - routes to tools and version to 3.0.0', async () => {
        const singleDir = join( TEST_DIR, 'single-test' )
        await mkdir( singleDir, { recursive: true } )
        const filePath = join( singleDir, 'schema.mjs' )
        await writeFile( filePath, V2_SCHEMA_CONTENT, 'utf-8' )

        const { result } = await FlowMcpCli.migrate( { 'schemaPath': filePath, 'cwd': TEST_DIR } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'migrated' ] ).toBe( 1 )
        expect( result[ 'skipped' ] ).toBe( 0 )
        expect( result[ 'failed' ] ).toBe( 0 )

        const updatedContent = await readFile( filePath, 'utf-8' )
        expect( updatedContent ).toContain( `'tools'` )
        expect( updatedContent ).not.toContain( `'routes'` )
        expect( updatedContent ).toContain( `'3.0.0'` )
        expect( updatedContent ).not.toContain( `'2.0.0'` )

        await rm( singleDir, { recursive: true, force: true } )
    } )


    it( 'skips a file that is already v3', async () => {
        const skipDir = join( TEST_DIR, 'skip-test' )
        await mkdir( skipDir, { recursive: true } )
        const filePath = join( skipDir, 'v3.mjs' )
        await writeFile( filePath, V3_SCHEMA_CONTENT, 'utf-8' )

        const { result } = await FlowMcpCli.migrate( { 'schemaPath': filePath, 'cwd': TEST_DIR } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'migrated' ] ).toBe( 0 )
        expect( result[ 'skipped' ] ).toBe( 1 )
        expect( result[ 'results' ][ 0 ][ 'action' ] ).toBe( 'skipped' )

        const unchangedContent = await readFile( filePath, 'utf-8' )
        expect( unchangedContent ).toBe( V3_SCHEMA_CONTENT )

        await rm( skipDir, { recursive: true, force: true } )
    } )


    it( 'skips a non-schema file without routes or v2 version', async () => {
        const nonSchemaDir = join( TEST_DIR, 'non-schema-test' )
        await mkdir( nonSchemaDir, { recursive: true } )
        const filePath = join( nonSchemaDir, 'helper.mjs' )
        await writeFile( filePath, NON_SCHEMA_CONTENT, 'utf-8' )

        const { result } = await FlowMcpCli.migrate( { 'schemaPath': filePath, 'cwd': TEST_DIR } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'skipped' ] ).toBe( 1 )
        expect( result[ 'migrated' ] ).toBe( 0 )

        await rm( nonSchemaDir, { recursive: true, force: true } )
    } )


    it( 'does not write files in dry-run mode', async () => {
        const dryRunDir = join( TEST_DIR, 'dry-run-test' )
        await mkdir( dryRunDir, { recursive: true } )
        const filePath = join( dryRunDir, 'schema.mjs' )
        await writeFile( filePath, V2_SCHEMA_CONTENT, 'utf-8' )

        const { result } = await FlowMcpCli.migrate( { 'schemaPath': filePath, 'cwd': TEST_DIR, 'dryRun': true } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'dryRun' ] ).toBe( true )
        expect( result[ 'migrated' ] ).toBe( 1 )
        expect( result[ 'results' ][ 0 ][ 'reason' ] ).toContain( 'dry-run' )

        const unchangedContent = await readFile( filePath, 'utf-8' )
        expect( unchangedContent ).toContain( `'routes'` )
        expect( unchangedContent ).toContain( `'2.0.0'` )

        await rm( dryRunDir, { recursive: true, force: true } )
    } )


    it( 'migrates all files in a directory with --all', async () => {
        const allDir = join( TEST_DIR, 'all-test' )
        const subDir = join( allDir, 'sub' )
        await mkdir( subDir, { recursive: true } )

        await writeFile( join( allDir, 'a.mjs' ), V2_SCHEMA_CONTENT, 'utf-8' )
        await writeFile( join( subDir, 'b.mjs' ), V2_SCHEMA_CONTENT_CUSTOM_VERSION, 'utf-8' )
        await writeFile( join( allDir, 'c.mjs' ), V3_SCHEMA_CONTENT, 'utf-8' )

        const { result } = await FlowMcpCli.migrate( { 'schemaPath': allDir, 'cwd': TEST_DIR, 'all': true } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'total' ] ).toBe( 3 )
        expect( result[ 'migrated' ] ).toBe( 2 )
        expect( result[ 'skipped' ] ).toBe( 1 )
        expect( result[ 'failed' ] ).toBe( 0 )

        const contentA = await readFile( join( allDir, 'a.mjs' ), 'utf-8' )
        expect( contentA ).toContain( `'tools'` )
        expect( contentA ).toContain( `'3.0.0'` )

        const contentB = await readFile( join( subDir, 'b.mjs' ), 'utf-8' )
        expect( contentB ).toContain( `'tools'` )
        expect( contentB ).toContain( `'3.0.0'` )
        expect( contentB ).not.toContain( `'2.1.3'` )

        await rm( allDir, { recursive: true, force: true } )
    } )


    it( 'returns error for non-existent path', async () => {
        const { result } = await FlowMcpCli.migrate( { 'schemaPath': '/nonexistent/path/schema.mjs', 'cwd': TEST_DIR } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Path not found' )
    } )


    it( 'returns validation error when schemaPath is missing', async () => {
        const { result } = await FlowMcpCli.migrate( { 'schemaPath': undefined, 'cwd': TEST_DIR } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
        expect( result[ 'messages' ][ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'handles a directory path without --all flag', async () => {
        const dirOnlyDir = join( TEST_DIR, 'dir-only-test' )
        await mkdir( dirOnlyDir, { recursive: true } )
        await writeFile( join( dirOnlyDir, 'schema.mjs' ), V2_SCHEMA_CONTENT, 'utf-8' )

        const { result } = await FlowMcpCli.migrate( { 'schemaPath': dirOnlyDir, 'cwd': TEST_DIR } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'migrated' ] ).toBe( 1 )

        await rm( dirOnlyDir, { recursive: true, force: true } )
    } )


    it( 'handles version 2.x.x variants correctly', async () => {
        const versionDir = join( TEST_DIR, 'version-test' )
        await mkdir( versionDir, { recursive: true } )
        const filePath = join( versionDir, 'schema.mjs' )
        await writeFile( filePath, V2_SCHEMA_CONTENT_CUSTOM_VERSION, 'utf-8' )

        const { result } = await FlowMcpCli.migrate( { 'schemaPath': filePath, 'cwd': TEST_DIR } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'migrated' ] ).toBe( 1 )

        const updatedContent = await readFile( filePath, 'utf-8' )
        expect( updatedContent ).toContain( `'3.0.0'` )
        expect( updatedContent ).not.toContain( `'2.1.3'` )

        await rm( versionDir, { recursive: true, force: true } )
    } )


    it( 'returns empty results for directory with no mjs files', async () => {
        const emptyDir = join( TEST_DIR, 'empty-test' )
        await mkdir( emptyDir, { recursive: true } )
        await writeFile( join( emptyDir, 'readme.txt' ), 'not a schema', 'utf-8' )

        const { result } = await FlowMcpCli.migrate( { 'schemaPath': emptyDir, 'cwd': TEST_DIR } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'total' ] ).toBe( 0 )
        expect( result[ 'migrated' ] ).toBe( 0 )
        expect( result[ 'results' ].length ).toBe( 0 )

        await rm( emptyDir, { recursive: true, force: true } )
    } )
} )
