import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
const SOURCE_NAME = 'cachesrc'
const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )
const ENV_PATH = join( GLOBAL_CONFIG_DIR, '.env.cachetest' )
const TEST_CWD = join( tmpdir(), 'flowmcp-cli-cache-flow' )
const LOCAL_CONFIG_DIR = join( TEST_CWD, '.flowmcp' )
const LOCAL_CONFIG_PATH = join( LOCAL_CONFIG_DIR, 'config.json' )
const CACHE_DIR = join( GLOBAL_CONFIG_DIR, 'cache' )

let originalGlobalConfig = null
let globalConfigExisted = false

const PRELOAD_SCHEMA = `export const main = {
    namespace: 'cachesrc',
    name: 'Cache Test API',
    description: 'Schema for cache tests',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    routes: {
        cachedPing: {
            method: 'GET',
            description: 'Cached ping',
            path: '/get',
            parameters: [],
            preload: { enabled: true, ttl: 300 }
        },
        uncachedPing: {
            method: 'GET',
            description: 'Uncached ping',
            path: '/get',
            parameters: []
        }
    }
}
`

const NOTESTS_SCHEMA = `export const main = {
    namespace: 'notestsrc',
    name: 'NoTest API',
    description: 'Schema without test definitions',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    routes: {
        ping: {
            method: 'GET',
            description: 'Ping',
            path: '/get',
            parameters: []
        }
    }
}
`

const ENVREQ_SCHEMA = `export const main = {
    namespace: 'envreqsrc',
    name: 'EnvReq API',
    description: 'Schema requiring env',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [ 'MISSING_API_KEY' ],
    headers: {},
    routes: {
        check: {
            method: 'GET',
            description: 'Check',
            path: '/get',
            parameters: [],
            tests: [ { _description: 'Test check' } ]
        }
    }
}
`

const REGISTRY = {
    'name': 'cachesrc',
    'version': '1.0.0',
    'description': 'Cache test source',
    'schemaSpec': '2.0.0',
    'schemas': [
        { 'namespace': 'cachesrc', 'file': 'cached.mjs', 'name': 'Cache Test API', 'requiredServerParams': [] },
        { 'namespace': 'notestsrc', 'file': 'notest.mjs', 'name': 'NoTest API', 'requiredServerParams': [] },
        { 'namespace': 'envreqsrc', 'file': 'envreq.mjs', 'name': 'EnvReq API', 'requiredServerParams': [ 'MISSING_API_KEY' ] }
    ]
}

const LOCAL_CONFIG = {
    'root': '~/.flowmcp',
    'defaultGroup': 'cache-test',
    'groups': {
        'cache-test': {
            'description': 'Cache test group',
            'tools': [
                'cachesrc/cached.mjs::cachedPing',
                'cachesrc/cached.mjs::uncachedPing'
            ]
        }
    }
}


beforeAll( async () => {
    try {
        originalGlobalConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        globalConfigExisted = true
    } catch {
        globalConfigExisted = false
    }

    await mkdir( SOURCE_DIR, { recursive: true } )
    await writeFile( join( SOURCE_DIR, 'cached.mjs' ), PRELOAD_SCHEMA, 'utf-8' )
    await writeFile( join( SOURCE_DIR, 'notest.mjs' ), NOTESTS_SCHEMA, 'utf-8' )
    await writeFile( join( SOURCE_DIR, 'envreq.mjs' ), ENVREQ_SCHEMA, 'utf-8' )
    await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( REGISTRY, null, 4 ), 'utf-8' )

    await writeFile( ENV_PATH, 'TEST_KEY=abc\n', 'utf-8' )

    const globalConfig = {
        'envPath': ENV_PATH,
        'flowmcpCore': {
            'version': '2.0.0',
            'commit': 'abc123',
            'schemaSpec': '2.0.0'
        },
        'initialized': new Date().toISOString(),
        'sources': {
            'cachesrc': {
                'type': 'builtin',
                'schemaCount': 3
            }
        }
    }

    if( globalConfigExisted && originalGlobalConfig ) {
        const parsed = JSON.parse( originalGlobalConfig )
        parsed[ 'sources' ] = parsed[ 'sources' ] || {}
        parsed[ 'sources' ][ 'cachesrc' ] = globalConfig[ 'sources' ][ 'cachesrc' ]
        parsed[ 'envPath' ] = ENV_PATH
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( parsed, null, 4 ), 'utf-8' )
    } else {
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
    }

    await mkdir( LOCAL_CONFIG_DIR, { recursive: true } )
    await writeFile( LOCAL_CONFIG_PATH, JSON.stringify( LOCAL_CONFIG, null, 4 ), 'utf-8' )
} )


