import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
const CACHE_DIR = join( GLOBAL_CONFIG_DIR, 'cache' )
const ENV_PATH = join( GLOBAL_CONFIG_DIR, '.env.helpers' )

let originalGlobalConfig = null
let globalConfigExisted = false


beforeAll( async () => {
    try {
        originalGlobalConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        globalConfigExisted = true
    } catch {
        globalConfigExisted = false
    }

    await writeFile( ENV_PATH, 'HELPER_KEY=abc\n', 'utf-8' )
} )


afterAll( async () => {
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    await rm( ENV_PATH, { force: true } ).catch( () => {} )
} )


describe( 'FlowMcpCli.schemas with source without registry — exercises listSchemaFiles', () => {
    const SOURCE_NAME = 'noregistry'
    const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )
    const SUB_DIR = join( SOURCE_DIR, 'subdir' )


    beforeAll( async () => {
        await mkdir( SUB_DIR, { recursive: true } )

        const simpleSchema = `export const main = {
    namespace: 'noregistry',
    name: 'No Registry API',
    description: 'Schema without registry',
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

        await writeFile( join( SOURCE_DIR, 'schema.mjs' ), simpleSchema, 'utf-8' )
        await writeFile( join( SUB_DIR, 'nested.mjs' ), simpleSchema, 'utf-8' )
        await writeFile( join( SOURCE_DIR, '_helper.mjs' ), '// helper file\n', 'utf-8' )

        const globalConfig = {
            'envPath': ENV_PATH,
            'flowmcpCore': {
                'version': '2.0.0',
                'commit': 'abc123',
                'schemaSpec': '2.0.0'
            },
            'initialized': new Date().toISOString(),
            'sources': {
                [SOURCE_NAME]: {
                    'type': 'local',
                    'schemaCount': 2
                }
            }
        }

        if( globalConfigExisted && originalGlobalConfig ) {
            const parsed = JSON.parse( originalGlobalConfig )
            parsed[ 'sources' ] = parsed[ 'sources' ] || {}
            parsed[ 'sources' ][ SOURCE_NAME ] = globalConfig[ 'sources' ][ SOURCE_NAME ]
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
    } )


    it( 'lists schemas including nested subdirectories and skipping underscore files', async () => {
        const { result } = await FlowMcpCli.schemas()

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'sources' ] ).toBeDefined()

        const noregSource = result[ 'sources' ]
            .find( ( s ) => {
                const isMatch = s[ 'name' ] === SOURCE_NAME

                return isMatch
            } )

        expect( noregSource ).toBeDefined()
        expect( noregSource[ 'schemas' ].length ).toBeGreaterThanOrEqual( 2 )

        const schemaFiles = noregSource[ 'schemas' ]
            .map( ( s ) => {
                const ref = s[ 'ref' ]

                return ref
            } )

        const hasUnderscore = schemaFiles
            .some( ( f ) => {
                const starts = f.includes( '_helper' )

                return starts
            } )

        expect( hasUnderscore ).toBe( false )
    } )
} )


describe( 'FlowMcpCli.cacheStatus with nested cache structure — exercises collectCacheFiles', () => {
    beforeAll( async () => {
        const nestedCacheDir = join( CACHE_DIR, 'testns', 'subroute' )
        await mkdir( nestedCacheDir, { recursive: true } )

        const now = new Date()
        const expiresAt = new Date( now.getTime() + 600000 )

        const cacheEntry = {
            'meta': {
                'fetchedAt': now.toISOString(),
                'expiresAt': expiresAt.toISOString(),
                'ttl': 600,
                'size': 42
            },
            'data': { 'test': true }
        }

        await writeFile(
            join( CACHE_DIR, 'testns', 'simple.json' ),
            JSON.stringify( cacheEntry, null, 2 ),
            'utf-8'
        )

        await writeFile(
            join( nestedCacheDir, 'nested.json' ),
            JSON.stringify( cacheEntry, null, 2 ),
            'utf-8'
        )

        await writeFile(
            join( CACHE_DIR, 'testns', 'corrupt.json' ),
            'not valid json',
            'utf-8'
        )
    } )


    afterAll( async () => {
        await rm( CACHE_DIR, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'returns cache status including nested entries', async () => {
        const { result } = await FlowMcpCli.cacheStatus()

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'entries' ] ).toBeDefined()
        expect( result[ 'entries' ].length ).toBeGreaterThanOrEqual( 2 )
    } )
} )


describe( 'FlowMcpCli.list with toolRef without route — exercises parseToolRef no-separator', () => {
    const CWD = join( tmpdir(), `flowmcp-parse-toolref-${Date.now()}` )
    const SOURCE_NAME = 'toolrefsrc'
    const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )
        await mkdir( SOURCE_DIR, { recursive: true } )

        const schema = `export const main = {
    namespace: 'toolrefsrc',
    name: 'ToolRef API',
    description: 'Schema for toolRef tests',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    routes: {
        routeA: {
            method: 'GET',
            description: 'Route A',
            path: '/get',
            parameters: []
        },
        routeB: {
            method: 'GET',
            description: 'Route B',
            path: '/get',
            parameters: []
        }
    }
}
`

        const registry = {
            'name': SOURCE_NAME,
            'version': '1.0.0',
            'description': 'ToolRef test source',
            'schemaSpec': '2.0.0',
            'schemas': [
                {
                    'namespace': 'toolrefsrc',
                    'file': 'multi.mjs',
                    'name': 'ToolRef API',
                    'requiredServerParams': []
                }
            ]
        }

        await writeFile( join( SOURCE_DIR, 'multi.mjs' ), schema, 'utf-8' )
        await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( registry, null, 4 ), 'utf-8' )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'ref-group',
            'groups': {
                'ref-group': {
                    'tools': [
                        `${SOURCE_NAME}/multi.mjs`
                    ]
                }
            }
        }

        await writeFile(
            join( CWD, '.flowmcp', 'config.json' ),
            JSON.stringify( localConfig, null, 4 ),
            'utf-8'
        )

        const globalConfig = {
            'envPath': ENV_PATH,
            'flowmcpCore': {
                'version': '2.0.0',
                'commit': 'abc123',
                'schemaSpec': '2.0.0'
            },
            'initialized': new Date().toISOString(),
            'sources': {
                [SOURCE_NAME]: {
                    'type': 'local',
                    'schemaCount': 1
                }
            }
        }

        if( globalConfigExisted && originalGlobalConfig ) {
            const parsed = JSON.parse( originalGlobalConfig )
            parsed[ 'sources' ] = parsed[ 'sources' ] || {}
            parsed[ 'sources' ][ SOURCE_NAME ] = globalConfig[ 'sources' ][ SOURCE_NAME ]
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
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'lists all routes when toolRef has no :: separator', async () => {
        const { result } = await FlowMcpCli.list( { 'cwd': CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolCount' ] ).toBeGreaterThanOrEqual( 2 )

        const toolNames = result[ 'tools' ]
            .map( ( t ) => {
                const name = t[ 'name' ]

                return name
            } )

        expect( toolNames ).toContain( 'route_a_toolrefsrc' )
        expect( toolNames ).toContain( 'route_b_toolrefsrc' )
    } )
} )
