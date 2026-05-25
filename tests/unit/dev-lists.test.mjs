import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { constants } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { createTestHome } from '../helpers/test-home.mjs'

const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


const execFileAsync = promisify( execFile )

const testHome = createTestHome( { suite: 'dev-lists' } )
const GLOBAL_CONFIG_PATH = testHome.globalConfigPath
const SCHEMAS_DIR = testHome.schemasDir
const SOURCE_NAME = 'devlistsrc'
const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )
const LISTS_DIR = join( SOURCE_DIR, '_lists' )
const ENV_PATH = testHome.envPath( '.devlists' )


// ─── fixtures ────────────────────────────────────────────────────────────────

const CHAIN_LIST_CONTENT = `export const list = {
    meta: {
        name: 'demoChains',
        version: '1.0.0',
        description: 'Demo chain list for tests',
        fields: [
            { key: 'alias', type: 'string', optional: false },
            { key: 'chainId', type: 'number', optional: false },
            { key: 'name', type: 'string', optional: false }
        ]
    },
    entries: [
        { alias: 'FOO', chainId: 1, name: 'Foo Chain' },
        { alias: 'BAR', chainId: 2, name: 'Bar Chain' }
    ]
}
`

const SCHEMA_REFERENCING_ALIAS = `export const main = {
    namespace: 'devlistsrc',
    name: 'DevLists API',
    description: 'Test schema referencing alias in enum',
    version: '4.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://example.com',
    requiredServerParams: [],
    headers: {},
    tools: {
        getChainData: {
            method: 'GET',
            description: 'Get chain data',
            path: '/chain',
            parameters: [
                {
                    position: { key: 'chain', value: '{{USER_PARAM}}', location: 'query' },
                    z: { primitive: 'enum({{demoChains}})', options: [ 'FOO', 'BAR' ] }
                }
            ]
        }
    }
}
`

const SCHEMA_NO_ALIAS = `export const main = {
    namespace: 'devlistsrc',
    name: 'Plain API',
    description: 'Test schema without alias reference',
    version: '4.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://example.com',
    requiredServerParams: [],
    headers: {},
    tools: {
        ping: {
            method: 'GET',
            description: 'Ping',
            path: '/ping',
            parameters: []
        }
    }
}
`

const REGISTRY = {
    'name': SOURCE_NAME,
    'version': '1.0.0',
    'description': 'DevLists test source',
    'schemaSpec': '4.0.0',
    'schemas': [
        {
            'namespace': 'devlistsrc',
            'file': 'chainSchema.mjs',
            'name': 'DevLists API',
            'requiredServerParams': []
        },
        {
            'namespace': 'devlistsrc',
            'file': 'plainSchema.mjs',
            'name': 'Plain API',
            'requiredServerParams': []
        }
    ]
}


// ─── setup / teardown ────────────────────────────────────────────────────────

beforeAll( async () => {
    await testHome.setup()

    await mkdir( LISTS_DIR, { recursive: true } )
    await writeFile( join( LISTS_DIR, 'demo-chains.mjs' ), CHAIN_LIST_CONTENT, 'utf-8' )
    await writeFile( join( SOURCE_DIR, 'chainSchema.mjs' ), SCHEMA_REFERENCING_ALIAS, 'utf-8' )
    await writeFile( join( SOURCE_DIR, 'plainSchema.mjs' ), SCHEMA_NO_ALIAS, 'utf-8' )
    await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( REGISTRY, null, 4 ), 'utf-8' )
    await writeFile( ENV_PATH, 'DEVLISTS_KEY=abc\n', 'utf-8' )

    const globalConfig = {
        'envPath': ENV_PATH,
        'flowmcpCore': {
            'version': '4.0.0',
            'commit': 'abc123',
            'schemaSpec': '4.0.0'
        },
        'initialized': new Date().toISOString(),
        'sources': {
            [SOURCE_NAME]: {
                'type': 'builtin',
                'schemaCount': 2
            }
        }
    }

    await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
} )


afterAll( async () => {
    await testHome.teardown()
} )


// ─── helper ──────────────────────────────────────────────────────────────────

async function resetListFile() {
    await writeFile( join( LISTS_DIR, 'demo-chains.mjs' ), CHAIN_LIST_CONTENT, 'utf-8' )
}


// ─── add-entry: happy path ────────────────────────────────────────────────────

describe( 'listsAddEntry — appends a valid entry', () => {
    beforeAll( async () => {
        await resetListFile()
    } )


    it( 'returns status true with updated count', async () => {
        const { result } = await FlowMcpCli.listsAddEntry( {
            'cwd': tmpdir(),
            'listName': 'demo-chains',
            'jsonEntry': '{"alias":"BAZ","chainId":3,"name":"Baz Chain"}'
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'listName' ] ).toBe( 'demo-chains' )
        expect( result[ 'totalEntries' ] ).toBe( 3 )
        expect( result[ 'entryAdded' ][ 'alias' ] ).toBe( 'BAZ' )
    } )


    it( 'file on disk contains the new entry', async () => {
        const content = await readFile( join( LISTS_DIR, 'demo-chains.mjs' ), 'utf-8' )

        expect( content ).toContain( 'BAZ' )
        expect( content ).toContain( 'Baz Chain' )
    } )
} )


