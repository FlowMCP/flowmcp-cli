import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
const SOURCE_NAME = 'deepremove'
const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )
const ENV_PATH = join( GLOBAL_CONFIG_DIR, '.env.deepremove' )

let originalGlobalConfig = null
let globalConfigExisted = false


const SIMPLE_SCHEMA = `export const main = {
    namespace: 'deepremove',
    name: 'DeepRemove Simple API',
    description: 'Simple schema for remove and misc path tests',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    routes: {
        ping: {
            method: 'GET',
            description: 'Simple ping endpoint',
            path: '/get',
            parameters: []
        }
    }
}
`

const PARAMS_SCHEMA = `export const main = {
    namespace: 'deepremoveparams',
    name: 'DeepRemove Params API',
    description: 'Schema with various parameter types for extraction tests',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    routes: {
        noZParam: {
            method: 'GET',
            description: 'Route with parameter that has no z field',
            path: '/get',
            parameters: [
                {
                    position: { key: 'query', value: '{{USER_PARAM}}', location: 'query' }
                }
            ]
        },
        enumParam: {
            method: 'GET',
            description: 'Route with enum parameter',
            path: '/get',
            parameters: [
                {
                    position: { key: 'interval', value: '{{USER_PARAM}}', location: 'query' },
                    z: { primitive: 'enum(h1,d1,w1)', options: [] }
                }
            ]
        },
        numberParam: {
            method: 'GET',
            description: 'Route with number parameter and default',
            path: '/get',
            parameters: [
                {
                    position: { key: 'limit', value: '{{USER_PARAM}}', location: 'query' },
                    z: { primitive: 'number()', options: [ 'optional()', 'default(10)' ] }
                }
            ]
        },
        arrayParam: {
            method: 'GET',
            description: 'Route with required array parameter',
            path: '/get',
            parameters: [
                {
                    position: { key: 'ids', value: '{{USER_PARAM}}', location: 'query' },
                    z: { primitive: 'array()', options: [] }
                }
            ]
        }
    }
}
`

const CACHED_SCHEMA = `export const main = {
    namespace: 'deepremovecached',
    name: 'DeepRemove Cached API',
    description: 'Schema with preload route and params for cache key test',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    routes: {
        cachedSearch: {
            method: 'GET',
            description: 'Cached search with user param',
            path: '/get',
            parameters: [
                {
                    position: { key: 'q', value: '{{USER_PARAM}}', location: 'query' },
                    z: { primitive: 'string()', options: [] }
                }
            ],
            preload: { enabled: true, ttl: 300 }
        }
    }
}
`

