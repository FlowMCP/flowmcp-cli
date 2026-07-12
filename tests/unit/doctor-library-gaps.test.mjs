import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { createTestHome } from '../helpers/test-home.mjs'

const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


// Memo 152 / PRD-027 — doctor gap (a): module-present must do the REAL load (import/dlopen), so a
// native lib that RESOLVES but fails to load reports FAIL (LIB-BINDING), not green. Gap (b): the
// install hint for a missing org-internal FlowMCP lib must be `github:FlowMCP/<repo>`, not a bare
// `npm install <name>` that would 404. The global home mock isolates ~/.flowmcp into the test home.

const BROKEN_LIB = 'broken-native-doctor-test'

// A schema that requires a native lib which RESOLVES (has package.json) but THROWS at import.
const BROKEN_LIB_SCHEMA = `export const main = {
    namespace: 'bindingns',
    name: 'Binding NS',
    description: 'A schema requiring a native lib with a broken binding',
    version: '4.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    requiredLibraries: [ '${BROKEN_LIB}' ],
    headers: {},
    tools: {
        ping: { method: 'GET', description: 'ping', path: '/get', parameters: [], tests: [ { _description: 'ping' } ] }
    }
}

export const handlers = ( { libraries } ) => ( { ping: { before: ( { userParams } ) => userParams } } )
`

// A schema requiring an org-internal FlowMCP lib that is nowhere installed -> LIB-001 (missing).
const ORG_LIB_SCHEMA = `export const main = {
    namespace: 'orgns',
    name: 'Org NS',
    description: 'A schema requiring an org-internal FlowMCP lib that is not installed',
    version: '4.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    requiredLibraries: [ 'time-csv-toolkit' ],
    headers: {},
    tools: {
        ping: { method: 'GET', description: 'ping', path: '/get', parameters: [], tests: [ { _description: 'ping' } ] }
    }
}

export const handlers = ( { libraries } ) => ( { ping: { before: ( { userParams } ) => userParams } } )
`

function checksByName( { result } ) {
    const byName = {}
    result[ 'checks' ]
        .forEach( ( check ) => { byName[ check[ 'check' ] ] = check } )

    return byName
}


describe( 'PRD-027 doctor gap (a) — module-present does a real load (dlopen truth)', () => {
    const testHome = createTestHome( { suite: 'doctor-gap-a' } )
    const CWD = join( testHome.root, 'cwd' )
    const base = join( testHome.root, 'schemasGapA', 'v4.0.0' )
    const providerDir = join( base, 'providers', 'bindingns' )

    beforeAll( async () => {
        await testHome.setup()

        const globalConfig = {
            'envPath': join( testHome.globalConfigDir, '.env' ),
            'initialized': '2026-07-12T00:00:00.000Z',
            'schemaFolders': [ { 'name': 'gapafolder', 'path': '~/schemasGapA/v4.0.0' } ]
        }
        await writeFile( testHome.globalConfigPath, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
        await writeFile( join( testHome.globalConfigDir, '.env' ), '', 'utf-8' )

        await mkdir( providerDir, { recursive: true } )
        await writeFile( join( providerDir, 'binding.mjs' ), BROKEN_LIB_SCHEMA, 'utf-8' )

        // The broken native module lives in the SCHEMA dir node_modules, so the schema-dir base of
        // the resolution chain resolves it — and the real load throws (dlopen failure shape).
        const libDir = join( providerDir, 'node_modules', BROKEN_LIB )
        await mkdir( libDir, { recursive: true } )
        await writeFile( join( libDir, 'package.json' ), JSON.stringify( { name: BROKEN_LIB, version: '1.0.0', main: 'index.js' }, null, 4 ), 'utf-8' )
        await writeFile( join( libDir, 'index.js' ), `throw new Error( "Could not locate the bindings file ${BROKEN_LIB}/build/Release/broken_native.node" )\n`, 'utf-8' )

        await mkdir( CWD, { recursive: true } )
    } )

    afterAll( async () => {
        await testHome.teardown()
    } )

    it( 'reports module-present FAIL with LIB-BINDING for an installed-but-unloadable lib', async () => {
        const { result } = await FlowMcpCli.doctor( { cwd: CWD } )

        const byName = checksByName( { result } )
        expect( byName[ 'module-present' ][ 'ok' ] ).toBe( false )
        expect( byName[ 'module-present' ][ 'code' ] ).toBe( 'LIB-BINDING' )
        expect( byName[ 'module-present' ][ 'detail' ] ).toContain( BROKEN_LIB )
        // The fix hint tells the user to REBUILD (native binding), never to (re)install.
        expect( result[ 'fix' ] ).toContain( 'npm rebuild' )
        expect( result[ 'fix' ] ).toContain( BROKEN_LIB )
    } )
} )


describe( 'PRD-027 doctor gap (b) — install hint uses github:FlowMCP for an org-internal lib', () => {
    const testHome = createTestHome( { suite: 'doctor-gap-b' } )
    const CWD = join( testHome.root, 'cwd' )
    const base = join( testHome.root, 'schemasGapB', 'v4.0.0' )
    const providerDir = join( base, 'providers', 'orgns' )

    beforeAll( async () => {
        await testHome.setup()

        const globalConfig = {
            'envPath': join( testHome.globalConfigDir, '.env' ),
            'initialized': '2026-07-12T00:00:00.000Z',
            'schemaFolders': [ { 'name': 'gapbfolder', 'path': '~/schemasGapB/v4.0.0' } ]
        }
        await writeFile( testHome.globalConfigPath, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
        await writeFile( join( testHome.globalConfigDir, '.env' ), '', 'utf-8' )

        await mkdir( providerDir, { recursive: true } )
        await writeFile( join( providerDir, 'org.mjs' ), ORG_LIB_SCHEMA, 'utf-8' )

        await mkdir( CWD, { recursive: true } )
    } )

    afterAll( async () => {
        await testHome.teardown()
    } )

    it( 'reports module-present FAIL with LIB-001 and a github:FlowMCP install hint', async () => {
        const { result } = await FlowMcpCli.doctor( { cwd: CWD } )

        const byName = checksByName( { result } )
        expect( byName[ 'module-present' ][ 'ok' ] ).toBe( false )
        expect( byName[ 'module-present' ][ 'code' ] ).toBe( 'LIB-001' )
        expect( result[ 'fix' ] ).toContain( 'github:FlowMCP/time-csv-toolkit' )
        // The bare-name form (npm install ... time-csv-toolkit) must NOT be used for an org lib.
        expect( result[ 'fix' ] ).not.toMatch( /npm install --prefix \S+ time-csv-toolkit(\s|$)/ )
    } )
} )
