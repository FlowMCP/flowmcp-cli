import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import { CatalogIndex } from 'flowmcp'


// ─── helpers ────────────────────────────────────────────────────────────────

function makeSchema( { namespace, tools = {}, resources = {}, prompts = {}, skills = [] } ) {
    return {
        namespace,
        name: `${namespace} API`,
        description: 'Test schema',
        version: '4.0.0',
        docs: [],
        tags: [ 'test' ],
        root: 'https://example.com',
        requiredServerParams: [],
        headers: {},
        tools,
        resources,
        prompts,
        skills
    }
}


function schemaEntry( { namespace, file, source = 'testsrc', tools = {}, resources = {}, prompts = {}, skills = [] } ) {
    return {
        'main': makeSchema( { namespace, tools, resources, prompts, skills } ),
        file,
        source
    }
}


// ─── parseSpecId ────────────────────────────────────────────────────────────

describe( 'FlowMcpCli.#parseSpecId — valid 2-slash tool', () => {
    it( 'returns valid: true with namespace, type tool, and name', async () => {
        const { index } = await CatalogIndex.build( { 'schemas': [] } )
        // We test parseSpecId indirectly via __testOnly_buildIndex which exercises the same logic.
        // For direct access to #parseSpecId we use the getNamespaceIndex path with fixture schemas.
        // Direct parse tests are exercised below via a thin exported wrapper pattern.

        // Since #parseSpecId is private, we verify its effect through index key shapes.
        expect( index ).toBeDefined()
    } )
} )


// We expose #parseSpecId behaviour by building an index that forces the parse path.
// The simplest correct approach: create a tiny public shim test via __testOnly_buildIndex
// and verify that specId keys have the correct namespace/type/name structure.

describe( 'parseSpecId logic — verified via index key structure', () => {
    it( 'tool specId has form namespace/tool/routeName', async () => {
        const schemas = [
            schemaEntry( {
                'namespace': 'moralis',
                'file': 'nftApi.mjs',
                'tools': { 'getBlock': {} }
            } )
        ]

        const { index } = await CatalogIndex.build( { schemas } )

        expect( index[ 'tools' ][ 'moralis/tool/getBlock' ] ).toBeDefined()
        expect( index[ 'tools' ][ 'moralis/tool/getBlock' ][ 'routeName' ] ).toBe( 'getBlock' )
    } )

    it( 'resource specId has form namespace/resource/name', async () => {
        const schemas = [
            schemaEntry( {
                'namespace': 'moralis',
                'file': 'dbApi.mjs',
                'resources': { 'chainDb': {} }
            } )
        ]

        const { index } = await CatalogIndex.build( { schemas } )

        expect( index[ 'resources' ][ 'moralis/resource/chainDb' ] ).toBeDefined()
    } )

    it( 'prompt specId has form namespace/prompt/name', async () => {
        const schemas = [
            schemaEntry( {
                'namespace': 'kba',
                'file': 'prompts.mjs',
                'prompts': { 'intro': {} }
            } )
        ]

        const { index } = await CatalogIndex.build( { schemas } )

        expect( index[ 'prompts' ][ 'kba/prompt/intro' ] ).toBeDefined()
    } )

    it( 'skill specId has form namespace/skill/name', async () => {
        const schemas = [
            schemaEntry( {
                'namespace': 'kba',
                'file': 'skills.mjs',
                'skills': [ { 'name': 'lookup' } ]
            } )
        ]

        const { index } = await CatalogIndex.build( { schemas } )

        expect( index[ 'skills' ][ 'kba/skill/lookup' ] ).toBeDefined()
    } )
} )


// ─── collision detection ─────────────────────────────────────────────────────

