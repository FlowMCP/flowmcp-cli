import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { createTestHome } from '../helpers/test-home.mjs'

const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


// PRD-008 — the schemaFolders[] `name` is the source coordinate. Two folders with
// the SAME name are a hard config error; two folders with DISTINCT names carrying
// the SAME provider must resolve via the "<source>:" prefix.

const ETHERSCAN_SCHEMA = `export const main = {
    namespace: 'etherscan',
    name: 'Etherscan API',
    description: 'Block explorer',
    version: '4.0.0',
    docs: [],
    tags: [ 'chain' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    tools: {
        getBalance: {
            method: 'GET',
            description: 'Get balance',
            path: '/get',
            parameters: [],
            tests: [ { _description: 'balance' } ]
        }
    }
}
`


// ─── Duplicate folder name = hard error ──────────────────────────────────────

describe( 'PRD-008 — duplicate schemaFolders[] name is a hard error', () => {
    const testHome = createTestHome( { suite: 'src-dup-name' } )

    beforeAll( async () => {
        await testHome.setup()

        const globalConfig = {
            'envPath': join( testHome.globalConfigDir, '.env' ),
            'initialized': '2026-06-04T00:00:00.000Z',
            'schemaFolders': [
                { 'name': 'shared', 'path': '~/a/v4.0.0' },
                { 'name': 'shared', 'path': '~/b/v4.0.0' }
            ]
        }
        await writeFile( testHome.globalConfigPath, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
        await writeFile( join( testHome.globalConfigDir, '.env' ), '', 'utf-8' )

        const aDir = join( testHome.root, 'a', 'v4.0.0', 'providers', 'etherscan' )
        const bDir = join( testHome.root, 'b', 'v4.0.0', 'providers', 'etherscan' )
        await mkdir( aDir, { recursive: true } )
        await mkdir( bDir, { recursive: true } )
        await writeFile( join( aDir, 'etherscan.mjs' ), ETHERSCAN_SCHEMA, 'utf-8' )
        await writeFile( join( bDir, 'etherscan.mjs' ), ETHERSCAN_SCHEMA, 'utf-8' )
    } )

    afterAll( async () => {
        await testHome.teardown()
    } )

    it( 'list rejects two folders that share the same name', async () => {
        const { result } = await FlowMcpCli.list( { cwd: testHome.root } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toMatch( /Duplicate schemaFolders\[\] name/ )
        expect( result[ 'fix' ] ).toMatch( /distinct "name"/ )
    } )
} )


// ─── Distinct names, same provider = "<source>:" disambiguation ──────────────

describe( 'PRD-008 — same provider in two folders resolves via source prefix', () => {
    const testHome = createTestHome( { suite: 'src-two-folders' } )

    beforeAll( async () => {
        await testHome.setup()

        const globalConfig = {
            'envPath': join( testHome.globalConfigDir, '.env' ),
            'initialized': '2026-06-04T00:00:00.000Z',
            'schemaFolders': [
                { 'name': 'Development', 'path': '~/dev/v4.0.0' },
                { 'name': 'Production', 'path': '~/prod/v4.0.0' }
            ]
        }
        await writeFile( testHome.globalConfigPath, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
        await writeFile( join( testHome.globalConfigDir, '.env' ), '', 'utf-8' )

        const devDir = join( testHome.root, 'dev', 'v4.0.0', 'providers', 'etherscan' )
        const prodDir = join( testHome.root, 'prod', 'v4.0.0', 'providers', 'etherscan' )
        await mkdir( devDir, { recursive: true } )
        await mkdir( prodDir, { recursive: true } )
        await writeFile( join( devDir, 'etherscan.mjs' ), ETHERSCAN_SCHEMA, 'utf-8' )
        await writeFile( join( prodDir, 'etherscan.mjs' ), ETHERSCAN_SCHEMA, 'utf-8' )
    } )

    afterAll( async () => {
        await testHome.teardown()
    } )

    it( 'list-tools shows the source coordinate for each entry', async () => {
        const { result } = await FlowMcpCli.callListTools( { cwd: testHome.root } )

        expect( result[ 'status' ] ).toBe( true )

        const sources = result[ 'tools' ]
            .filter( ( tool ) => tool[ 'namespace' ] === 'etherscan' )
            .map( ( tool ) => tool[ 'source' ] )

        expect( sources ).toContain( 'Development' )
        expect( sources ).toContain( 'Production' )
    } )

    it( 'an unknown "<source>:" prefix is a hard error (no first-wins guess)', async () => {
        const { result } = await FlowMcpCli.callTool( {
            toolName: 'Nonexistent:etherscan/tool/getBalance',
            jsonArgs: null,
            cwd: testHome.root
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toMatch( /No schemaFolders\[\] source named "Nonexistent"/ )
    } )
} )
