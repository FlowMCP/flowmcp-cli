import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { createTestHome } from '../helpers/test-home.mjs'

const { FlowMcpCli, CliError } = await import( '../../src/task/FlowMcpCli.mjs' )


// Memo 149 — Strang B (single-source path + fail-loud shared lists), Strang C (error-code
// infra: CliError + coded surfacing) and Strang D (flowmcp doctor + version). The global
// home mock points homedir() at the isolated test home, so a "~/..." schemaFolders path
// resolves inside it.

const GOOD_SCHEMA = `export const main = {
    namespace: 'goodns',
    name: 'Good NS',
    description: 'A schema whose declared shared list resolves',
    version: '4.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    requiredLibraries: [],
    sharedLists: [ { ref: 'testchains', version: '1.0.0' } ],
    headers: {},
    tools: {
        ping: {
            method: 'GET',
            description: 'ping',
            path: '/get',
            parameters: [],
            tests: [ { _description: 'ping' } ]
        }
    }
}

export const handlers = ( { sharedLists, libraries } ) => {
    return {
        ping: {
            before: ( { userParams } ) => {
                return userParams
            }
        }
    }
}
`

const TESTCHAINS_LIST = `export const list = {
    meta: { name: 'testchains', version: '1.0.0' },
    entries: [ { key: 'A' }, { key: 'B' } ]
}
`

const BAD_SCHEMA = `export const main = {
    namespace: 'badns',
    name: 'Bad NS',
    description: 'A schema declaring a shared list that has no _lists dir',
    version: '4.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    requiredLibraries: [],
    sharedLists: [ { ref: 'missinglist', version: '1.0.0' } ],
    headers: {},
    tools: {
        ping: {
            method: 'GET',
            description: 'ping',
            path: '/get',
            parameters: [],
            tests: [ { _description: 'ping' } ]
        }
    }
}

export const handlers = ( { sharedLists, libraries } ) => {
    return { ping: { before: ( { userParams } ) => userParams } }
}
`


describe( 'Memo 149 Strang D — flowmcp version', () => {
    it( 'returns the CLI name and a semver-shaped version', async () => {
        const { result } = await FlowMcpCli.version()

        expect( result[ 'status' ] ).toBe( true )
        expect( typeof result[ 'name' ] ).toBe( 'string' )
        expect( result[ 'version' ] ).toMatch( /^\d+\.\d+\.\d+/ )
    } )
} )


describe( 'Memo 149 Strang C — CliError class', () => {
    it( 'carries code, severity, source and message', () => {
        const err = new CliError( { 'code': 'CFG-001', 'severity': 'ERROR', 'source': 'test', 'message': 'boom' } )

        expect( err ).toBeInstanceOf( Error )
        expect( err[ 'code' ] ).toBe( 'CFG-001' )
        expect( err[ 'severity' ] ).toBe( 'ERROR' )
        expect( err[ 'source' ] ).toBe( 'test' )
        expect( err[ 'message' ] ).toBe( 'boom' )
    } )

    it( 'defaults severity to ERROR', () => {
        const err = new CliError( { 'code': 'CFG-002', 'message': 'x' } )

        expect( err[ 'severity' ] ).toBe( 'ERROR' )
    } )
} )


describe( 'Memo 149 Strang B — single-source schema file path + fail-loud shared lists', () => {
    it( '#resolveSchemaFilePath returns an empty path for an empty ref (no throw)', async () => {
        const { filePath } = await FlowMcpCli._testHook_resolveSchemaFilePath( { schemaRef: '' } )

        expect( filePath ).toBe( '' )
    } )

    it( '#resolveHandlers fails loud (LST-001) when a declared sharedList has no _lists dir', async () => {
        const main = { 'namespace': 'x', 'tools': {}, 'sharedLists': [ { 'ref': 'nope', 'version': '1.0.0' } ] }
        const handlersFn = () => ( {} )

        await expect(
            FlowMcpCli._testHook_resolveHandlers( { main, handlersFn, filePath: '/tmp/does-not-exist/schema.mjs' } )
        ).rejects.toThrow( /^LST-001/ )
    } )

    it( '#resolveHandlers stays graceful (no throw, empty maps) when no sharedLists are declared', async () => {
        const main = { 'namespace': 'x', 'tools': {}, 'sharedLists': [] }
        const handlersFn = () => ( {} )

        const { handlerMap } = await FlowMcpCli._testHook_resolveHandlers( { main, handlersFn, filePath: '/tmp/does-not-exist/schema.mjs' } )

        expect( handlerMap ).toEqual( {} )
    } )
} )