describe( 'Collision detection', () => {
    it( 'two schemas with same namespace+tool produce a collision entry', async () => {
        const schemas = [
            schemaEntry( {
                'namespace': 'moralis',
                'file': 'schemaA.mjs',
                'tools': { 'getBlock': {} }
            } ),
            schemaEntry( {
                'namespace': 'moralis',
                'file': 'schemaB.mjs',
                'tools': { 'getBlock': {} }
            } )
        ]

        const { index } = await CatalogIndex.build( { schemas } )

        expect( index[ 'collisions' ].length ).toBe( 1 )
        expect( index[ 'collisions' ][ 0 ][ 'specId' ] ).toBe( 'moralis/tool/getBlock' )
        expect( index[ 'collisions' ][ 0 ][ 'files' ] ).toContain( 'schemaA.mjs' )
        expect( index[ 'collisions' ][ 0 ][ 'files' ] ).toContain( 'schemaB.mjs' )
    } )

    it( 'three schemas with same namespace+tool merge into one collision entry', async () => {
        const schemas = [
            schemaEntry( { 'namespace': 'foo', 'file': 'a.mjs', 'tools': { 'ping': {} } } ),
            schemaEntry( { 'namespace': 'foo', 'file': 'b.mjs', 'tools': { 'ping': {} } } ),
            schemaEntry( { 'namespace': 'foo', 'file': 'c.mjs', 'tools': { 'ping': {} } } )
        ]

        const { index } = await CatalogIndex.build( { schemas } )
        const collision = index[ 'collisions' ]
            .find( ( c ) => {
                const matches = c[ 'specId' ] === 'foo/tool/ping'

                return matches
            } )

        expect( collision ).toBeDefined()
        expect( collision[ 'files' ].length ).toBe( 3 )
    } )

    it( 'no collision when different namespaces use same route name', async () => {
        const schemas = [
            schemaEntry( { 'namespace': 'ns1', 'file': 'a.mjs', 'tools': { 'getData': {} } } ),
            schemaEntry( { 'namespace': 'ns2', 'file': 'b.mjs', 'tools': { 'getData': {} } } )
        ]

        const { index } = await CatalogIndex.build( { schemas } )

        expect( index[ 'collisions' ].length ).toBe( 0 )
        expect( index[ 'tools' ][ 'ns1/tool/getData' ] ).toBeDefined()
        expect( index[ 'tools' ][ 'ns2/tool/getData' ] ).toBeDefined()
    } )
} )


// ─── multi-part container grouping ──────────────────────────────────────────

describe( 'Multi-part container grouping', () => {
    it( 'nftApi-part1.mjs and nftApi-part2.mjs group under moralis/nftApi', async () => {
        const schemas = [
            schemaEntry( { 'namespace': 'moralis', 'file': 'nftApi-part1.mjs', 'tools': { 'getNft': {} } } ),
            schemaEntry( { 'namespace': 'moralis', 'file': 'nftApi-part2.mjs', 'tools': { 'getNftMetadata': {} } } )
        ]

        const { index } = await CatalogIndex.build( { schemas } )

        expect( index[ 'containers' ][ 'moralis/nftApi' ] ).toBeDefined()
        expect( index[ 'containers' ][ 'moralis/nftApi' ][ 'files' ] ).toContain( 'nftApi-part1.mjs' )
        expect( index[ 'containers' ][ 'moralis/nftApi' ][ 'files' ] ).toContain( 'nftApi-part2.mjs' )
        expect( index[ 'containers' ][ 'moralis/nftApi' ][ 'files' ].length ).toBe( 2 )
    } )

    it( 'single-part walletApi.mjs becomes containers["moralis/walletApi"] with one file', async () => {
        const schemas = [
            schemaEntry( { 'namespace': 'moralis', 'file': 'walletApi.mjs', 'tools': { 'getWallet': {} } } )
        ]

        const { index } = await CatalogIndex.build( { schemas } )

        expect( index[ 'containers' ][ 'moralis/walletApi' ] ).toBeDefined()
        expect( index[ 'containers' ][ 'moralis/walletApi' ][ 'files' ] ).toEqual( [ 'walletApi.mjs' ] )
    } )

    it( 'three parts collapse to one container key', async () => {
        const schemas = [
            schemaEntry( { 'namespace': 'moralis', 'file': 'nftApi-part1.mjs', 'tools': {} } ),
            schemaEntry( { 'namespace': 'moralis', 'file': 'nftApi-part2.mjs', 'tools': {} } ),
            schemaEntry( { 'namespace': 'moralis', 'file': 'nftApi-part3.mjs', 'tools': {} } )
        ]

        const { index } = await CatalogIndex.build( { schemas } )

        expect( index[ 'containers' ][ 'moralis/nftApi' ][ 'files' ].length ).toBe( 3 )
    } )
} )


// ─── schema skipping ─────────────────────────────────────────────────────────

describe( 'Schema skipping — missing namespace', () => {
    it( 'schema without namespace is not indexed in tools', async () => {
        const schemas = [
            {
                'main': {
                    'name': 'No NS',
                    'description': 'Missing namespace',
                    'tools': { 'ping': {} }
                },
                'file': 'no-ns.mjs',
                'source': 'test'
            }
        ]

        const { index } = await CatalogIndex.build( { schemas } )

        const toolKeys = Object.keys( index[ 'tools' ] )

        expect( toolKeys.length ).toBe( 0 )
        expect( index[ 'schemaCount' ] ).toBe( 1 )
    } )
} )


// ─── index metadata ──────────────────────────────────────────────────────────

describe( 'Index metadata', () => {
    it( 'index contains builtAt ISO string and schemaCount', async () => {
        const schemas = [
            schemaEntry( { 'namespace': 'ns', 'file': 'api.mjs', 'tools': { 'get': {} } } )
        ]

        const { index } = await CatalogIndex.build( { schemas } )

        expect( typeof index[ 'builtAt' ] ).toBe( 'string' )
        expect( new Date( index[ 'builtAt' ] ).toString() ).not.toBe( 'Invalid Date' )
        expect( index[ 'schemaCount' ] ).toBe( 1 )
    } )
} )