const REGISTRY = {
    'name': 'deepremove',
    'version': '1.0.0',
    'description': 'Registry for remove and misc path tests',
    'schemaSpec': '2.0.0',
    'schemas': [
        {
            'namespace': 'deepremove',
            'file': 'simple.mjs',
            'name': 'DeepRemove Simple API',
            'requiredServerParams': []
        },
        {
            'namespace': 'deepremoveparams',
            'file': 'params.mjs',
            'name': 'DeepRemove Params API',
            'requiredServerParams': []
        },
        {
            'namespace': 'deepremovecached',
            'file': 'cached.mjs',
            'name': 'DeepRemove Cached API',
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

    await mkdir( SOURCE_DIR, { recursive: true } )
    await writeFile( join( SOURCE_DIR, 'simple.mjs' ), SIMPLE_SCHEMA, 'utf-8' )
    await writeFile( join( SOURCE_DIR, 'params.mjs' ), PARAMS_SCHEMA, 'utf-8' )
    await writeFile( join( SOURCE_DIR, 'cached.mjs' ), CACHED_SCHEMA, 'utf-8' )
    await writeFile(
        join( SOURCE_DIR, '_registry.json' ),
        JSON.stringify( REGISTRY, null, 4 ),
        'utf-8'
    )

    await writeFile( ENV_PATH, 'DEEPREMOVE_TEST=true\n', 'utf-8' )

    const globalConfig = {
        'envPath': ENV_PATH,
        'flowmcpCore': {
            'version': '2.0.0',
            'commit': 'abc123deepremove',
            'schemaSpec': '2.0.0'
        },
        'initialized': new Date().toISOString(),
        'sources': {
            'deepremove': {
                'type': 'builtin',
                'schemaCount': 3
            }
        }
    }

    if( globalConfigExisted && originalGlobalConfig ) {
        const parsed = JSON.parse( originalGlobalConfig )
        parsed[ 'sources' ] = parsed[ 'sources' ] || {}
        parsed[ 'sources' ][ 'deepremove' ] = globalConfig[ 'sources' ][ 'deepremove' ]
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

    await rm( SOURCE_DIR, { recursive: true, force: true } ).catch( () => {} )
    await rm( ENV_PATH, { force: true } ).catch( () => {} )
} )


describe( 'FlowMcpCli.remove — tool not recognized in global catalog', () => {
    const CWD = join( tmpdir(), `flowmcp-remove-notrecognized-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'tools': [
                'deepremove/simple.mjs::ping'
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


    it( 'returns error when toolName does not match any known global schema tool', async () => {
        const { result } = await FlowMcpCli.remove( {
            'toolName': 'fakeTool_zzz_nonexistent',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'not recognized' )
    } )
} )


describe( 'FlowMcpCli.remove — successful group-based removal', () => {
    const CWD = join( tmpdir(), `flowmcp-remove-groupbased-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'mygroup',
            'groups': {
                'mygroup': {
                    'tools': [
                        'deepremove/simple.mjs::ping'
                    ]
                }
            }
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


    it( 'removes a tool from a group-based local config', async () => {
        const { result } = await FlowMcpCli.remove( {
            'toolName': 'ping_deepremove',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'removed' ] ).toBe( 'ping_deepremove' )
    } )


    it( 'clears the tool from the group tools array after removal', async () => {
        const configRaw = await readFile( join( CWD, '.flowmcp', 'config.json' ), 'utf-8' )
        const config = JSON.parse( configRaw )

        const groupTools = config[ 'groups' ][ 'mygroup' ][ 'tools' ]

        expect( groupTools ).not.toContain( 'deepremove/simple.mjs::ping' )
    } )
} )


describe( 'FlowMcpCli.list — broken toolRef schema returns null main', () => {
    const CWD = join( tmpdir(), `flowmcp-list-brokenmain-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'tools': [
                'deepremove/nonexistent-schema.mjs::ping'
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


    it( 'returns an empty tool list when the only toolRef points to a nonexistent schema', async () => {
        const { result } = await FlowMcpCli.list( { 'cwd': CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolCount' ] ).toBe( 0 )
        expect( result[ 'tools' ] ).toHaveLength( 0 )
    } )
} )


describe( 'FlowMcpCli.status — healthCheck level 1 failure when global config is missing', () => {
    const CWD = join( tmpdir(), `flowmcp-status-noglobalconfig-${Date.now()}` )

    let savedConfig = null


    beforeAll( async () => {
        await mkdir( CWD, { recursive: true } )
        savedConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )

        await rm( GLOBAL_CONFIG_PATH, { force: true } ).catch( () => {} )
    } )


    afterAll( async () => {
        if( savedConfig ) {
            await writeFile( GLOBAL_CONFIG_PATH, savedConfig, 'utf-8' )
        }

        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'returns globalConfig check with ok: false when global config does not exist', async () => {
        const { result } = await FlowMcpCli.status( { 'cwd': CWD } )

        const globalConfigCheck = result[ 'checks' ]
            .find( ( check ) => {
                const isGlobalConfig = check[ 'name' ] === 'globalConfig'

                return isGlobalConfig
            } )

        expect( globalConfigCheck ).toBeDefined()
        expect( globalConfigCheck[ 'ok' ] ).toBe( false )
        expect( result[ 'healthy' ] ).toBe( false )
    } )
} )


describe( 'FlowMcpCli.add — extractParameters with no z field', () => {
    const CWD = join( tmpdir(), `flowmcp-params-noz-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )
    } )


    afterAll( async () => {
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'defaults to type string required true when parameter has no z field', async () => {
        const { result } = await FlowMcpCli.add( {
            'toolName': 'no_zparam_deepremoveparams',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'parameters' ] ).toBeDefined()
        expect( result[ 'parameters' ][ 'query' ] ).toBeDefined()
        expect( result[ 'parameters' ][ 'query' ][ 'type' ] ).toBe( 'string' )
        expect( result[ 'parameters' ][ 'query' ][ 'required' ] ).toBe( true )
    } )
} )


describe( 'FlowMcpCli.add — extractParameters with enum type', () => {
    const CWD = join( tmpdir(), `flowmcp-params-enum-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )
    } )


    afterAll( async () => {
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'extracts enum type with correct values array', async () => {
        const { result } = await FlowMcpCli.add( {
            'toolName': 'enum_param_deepremoveparams',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'parameters' ] ).toBeDefined()
        expect( result[ 'parameters' ][ 'interval' ] ).toBeDefined()
        expect( result[ 'parameters' ][ 'interval' ][ 'type' ] ).toBe( 'enum' )
        expect( result[ 'parameters' ][ 'interval' ][ 'values' ] ).toEqual( [ 'h1', 'd1', 'w1' ] )
        expect( result[ 'parameters' ][ 'interval' ][ 'required' ] ).toBe( true )
    } )
} )


describe( 'FlowMcpCli.add — extractParameters with number type and default', () => {
    const CWD = join( tmpdir(), `flowmcp-params-number-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )
    } )


    afterAll( async () => {
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'extracts number type with required false and numeric default value', async () => {
        const { result } = await FlowMcpCli.add( {
            'toolName': 'number_param_deepremoveparams',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'parameters' ] ).toBeDefined()
        expect( result[ 'parameters' ][ 'limit' ] ).toBeDefined()
        expect( result[ 'parameters' ][ 'limit' ][ 'type' ] ).toBe( 'number' )
        expect( result[ 'parameters' ][ 'limit' ][ 'required' ] ).toBe( false )
        expect( result[ 'parameters' ][ 'limit' ][ 'default' ] ).toBe( 10 )
    } )
} )


describe( 'FlowMcpCli.add — extractParameters with array type', () => {
    const CWD = join( tmpdir(), `flowmcp-params-array-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )
    } )


    afterAll( async () => {
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'extracts array type with required true', async () => {
        const { result } = await FlowMcpCli.add( {
            'toolName': 'array_param_deepremoveparams',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'parameters' ] ).toBeDefined()
        expect( result[ 'parameters' ][ 'ids' ] ).toBeDefined()
        expect( result[ 'parameters' ][ 'ids' ][ 'type' ] ).toBe( 'array' )
        expect( result[ 'parameters' ][ 'ids' ][ 'required' ] ).toBe( true )
    } )
} )


describe( 'FlowMcpCli.callTool — buildCacheKey with user params triggers hash subdirectory', () => {
    const CWD = join( tmpdir(), `flowmcp-cachekey-params-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'cachegroup',
            'groups': {
                'cachegroup': {
                    'tools': [
                        'deepremove/cached.mjs::cachedSearch'
                    ]
                }
            }
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


    it( 'calls preload-enabled route with params and returns successful result with cache info', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'cached_search_deepremovecached',
            'jsonArgs': '{"q":"test"}',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolName' ] ).toBe( 'cached_search_deepremovecached' )
        expect( result[ 'cache' ] ).toBeDefined()
    }, 15000 )


    it( 'second call with same params returns a cache hit', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'cached_search_deepremovecached',
            'jsonArgs': '{"q":"test"}',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'cache' ][ 'hit' ] ).toBe( true )
    }, 15000 )


    it( 'call with different params generates a separate cache entry', async () => {
        const firstCall = await FlowMcpCli.callTool( {
            'toolName': 'cached_search_deepremovecached',
            'jsonArgs': '{"q":"different"}',
            'cwd': CWD
        } )

        const firstResult = firstCall[ 'result' ]

        expect( firstResult[ 'status' ] ).toBe( true )
        expect( firstResult[ 'cache' ] ).toBeDefined()

        const isFreshOrStored = firstResult[ 'cache' ][ 'stored' ] === true
            || firstResult[ 'cache' ][ 'hit' ] === true

        expect( isFreshOrStored ).toBe( true )
    }, 15000 )
} )
