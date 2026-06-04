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
    version: '4.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    tools: {
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
    'schemaSpec': '4.0.0',
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
        'schemaSpec': '4.0.0'
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
        'schemaSpec': '4.0.0'
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


// Memo 102 / PRD-002 — the three "FlowMcpCli.test" deep-path describe blocks
// (group param branch, group env-missing branch, schemaPath null-config branch)
// were removed together with FlowMcpCli.test. The callListTools/callTool
// branches below are independent and stay.


// ---------------------------------------------------------------------------
// FlowMcpCli.callListTools — no active tools (lines 2177-2180)
// ---------------------------------------------------------------------------

// Memo 099 Kap 5 — call list-tools lists ALL tools from the schemaFolders.
// There is no activation/group gate, so an empty/absent local config is fine.
describe( 'FlowMcpCli.callListTools — no activation required (Memo 099)', () => {
    it( 'lists all tools when local config has an empty tools array', async () => {
        const { result } = await FlowMcpCli.callListTools( {
            'group': undefined,
            'cwd': EMPTY_TOOLS_CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'group' ] ).toBe( '_all' )
    } )


    it( 'lists all tools when cwd has no local config at all', async () => {
        const { result } = await FlowMcpCli.callListTools( {
            'group': undefined,
            'cwd': NO_CONFIG_CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'group' ] ).toBe( '_all' )
    } )
} )


// ---------------------------------------------------------------------------
// Memo 099 Kap 5 — group is removed; the group param is ignored.
// ---------------------------------------------------------------------------

describe( 'FlowMcpCli.callListTools — group param ignored (Memo 099)', () => {
    it( 'ignores a nonexistent group and still lists all tools', async () => {
        const { result } = await FlowMcpCli.callListTools( {
            'group': 'totally-nonexistent-group',
            'cwd': GROUP_MISSING_CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'group' ] ).toBe( '_all' )
    } )
} )


// ---------------------------------------------------------------------------
// FlowMcpCli.callTool — group schemas resolution failure (lines 2292-2295)
// ---------------------------------------------------------------------------

// Memo 099 Kap 5 — group is removed. The group param is ignored; the tool
// resolves against the schemaFolders regardless of any (non-)existent group.
describe( 'FlowMcpCli.callTool — group param ignored (Memo 099)', () => {
    it( 'ignores a nonexistent group name and resolves the tool', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'ping_deeptest',
            'jsonArgs': undefined,
            'group': 'totally-nonexistent-group',
            'cwd': GROUP_MISSING_CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
    }, 15000 )


    it( 'ignores the group param even when cwd has no local config', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'ping_deeptest',
            'jsonArgs': undefined,
            'group': 'any-group',
            'cwd': NO_CONFIG_CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
    }, 15000 )
} )