// ─── add-entry: invalid JSON ──────────────────────────────────────────────────

describe( 'listsAddEntry — rejects invalid JSON', () => {
    it( 'returns status false with clear error', async () => {
        const { result } = await FlowMcpCli.listsAddEntry( {
            'cwd': tmpdir(),
            'listName': 'demo-chains',
            'jsonEntry': '{not valid json'
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toMatch( /Invalid JSON/ )
    } )
} )


// ─── add-entry: shape mismatch (missing key) ─────────────────────────────────

describe( 'listsAddEntry — rejects entry missing required field', () => {
    beforeAll( async () => {
        await resetListFile()
    } )


    it( 'returns status false when required field is absent', async () => {
        const { result } = await FlowMcpCli.listsAddEntry( {
            'cwd': tmpdir(),
            'listName': 'demo-chains',
            'jsonEntry': '{"alias":"NOPE","chainId":99}'
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toMatch( /missing required/ )
    } )
} )


// ─── add-entry: shape mismatch (extra key) ────────────────────────────────────

describe( 'listsAddEntry — rejects entry with unknown field', () => {
    beforeAll( async () => {
        await resetListFile()
    } )


    it( 'returns status false when unknown field is provided', async () => {
        const { result } = await FlowMcpCli.listsAddEntry( {
            'cwd': tmpdir(),
            'listName': 'demo-chains',
            'jsonEntry': '{"alias":"QUX","chainId":5,"name":"Qux","extraField":"bad"}'
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toMatch( /unknown field/ )
    } )
} )


// ─── add-entry: list file not found ──────────────────────────────────────────

describe( 'listsAddEntry — returns error when list file does not exist', () => {
    it( 'returns status false with fix hint', async () => {
        const { result } = await FlowMcpCli.listsAddEntry( {
            'cwd': tmpdir(),
            'listName': 'nonexistent-list',
            'jsonEntry': '{"alias":"X","chainId":1,"name":"X"}'
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toMatch( /not found/ )
    } )
} )


// ─── refs: finds schemas referencing the alias ────────────────────────────────

describe( 'listsRefs — finds schemas referencing FOO alias', () => {
    it( 'returns schemaCount >= 1 and matching schema info', async () => {
        const { result } = await FlowMcpCli.listsRefs( {
            'cwd': tmpdir(),
            'alias': 'FOO'
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'alias' ] ).toBe( 'FOO' )
        expect( result[ 'schemaCount' ] ).toBeGreaterThanOrEqual( 1 )

        const match = result[ 'schemas' ]
            .find( ( s ) => s[ 'namespace' ] === 'devlistsrc' && s[ 'file' ] === 'chainSchema.mjs' )

        expect( match ).toBeDefined()
        expect( match[ 'references' ].length ).toBeGreaterThanOrEqual( 1 )
        expect( match[ 'references' ][ 0 ][ 'tool' ] ).toBe( 'getChainData' )
    } )
} )


// ─── refs: alias not referenced anywhere ─────────────────────────────────────

describe( 'listsRefs — returns empty when alias is not referenced', () => {
    it( 'returns schemaCount 0 and empty schemas array', async () => {
        const { result } = await FlowMcpCli.listsRefs( {
            'cwd': tmpdir(),
            'alias': 'TOTALLY_UNKNOWN_ALIAS_XYZ_9999'
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'schemaCount' ] ).toBe( 0 )
        expect( result[ 'schemas' ] ).toHaveLength( 0 )
    } )
} )


// ─── refs: handles malformed schemas gracefully ──────────────────────────────

describe( 'listsRefs — skips malformed schema files', () => {
    const MALFORMED_FILE = join( SOURCE_DIR, 'broken.mjs' )


    beforeAll( async () => {
        await writeFile( MALFORMED_FILE, 'this is not valid mjs syntax @@@@', 'utf-8' )

        const updatedRegistry = {
            ...REGISTRY,
            'schemas': [
                ...REGISTRY[ 'schemas' ],
                {
                    'namespace': 'devlistsrc',
                    'file': 'broken.mjs',
                    'name': 'Broken Schema',
                    'requiredServerParams': []
                }
            ]
        }

        await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( updatedRegistry, null, 4 ), 'utf-8' )
    } )


    afterAll( async () => {
        await rm( MALFORMED_FILE, { force: true } ).catch( () => {} )
        await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( REGISTRY, null, 4 ), 'utf-8' )
    } )


    it( 'still returns status true and valid results, skipping broken file', async () => {
        const { result } = await FlowMcpCli.listsRefs( {
            'cwd': tmpdir(),
            'alias': 'FOO'
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'schemaCount' ] ).toBeGreaterThanOrEqual( 1 )
    } )
} )


// ─── list passthrough: dev lists list == flowmcp lists ───────────────────────

describe( 'dev lists list passthrough — same result as flowmcp lists', () => {
    it( 'listsAddEntry with list sub-command returns listSharedLists result', async () => {
        const { result: passthroughResult } = await FlowMcpCli.listSharedLists( { 'listName': null } )
        const { result: directResult } = await FlowMcpCli.listSharedLists( { 'listName': null } )

        expect( passthroughResult[ 'status' ] ).toBe( directResult[ 'status' ] )
        expect( passthroughResult[ 'listCount' ] ).toBe( directResult[ 'listCount' ] )
    } )
} )
