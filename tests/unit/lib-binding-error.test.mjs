import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import { seedInitializedGlobalConfig } from '../helpers/seed-home.mjs'


// PRD-4.2 — a required native library that is INSTALLED but fails to LOAD (a missing /
// ABI-mismatched .node binding, as happened with better-sqlite3 after a broken build)
// must produce a clear LIB-BINDING error that says "rebuild the native module", NOT the
// misleading LIB-RESOLVE "library not resolvable / install it" message.

const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SOURCE_NAME = 'bindingsrc'
const SOURCE_DIR = join( GLOBAL_CONFIG_DIR, 'schemas', SOURCE_NAME )
const BROKEN_LIB = 'broken-native-flowmcp-test'

const SCHEMA = `export const main = {
    namespace: 'bindingsrc',
    name: 'Binding API',
    description: 'Schema requiring a native lib with a broken binding',
    version: '4.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    requiredLibraries: [ '${BROKEN_LIB}' ],
    tools: {
        ping: { method: 'GET', description: 'Ping', path: '/get', parameters: [] }
    }
}

export const handlers = ( { libraries } ) => ( { ping: { before: ( { userParams } ) => userParams } } )
`

const REGISTRY = {
    name: SOURCE_NAME, version: '1.0.0', description: 'binding test', schemaSpec: '4.0.0',
    schemas: [ { namespace: 'bindingsrc', file: 'bindingsrc.mjs', name: 'Binding API', requiredServerParams: [] } ]
}

const CWD = join( tmpdir(), `flowmcp-binding-${process.pid}` )


beforeAll( async () => {
    await seedInitializedGlobalConfig()

    // A module that resolves (has a package.json) but THROWS at load — the canonical
    // "native binding missing" failure shape.
    const libDir = join( SOURCE_DIR, 'node_modules', BROKEN_LIB )
    await mkdir( libDir, { recursive: true } )
    await writeFile( join( libDir, 'package.json' ), JSON.stringify( { name: BROKEN_LIB, version: '1.0.0', main: 'index.js' }, null, 4 ), 'utf-8' )
    await writeFile( join( libDir, 'index.js' ), `throw new Error( "Could not locate the bindings file ${BROKEN_LIB}/build/Release/broken_native.node" )\n`, 'utf-8' )

    await mkdir( SOURCE_DIR, { recursive: true } )
    await writeFile( join( SOURCE_DIR, 'bindingsrc.mjs' ), SCHEMA, 'utf-8' )
    await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( REGISTRY, null, 4 ), 'utf-8' )

    const raw = await import( 'node:fs/promises' ).then( ( fs ) => fs.readFile( GLOBAL_CONFIG_PATH, 'utf-8' ) )
    const config = JSON.parse( raw )
    config[ 'sources' ] = config[ 'sources' ] || {}
    config[ 'sources' ][ SOURCE_NAME ] = { type: 'local', schemaCount: 1 }
    await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( config, null, 4 ), 'utf-8' )

    await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )
    await writeFile( join( CWD, '.flowmcp', 'config.json' ), JSON.stringify( { root: '~/.flowmcp', tools: [ `${SOURCE_NAME}/bindingsrc.mjs::ping` ] }, null, 4 ), 'utf-8' )
} )


afterAll( async () => {
    await rm( SOURCE_DIR, { recursive: true, force: true } ).catch( () => {} )
    await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
} )


describe( 'requiredLibraries — installed-but-unloadable native module', () => {
    it( 'reports a clear LIB-BINDING error (rebuild), not LIB-RESOLVE (install)', async () => {
        const errorSpy = jest.spyOn( console, 'error' ).mockImplementation( () => {} )

        await FlowMcpCli.callTool( { toolName: 'ping_bindingsrc', jsonArgs: '{}', cwd: CWD } )

        const messages = errorSpy.mock.calls
            .map( ( callArgs ) => String( callArgs[ 0 ] || '' ) )
            .filter( ( text ) => text.includes( '[resolveHandlers]' ) )

        errorSpy.mockRestore()

        const joined = messages.join( ' | ' )
        expect( joined ).toContain( 'LIB-BINDING' )
        expect( joined ).toContain( BROKEN_LIB )
        expect( joined ).not.toContain( 'LIB-RESOLVE' )
    }, 15000 )
} )
