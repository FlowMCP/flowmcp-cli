import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
const SOURCE_NAME = 'deeptestsrc'
const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )

const TEST_BASE = join( tmpdir(), 'flowmcp-cli-deep-paths-test' )
const ENV_PATH = join( TEST_BASE, '.env' )

// cwd for group-based test() — has a valid defaultGroup pointing to our schema
const GROUP_CWD = join( TEST_BASE, 'group-cwd' )
const GROUP_CWD_LOCAL_DIR = join( GROUP_CWD, '.flowmcp' )

// cwd for env-missing test() — has a valid group but global config has a bad envPath
const NO_ENV_CWD = join( TEST_BASE, 'no-env-cwd' )
const NO_ENV_CWD_LOCAL_DIR = join( NO_ENV_CWD, '.flowmcp' )

// cwd for config-null test() — has no .flowmcp/config.json at all
const NO_CONFIG_CWD = join( TEST_BASE, 'no-config-cwd' )

// cwd for callListTools no-active-tools test — has empty tools array
const EMPTY_TOOLS_CWD = join( TEST_BASE, 'empty-tools-cwd' )
const EMPTY_TOOLS_LOCAL_DIR = join( EMPTY_TOOLS_CWD, '.flowmcp' )

// cwd for callListTools/callTool nonexistent-group test
const GROUP_MISSING_CWD = join( TEST_BASE, 'group-missing-cwd' )
const GROUP_MISSING_LOCAL_DIR = join( GROUP_MISSING_CWD, '.flowmcp' )

let originalGlobalConfig = null
let globalConfigExisted = false

// Schema that has a tests array so test() can exercise the group-based test execution path
const SCHEMA_WITH_TESTS = `export const main = {
    namespace: 'deeptest',
    name: 'Deep Test API',
    description: 'Schema for deep test paths',
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
            parameters: [],
            tests: [ { _description: 'Test ping' } ]
        }
    }
}
`

const REGISTRY = {
    'name': SOURCE_NAME,
    'version': '1.0.0',
    'description': 'Registry for deep path tests',
    'schemaSpec': '2.0.0',
    'schemas': [
        {
            'namespace': 'deeptest',
            'file': 'api.mjs',
            'name': 'Deep Test API',
            'requiredServerParams': []
        }
    ]
}

// Global config that points envPath to our existing TEST_BASE .env file
const GLOBAL_CONFIG_WITH_ENV = {
    'envPath': ENV_PATH,
    'flowmcpCore': {
        'version': '2.0.0',
        'commit': 'abc123def',
        'schemaSpec': '2.0.0'
    },
    'initialized': '2026-02-20T12:00:00.000Z',
    'sources': {
        [SOURCE_NAME]: {
            'type': 'builtin',
            'schemaCount': 1
        }
    }
}

// Global config whose envPath points to a nonexistent file — used to trigger env-missing branch
const GLOBAL_CONFIG_MISSING_ENV = {
    'envPath': join( TEST_BASE, 'does-not-exist.env' ),
    'flowmcpCore': {
        'version': '2.0.0',
        'commit': 'abc123def',
        'schemaSpec': '2.0.0'
    },
    'initialized': '2026-02-20T12:00:00.000Z',
    'sources': {
        [SOURCE_NAME]: {
            'type': 'builtin',
            'schemaCount': 1
        }
    }
}

// Local config for GROUP_CWD — uses an explicit group that matches our schema
const GROUP_LOCAL_CONFIG = {
    'root': '~/.flowmcp',
    'defaultGroup': 'deep-group',
    'groups': {
        'deep-group': {
            'description': 'Group with deep test schema',
            'tools': [
                `${SOURCE_NAME}/api.mjs::ping`
            ]
        }
    }
}

// Local config for NO_ENV_CWD — same group definition, same structure
const NO_ENV_LOCAL_CONFIG = {
    'root': '~/.flowmcp',
    'defaultGroup': 'deep-group',
    'groups': {
        'deep-group': {
            'description': 'Group with deep test schema',
            'tools': [
                `${SOURCE_NAME}/api.mjs::ping`
            ]
        }
    }
}

// Local config for EMPTY_TOOLS_CWD — tools array is empty so #resolveAgentSchemas returns null
const EMPTY_TOOLS_LOCAL_CONFIG = {
    'root': '~/.flowmcp',
    'tools': []
}

