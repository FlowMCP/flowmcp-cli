import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const TEST_DIR = join( tmpdir(), `flowmcp-cli-resource-test-${Date.now()}` )
const SCHEMAS_DIR = join( TEST_DIR, 'schemas' )

const SCHEMA_WITH_FILE_BASED_RESOURCE = `export const main = {
    'namespace': 'testresource',
    'name': 'Test Resource Schema',
    'description': 'Schema with file-based SQLite resource',
    'version': '3.0.0',
    'docs': [],
    'tags': [ 'test' ],
    'root': 'local://test',
    'requiredServerParams': [],
    'headers': {},
    'tools': {},
    'resources': {
        'testDb': {
            'source': 'sqlite',
            'mode': 'file-based',
            'origin': 'project',
            'name': 'test-resource.db',
            'description': 'A test database',
            'queries': {
                'searchItems': {
                    'sql': 'SELECT * FROM items WHERE name = ?',
                    'description': 'Search items by name',
                    'parameters': [
                        {
                            'position': { 'key': 'name', 'value': '{{USER_PARAM}}' },
                            'z': { 'primitive': 'string()', 'options': [] }
                        }
                    ]
                },
                'countItems': {
                    'sql': 'SELECT COUNT(*) as total FROM items',
                    'description': 'Count all items',
                    'parameters': []
                }
            }
        }
    }
}
`

const SCHEMA_WITH_OLD_DATABASE_PATH = `export const main = {
    'namespace': 'oldformat',
    'name': 'Old Format Schema',
    'description': 'Schema with old database path',
    'version': '3.0.0',
    'docs': [],
    'tags': [ 'test' ],
    'root': 'local://old',
    'requiredServerParams': [],
    'headers': {},
    'tools': {},
    'resources': {
        'legacyDb': {
            'source': 'sqlite',
            'description': 'Legacy database',
            'database': '~/.flowmcp/data/old-test.db',
            'queries': {
                'getAll': {
                    'sql': 'SELECT * FROM records',
                    'description': 'Get all records',
                    'parameters': []
                }
            }
        }
    }
}
`

const SCHEMA_NO_RESOURCES = `export const main = {
    'namespace': 'noresources',
    'name': 'No Resources Schema',
    'description': 'Schema without resources',
    'version': '3.0.0',
    'docs': [],
    'tags': [ 'test' ],
    'root': 'https://api.example.com',
    'requiredServerParams': [],
    'headers': {},
    'tools': {
        'ping': {
            'method': 'GET',
            'description': 'Ping',
            'path': '/ping',
            'parameters': [],
            'tests': []
        }
    }
}
`

const SCHEMA_WITH_READONLY_RESOURCE = `export const main = {
    'namespace': 'readonlyres',
    'name': 'Read-Only Resource Schema',
    'description': 'Schema with in-memory resource',
    'version': '3.0.0',
    'docs': [],
    'tags': [ 'test' ],
    'root': 'local://readonly',
    'requiredServerParams': [],
    'headers': {},
    'tools': {},
    'resources': {
        'readDb': {
            'source': 'sqlite',
            'mode': 'in-memory',
            'origin': 'global',
            'name': 'readonly.db',
            'description': 'A read-only database',
            'queries': {
                'getAll': {
                    'sql': 'SELECT * FROM data',
                    'description': 'Get all data',
                    'parameters': []
                }
            }
        }
    }
}
`

const SCHEMA_WITH_GET_SCHEMA_QUERY = `export const main = {
    'namespace': 'withgetschema',
    'name': 'Schema with getSchema',
    'description': 'Schema that has a getSchema query',
    'version': '3.0.0',
    'docs': [],
    'tags': [ 'test' ],
    'root': 'local://getschema',
    'requiredServerParams': [],
    'headers': {},
    'tools': {},
    'resources': {
        'schemaDb': {
            'source': 'sqlite',
            'mode': 'file-based',
            'origin': 'project',
            'name': 'schema-test.db',
            'description': 'A database with getSchema query',
            'queries': {
                'getSchema': {
                    'sql': "SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name",
                    'description': 'Returns the database schema',
                    'parameters': []
                }
            }
        }
    }
}
`


beforeAll( async () => {
    await mkdir( SCHEMAS_DIR, { recursive: true } )

    await writeFile( join( SCHEMAS_DIR, 'file-based.mjs' ), SCHEMA_WITH_FILE_BASED_RESOURCE, 'utf-8' )
    await writeFile( join( SCHEMAS_DIR, 'old-format.mjs' ), SCHEMA_WITH_OLD_DATABASE_PATH, 'utf-8' )
    await writeFile( join( SCHEMAS_DIR, 'no-resources.mjs' ), SCHEMA_NO_RESOURCES, 'utf-8' )
    await writeFile( join( SCHEMAS_DIR, 'readonly.mjs' ), SCHEMA_WITH_READONLY_RESOURCE, 'utf-8' )
    await writeFile( join( SCHEMAS_DIR, 'with-getschema.mjs' ), SCHEMA_WITH_GET_SCHEMA_QUERY, 'utf-8' )
} )


afterAll( async () => {
    await rm( TEST_DIR, { recursive: true, force: true } )
} )


