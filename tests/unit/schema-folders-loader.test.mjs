import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { createTestHome } from '../helpers/test-home.mjs'

const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


// Memo 099 Phase 1 — schemaFolders[] loader. The global home mock points
// homedir() at testHome.root, so a "~/..." schemaFolders path resolves into
// the isolated test home. We exercise the private loader through the public
// search() command (which reads #listSources -> #listAvailableTools).
const testHome = createTestHome( { suite: 'schema-folders' } )
const GLOBAL_CONFIG_PATH = testHome.globalConfigPath

const DEMO_SCHEMA = `export const main = {
    namespace: 'folderdemo',
    name: 'Folder Demo API',
    description: 'Schema loaded directly from a schemaFolders path',
    version: '4.0.0',
    docs: [],
    tags: [ 'folder', 'demo' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    tools: {
        ping: {
            method: 'GET',
            description: 'Folder ping endpoint',
            path: '/get',
            parameters: [],
            tests: [ { _description: 'ping' } ]
        }
    }
}
`

const SKIPPED_SCHEMA = `export const main = {
    namespace: 'shouldskip',
    name: 'Should Be Skipped',
    description: 'Lives under a _-prefixed dir and must not be loaded',
    version: '4.0.0',
    docs: [],
    tags: [ 'skip' ],
    root: 'https://example.com',
    requiredServerParams: [],
    headers: {},
    tools: {
        nope: { method: 'GET', description: 'must not appear', path: '/x', parameters: [], tests: [] }
    }
}
`


beforeAll( async () => {
    await testHome.setup()

    // schemaFolders path uses ~ — resolves to testHome.root via the mocked homedir()
    const globalConfig = {
        'envPath': join( testHome.globalConfigDir, '.env' ),
        'initialized': '2026-06-03T12:00:00.000Z',
        'schemaFolders': [
            { 'name': 'development', 'path': '~/myschemas/v4.0.0' }
        ]
    }
    await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
    await writeFile( join( testHome.globalConfigDir, '.env' ), '', 'utf-8' )

    const providersDir = join( testHome.root, 'myschemas', 'v4.0.0', 'providers' )
    const demoDir = join( providersDir, 'folderdemo' )
    await mkdir( demoDir, { recursive: true } )
    await writeFile( join( demoDir, 'demo.mjs' ), DEMO_SCHEMA, 'utf-8' )

    // a _-prefixed dir under providers must be skipped by the loader
    const skipDir = join( providersDir, '_shared' )
    await mkdir( skipDir, { recursive: true } )
    await writeFile( join( skipDir, 'ignore.mjs' ), SKIPPED_SCHEMA, 'utf-8' )
} )

afterAll( async () => {
    await testHome.teardown()
} )


describe( 'Memo 099 — schemaFolders[] loader', () => {
    it( 'loads tools from the configured schemaFolders path (~ resolved)', async () => {
        const { result } = await FlowMcpCli.search( { query: 'folderdemo' } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'matchCount' ] ).toBeGreaterThan( 0 )

        const names = result[ 'tools' ]
            .map( ( tool ) => tool[ 'name' ] )
        const hasPing = names
            .some( ( name ) => name.includes( 'ping' ) && name.includes( 'folderdemo' ) )

        expect( hasPing ).toBe( true )
    } )


    it( 'assigns the schemaFolders name as namespace source', async () => {
        const { result } = await FlowMcpCli.search( { query: 'Folder ping endpoint' } )

        expect( result[ 'status' ] ).toBe( true )

        const pingTool = result[ 'tools' ]
            .find( ( tool ) => tool[ 'namespace' ] === 'folderdemo' )

        expect( pingTool ).toBeDefined()
    } )


    it( 'skips schemas under _-prefixed directories (_shared/_lists)', async () => {
        const { result } = await FlowMcpCli.search( { query: 'shouldskip' } )

        expect( result[ 'status' ] ).toBe( true )

        const leaked = result[ 'tools' ]
            .some( ( tool ) => tool[ 'namespace' ] === 'shouldskip' )

        expect( leaked ).toBe( false )
    } )
} )