afterAll( async () => {
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    await rm( SOURCE_DIR, { recursive: true, force: true } ).catch( () => {} )
    await rm( TEST_CWD, { recursive: true, force: true } ).catch( () => {} )
    await rm( ENV_PATH, { force: true } ).catch( () => {} )
    await rm( CACHE_DIR, { recursive: true, force: true } ).catch( () => {} )
} )


describe( 'FlowMcpCli.callTool cache write and hit', () => {
    it( 'writes to cache on first call with preload-enabled route', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'cached_ping_cachesrc',
            'cwd': TEST_CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'cache' ] ).toBeDefined()
        expect(
            result[ 'cache' ][ 'stored' ] === true || result[ 'cache' ][ 'hit' ] === false
        ).toBe( true )
    }, 15000 )


    it( 'returns cache hit on second call', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'cached_ping_cachesrc',
            'cwd': TEST_CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'cache' ][ 'hit' ] ).toBe( true )
        expect( result[ 'cache' ][ 'fetchedAt' ] ).toBeDefined()
        expect( result[ 'cache' ][ 'expiresAt' ] ).toBeDefined()
    }, 15000 )


    it( 'bypasses cache with noCache flag', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'cached_ping_cachesrc',
            'cwd': TEST_CWD,
            'noCache': true
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'cache' ] ).toBeUndefined()
    }, 15000 )


    it( 'refreshes cache with refresh flag', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'cached_ping_cachesrc',
            'cwd': TEST_CWD,
            'refresh': true
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'cache' ][ 'stored' ] ).toBe( true )
    }, 15000 )


    it( 'does not cache non-preload routes', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'uncached_ping_cachesrc',
            'cwd': TEST_CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'cache' ] ).toBeUndefined()
    }, 15000 )
} )


describe( 'FlowMcpCli.callTool with group override', () => {
    it( 'resolves tool from specified group', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'cached_ping_cachesrc',
            'group': 'cache-test',
            'cwd': TEST_CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
    }, 15000 )
} )


describe( 'FlowMcpCli.callTool env missing path', () => {
    it( 'returns error when env file is not readable', async () => {
        const badEnvCwd = join( tmpdir(), 'flowmcp-cli-cache-badenv' )
        const badEnvConfigDir = join( badEnvCwd, '.flowmcp' )
        await mkdir( badEnvConfigDir, { recursive: true } )

        const badLocalConfig = {
            'root': '~/.flowmcp',
            'tools': [
                'cachesrc/cached.mjs::cachedPing'
            ]
        }

        await writeFile(
            join( badEnvConfigDir, 'config.json' ),
            JSON.stringify( badLocalConfig, null, 4 ),
            'utf-8'
        )

        const savedConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        const parsed = JSON.parse( savedConfig )
        parsed[ 'envPath' ] = '/tmp/nonexistent-env-file-12345.env'
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( parsed, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'cached_ping_cachesrc',
            'cwd': badEnvCwd
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( '.env' )

        const restoredConfig = JSON.parse( savedConfig )
        restoredConfig[ 'envPath' ] = ENV_PATH
        restoredConfig[ 'sources' ] = restoredConfig[ 'sources' ] || {}
        restoredConfig[ 'sources' ][ 'cachesrc' ] = { 'type': 'builtin', 'schemaCount': 3 }
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( restoredConfig, null, 4 ), 'utf-8' )

        await rm( badEnvCwd, { recursive: true, force: true } ).catch( () => {} )
    } )
} )


describe( 'FlowMcpCli.callListTools env missing path', () => {
    it( 'returns error when env file is not readable', async () => {
        const badEnvCwd = join( tmpdir(), 'flowmcp-cli-listtools-badenv' )
        const badEnvConfigDir = join( badEnvCwd, '.flowmcp' )
        await mkdir( badEnvConfigDir, { recursive: true } )

        const badLocalConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'test',
            'groups': {
                'test': {
                    'tools': [ 'cachesrc/cached.mjs::cachedPing' ]
                }
            }
        }

        await writeFile(
            join( badEnvConfigDir, 'config.json' ),
            JSON.stringify( badLocalConfig, null, 4 ),
            'utf-8'
        )

        const savedConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        const parsed = JSON.parse( savedConfig )
        parsed[ 'envPath' ] = '/tmp/nonexistent-env-file-67890.env'
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( parsed, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.callListTools( {
            'cwd': badEnvCwd
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( '.env' )

        const restoredConfig = JSON.parse( savedConfig )
        restoredConfig[ 'envPath' ] = ENV_PATH
        restoredConfig[ 'sources' ] = restoredConfig[ 'sources' ] || {}
        restoredConfig[ 'sources' ][ 'cachesrc' ] = { 'type': 'builtin', 'schemaCount': 3 }
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( restoredConfig, null, 4 ), 'utf-8' )

        await rm( badEnvCwd, { recursive: true, force: true } ).catch( () => {} )
    } )
} )