describe( 'FlowMcpCli.validationResourceCreate', () => {
    it( 'returns error when schemaPath is missing', () => {
        const { status, messages } = FlowMcpCli.validationResourceCreate( { 'schemaPath': undefined } )

        expect( status ).toBe( false )
        expect( messages.length ).toBeGreaterThan( 0 )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'returns error when schemaPath is not a string', () => {
        const { status, messages } = FlowMcpCli.validationResourceCreate( { 'schemaPath': 123 } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'passes when schemaPath is a valid string', () => {
        const { status, messages } = FlowMcpCli.validationResourceCreate( { 'schemaPath': '/some/path.mjs' } )

        expect( status ).toBe( true )
        expect( messages.length ).toBe( 0 )
    } )
} )


describe( 'FlowMcpCli.resourceCreate', () => {
    it( 'creates a database for file-based SQLite resources', async () => {
        const schemaPath = join( SCHEMAS_DIR, 'file-based.mjs' )
        const projectDir = join( TEST_DIR, 'project-create-test' )
        await mkdir( projectDir, { recursive: true } )

        const { result } = await FlowMcpCli.resourceCreate( {
            schemaPath,
            'cwd': projectDir,
            'basis': 'flowmcp',
            'autoConfirm': true
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'created' ] ).toBe( 1 )
        expect( result[ 'skipped' ] ).toBe( 0 )
        expect( result[ 'failed' ] ).toBe( 0 )

        const dbPath = join( projectDir, '.flowmcp', 'resources', 'test-resource.db' )
        expect( existsSync( dbPath ) ).toBe( true )

        await rm( projectDir, { recursive: true, force: true } )
    } )


    it( 'skips when database already exists', async () => {
        const schemaPath = join( SCHEMAS_DIR, 'file-based.mjs' )
        const projectDir = join( TEST_DIR, 'project-skip-test' )
        const dbDir = join( projectDir, '.flowmcp', 'resources' )
        await mkdir( dbDir, { recursive: true } )
        await writeFile( join( dbDir, 'test-resource.db' ), '', 'utf-8' )

        const { result } = await FlowMcpCli.resourceCreate( {
            schemaPath,
            'cwd': projectDir,
            'basis': 'flowmcp',
            'autoConfirm': true
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'created' ] ).toBe( 0 )
        expect( result[ 'skipped' ] ).toBe( 1 )
        expect( result[ 'results' ][ 0 ][ 'reason' ] ).toContain( 'already exists' )

        await rm( projectDir, { recursive: true, force: true } )
    } )


    it( 'returns no resources message for schemas without file-based resources', async () => {
        const schemaPath = join( SCHEMAS_DIR, 'no-resources.mjs' )

        const { result } = await FlowMcpCli.resourceCreate( {
            schemaPath,
            'cwd': TEST_DIR,
            'basis': 'flowmcp',
            'autoConfirm': true
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'created' ] ).toBe( 0 )
        expect( result[ 'message' ] ).toContain( 'No file-based' )
    } )


    it( 'skips in-memory resources', async () => {
        const schemaPath = join( SCHEMAS_DIR, 'readonly.mjs' )

        const { result } = await FlowMcpCli.resourceCreate( {
            schemaPath,
            'cwd': TEST_DIR,
            'basis': 'flowmcp',
            'autoConfirm': true
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'created' ] ).toBe( 0 )
        expect( result[ 'message' ] ).toContain( 'No file-based' )
    } )


    it( 'returns validation error for missing path', async () => {
        const { result } = await FlowMcpCli.resourceCreate( {
            'schemaPath': undefined,
            'cwd': TEST_DIR,
            'basis': 'flowmcp',
            'autoConfirm': true
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
    } )


    it( 'returns error for non-existent schema file', async () => {
        const { result } = await FlowMcpCli.resourceCreate( {
            'schemaPath': '/nonexistent/schema.mjs',
            'cwd': TEST_DIR,
            'basis': 'flowmcp',
            'autoConfirm': true
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Failed to load schema' )
    } )


    it( 'uses custom basis folder', async () => {
        const schemaPath = join( SCHEMAS_DIR, 'file-based.mjs' )
        const projectDir = join( TEST_DIR, 'project-basis-test' )
        await mkdir( projectDir, { recursive: true } )

        const { result } = await FlowMcpCli.resourceCreate( {
            schemaPath,
            'cwd': projectDir,
            'basis': 'myagent',
            'autoConfirm': true
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'created' ] ).toBe( 1 )

        const dbPath = join( projectDir, '.myagent', 'resources', 'test-resource.db' )
        expect( existsSync( dbPath ) ).toBe( true )

        await rm( projectDir, { recursive: true, force: true } )
    } )


    it( 'creates empty database when schema has getSchema query', async () => {
        const schemaPath = join( SCHEMAS_DIR, 'with-getschema.mjs' )
        const projectDir = join( TEST_DIR, 'project-getschema-test' )
        await mkdir( projectDir, { recursive: true } )

        const { result } = await FlowMcpCli.resourceCreate( {
            schemaPath,
            'cwd': projectDir,
            'basis': 'flowmcp',
            'autoConfirm': true
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'created' ] ).toBe( 1 )
        expect( result[ 'results' ][ 0 ][ 'tables' ] ).toBe( 0 )

        const dbPath = join( projectDir, '.flowmcp', 'resources', 'schema-test.db' )
        expect( existsSync( dbPath ) ).toBe( true )

        await rm( projectDir, { recursive: true, force: true } )
    } )
} )


describe( 'FlowMcpCli.resourceMigrate', () => {
    it( 'returns empty results when no old-format schemas exist', async () => {
        const { result } = await FlowMcpCli.resourceMigrate( {
            'cwd': TEST_DIR,
            'basis': 'flowmcp',
            'dryRun': false,
            'autoConfirm': true
        } )

        expect( result[ 'status' ] ).toBe( true )
    } )
} )
