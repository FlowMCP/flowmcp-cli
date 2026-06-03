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

describe( 'groupAppend — Spec-ID 2-slash tool', () => {
    it( 'accepts demo/tool/ping and appends it to a group', async () => {
        const cwd = await makeTmpCwd( { 'suffix': 'ga-specid' } )

        const { result } = await FlowMcpCli.groupAppend( {
            'name': 'spec-group',
            'tools': 'demo/tool/ping',
            cwd
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolCount' ] ).toBe( 1 )
        expect( result[ 'tools' ] ).toContain( 'demo/tool/ping' )

        await rm( cwd, { recursive: true, force: true } )
    }, 90000 )
} )


// ─── 2. groupAppend expands container Spec-ID ────────────────────────────────

describe( 'groupAppend — container Spec-ID expansion', () => {
    it( 'expands moralis/nftApi container to all primitive Spec-IDs', async () => {
        const cwd = await makeTmpCwd( { 'suffix': 'ga-container' } )

        const { result } = await FlowMcpCli.groupAppend( {
            'name': 'nft-group',
            'tools': 'moralis/nftApi',
            cwd
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'tools' ] ).toContain( 'moralis/tool/getNft' )
        expect( result[ 'tools' ] ).toContain( 'moralis/tool/getNftMetadata' )
        expect( result[ 'tools' ] ).toContain( 'moralis/tool/getNftOwners' )
        expect( result[ 'toolCount' ] ).toBe( 3 )

        await rm( cwd, { recursive: true, force: true } )
    } )
} )


// ─── 3. groupAppend handles mixed legacy + Spec-ID ───────────────────────────

describe( 'groupAppend — mixed legacy and Spec-ID', () => {
    it( 'processes legacy ref and Spec-ID in same comma-separated input', async () => {
        const cwd = await makeTmpCwd( { 'suffix': 'ga-mixed' } )

        const { result } = await FlowMcpCli.groupAppend( {
            'name': 'mixed-group',
            'tools': 'demosrc/ping.mjs::ping, demo/tool/ping',
            cwd
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'tools' ] ).toContain( 'demosrc/ping.mjs::ping' )
        expect( result[ 'tools' ] ).toContain( 'demo/tool/ping' )

        await rm( cwd, { recursive: true, force: true } )
    } )
} )


// ─── 4. add with 2-slash tool Spec-ID ────────────────────────────────────────

describe( 'add — Spec-ID 2-slash tool', () => {
    it( 'adds demo/tool/ping to config as Spec-ID', async () => {
        const cwd = await makeTmpCwd( { 'suffix': 'add-specid' } )
        const configDir = join( cwd, '.flowmcp' )
        await mkdir( configDir, { recursive: true } )
        await writeFile( join( configDir, 'config.json' ), JSON.stringify( { 'root': '~/.flowmcp', 'tools': [] }, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.add( { 'toolName': 'demo/tool/ping', cwd } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'added' ] ).toBe( 'demo/tool/ping' )

        const raw = await readFile( join( configDir, 'config.json' ), 'utf-8' )
        const config = JSON.parse( raw )

        expect( config[ 'tools' ] ).toContain( 'demo/tool/ping' )

        await rm( cwd, { recursive: true, force: true } )
    } )
} )


// ─── 5. add with container Spec-ID expands to primitives ─────────────────────

describe( 'add — container Spec-ID expansion', () => {
    it( 'expands moralis/nftApi and adds all primitives', async () => {
        const cwd = await makeTmpCwd( { 'suffix': 'add-container' } )
        const configDir = join( cwd, '.flowmcp' )
        await mkdir( configDir, { recursive: true } )
        await writeFile( join( configDir, 'config.json' ), JSON.stringify( { 'root': '~/.flowmcp', 'tools': [] }, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.add( { 'toolName': 'moralis/nftApi', cwd } )

        expect( result[ 'status' ] ).toBe( true )

        const raw = await readFile( join( configDir, 'config.json' ), 'utf-8' )
        const config = JSON.parse( raw )

        expect( config[ 'tools' ] ).toContain( 'moralis/tool/getNft' )
        expect( config[ 'tools' ] ).toContain( 'moralis/tool/getNftMetadata' )
        expect( config[ 'tools' ] ).toContain( 'moralis/tool/getNftOwners' )

        await rm( cwd, { recursive: true, force: true } )
    } )
} )


// ─── 6. add with unknown Spec-ID errors clearly ──────────────────────────────

describe( 'add — unknown Spec-ID', () => {
    it( 'returns error for Spec-ID not found in index', async () => {
        const cwd = await makeTmpCwd( { 'suffix': 'add-unknown' } )
        const configDir = join( cwd, '.flowmcp' )
        await mkdir( configDir, { recursive: true } )
        await writeFile( join( configDir, 'config.json' ), JSON.stringify( { 'root': '~/.flowmcp', 'tools': [] }, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.add( { 'toolName': 'unknown/tool/doesNotExist', cwd } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toMatch( /not found/ )

        await rm( cwd, { recursive: true, force: true } )
    } )
} )


// ─── 7. add rejects unknown container Spec-ID ────────────────────────────────

describe( 'add — nonexistent 1-slash container', () => {
    it( 'returns clear error for container that does not exist', async () => {
        const cwd = await makeTmpCwd( { 'suffix': 'add-nocontainer' } )
        const configDir = join( cwd, '.flowmcp' )
        await mkdir( configDir, { recursive: true } )
        await writeFile( join( configDir, 'config.json' ), JSON.stringify( { 'root': '~/.flowmcp', 'tools': [] }, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.add( { 'toolName': 'demo/noSuchSchema', cwd } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toMatch( /not found/ )

        await rm( cwd, { recursive: true, force: true } )
    } )
} )


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

describe( 'list — Spec-ID entries in config', () => {
    it( 'includes Spec-ID entry in output when config has a Spec-ID ref', async () => {
        const cwd = await makeTmpCwdWithConfig( {
            'tools': [ 'demo/tool/ping' ],
            'suffix': 'list-specid'
        } )

        const { result } = await FlowMcpCli.list( { cwd } )

        expect( result[ 'status' ] ).toBe( true )

        const specEntry = result[ 'tools' ]
            .find( ( t ) => {
                const isSpecId = t[ 'specId' ] === 'demo/tool/ping'

                return isSpecId
            } )

        expect( specEntry ).toBeDefined()
        expect( specEntry[ 'name' ] ).toBe( 'demo/tool/ping' )

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

describe( 'Multi-part container expansion via groupAppend', () => {
    it( 'nftApi with part1 and part2 expands to 3 tools total', async () => {
        const cwd = await makeTmpCwd( { 'suffix': 'multipart' } )

        const { result } = await FlowMcpCli.groupAppend( {
            'name': 'full-nft',
            'tools': 'moralis/nftApi',
            cwd
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolCount' ] ).toBe( 3 )

        const toolIds = result[ 'tools' ]

        expect( toolIds ).toContain( 'moralis/tool/getNft' )
        expect( toolIds ).toContain( 'moralis/tool/getNftMetadata' )
        expect( toolIds ).toContain( 'moralis/tool/getNftOwners' )

        await rm( cwd, { recursive: true, force: true } )
    } )
} )
