import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createTestHome } from '../helpers/test-home.mjs'

const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


// Regression cover for PRD-007 (Memo 070): the CLI catalog only scanned
// ~/.flowmcp/schemas/<source>. v4-private provider tools (e.g. ethersread's
// readContractFunction) lived outside that tree and were invisible to
// list/search/add/call. `catalog link` registers a local directory as a
// catalog source, resolved in-place (no copy), making those tools usable.

const testHome = createTestHome( { suite: 'catalog-local' } )
const GLOBAL_CONFIG_PATH = testHome.globalConfigPath
const LOCAL_SOURCE_DIR = join( tmpdir(), 'flowmcp-cli-local-source-v4' )
const TEST_CWD = join( tmpdir(), 'flowmcp-cli-catalog-local-cwd' )

const ABI_READ_SCHEMA = `export const main = {
    namespace: 'ethersread',
    name: 'Ethers Generic ABI Read',
    description: 'Read a view/pure function from an EVM contract via a live RPC and a supplied ABI',
    version: '4.0.0',
    docs: [],
    tags: [ 'blockchain', 'evm', 'abi', 'read' ],
    root: 'https://example.invalid',
    requiredServerParams: [],
    tools: {
        readContractFunction: {
            method: 'GET',
            description: 'Read a view/pure function from an EVM contract via ABI and a live RPC',
            path: '/read',
            parameters: [
                {
                    position: { key: 'address', value: '{{USER_PARAM}}', location: 'query' },
                    z: { primitive: 'string()', options: [] }
                },
                {
                    position: { key: 'functionName', value: '{{USER_PARAM}}', location: 'query' },
                    z: { primitive: 'string()', options: [] }
                }
            ],
            tests: [ { _description: 'read decimals', address: '0x0', functionName: 'decimals' } ]
        }
    }
}
`

const SKILL_DOC = `export const skill = {
    name: 'evm-contract-read-via-name',
    version: 'flowmcp/4.0.0',
    description: 'Skill doc — not a schema, must be skipped by the catalog',
    requires: { tools: [ 'readContractFunction' ], external: [] },
    content: 'irrelevant'
}
`

const TEST_GLOBAL_CONFIG = {
    'envPath': join( TEST_CWD, '.env' ),
    'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc123', 'schemaSpec': '4.0.0' },
    'initialized': '2026-05-28T12:00:00.000Z'
}


beforeAll( async () => {
    await testHome.setup()
    await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( TEST_GLOBAL_CONFIG, null, 4 ), 'utf-8' )

    // Local source mimics the v4-private layout: providers/<provider>/<schema>.mjs
    // plus a providers/<provider>/skills/<skill>.mjs doc that must be skipped.
    const ethersDir = join( LOCAL_SOURCE_DIR, 'ethers' )
    const skillsDir = join( ethersDir, 'skills' )
    await mkdir( skillsDir, { recursive: true } )
    await writeFile( join( ethersDir, 'abi-read.mjs' ), ABI_READ_SCHEMA, 'utf-8' )
    await writeFile( join( skillsDir, 'evm-contract-read-via-name.mjs' ), SKILL_DOC, 'utf-8' )

    await mkdir( TEST_CWD, { recursive: true } )
    await writeFile( join( TEST_CWD, '.env' ), '\n', 'utf-8' )
} )

afterAll( async () => {
    await rm( LOCAL_SOURCE_DIR, { recursive: true, force: true } )
    await rm( TEST_CWD, { recursive: true, force: true } )
    await testHome.teardown()
} )


describe( 'FlowMcpCli.catalogLink — validation', () => {
    it( 'returns error when name is missing', async () => {
        const { result } = await FlowMcpCli.catalogLink( { name: undefined, path: LOCAL_SOURCE_DIR } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Missing source name' )
    } )


    it( 'returns error when path is missing', async () => {
        const { result } = await FlowMcpCli.catalogLink( { name: 'v4private', path: '   ' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Missing source path' )
    } )


    it( 'returns error when path does not exist', async () => {
        const missing = join( tmpdir(), 'flowmcp-cli-does-not-exist-xyz' )
        const { result } = await FlowMcpCli.catalogLink( { name: 'v4private', path: missing } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'does not exist' )
    } )
} )


describe( 'FlowMcpCli.catalogLink — link + discovery', () => {
    it( 'links a local directory and counts its schemas', async () => {
        const { result } = await FlowMcpCli.catalogLink( { name: 'v4private', path: LOCAL_SOURCE_DIR } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'linked' ] ).toBe( 'v4private' )
        expect( result[ 'schemaCount' ] ).toBe( 1 )
    } )


    it( 'persists the local source in the global config', async () => {
        const raw = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        const config = JSON.parse( raw )

        expect( config[ 'localSources' ] ).toBeDefined()
        expect( config[ 'localSources' ][ 'v4private' ] ).toBeDefined()
        expect( typeof config[ 'localSources' ][ 'v4private' ][ 'path' ] ).toBe( 'string' )
    } )


    it( 'surfaces the linked source via catalogSources', async () => {
        const { result } = await FlowMcpCli.catalogSources()

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'count' ] ).toBe( 1 )

        const names = result[ 'sources' ]
            .map( ( entry ) => entry[ 'name' ] )

        expect( names ).toContain( 'v4private' )
    } )


    it( 'makes a v4-private tool searchable after link', async () => {
        const { result } = await FlowMcpCli.search( { query: 'abi read evm' } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'matchCount' ] ).toBeGreaterThan( 0 )

        const match = result[ 'tools' ]
            .find( ( tool ) => tool[ 'namespace' ] === 'ethersread' )

        expect( match ).toBeDefined()
    } )


    it( 'skips skills/ docs (not schemas) in a local source', async () => {
        const { result } = await FlowMcpCli.search( { query: 'abi read evm' } )

        const skillEntry = result[ 'tools' ]
            .find( ( tool ) => tool[ 'name' ] && tool[ 'name' ].includes( 'evm-contract-read-via-name' ) )

        expect( skillEntry ).toBeUndefined()
    } )


} )


describe( 'FlowMcpCli.catalogUnlink', () => {
    it( 'returns error when name is missing', async () => {
        const { result } = await FlowMcpCli.catalogUnlink( { name: '' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Missing source name' )
    } )


    it( 'returns error when the source is not linked', async () => {
        const { result } = await FlowMcpCli.catalogUnlink( { name: 'not-linked-xyz' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'not linked' )
    } )


    it( 'unlinks a previously linked source', async () => {
        const { result } = await FlowMcpCli.catalogUnlink( { name: 'v4private' } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'unlinked' ] ).toBe( 'v4private' )

        const { result: sources } = await FlowMcpCli.catalogSources()

        expect( sources[ 'count' ] ).toBe( 0 )
    } )


    it( 'removes the unlinked tool from search results', async () => {
        const { result } = await FlowMcpCli.search( { query: 'abi read evm' } )

        const match = result[ 'tools' ]
            .find( ( tool ) => tool[ 'namespace' ] === 'ethersread' )

        expect( match ).toBeUndefined()
    } )
} )
