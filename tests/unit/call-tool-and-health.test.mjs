import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
const TEST_CWD = join( tmpdir(), 'flowmcp-cli-call-tool-health-test' )

let originalGlobalConfig = null
let globalConfigExisted = false

const HEALTH_SCHEMA_CONTENT = `export const main = {
    namespace: 'healthapi',
    name: 'Health Test API',
    description: 'Schema for callTool and health tests',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [ 'HEALTH_TEST_KEY' ],
    headers: {},
    routes: {
        getAnything: {
            method: 'GET',
            description: 'Get anything',
            path: '/get',
            parameters: []
        }
    }
}
`

const HEALTH_REGISTRY = {
    'name': 'healthsrc',
    'version': '1.0.0',
    'description': 'Health test registry',
    'schemaSpec': '2.0.0',
    'schemas': [
        {
            'namespace': 'healthapi',
            'file': 'api.mjs',
            'name': 'Health Test API',
            'requiredServerParams': [ 'HEALTH_TEST_KEY' ]
        }
    ]
}

const SIMPLE_SCHEMA_CONTENT = `export const main = {
    namespace: 'simpleapi',
    name: 'Simple Test API',
    description: 'Schema for callTool success test',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    routes: {
        getData: {
            method: 'GET',
            description: 'Get data',
            path: '/get',
            parameters: []
        }
    }
}
`

const SIMPLE_REGISTRY = {
    'name': 'callsrc2',
    'version': '1.0.0',
    'description': 'Simple test registry',
    'schemaSpec': '2.0.0',
    'schemas': [
        {
            'namespace': 'simpleapi',
            'file': 'simple.mjs',
            'name': 'Simple Test API',
            'requiredServerParams': []
        }
    ]
}

const TEST_GLOBAL_CONFIG = {
    'envPath': join( TEST_CWD, '.env' ),
    'flowmcpCore': {
        'version': '2.0.0',
        'commit': 'abc123def',
        'schemaSpec': '2.0.0'
    },
    'initialized': '2026-02-20T12:00:00.000Z',
    'sources': {
        'healthsrc': {
            'type': 'github',
            'schemaCount': 1
        },
        'callsrc2': {
            'type': 'builtin',
            'schemaCount': 1
        }
    }
}