describe( 'Memo 149 Strang D — flowmcp doctor (healthy)', () => {
    const testHome = createTestHome( { suite: 'doctor-healthy' } )
    const CWD = join( testHome.root, 'cwd' )

    beforeAll( async () => {
        await testHome.setup()

        const globalConfig = {
            'envPath': join( testHome.globalConfigDir, '.env' ),
            'initialized': '2026-07-07T00:00:00.000Z',
            'schemaFolders': [ { 'name': 'testfolder', 'path': '~/schemas149/v4.0.0' } ]
        }
        await writeFile( testHome.globalConfigPath, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
        await writeFile( join( testHome.globalConfigDir, '.env' ), '', 'utf-8' )

        const base = join( testHome.root, 'schemas149', 'v4.0.0' )
        await mkdir( join( base, 'providers', 'goodns' ), { recursive: true } )
        await writeFile( join( base, 'providers', 'goodns', 'good.mjs' ), GOOD_SCHEMA, 'utf-8' )
        await mkdir( join( base, '_lists' ), { recursive: true } )
        await writeFile( join( base, '_lists', 'testchains.mjs' ), TESTCHAINS_LIST, 'utf-8' )
        await mkdir( CWD, { recursive: true } )
    } )

    afterAll( async () => {
        await testHome.teardown()
    } )

    it( 'reports status true and all structural checks ok', async () => {
        const { result } = await FlowMcpCli.doctor( { cwd: CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'cli' ] ).toMatch( /@\d+\.\d+\.\d+/ )

        const byName = {}
        result[ 'checks' ]
            .forEach( ( check ) => {
                byName[ check[ 'check' ] ] = check
            } )

        expect( byName[ 'config-single-source' ][ 'ok' ] ).toBe( true )
        expect( byName[ 'schema-load' ][ 'ok' ] ).toBe( true )
        expect( byName[ 'shared-list-resolve' ][ 'ok' ] ).toBe( true )
        expect( byName[ 'module-present' ][ 'ok' ] ).toBe( true )
        expect( byName[ 'cli-version' ][ 'detail' ] ).toMatch( /@\d+\.\d+\.\d+/ )
    } )
} )


describe( 'Memo 149 Strang D — flowmcp doctor (surfaces a broken shared list by code)', () => {
    const testHome = createTestHome( { suite: 'doctor-broken' } )
    const CWD = join( testHome.root, 'cwd' )

    beforeAll( async () => {
        await testHome.setup()

        const globalConfig = {
            'envPath': join( testHome.globalConfigDir, '.env' ),
            'initialized': '2026-07-07T00:00:00.000Z',
            'schemaFolders': [ { 'name': 'testfolder', 'path': '~/schemas149/v4.0.0' } ]
        }
        await writeFile( testHome.globalConfigPath, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
        await writeFile( join( testHome.globalConfigDir, '.env' ), '', 'utf-8' )

        const base = join( testHome.root, 'schemas149', 'v4.0.0' )
        await mkdir( join( base, 'providers', 'badns' ), { recursive: true } )
        await writeFile( join( base, 'providers', 'badns', 'bad.mjs' ), BAD_SCHEMA, 'utf-8' )
        // deliberately NO _lists dir — a declared sharedList that cannot resolve
        await mkdir( CWD, { recursive: true } )
    } )

    afterAll( async () => {
        await testHome.teardown()
    } )

    it( 'reports status false with an LST code on shared-list-resolve', async () => {
        const { result } = await FlowMcpCli.doctor( { cwd: CWD } )

        expect( result[ 'status' ] ).toBe( false )

        const sharedListCheck = result[ 'checks' ]
            .find( ( check ) => check[ 'check' ] === 'shared-list-resolve' )

        expect( sharedListCheck[ 'ok' ] ).toBe( false )
        expect( sharedListCheck[ 'code' ] ).toMatch( /^LST-/ )
        expect( result[ 'summary' ][ 'errors' ] ).toBeGreaterThanOrEqual( 1 )
    } )
} )