// Local config for GROUP_MISSING_CWD — has groups but not the one we will request
const GROUP_MISSING_LOCAL_CONFIG = {
    'root': '~/.flowmcp',
    'defaultGroup': 'existing-group',
    'groups': {
        'existing-group': {
            'description': 'An existing group',
            'tools': [
                `${SOURCE_NAME}/api.mjs::ping`
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
    await mkdir( TEST_BASE, { recursive: true } )

    // Write the real .env file used by most tests
    await writeFile( ENV_PATH, 'SOME_KEY=hello\n', 'utf-8' )

    // Create the schema source dir with registry and schema file
    await mkdir( SOURCE_DIR, { recursive: true } )
    await writeFile( join( SOURCE_DIR, 'api.mjs' ), SCHEMA_WITH_TESTS, 'utf-8' )
    await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( REGISTRY, null, 4 ), 'utf-8' )

    // Write global config pointing to the existing .env
    await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( GLOBAL_CONFIG_WITH_ENV, null, 4 ), 'utf-8' )

    // Setup GROUP_CWD — valid group, valid env
    await mkdir( GROUP_CWD_LOCAL_DIR, { recursive: true } )
    await writeFile( join( GROUP_CWD_LOCAL_DIR, 'config.json' ), JSON.stringify( GROUP_LOCAL_CONFIG, null, 4 ), 'utf-8' )

    // Setup NO_ENV_CWD — valid group, env file missing (will be switched during test)
    await mkdir( NO_ENV_CWD_LOCAL_DIR, { recursive: true } )
    await writeFile( join( NO_ENV_CWD_LOCAL_DIR, 'config.json' ), JSON.stringify( NO_ENV_LOCAL_CONFIG, null, 4 ), 'utf-8' )

    // NO_CONFIG_CWD — directory exists but has no .flowmcp/config.json inside
    await mkdir( NO_CONFIG_CWD, { recursive: true } )

    // EMPTY_TOOLS_CWD — local config has an empty tools array
    await mkdir( EMPTY_TOOLS_LOCAL_DIR, { recursive: true } )
    await writeFile( join( EMPTY_TOOLS_LOCAL_DIR, 'config.json' ), JSON.stringify( EMPTY_TOOLS_LOCAL_CONFIG, null, 4 ), 'utf-8' )

    // GROUP_MISSING_CWD — local config has groups but not the one we will request
    await mkdir( GROUP_MISSING_LOCAL_DIR, { recursive: true } )
    await writeFile( join( GROUP_MISSING_LOCAL_DIR, 'config.json' ), JSON.stringify( GROUP_MISSING_LOCAL_CONFIG, null, 4 ), 'utf-8' )
} )


afterAll( async () => {
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    await rm( SOURCE_DIR, { recursive: true, force: true } )
    await rm( TEST_BASE, { recursive: true, force: true } )
} )


// ---------------------------------------------------------------------------
// FlowMcpCli.test — group parameter branch (lines 1632-1635)
// ---------------------------------------------------------------------------

describe( 'FlowMcpCli.test with explicit group parameter', () => {
    it( 'runs tests for schemas resolved from the named group', async () => {
        const { result } = await FlowMcpCli.test( {
            'schemaPath': undefined,
            'route': undefined,
            'cwd': GROUP_CWD,
            'group': 'deep-group',
            'all': undefined
        } )

        expect( result[ 'status' ] ).toBeDefined()
        expect( result ).toHaveProperty( 'total' )
        expect( result ).toHaveProperty( 'passed' )
        expect( result ).toHaveProperty( 'failed' )
        expect( result ).toHaveProperty( 'results' )
        expect( Array.isArray( result[ 'results' ] ) ).toBe( true )
        expect( result[ 'results' ].length ).toBeGreaterThanOrEqual( 1 )
    }, 30000 )


    it( 'result entries contain namespace and routeName from the group schema', async () => {
        const { result } = await FlowMcpCli.test( {
            'schemaPath': undefined,
            'route': undefined,
            'cwd': GROUP_CWD,
            'group': 'deep-group',
            'all': undefined
        } )

        const firstEntry = result[ 'results' ][ 0 ]

        expect( firstEntry[ 'namespace' ] ).toBe( 'deeptest' )
        expect( firstEntry[ 'routeName' ] ).toBe( 'ping' )
        expect( firstEntry ).toHaveProperty( 'status' )
    }, 30000 )
} )


// ---------------------------------------------------------------------------
// FlowMcpCli.test — group path with missing env file (lines 1652-1658)
// ---------------------------------------------------------------------------