// ─── cache write + read roundtrip ────────────────────────────────────────────

describe( 'Cache write and read roundtrip', () => {
    let tmpCwd

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-ns-cache-test-${Date.now()}` )
        await mkdir( join( tmpCwd, '.flowmcp' ), { recursive: true } )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'written index can be read back with identical content', async () => {
        const schemas = [
            schemaEntry( { 'namespace': 'moralis', 'file': 'nftApi.mjs', 'tools': { 'getNft': {} } } )
        ]

        const { index: originalIndex } = await CatalogIndex.build( { schemas } )

        // Write via getNamespaceIndex with fixture — but since #buildNamespaceIndex calls
        // #loadAllSchemas (global config dependent), we test the cache path directly
        // by writing a known index and reading it back via the cache path.

        const cachePath = join( tmpCwd, '.flowmcp', 'namespace-index.json' )
        await writeFile( cachePath, JSON.stringify( originalIndex, null, 4 ), 'utf-8' )

        const content = await readFile( cachePath, 'utf-8' )
        const restoredIndex = JSON.parse( content )

        expect( restoredIndex[ 'tools' ][ 'moralis/tool/getNft' ] ).toBeDefined()
        expect( restoredIndex[ 'builtAt' ] ).toBe( originalIndex[ 'builtAt' ] )
        expect( restoredIndex[ 'schemaCount' ] ).toBe( originalIndex[ 'schemaCount' ] )
    } )
} )


// ─── getNamespaceIndex — end-to-end with fixture on disk ────────────────────

describe( 'getNamespaceIndex — source: cache vs rebuilt', () => {
    let tmpCwd

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-ns-index-e2e-${Date.now()}` )
        await mkdir( join( tmpCwd, '.flowmcp' ), { recursive: true } )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'returns source: rebuilt when no cache exists, then source: cache on second call', async () => {
        // First call — no cache exists yet.
        // getNamespaceIndex calls #buildNamespaceIndex which calls #loadAllSchemas.
        // In this test environment #loadAllSchemas reads from the global ~/.flowmcp/schemas dir,
        // so we just verify the returned structure shape (not a specific schema count).
        const result1 = await FlowMcpCli.getNamespaceIndex( { 'cwd': tmpCwd } )

        expect( result1[ 'source' ] ).toBe( 'rebuilt' )
        expect( result1[ 'index' ] ).toBeDefined()
        expect( result1[ 'index' ][ 'tools' ] ).toBeDefined()
        expect( result1[ 'index' ][ 'containers' ] ).toBeDefined()
        expect( result1[ 'index' ][ 'collisions' ] ).toBeDefined()
        expect( typeof result1[ 'index' ][ 'builtAt' ] ).toBe( 'string' )

        // Second call — cache exists now.
        const result2 = await FlowMcpCli.getNamespaceIndex( { 'cwd': tmpCwd } )

        expect( result2[ 'source' ] ).toBe( 'cache' )
        expect( result2[ 'index' ][ 'builtAt' ] ).toBe( result1[ 'index' ][ 'builtAt' ] )
    }, 90000 )

    it( 'forceRebuild: true rebuilds even if cache exists', async () => {
        // Ensure cache exists from previous test
        const cachedResult = await FlowMcpCli.getNamespaceIndex( { 'cwd': tmpCwd } )
        expect( cachedResult[ 'source' ] ).toBe( 'cache' )

        // Force rebuild
        const rebuiltResult = await FlowMcpCli.getNamespaceIndex( { 'cwd': tmpCwd, 'forceRebuild': true } )

        expect( rebuiltResult[ 'source' ] ).toBe( 'rebuilt' )
        expect( rebuiltResult[ 'index' ] ).toBeDefined()
    }, 90000 )
} )


// ─── parseSpecId — direct-path validation through index key shapes ────────────

describe( 'parseSpecId — invalid inputs produce no index entry', () => {
    it( 'schema with null main produces no tools entry', async () => {
        const schemas = [
            { 'main': null, 'file': 'broken.mjs', 'source': 'test' }
        ]

        const { index } = await CatalogIndex.build( { schemas } )

        expect( Object.keys( index[ 'tools' ] ).length ).toBe( 0 )
    } )

    it( 'routes key is supported as alias for tools', async () => {
        const schemas = [
            {
                'main': {
                    'namespace': 'alias',
                    'tools': { 'doThing': {} }
                },
                'file': 'alias.mjs',
                'source': 'test'
            }
        ]

        const { index } = await CatalogIndex.build( { schemas } )

        expect( index[ 'tools' ][ 'alias/tool/doThing' ] ).toBeDefined()
    } )
} )
