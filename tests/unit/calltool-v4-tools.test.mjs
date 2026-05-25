import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


// Regression test for the v4 `call` blocker (Memo 062):
// callTool / callListTools / #filterMainRoutes previously only read main['routes']
// (v2 spec). v4 schemas use main['tools'] and were therefore not callable.
// All existing call tests use `routes:` fixtures, so the v4 path was never exercised.

const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
const SOURCE_NAME = 'v4toolssrc'
const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )
const ENV_PATH = join( GLOBAL_CONFIG_DIR, '.env.v4toolstest' )
const TEST_CWD = join( tmpdir(), 'flowmcp-cli-v4-tools' )
const LOCAL_CONFIG_DIR = join( TEST_CWD, '.flowmcp' )
const LOCAL_CONFIG_PATH = join( LOCAL_CONFIG_DIR, 'config.json' )
const CACHE_DIR = join( GLOBAL_CONFIG_DIR, 'cache' )

let originalGlobalConfig = null
let globalConfigExisted = false

const V4_SCHEMA = `export const main = {
    namespace: 'v4toolssrc',
    name: 'V4 Tools API',
    description: 'v4 schema that uses the tools key instead of routes',
    version: '4.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    tools: {
        getPing: {
            method: 'GET',
            description: 'Ping via the v4 tools key',
            path: '/get',
            parameters: []
        }
    }
}
`

const REGISTRY = {
    'name': 'v4toolssrc',
    'version': '1.0.0',
    'description': 'v4 tools test source',
    'schemaSpec': '4.0.0',
    'schemas': [
        { 'namespace': 'v4toolssrc', 'file': 'v4tools.mjs', 'name': 'V4 Tools API', 'requiredServerParams': [] }
    ]
}

const LOCAL_CONFIG = {
    'root': '~/.flowmcp',
    'defaultGroup': 'v4-test',
    'groups': {
        'v4-test': {
            'description': 'v4 tools test group',
            'tools': [
                'v4toolssrc/v4tools.mjs::getPing'
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
    await writeFile( join( SOURCE_DIR, 'v4tools.mjs' ), V4_SCHEMA, 'utf-8' )
    await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( REGISTRY, null, 4 ), 'utf-8' )

    await writeFile( ENV_PATH, 'TEST_KEY=abc\n', 'utf-8' )

    const globalConfig = {
        'envPath': ENV_PATH,
        'flowmcpCore': { 'version': '4.0.0', 'commit': 'test', 'schemaSpec': '4.0.0' },
        'initialized': new Date().toISOString(),
        'sources': { 'v4toolssrc': { 'type': 'builtin', 'schemaCount': 1 } }
    }

    if( globalConfigExisted && originalGlobalConfig ) {
        const parsed = JSON.parse( originalGlobalConfig )
        parsed[ 'sources' ] = parsed[ 'sources' ] || {}
        parsed[ 'sources' ][ 'v4toolssrc' ] = globalConfig[ 'sources' ][ 'v4toolssrc' ]
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


describe( 'FlowMcpCli v4 schema (tools key) is callable', () => {
    it( 'callListTools lists the v4 tool', async () => {
        const { result } = await FlowMcpCli.callListTools( { 'cwd': TEST_CWD } )

        expect( result[ 'status' ] ).toBe( true )

        const v4Tool = result[ 'tools' ]
            .find( ( tool ) => {
                const isMatch = tool[ 'namespace' ] === 'v4toolssrc'

                return isMatch
            } )

        expect( v4Tool ).toBeDefined()
        expect( v4Tool[ 'routeName' ] ).toBe( 'getPing' )
    }, 15000 )


    it( 'callTool resolves and executes the v4 tool', async () => {
        const { result: listResult } = await FlowMcpCli.callListTools( { 'cwd': TEST_CWD } )
        const v4Tool = listResult[ 'tools' ]
            .find( ( tool ) => {
                const isMatch = tool[ 'namespace' ] === 'v4toolssrc'

                return isMatch
            } )

        const { result } = await FlowMcpCli.callTool( {
            'toolName': v4Tool[ 'toolName' ],
            'cwd': TEST_CWD
        } )

        // Must NOT be "tool not found" — that was the v4 blocker symptom.
        const notFound = result[ 'error' ] && result[ 'error' ].includes( 'not found in active tools' )
        expect( notFound ).toBeFalsy()
        expect( result[ 'status' ] ).toBe( true )
    }, 20000 )
} )
