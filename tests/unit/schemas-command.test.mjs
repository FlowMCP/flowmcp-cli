import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import { VALID_GLOBAL_CONFIG_WITH_SOURCES, VALID_REGISTRY } from '../helpers/config.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )

let originalGlobalConfig = null
let globalConfigExisted = false

beforeAll( async () => {
    try {
        const { readFile } = await import( 'node:fs/promises' )
        originalGlobalConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        globalConfigExisted = true
    } catch {
        globalConfigExisted = false
    }

    await mkdir( GLOBAL_CONFIG_DIR, { recursive: true } )
    await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( VALID_GLOBAL_CONFIG_WITH_SOURCES, null, 4 ), 'utf-8' )

    const demoDir = join( SCHEMAS_DIR, 'demo' )
    await mkdir( demoDir, { recursive: true } )
    await writeFile(
        join( demoDir, 'ping.mjs' ),
        `export default { namespace: 'demo', name: 'Ping Demo' }\n`,
        'utf-8'
    )

    const communityDir = join( SCHEMAS_DIR, 'flowmcp-community' )
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
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    await rm( join( SCHEMAS_DIR, 'flowmcp-community' ), { recursive: true, force: true } )
} )


describe( 'FlowMcpCli.schemas', () => {
    it( 'returns status true', async () => {
        const { result } = await FlowMcpCli.schemas()

        expect( result[ 'status' ] ).toBe( true )
    } )


    it( 'lists demo source', async () => {
        const { result } = await FlowMcpCli.schemas()
        const { sources } = result

        const demoSource = sources
            .find( ( source ) => {
                const isDemo = source[ 'name' ] === 'demo'

                return isDemo
            } )

        expect( demoSource ).toBeDefined()
        expect( demoSource[ 'type' ] ).toBe( 'builtin' )
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
        expect( communitySource[ 'type' ] ).toBe( 'github' )
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
