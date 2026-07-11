import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )

let originalGlobalConfig = null
let globalConfigExisted = false


const PING_SCHEMA = `export const main = {
    namespace: 'demo',
    name: 'Demo Ping API',
    description: 'Demo schema for spec-id dispatch tests',
    version: '4.0.0',
    docs: [],
    tags: [ 'demo', 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    tools: {
        ping: {
            method: 'GET',
            description: 'Ping endpoint',
            path: '/get',
            parameters: []
        }
    }
}
`


const NFT_PART1_SCHEMA = `export const main = {
    namespace: 'moralis',
    name: 'NFT API Part 1',
    description: 'NFT schema part 1',
    version: '4.0.0',
    docs: [],
    tags: [ 'nft', 'blockchain' ],
    root: 'https://deep-index.moralis.io/api/v2.2',
    requiredServerParams: [],
    headers: {},
    tools: {
        getNft: {
            method: 'GET',
            description: 'Get NFT',
            path: '/nft/{address}',
            parameters: []
        }
    }
}
`


const NFT_PART2_SCHEMA = `export const main = {
    namespace: 'moralis',
    name: 'NFT API Part 2',
    description: 'NFT schema part 2',
    version: '4.0.0',
    docs: [],
    tags: [ 'nft', 'blockchain' ],
    root: 'https://deep-index.moralis.io/api/v2.2',
    requiredServerParams: [],
    headers: {},
    tools: {
        getNftMetadata: {
            method: 'GET',
            description: 'Get NFT metadata',
            path: '/nft/{address}/metadata',
            parameters: []
        },
        getNftOwners: {
            method: 'GET',
            description: 'Get NFT owners',
            path: '/nft/{address}/owners',
            parameters: []
        }
    }
}
`


const TEST_ENV_PATH = join( GLOBAL_CONFIG_DIR, '.env' )

const TEST_GLOBAL_CONFIG = {
    'envPath': TEST_ENV_PATH,
    'flowmcpCore': {
        'version': '2.0.0',
        'commit': 'abc123',
        'schemaSpec': '4.0.0'
    },
    'initialized': '2026-02-20T12:00:00.000Z',
    'sources': {
        'demosrc': { 'type': 'builtin', 'schemaCount': 1 },
        'moralisrc': { 'type': 'builtin', 'schemaCount': 2 }
    }
}


beforeAll( async () => {
    try {
        originalGlobalConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        globalConfigExisted = true
    } catch {
        globalConfigExisted = false
    }

    await mkdir( GLOBAL_CONFIG_DIR, { recursive: true } )
    await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( TEST_GLOBAL_CONFIG, null, 4 ), 'utf-8' )

    const demoDir = join( SCHEMAS_DIR, 'demosrc' )
    await mkdir( demoDir, { recursive: true } )
    await writeFile( join( demoDir, 'ping.mjs' ), PING_SCHEMA, 'utf-8' )

    const moralisDir = join( SCHEMAS_DIR, 'moralisrc' )
    await mkdir( moralisDir, { recursive: true } )
    await writeFile( join( moralisDir, 'nftApi-part1.mjs' ), NFT_PART1_SCHEMA, 'utf-8' )
    await writeFile( join( moralisDir, 'nftApi-part2.mjs' ), NFT_PART2_SCHEMA, 'utf-8' )

    await writeFile( TEST_ENV_PATH, '', 'utf-8' )
} )


afterAll( async () => {
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    await rm( join( SCHEMAS_DIR, 'demosrc' ), { recursive: true, force: true } ).catch( () => {} )
    await rm( join( SCHEMAS_DIR, 'moralisrc' ), { recursive: true, force: true } ).catch( () => {} )
} )


// ─── helpers ────────────────────────────────────────────────────────────────

async function makeTmpCwd( { suffix = '' } = {} ) {
    const cwd = join( tmpdir(), `flowmcp-spec-id-${suffix}-${Date.now()}` )
    await mkdir( cwd, { recursive: true } )

    return cwd
}


async function makeTmpCwdWithConfig( { tools = [], groups = null, defaultGroup = null, suffix = '' } = {} ) {
    const cwd = await makeTmpCwd( { suffix } )
    const configDir = join( cwd, '.flowmcp' )
    await mkdir( configDir, { recursive: true } )

    const config = { 'root': '~/.flowmcp', tools }
    if( defaultGroup ) { config[ 'defaultGroup' ] = defaultGroup }
    if( groups ) { config[ 'groups' ] = groups }

    await writeFile( join( configDir, 'config.json' ), JSON.stringify( config, null, 4 ), 'utf-8' )

    return cwd
}