const TEST_LOCAL_CONFIG = {
    'root': '~/.flowmcp',
    'defaultGroup': 'default',
    'groups': {
        'default': {
            'description': 'Default group',
            'tools': [
                'callsrc2/simple.mjs::getData'
            ]
        },
        'health-group': {
            'description': 'Health group',
            'tools': [
                'healthsrc/api.mjs::getAnything'
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

    await mkdir( GLOBAL_CONFIG_DIR, { recursive: true } )
    await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( TEST_GLOBAL_CONFIG, null, 4 ), 'utf-8' )

    const healthsrcDir = join( SCHEMAS_DIR, 'healthsrc' )
    await mkdir( healthsrcDir, { recursive: true } )
    await writeFile( join( healthsrcDir, 'api.mjs' ), HEALTH_SCHEMA_CONTENT, 'utf-8' )
    await writeFile(
        join( healthsrcDir, '_registry.json' ),
        JSON.stringify( HEALTH_REGISTRY, null, 4 ),
        'utf-8'
    )

    const callsrc2Dir = join( SCHEMAS_DIR, 'callsrc2' )
    await mkdir( callsrc2Dir, { recursive: true } )
    await writeFile( join( callsrc2Dir, 'simple.mjs' ), SIMPLE_SCHEMA_CONTENT, 'utf-8' )
    await writeFile(
        join( callsrc2Dir, '_registry.json' ),
        JSON.stringify( SIMPLE_REGISTRY, null, 4 ),
        'utf-8'
    )

    await mkdir( TEST_CWD, { recursive: true } )
    await writeFile( join( TEST_CWD, '.env' ), 'HEALTH_TEST_KEY=test-value-123\n', 'utf-8' )

    const localConfigDir = join( TEST_CWD, '.flowmcp' )
    await mkdir( localConfigDir, { recursive: true } )
    await writeFile(
        join( localConfigDir, 'config.json' ),
        JSON.stringify( TEST_LOCAL_CONFIG, null, 4 ),
        'utf-8'
    )
} )


afterAll( async () => {
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    await rm( join( SCHEMAS_DIR, 'healthsrc' ), { recursive: true, force: true } )
    await rm( join( SCHEMAS_DIR, 'callsrc2' ), { recursive: true, force: true } )
    await rm( TEST_CWD, { recursive: true, force: true } )
} )


describe( 'FlowMcpCli.callTool success path', () => {
    it( 'calls tool successfully with httpbin.org', async () => {
        const { result } = await FlowMcpCli.callTool( {
            toolName: 'get_data_simpleapi',
            jsonArgs: '{}',
            group: undefined,
            cwd: TEST_CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolName' ] ).toBe( 'get_data_simpleapi' )
        expect( result[ 'content' ] ).toBeDefined()
    } )


    it( 'returns tool not found for non-matching tool name', async () => {
        const { result } = await FlowMcpCli.callTool( {
            toolName: 'nonexistent_tool',
            jsonArgs: '{}',
            group: undefined,
            cwd: TEST_CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'not found' )
    } )
} )


describe( 'FlowMcpCli.status deep health check', () => {
    it( 'performs full health check with schemas, env, local config, and groups', async () => {
        const { result } = await FlowMcpCli.status( { cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'checks' ] ).toBeDefined()
        expect( result[ 'checks' ].length ).toBeGreaterThanOrEqual( 5 )

        const globalConfigCheck = result[ 'checks' ]
            .find( ( check ) => {
                const isGlobalConfig = check[ 'name' ] === 'globalConfig'

                return isGlobalConfig
            } )

        expect( globalConfigCheck ).toBeDefined()
        expect( globalConfigCheck[ 'ok' ] ).toBe( true )

        const envFileCheck = result[ 'checks' ]
            .find( ( check ) => {
                const isEnvFile = check[ 'name' ] === 'envFile'

                return isEnvFile
            } )

        expect( envFileCheck ).toBeDefined()
        expect( envFileCheck[ 'ok' ] ).toBe( true )

        const schemasCheck = result[ 'checks' ]
            .find( ( check ) => {
                const isSchemas = check[ 'name' ] === 'schemas'

                return isSchemas
            } )

        expect( schemasCheck ).toBeDefined()
        expect( schemasCheck[ 'ok' ] ).toBe( true )

        const localConfigCheck = result[ 'checks' ]
            .find( ( check ) => {
                const isLocalConfig = check[ 'name' ] === 'localConfig'

                return isLocalConfig
            } )

        expect( localConfigCheck ).toBeDefined()
        expect( localConfigCheck[ 'ok' ] ).toBe( true )

        const groupsCheck = result[ 'checks' ]
            .find( ( check ) => {
                const isGroups = check[ 'name' ] === 'groups'

                return isGroups
            } )

        expect( groupsCheck ).toBeDefined()
        expect( groupsCheck[ 'ok' ] ).toBe( true )

        expect( result[ 'sources' ] ).toHaveProperty( 'healthsrc' )
        expect( result[ 'groups' ] ).toHaveProperty( 'default' )
        expect( result[ 'defaultGroup' ] ).toBe( 'default' )
    } )


    it( 'reports missing env params in health check', async () => {
        const tempCwd = join( tmpdir(), 'flowmcp-cli-health-missing-env-params' )
        const tempEnvPath = join( tempCwd, '.env' )
        await mkdir( tempCwd, { recursive: true } )
        await writeFile( tempEnvPath, 'SOME_OTHER_KEY=value\n', 'utf-8' )

        const tempGlobalConfig = {
            'envPath': tempEnvPath,
            'flowmcpCore': {
                'version': '2.0.0',
                'commit': 'abc123def',
                'schemaSpec': '2.0.0'
            },
            'initialized': '2026-02-20T12:00:00.000Z',
            'sources': {
                'healthsrc': {
                    'type': 'github',
                    'schemaCount': 1
                }
            }
        }

        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( tempGlobalConfig, null, 4 ), 'utf-8' )

        const tempLocalConfigDir = join( tempCwd, '.flowmcp' )
        await mkdir( tempLocalConfigDir, { recursive: true } )
        await writeFile(
            join( tempLocalConfigDir, 'config.json' ),
            JSON.stringify( {
                'root': '~/.flowmcp',
                'defaultGroup': 'health-group',
                'groups': {
                    'health-group': {
                        'description': 'Health group',
                        'tools': [ 'healthsrc/api.mjs::getAnything' ]
                    }
                }
            }, null, 4 ),
            'utf-8'
        )

        const { result } = await FlowMcpCli.status( { cwd: tempCwd } )

        const envParamsCheck = result[ 'checks' ]
            .find( ( check ) => {
                const isEnvParams = check[ 'name' ] === 'envParams'

                return isEnvParams
            } )

        expect( envParamsCheck ).toBeDefined()
        expect( envParamsCheck[ 'warnings' ] ).toBeDefined()

        const hasHealthKeyWarning = envParamsCheck[ 'warnings' ]
            .some( ( warning ) => {
                const mentionsKey = warning.includes( 'HEALTH_TEST_KEY' )

                return mentionsKey
            } )

        expect( hasHealthKeyWarning ).toBe( true )

        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( TEST_GLOBAL_CONFIG, null, 4 ), 'utf-8' )
        await rm( tempCwd, { recursive: true, force: true } )
    } )


    it( 'reports local config warnings for invalid structure', async () => {
        const tempCwd = join( tmpdir(), 'flowmcp-cli-health-invalid-local' )
        const tempEnvPath = join( tempCwd, '.env' )
        await mkdir( tempCwd, { recursive: true } )
        await writeFile( tempEnvPath, 'SOME_KEY=value\n', 'utf-8' )

        const tempGlobalConfig = {
            'envPath': tempEnvPath,
            'flowmcpCore': {
                'version': '2.0.0',
                'commit': 'abc123def',
                'schemaSpec': '2.0.0'
            },
            'initialized': '2026-02-20T12:00:00.000Z',
            'sources': {
                'healthsrc': {
                    'type': 'github',
                    'schemaCount': 1
                }
            }
        }

        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( tempGlobalConfig, null, 4 ), 'utf-8' )

        const tempLocalConfigDir = join( tempCwd, '.flowmcp' )
        await mkdir( tempLocalConfigDir, { recursive: true } )
        await writeFile(
            join( tempLocalConfigDir, 'config.json' ),
            JSON.stringify( {
                'root': '~/.flowmcp',
                'defaultGroup': 'broken-group',
                'groups': {
                    'broken-group': {
                        'description': 'Broken group',
                        'tools': 'not-an-array'
                    }
                }
            }, null, 4 ),
            'utf-8'
        )

        const { result } = await FlowMcpCli.status( { cwd: tempCwd } )

        const localConfigCheck = result[ 'checks' ]
            .find( ( check ) => {
                const isLocalConfig = check[ 'name' ] === 'localConfig'

                return isLocalConfig
            } )

        const groupsCheck = result[ 'checks' ]
            .find( ( check ) => {
                const isGroups = check[ 'name' ] === 'groups'

                return isGroups
            } )

        const hasLocalWarnings = localConfigCheck && localConfigCheck[ 'ok' ] === false
        const hasGroupWarnings = groupsCheck && groupsCheck[ 'ok' ] === false

        expect( hasLocalWarnings || hasGroupWarnings ).toBe( true )

        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( TEST_GLOBAL_CONFIG, null, 4 ), 'utf-8' )
        await rm( tempCwd, { recursive: true, force: true } )
    } )
} )