describe( 'FlowMcpCli.test with group — env file missing', () => {
    it( 'returns error containing Cannot read .env file when envPath is missing', async () => {
        // Temporarily switch global config to one with a nonexistent envPath
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( GLOBAL_CONFIG_MISSING_ENV, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.test( {
            'schemaPath': undefined,
            'route': undefined,
            'cwd': NO_ENV_CWD,
            'group': 'deep-group',
            'all': undefined
        } )

        // Restore the working global config before any assertions that could throw
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( GLOBAL_CONFIG_WITH_ENV, null, 4 ), 'utf-8' )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'Cannot read .env file' )
    } )
} )


// ---------------------------------------------------------------------------
// FlowMcpCli.test — schemaPath provided but no local config (lines 1795-1799)
// ---------------------------------------------------------------------------

describe( 'FlowMcpCli.test with schemaPath — config returns null', () => {
    it( 'returns config error when cwd has no .flowmcp/config.json', async () => {
        // NO_CONFIG_CWD has no .flowmcp directory — #readConfig will find globalConfig
        // but localConfig is null, and the envPath from globalConfig still works.
        // The null-config path (lines 1796-1799) is triggered when #readConfig itself
        // returns null config — this happens when the global config is missing.
        // We deliberately use an uninitialized cwd without any local config to trigger
        // the schemaPath path (validationTest passes) and then #readConfig returns null
        // because the cwd has no .flowmcp/config.json — BUT global config still has
        // initialized flag, so we need to also test the case where cwd is undefined.
        //
        // Per the source: #readConfig only returns null config when globalConfig is null.
        // So this test verifies that when schemaPath is valid and cwd points to a dir
        // without .flowmcp/config.json, the flow still proceeds (config is not null —
        // localConfig is null but config is still returned). To hit lines 1797-1799
        // we pass a nonexistent cwd so that validationTest passes and then #readConfig
        // builds a config with null local — since globalConfig is present with
        // initialized flag, config is NOT null. Lines 1797-1799 are only reached when
        // globalConfig itself is absent.
        //
        // Strategy: remove the global config file, then call test() with a schemaPath.
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( { 'sources': {} }, null, 4 ), 'utf-8' )

        const schemaFile = join( SOURCE_DIR, 'api.mjs' )
        const { result } = await FlowMcpCli.test( {
            'schemaPath': schemaFile,
            'route': undefined,
            'cwd': NO_CONFIG_CWD,
            'group': undefined,
            'all': undefined
        } )

        // Restore global config immediately
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( GLOBAL_CONFIG_WITH_ENV, null, 4 ), 'utf-8' )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
    } )
} )


// ---------------------------------------------------------------------------
// FlowMcpCli.callListTools — no active tools (lines 2177-2180)
// ---------------------------------------------------------------------------

describe( 'FlowMcpCli.callListTools — no active tools', () => {
    it( 'returns No active tools error when local config has an empty tools array', async () => {
        const { result } = await FlowMcpCli.callListTools( {
            'group': undefined,
            'cwd': EMPTY_TOOLS_CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'No active tools' )
    } )


    it( 'returns No active tools error when cwd has no local config at all', async () => {
        const { result } = await FlowMcpCli.callListTools( {
            'group': undefined,
            'cwd': NO_CONFIG_CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'No active tools' )
    } )
} )


// ---------------------------------------------------------------------------
// FlowMcpCli.callListTools — group schemas resolution failure (lines 2196-2199)
// ---------------------------------------------------------------------------

describe( 'FlowMcpCli.callListTools — nonexistent group', () => {
    it( 'returns group not found error when group name does not exist in local config', async () => {
        const { result } = await FlowMcpCli.callListTools( {
            'group': 'totally-nonexistent-group',
            'cwd': GROUP_MISSING_CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'totally-nonexistent-group' )
    } )
} )


// ---------------------------------------------------------------------------
// FlowMcpCli.callTool — group schemas resolution failure (lines 2292-2295)
// ---------------------------------------------------------------------------

describe( 'FlowMcpCli.callTool — nonexistent group', () => {
    it( 'returns group not found error when group name does not exist in local config', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'ping_deeptest',
            'jsonArgs': undefined,
            'group': 'totally-nonexistent-group',
            'cwd': GROUP_MISSING_CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'totally-nonexistent-group' )
    } )


    it( 'returns error when group name is valid but cwd has no local config', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'ping_deeptest',
            'jsonArgs': undefined,
            'group': 'any-group',
            'cwd': NO_CONFIG_CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
    } )
} )
