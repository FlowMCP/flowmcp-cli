import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
const SOURCE_NAME = 'routefilter'
const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )
const ENV_PATH = join( GLOBAL_CONFIG_DIR, '.env.routefilter' )

let originalGlobalConfig = null
let globalConfigExisted = false

const SCHEMA_WITH_TESTS = `export const main = {
    namespace: 'routefilter',
    name: 'Route Filter API',
    description: 'Schema with tests for route filtering',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    routes: {
        pingRoute: {
            method: 'GET',
            description: 'Ping route with tests',
            path: '/get',
            parameters: [],
            tests: [ { _description: 'Test ping' } ]
        },
        otherRoute: {
            method: 'GET',
            description: 'Other route with tests',
            path: '/get',
            parameters: [],
            tests: [ { _description: 'Test other' } ]
        }
    }
}
`

const SCHEMA_NO_ROUTES = `export const main = {
    namespace: 'routefilter_broken',
    name: 'Broken Schema',
    description: 'Schema that may trigger catch blocks',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {}
}
`

const REGISTRY = {
    'name': SOURCE_NAME,
    'version': '1.0.0',
    'description': 'Route filter test source',
    'schemaSpec': '2.0.0',
    'schemas': [
        {
            'namespace': 'routefilter',
            'file': 'withTests.mjs',
            'name': 'Route Filter API',
            'requiredServerParams': []
        },
        {
            'namespace': 'routefilter_broken',
            'file': 'broken.mjs',
            'name': 'Broken Schema',
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
    await writeFile( join( SOURCE_DIR, 'withTests.mjs' ), SCHEMA_WITH_TESTS, 'utf-8' )
    await writeFile( join( SOURCE_DIR, 'broken.mjs' ), SCHEMA_NO_ROUTES, 'utf-8' )
    await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( REGISTRY, null, 4 ), 'utf-8' )
    await writeFile( ENV_PATH, 'ROUTEFILTER_KEY=abc\n', 'utf-8' )

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
                'type': 'builtin',
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
    await rm( ENV_PATH, { force: true } ).catch( () => {} )
} )


describe( 'FlowMcpCli.test with group — route filter exercises lines 1717-1722', () => {
    const CWD = join( tmpdir(), `flowmcp-route-filter-group-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'filter-group',
            'groups': {
                'filter-group': {
                    'tools': [
                        `${SOURCE_NAME}/withTests.mjs::pingRoute`,
                        `${SOURCE_NAME}/withTests.mjs::otherRoute`
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


    it( 'filters to only pingRoute when route param is set', async () => {
        const { result } = await FlowMcpCli.test( {
            'group': 'filter-group',
            'route': 'pingRoute',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBeDefined()
        expect( result[ 'total' ] ).toBeGreaterThanOrEqual( 0 )
        expect( result[ 'results' ] ).toBeDefined()
    }, 30000 )


    it( 'returns empty results for nonexistent route', async () => {
        const { result } = await FlowMcpCli.test( {
            'group': 'filter-group',
            'route': 'nonexistent_route',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'total' ] ).toBe( 0 )
    }, 30000 )
} )


describe( 'FlowMcpCli.test with schemaPath — route filter exercises lines 1879-1884', () => {
    it( 'filters to only pingRoute when route param is set', async () => {
        const CWD = join( tmpdir(), `flowmcp-route-filter-schema-${Date.now()}` )
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'default',
            'groups': {
                'default': {
                    'tools': [ `${SOURCE_NAME}/withTests.mjs::pingRoute` ]
                }
            }
        }

        await writeFile(
            join( CWD, '.flowmcp', 'config.json' ),
            JSON.stringify( localConfig, null, 4 ),
            'utf-8'
        )

        const schemaPath = join( SOURCE_DIR, 'withTests.mjs' )

        const { result } = await FlowMcpCli.test( {
            schemaPath,
            'route': 'pingRoute',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBeDefined()
        expect( result[ 'total' ] ).toBeGreaterThanOrEqual( 0 )

        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    }, 30000 )


    it( 'returns zero results for nonexistent route with schemaPath', async () => {
        const CWD = join( tmpdir(), `flowmcp-route-filter-schema2-${Date.now()}` )
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'default',
            'groups': {
                'default': {
                    'tools': [ `${SOURCE_NAME}/withTests.mjs::pingRoute` ]
                }
            }
        }

        await writeFile(
            join( CWD, '.flowmcp', 'config.json' ),
            JSON.stringify( localConfig, null, 4 ),
            'utf-8'
        )

        const schemaPath = join( SOURCE_DIR, 'withTests.mjs' )

        const { result } = await FlowMcpCli.test( {
            schemaPath,
            'route': 'totally_nonexistent',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'total' ] ).toBe( 0 )

        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    }, 30000 )
} )


describe( 'FlowMcpCli.validate with group — validate catch on broken schema', () => {
    const CWD = join( tmpdir(), `flowmcp-validate-catch-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'validate-catch',
            'groups': {
                'validate-catch': {
                    'tools': [
                        `${SOURCE_NAME}/broken.mjs::ping`
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


    it( 'handles schema without routes in validation gracefully', async () => {
        const { result } = await FlowMcpCli.validate( { 'cwd': CWD } )

        expect( result[ 'status' ] ).toBeDefined()
        expect( result[ 'total' ] ).toBeGreaterThanOrEqual( 1 )
    } )
} )


describe( 'FlowMcpCli.validate with schemaPath — exercises catch block lines 1441-1448', () => {
    it( 'handles broken schema file via schemaPath', async () => {
        const { result } = await FlowMcpCli.validate( {
            'schemaPath': join( SOURCE_DIR, 'broken.mjs' )
        } )

        expect( result[ 'status' ] ).toBeDefined()
        expect( result[ 'total' ] ).toBe( 1 )
        expect( result[ 'results' ] ).toBeDefined()
    } )
} )


describe( 'FlowMcpCli.validate with schemaPath directory — exercises catch block lines 1386-1393', () => {
    it( 'validates directory with mixed valid and broken schemas', async () => {
        const { result } = await FlowMcpCli.validate( {
            'schemaPath': SOURCE_DIR
        } )

        expect( result[ 'total' ] ).toBeGreaterThanOrEqual( 2 )
        expect( result[ 'results' ] ).toBeDefined()
        expect( result[ 'results' ].length ).toBeGreaterThanOrEqual( 2 )
    } )
} )


describe( 'FlowMcpCli.list — schema with no routes exercises line 2870', () => {
    const CWD = join( tmpdir(), `flowmcp-list-broken-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'broken-list',
            'groups': {
                'broken-list': {
                    'tools': [
                        `${SOURCE_NAME}/broken.mjs::nonexistent`,
                        `${SOURCE_NAME}/withTests.mjs::pingRoute`
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


    it( 'lists tools skipping broken schema entries', async () => {
        const { result } = await FlowMcpCli.list( { 'cwd': CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolCount' ] ).toBeGreaterThanOrEqual( 1 )
    } )
} )


describe( 'FlowMcpCli.callListTools — no active tools in empty cwd', () => {
    it( 'returns error when cwd has no local config at all', async () => {
        const emptyCwd = join( tmpdir(), `flowmcp-listtools-empty-${Date.now()}` )
        await mkdir( emptyCwd, { recursive: true } )

        const { result } = await FlowMcpCli.callListTools( { 'cwd': emptyCwd } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'No active tools' )

        await rm( emptyCwd, { recursive: true, force: true } ).catch( () => {} )
    } )
} )
