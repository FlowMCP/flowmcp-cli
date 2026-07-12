import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { createTestHome } from '../helpers/test-home.mjs'
import { HandlerResolver } from '../../src/lib/HandlerResolver.mjs'

const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


// Memo 150 — external requiredLibraries resolve from allowed-libraries (config allowedLibrariesPath,
// default ~/.flowmcp/allowed-libraries). These tests exercise the REAL resolution path
// (#resolveHandlers via the test hook, and doctor's module-present check) per the Kap-8 D2-Lesson:
// wire + test in the REAL CLI path, not a dead mock. homedir() is mocked to the isolated test home,
// so a "~/..." path and the allowed-libraries default resolve inside <repo>/.test-home.
//
// NOTE on lib names: each describe uses a DISTINCT lib name and a DISTINCT test home. Jest's CJS
// module runtime keeps a per-process resolution cache; a name that was resolve-failed once in the
// process stays cached as missing (plain Node re-resolves — verified — so real short-lived CLI
// invocations are unaffected). Distinct names keep each case's first resolve authoritative.

const LIB_INDEX = `module.exports = { marker: 'allowed-libraries-150' }\n`


function libPackageJson( { name } ) {
    return `{ "name": "${name}", "version": "1.0.0", "main": "index.js" }`
}


function schemaDeclaring( { namespace, lib } ) {
    return `export const main = {
    namespace: '${namespace}',
    name: 'Schema ${namespace}',
    description: 'Schema declaring a requiredLibrary that lives only in allowed-libraries',
    version: '4.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    requiredLibraries: [ '${lib}' ],
    sharedLists: [],
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
}


async function installLib( { allowedLibrariesDir, name } ) {
    const libDir = join( allowedLibrariesDir, 'node_modules', name )
    await mkdir( libDir, { recursive: true } )
    await writeFile( join( libDir, 'package.json' ), libPackageJson( { name } ), 'utf-8' )
    await writeFile( join( libDir, 'index.js' ), LIB_INDEX, 'utf-8' )
}


// ─── P1/D1 — real #resolveHandlers against allowed-libraries ─────────────────

describe( 'Memo 150 P1 — requiredLibrary resolves from allowed-libraries (real #resolveHandlers)', () => {
    const testHome = createTestHome( { suite: 'memo150-resolve' } )
    const PRESENT_LIB = 'flowmcp-p1-present-150'
    const MISSING_LIB = 'flowmcp-p1-missing-150'

    beforeAll( async () => {
        await testHome.setup()

        const globalConfig = {
            'envPath': join( testHome.globalConfigDir, '.env' ),
            'initialized': '2026-07-08T00:00:00.000Z',
            'schemaFolders': [ { 'name': 'testfolder', 'path': '~/schemas150/v4.0.0' } ],
            'allowedLibrariesPath': '~/.flowmcp/allowed-libraries'
        }
        await writeFile( testHome.globalConfigPath, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
        await writeFile( join( testHome.globalConfigDir, '.env' ), '', 'utf-8' )
        await installLib( { 'allowedLibrariesDir': join( testHome.globalConfigDir, 'allowed-libraries' ), 'name': PRESENT_LIB } )
    } )

    afterAll( async () => {
        await testHome.teardown()
    } )

    it( 'resolves the lib from allowed-libraries and builds handlers (no throw)', async () => {
        const main = {
            'namespace': 'p1present',
            'requiredLibraries': [ PRESENT_LIB ],
            'tools': { 'ping': {} }
        }
        const handlersFn = ( { libraries } ) => {
            return { 'ping': { 'before': ( { userParams } ) => userParams } }
        }

        const { handlerMap } = await HandlerResolver.resolve( {
            main,
            handlersFn,
            'filePath': join( testHome.root, 'schemas150', 'v4.0.0', 'present.mjs' )
        } )

        expect( handlerMap ).toBeDefined()
        expect( Object.keys( handlerMap ).length ).toBeGreaterThanOrEqual( 1 )
    } )

    it( 'fails loud (LIB-001 + npm install --prefix) when the lib is nowhere resolvable', async () => {
        const main = {
            'namespace': 'p1missing',
            'requiredLibraries': [ MISSING_LIB ],
            'tools': { 'ping': {} }
        }
        const handlersFn = () => ( { 'ping': { 'before': ( { userParams } ) => userParams } } )

        await expect(
            HandlerResolver.resolve( {
                main,
                handlersFn,
                'filePath': join( testHome.root, 'schemas150', 'v4.0.0', 'missing.mjs' )
            } )
        ).rejects.toThrow( /LIB-001[\s\S]*npm install --prefix/ )
    } )
} )


// ─── P2 — doctor shows the install command for a missing library ─────────────

describe( 'Memo 150 P2 — doctor shows npm install --prefix for a missing requiredLibrary', () => {
    const testHome = createTestHome( { suite: 'memo150-doctor-missing' } )
    const CWD = join( testHome.root, 'cwd' )
    const MISSING_LIB = 'flowmcp-doctor-missing-150'

    beforeAll( async () => {
        await testHome.setup()

        const globalConfig = {
            'envPath': join( testHome.globalConfigDir, '.env' ),
            'initialized': '2026-07-08T00:00:00.000Z',
            'schemaFolders': [ { 'name': 'testfolder', 'path': '~/schemas150m/v4.0.0' } ],
            'allowedLibrariesPath': '~/.flowmcp/allowed-libraries'
        }
        await writeFile( testHome.globalConfigPath, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
        await writeFile( join( testHome.globalConfigDir, '.env' ), '', 'utf-8' )

        const base = join( testHome.root, 'schemas150m', 'v4.0.0' )
        await mkdir( join( base, 'providers', 'docmissing' ), { recursive: true } )
        await writeFile( join( base, 'providers', 'docmissing', 'schema.mjs' ), schemaDeclaring( { 'namespace': 'docmissing', 'lib': MISSING_LIB } ), 'utf-8' )
        await mkdir( CWD, { recursive: true } )
    } )

    afterAll( async () => {
        await testHome.teardown()
    } )

    it( 'module-present FAILS (LIB-001) and result.fix carries the install command', async () => {
        const { result } = await FlowMcpCli.doctor( { 'cwd': CWD } )

        const byName = {}
        result[ 'checks' ]
            .forEach( ( check ) => {
                byName[ check[ 'check' ] ] = check
            } )

        expect( byName[ 'module-present' ][ 'ok' ] ).toBe( false )
        expect( byName[ 'module-present' ][ 'code' ] ).toBe( 'LIB-001' )
        expect( typeof result[ 'fix' ] ).toBe( 'string' )
        expect( result[ 'fix' ] ).toContain( 'npm install --prefix' )
        expect( result[ 'fix' ] ).toContain( MISSING_LIB )
    } )
} )


describe( 'Memo 150 P2 — doctor module-present PASSES when the lib is in allowed-libraries', () => {
    const testHome = createTestHome( { suite: 'memo150-doctor-present' } )
    const CWD = join( testHome.root, 'cwd' )
    const PRESENT_LIB = 'flowmcp-doctor-present-150'

    beforeAll( async () => {
        await testHome.setup()

        const globalConfig = {
            'envPath': join( testHome.globalConfigDir, '.env' ),
            'initialized': '2026-07-08T00:00:00.000Z',
            'schemaFolders': [ { 'name': 'testfolder', 'path': '~/schemas150p/v4.0.0' } ],
            'allowedLibrariesPath': '~/.flowmcp/allowed-libraries'
        }
        await writeFile( testHome.globalConfigPath, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
        await writeFile( join( testHome.globalConfigDir, '.env' ), '', 'utf-8' )

        const base = join( testHome.root, 'schemas150p', 'v4.0.0' )
        await mkdir( join( base, 'providers', 'docpresent' ), { recursive: true } )
        await writeFile( join( base, 'providers', 'docpresent', 'schema.mjs' ), schemaDeclaring( { 'namespace': 'docpresent', 'lib': PRESENT_LIB } ), 'utf-8' )
        // install BEFORE any doctor call so the first resolve of PRESENT_LIB is a success.
        await installLib( { 'allowedLibrariesDir': join( testHome.globalConfigDir, 'allowed-libraries' ), 'name': PRESENT_LIB } )
        await mkdir( CWD, { recursive: true } )
    } )

    afterAll( async () => {
        await testHome.teardown()
    } )

    it( 'module-present is ok and there is no install fix', async () => {
        const { result } = await FlowMcpCli.doctor( { 'cwd': CWD } )

        const byName = {}
        result[ 'checks' ]
            .forEach( ( check ) => {
                byName[ check[ 'check' ] ] = check
            } )

        expect( byName[ 'module-present' ][ 'ok' ] ).toBe( true )
        expect( result[ 'fix' ] ).toBeUndefined()
    } )
} )
