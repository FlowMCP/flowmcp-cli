import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
const ENV_PATH = join( GLOBAL_CONFIG_DIR, '.env.reqlibs' )

let originalGlobalConfig = null
let globalConfigExisted = false

const REQLIBS_SOURCE_NAME = 'reqlibs'
const REQLIBS_SOURCE_DIR = join( SCHEMAS_DIR, REQLIBS_SOURCE_NAME )

const DEBUG_SOURCE_NAME = 'debugsrc'
const DEBUG_SOURCE_DIR = join( SCHEMAS_DIR, DEBUG_SOURCE_NAME )

const REQLIBS_SCHEMA = `export const main = {
    namespace: 'reqlibs',
    name: 'Required Libs API',
    description: 'Schema with required libraries',
    version: '4.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    requiredLibraries: [ 'zod' ],
    tools: {
        ping: {
            method: 'GET',
            description: 'Ping with lib',
            path: '/get',
            parameters: []
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

const REQLIBS_REGISTRY = {
    'name': REQLIBS_SOURCE_NAME,
    'version': '1.0.0',
    'description': 'RequiredLibraries test source',
    'schemaSpec': '4.0.0',
    'schemas': [
        {
            'namespace': 'reqlibs',
            'file': 'reqlibs.mjs',
            'name': 'Required Libs API',
            'requiredServerParams': []
        }
    ]
}

const DEBUG_SCHEMA = `export const main = {
    namespace: 'debugsrc',
    name: 'Debug API',
    description: 'Schema for debug test',
    version: '4.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    requiredLibraries: [ 'nonexistent-module-xyz-flowmcp-test' ],
    tools: {
        ping: {
            method: 'GET',
            description: 'Ping',
            path: '/get',
            parameters: []
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

const DEBUG_REGISTRY = {
    'name': DEBUG_SOURCE_NAME,
    'version': '1.0.0',
    'description': 'Debug test source',
    'schemaSpec': '4.0.0',
    'schemas': [
        {
            'namespace': 'debugsrc',
            'file': 'debug.mjs',
            'name': 'Debug API',
            'requiredServerParams': []
        }
    ]
}


beforeAll( async () => {
    try {
        originalGlobalConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        globalConfigExisted = true
    } catch {
        globalConfigExisted = false
    }

    await mkdir( REQLIBS_SOURCE_DIR, { recursive: true } )
    await writeFile( join( REQLIBS_SOURCE_DIR, 'reqlibs.mjs' ), REQLIBS_SCHEMA, 'utf-8' )
    await writeFile( join( REQLIBS_SOURCE_DIR, '_registry.json' ), JSON.stringify( REQLIBS_REGISTRY, null, 4 ), 'utf-8' )

    await mkdir( DEBUG_SOURCE_DIR, { recursive: true } )
    await writeFile( join( DEBUG_SOURCE_DIR, 'debug.mjs' ), DEBUG_SCHEMA, 'utf-8' )
    await writeFile( join( DEBUG_SOURCE_DIR, '_registry.json' ), JSON.stringify( DEBUG_REGISTRY, null, 4 ), 'utf-8' )

    await writeFile( ENV_PATH, 'REQLIBS_KEY=abc\n', 'utf-8' )

    const globalConfig = {
        'envPath': ENV_PATH,
        'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc', 'schemaSpec': '4.0.0' },
        'initialized': new Date().toISOString(),
        'sources': {
            [REQLIBS_SOURCE_NAME]: { 'type': 'local', 'schemaCount': 1 },
            [DEBUG_SOURCE_NAME]: { 'type': 'local', 'schemaCount': 1 }
        }
    }

    if( globalConfigExisted && originalGlobalConfig ) {
        const parsed = JSON.parse( originalGlobalConfig )
        parsed[ 'sources' ] = parsed[ 'sources' ] || {}
        parsed[ 'sources' ][ REQLIBS_SOURCE_NAME ] = globalConfig[ 'sources' ][ REQLIBS_SOURCE_NAME ]
        parsed[ 'sources' ][ DEBUG_SOURCE_NAME ] = globalConfig[ 'sources' ][ DEBUG_SOURCE_NAME ]
        parsed[ 'envPath' ] = ENV_PATH
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( parsed, null, 4 ), 'utf-8' )
    } else {
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
    }
} )


afterAll( async () => {
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    await rm( REQLIBS_SOURCE_DIR, { recursive: true, force: true } ).catch( () => {} )
    await rm( DEBUG_SOURCE_DIR, { recursive: true, force: true } ).catch( () => {} )
    await rm( ENV_PATH, { force: true } ).catch( () => {} )
} )


describe( 'FlowMcpCli.callTool with requiredLibraries — exercises #resolveHandlers requiredLibraries block', () => {
    const CWD = join( tmpdir(), `flowmcp-reqlibs-call-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'tools': [
                `${REQLIBS_SOURCE_NAME}/reqlibs.mjs::ping`
            ]
        }

        await writeFile(
            join( CWD, '.flowmcp', 'config.json' ),
            JSON.stringify( localConfig, null, 4 ),
            'utf-8'
        )
    } )


    afterAll( async () => {
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'calls tool with handlers that receive resolved required libraries (zod)', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'ping_reqlibs',
            'jsonArgs': '{}',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'content' ] ).toBeDefined()
    }, 15000 )
} )


describe( 'FlowMcpCli.callTool — #resolveHandlers fails loud on unresolvable required library (Memo 150 D1)', () => {
    const CWD = join( tmpdir(), `flowmcp-debug-call-${Date.now()}` )
    let originalDebugEnv


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'tools': [
                `${DEBUG_SOURCE_NAME}/debug.mjs::ping`
            ]
        }

        await writeFile(
            join( CWD, '.flowmcp', 'config.json' ),
            JSON.stringify( localConfig, null, 4 ),
            'utf-8'
        )

        originalDebugEnv = process.env[ 'FLOWMCP_DEBUG' ]
    } )


    afterAll( async () => {
        if( originalDebugEnv !== undefined ) {
            process.env[ 'FLOWMCP_DEBUG' ] = originalDebugEnv
        } else {
            delete process.env[ 'FLOWMCP_DEBUG' ]
        }

        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'fails loud with a coded LIB-001 error + install command when FLOWMCP_DEBUG is set', async () => {
        // Memo 150 D1: an unresolvable requiredLibrary is now a CODED (LIB-001) fail-loud error that
        // re-throws instead of silently degrading to empty handlers. callTool surfaces status:false
        // with the exact `npm install --prefix` command. Replaces the former silent-degrade behavior.
        process.env[ 'FLOWMCP_DEBUG' ] = 'true'

        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'ping_debugsrc',
            'jsonArgs': '{}',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( String( result[ 'error' ] ) ).toContain( 'LIB-001' )
        expect( String( result[ 'error' ] ) ).toContain( 'npm install --prefix' )
    }, 15000 )


    it( 'fails loud identically when FLOWMCP_DEBUG is not set (No Silent Defaults)', async () => {
        // The coded fail-loud is independent of FLOWMCP_DEBUG — a declared-but-unresolvable library
        // is a contract violation that must always surface, never a confusing empty content:[].
        delete process.env[ 'FLOWMCP_DEBUG' ]

        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'ping_debugsrc',
            'jsonArgs': '{}',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( String( result[ 'error' ] ) ).toContain( 'LIB-001' )
        expect( String( result[ 'error' ] ) ).toContain( 'npm install --prefix' )
    }, 15000 )
} )