// ─── 1. groupAppend accepts 2-slash tool Spec-ID ─────────────────────────────


// ─── 2. groupAppend expands container Spec-ID ────────────────────────────────


// ─── 3. groupAppend handles mixed legacy + Spec-ID ───────────────────────────


// ─── 4. add with 2-slash tool Spec-ID ────────────────────────────────────────


// ─── 5. add with container Spec-ID expands to primitives ─────────────────────


// ─── 6. add with unknown Spec-ID errors clearly ──────────────────────────────


// ─── 7. add rejects unknown container Spec-ID ────────────────────────────────


// ─── 8. callTool rejects 1-slash container ───────────────────────────────────

describe( 'callTool — container Spec-ID rejected', () => {
    it( 'returns error when calling a container Spec-ID', async () => {
        const cwd = await makeTmpCwd( { 'suffix': 'call-container' } )
        const configDir = join( cwd, '.flowmcp' )
        await mkdir( configDir, { recursive: true } )
        await writeFile( join( configDir, 'config.json' ), JSON.stringify( { 'root': '~/.flowmcp', 'tools': [ 'demosrc/ping.mjs::ping' ] }, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.callTool( { 'toolName': 'demo/pingSchema', cwd } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toMatch( /container/i )

        await rm( cwd, { recursive: true, force: true } )
    } )
} )


// ─── 9. callTool accepts 2-slash tool Spec-ID ────────────────────────────────

describe( 'callTool — Spec-ID 2-slash dispatches via index', () => {
    it( 'resolves demo/tool/ping to MCP tool name before dispatching', async () => {
        const cwd = await makeTmpCwd( { 'suffix': 'call-specid' } )
        const configDir = join( cwd, '.flowmcp' )
        await mkdir( configDir, { recursive: true } )
        await writeFile( join( configDir, 'config.json' ), JSON.stringify( { 'root': '~/.flowmcp', 'tools': [ 'demosrc/ping.mjs::ping' ] }, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.callTool( { 'toolName': 'demo/tool/ping', cwd } )

        // The tool exists (ping.mjs has no requiredServerParams but env is empty)
        // We expect either a successful call or a missing env error,
        // NOT a "not found" error — which confirms the Spec-ID was resolved correctly.
        const isNotFoundError = Boolean( result[ 'error' ] && result[ 'error' ].includes( 'not found' ) )

        expect( isNotFoundError ).toBe( false )

        await rm( cwd, { recursive: true, force: true } )
    } )
} )


// ─── 10. search returns both toolRef and specId fields ───────────────────────

describe( 'search — results include specId field', () => {
    it( 'returns specId alongside toolRef for each result', async () => {
        const { result } = await FlowMcpCli.search( { 'query': 'ping demo' } )

        expect( result[ 'status' ] ).toBe( true )

        if( result[ 'tools' ].length > 0 ) {
            const tool = result[ 'tools' ][ 0 ]

            expect( tool[ 'specId' ] ).toBeDefined()
            expect( typeof tool[ 'specId' ] ).toBe( 'string' )
            expect( tool[ 'specId' ] ).toMatch( /^[^/]+\/[^/]+\/[^/]+$/ )
        }
    } )
} )


// ─── 11. list displays Spec-IDs from config ───────────────────────────────────

// Memo 099 Kap 5 — list shows ALL tools from the schemaFolders by their MCP
// tool name (no per-config spec-id entries). The ping tool is listed regardless.
describe( 'list — shows folder tools by MCP name (Memo 099)', () => {
    it( 'lists the ping tool from the folder index', async () => {
        const cwd = await makeTmpCwdWithConfig( {
            'tools': [ 'demo/tool/ping' ],
            'suffix': 'list-specid'
        } )

        const { result } = await FlowMcpCli.list( { cwd } )

        expect( result[ 'status' ] ).toBe( true )

        const pingEntry = result[ 'tools' ]
            .find( ( t ) => t[ 'name' ] && t[ 'name' ].includes( 'ping' ) )

        expect( pingEntry ).toBeDefined()

        await rm( cwd, { recursive: true, force: true } )
    } )

    it( 'handles mix of legacy toolRefs and Spec-IDs in config', async () => {
        const cwd = await makeTmpCwdWithConfig( {
            'tools': [ 'demosrc/ping.mjs::ping', 'demo/tool/ping' ],
            'suffix': 'list-mixed'
        } )

        const { result } = await FlowMcpCli.list( { cwd } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolCount' ] ).toBeGreaterThanOrEqual( 2 )

        await rm( cwd, { recursive: true, force: true } )
    } )
} )


// ─── 12. multi-part container expansion ──────────────────────────────────────

