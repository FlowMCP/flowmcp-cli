import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { createTestHome } from '../helpers/test-home.mjs'

const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


// Memo 099 Phase 3 — a tool whose requiredServerParams are missing from the
// .env is flagged disabled (visible, never hidden) in both list and search.
const testHome = createTestHome( { suite: 'disabled-flag' } )
const GLOBAL_CONFIG_PATH = testHome.globalConfigPath

const KEYLESS_SCHEMA = `export const main = {
    namespace: 'freeapi',
    name: 'Free API',
    description: 'A keyless tool that is always available',
    version: '4.0.0',
    docs: [], tags: [ 'free' ], root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    tools: { ping: { method: 'GET', description: 'free ping', path: '/get', parameters: [], tests: [] } }
}
`

const KEYED_SCHEMA = `export const main = {
    namespace: 'paidapi',
    name: 'Paid API',
    description: 'A tool that needs an API key',
    version: '4.0.0',
    docs: [], tags: [ 'paid' ], root: 'https://api.example.com',
    requiredServerParams: [ 'PAID_API_KEY' ],
    headers: { 'Authorization': 'Bearer {{PAID_API_KEY}}' },
    tools: { fetchData: { method: 'GET', description: 'paid fetch data', path: '/data', parameters: [], tests: [] } }
}
`


beforeAll( async () => {
    await testHome.setup()

    const globalConfig = {
        'envPath': join( testHome.globalConfigDir, '.env' ),
        'initialized': '2026-06-03T12:00:00.000Z',
        'schemaFolders': [
            { 'name': 'development', 'path': join( testHome.root, 'schemas', 'v4.0.0' ) }
        ]
    }
    await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
    // empty env — PAID_API_KEY is absent
    await writeFile( join( testHome.globalConfigDir, '.env' ), '', 'utf-8' )

    const providersDir = join( testHome.root, 'schemas', 'v4.0.0', 'providers' )
    await mkdir( join( providersDir, 'freeapi' ), { recursive: true } )
    await mkdir( join( providersDir, 'paidapi' ), { recursive: true } )
    await writeFile( join( providersDir, 'freeapi', 'free.mjs' ), KEYLESS_SCHEMA, 'utf-8' )
    await writeFile( join( providersDir, 'paidapi', 'paid.mjs' ), KEYED_SCHEMA, 'utf-8' )
} )

afterAll( async () => {
    await testHome.teardown()
} )


describe( 'Memo 099 — disabled-flag display (missing keys)', () => {
    it( 'list flags the key-gated tool as disabled and leaves the keyless one enabled', async () => {
        const { result } = await FlowMcpCli.list( { cwd: testHome.root } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'disabledCount' ] ).toBeGreaterThanOrEqual( 1 )

        const paid = result[ 'tools' ]
            .find( ( tool ) => tool[ 'name' ].includes( 'fetch_data' ) || tool[ 'name' ].includes( 'paidapi' ) )
        const free = result[ 'tools' ]
            .find( ( tool ) => tool[ 'name' ].includes( 'ping' ) && tool[ 'name' ].includes( 'freeapi' ) )

        expect( paid ).toBeDefined()
        expect( paid[ 'disabled' ] ).toBe( true )
        expect( paid[ 'disabledReason' ] ).toContain( 'PAID_API_KEY' )

        expect( free ).toBeDefined()
        expect( free[ 'disabled' ] ).toBeUndefined()
    } )


    it( 'search flags the key-gated tool as disabled', async () => {
        const { result } = await FlowMcpCli.search( { query: 'paidapi paid' } )

        expect( result[ 'status' ] ).toBe( true )

        const paid = result[ 'tools' ]
            .find( ( tool ) => tool[ 'namespace' ] === 'paidapi' )

        expect( paid ).toBeDefined()
        expect( paid[ 'disabled' ] ).toBe( true )
        expect( paid[ 'disabledReason' ] ).toContain( 'PAID_API_KEY' )
    } )


    it( 'call on a disabled tool returns a friendly error, not a global abort', async () => {
        const { result } = await FlowMcpCli.callTool( { toolName: 'fetch_data_paidapi', jsonArgs: '{}', cwd: testHome.root } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'PAID_API_KEY' )
        expect( result[ 'fix' ] ).toContain( 'remain callable' )
    } )
} )
