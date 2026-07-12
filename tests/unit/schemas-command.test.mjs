import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { VALID_REGISTRY } from '../helpers/config.mjs'
import { createTestHome } from '../helpers/test-home.mjs'

const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


// Memo 152 / PRD-020 (G-12) — schemaFolders[] is the single source of truth. Each folder's
// schemas live under <folder>/providers; a _registry.json there declares the schema list,
// otherwise the providers dir is FS-scanned. The legacy ~/.flowmcp/schemas disk-scan is gone.
const testHome = createTestHome( { suite: 'schemas-cmd' } )
const GLOBAL_CONFIG_PATH = testHome.globalConfigPath
const SCHEMAS_DIR = testHome.schemasDir

const GLOBAL_CONFIG = {
    'envPath': join( testHome.globalConfigDir, '.env' ),
    'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc123', 'schemaSpec': '4.0.0' },
    'initialized': '2026-02-20T12:00:00.000Z',
    'schemaFolders': [
        { 'name': 'demo', 'path': '~/.flowmcp/schemas/demo' },
        { 'name': 'flowmcp-community', 'path': '~/.flowmcp/schemas/flowmcp-community' }
    ]
}

beforeAll( async () => {
    await testHome.setup()
    await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( GLOBAL_CONFIG, null, 4 ), 'utf-8' )

    // demo: no registry -> FS scan of providers finds the single .mjs file.
    const demoDir = join( SCHEMAS_DIR, 'demo', 'providers' )
    await mkdir( demoDir, { recursive: true } )
    await writeFile(
        join( demoDir, 'ping.mjs' ),
        `export default { namespace: 'demo', name: 'Ping Demo' }\n`,
        'utf-8'
    )

    // flowmcp-community: a _registry.json declares two schemas.
    const communityDir = join( SCHEMAS_DIR, 'flowmcp-community', 'providers' )
    await mkdir( join( communityDir, 'coincap' ), { recursive: true } )
    await mkdir( join( communityDir, 'coingecko-com' ), { recursive: true } )

    await writeFile(
        join( communityDir, '_registry.json' ),
        JSON.stringify( VALID_REGISTRY, null, 4 ),
        'utf-8'
    )

    await writeFile(
        join( communityDir, 'coincap', 'assets.mjs' ),
        `export default { namespace: 'coincap', name: 'CoinCap Assets' }\n`,
        'utf-8'
    )

    await writeFile(
        join( communityDir, 'coingecko-com', 'prices.mjs' ),
        `export default { namespace: 'coingecko', name: 'CoinGecko Prices' }\n`,
        'utf-8'
    )
} )

afterAll( async () => {
    await testHome.teardown()
} )


describe( 'FlowMcpCli.schemas — schemaFolders[] enumeration', () => {
    it( 'returns status true', async () => {
        const { result } = await FlowMcpCli.schemas()

        expect( result[ 'status' ] ).toBe( true )
    } )


    it( 'lists demo source (FS-scanned, type local)', async () => {
        const { result } = await FlowMcpCli.schemas()
        const { sources } = result

        const demoSource = sources
            .find( ( source ) => {
                const isDemo = source[ 'name' ] === 'demo'

                return isDemo
            } )

        expect( demoSource ).toBeDefined()
        expect( demoSource[ 'type' ] ).toBe( 'local' )
    } )


    it( 'lists community source with schemas from registry', async () => {
        const { result } = await FlowMcpCli.schemas()
        const { sources } = result

        const communitySource = sources
            .find( ( source ) => {
                const isCommunity = source[ 'name' ] === 'flowmcp-community'

                return isCommunity
            } )

        expect( communitySource ).toBeDefined()
        expect( communitySource[ 'type' ] ).toBe( 'local' )
        expect( communitySource[ 'schemaCount' ] ).toBe( 2 )
        expect( communitySource[ 'schemas' ].length ).toBe( 2 )
    } )


    it( 'includes schema details from registry', async () => {
        const { result } = await FlowMcpCli.schemas()
        const { sources } = result

        const communitySource = sources
            .find( ( source ) => {
                const isCommunity = source[ 'name' ] === 'flowmcp-community'

                return isCommunity
            } )

        const coincapSchema = communitySource[ 'schemas' ]
            .find( ( schema ) => {
                const isCoincap = schema[ 'namespace' ] === 'coincap'

                return isCoincap
            } )

        expect( coincapSchema ).toBeDefined()
        expect( coincapSchema[ 'file' ] ).toBe( 'coincap/assets.mjs' )
        expect( coincapSchema[ 'name' ] ).toBe( 'CoinCap Assets API' )
        expect( coincapSchema[ 'requiredServerParams' ] ).toContain( 'COINCAP_API_KEY' )
    } )
} )
