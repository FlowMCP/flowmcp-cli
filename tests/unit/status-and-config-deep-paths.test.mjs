import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
const ENV_PATH = join( GLOBAL_CONFIG_DIR, '.env.deepconfig' )
const SOURCE_NAME = 'deepcfgsrc'
const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )

const schema = `export const main = {
    namespace: 'deepcfgsrc',
    name: 'Deep Config API',
    description: 'Schema for config tests',
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

const registry = {
    'name': SOURCE_NAME,
    'version': '1.0.0',
    'description': 'Deep config test',
    'schemaSpec': '2.0.0',
    'schemas': [
        { 'namespace': 'deepcfgsrc', 'file': 'simple.mjs', 'name': 'Deep Config API', 'requiredServerParams': [] }
    ]
}

let originalGlobalConfig = null
let globalConfigExisted = false


beforeAll( async () => {
    try {
        originalGlobalConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        globalConfigExisted = true
    } catch {
        globalConfigExisted = false
    }

    await mkdir( SOURCE_DIR, { recursive: true } )
    await writeFile( join( SOURCE_DIR, 'simple.mjs' ), schema, 'utf-8' )
    await writeFile( join( SOURCE_DIR, 'flowmcp-registry.json' ), JSON.stringify( registry, null, 4 ), 'utf-8' )
    await writeFile( ENV_PATH, 'DEEP_KEY=abc\n', 'utf-8' )

    const globalConfig = {
        'envPath': ENV_PATH,
        'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc', 'schemaSpec': '2.0.0' },
        'initialized': new Date().toISOString(),
        'sources': { [SOURCE_NAME]: { 'type': 'local', 'schemaCount': 1 } }
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


describe( 'status — group data is not an object (line 3591)', () => {
    const TEST_CWD = join( tmpdir(), 'flowmcp-deep-status-nonobj-group' )
    const LOCAL_DIR = join( TEST_CWD, '.flowmcp' )

    beforeAll( async () => {
        await mkdir( LOCAL_DIR, { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'badgroup',
            'groups': {
                'badgroup': 'this-is-a-string-not-an-object'
            }
        }

        await writeFile( join( LOCAL_DIR, 'config.json' ), JSON.stringify( localConfig, null, 4 ), 'utf-8' )
    } )

    afterAll( async () => {
        await rm( TEST_CWD, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'reports warning when group data is a string', async () => {
        const { result } = await FlowMcpCli.status( { 'cwd': TEST_CWD } )

        expect( result[ 'status' ] ).toBe( true )

        const groupsCheck = result[ 'checks' ]
            .find( ( { name } ) => {
                const isGroups = name === 'groups'

                return isGroups
            } )

        expect( groupsCheck ).toBeDefined()
        expect( groupsCheck[ 'ok' ] ).toBe( false )
        expect( groupsCheck[ 'warnings' ] ).toBeDefined()

        const hasNonObjectWarning = groupsCheck[ 'warnings' ]
            .find( ( w ) => {
                const matches = w.includes( 'badgroup' ) && w.includes( 'Must be an object' )

                return matches
            } )

        expect( hasNonObjectWarning ).toBeDefined()
    } )
} )


describe( 'status — group without tools or schemas array (lines 3596-3598)', () => {
    const TEST_CWD = join( tmpdir(), 'flowmcp-deep-status-empty-group' )
    const LOCAL_DIR = join( TEST_CWD, '.flowmcp' )

    beforeAll( async () => {
        await mkdir( LOCAL_DIR, { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'emptygroup',
            'groups': {
                'emptygroup': {}
            }
        }

        await writeFile( join( LOCAL_DIR, 'config.json' ), JSON.stringify( localConfig, null, 4 ), 'utf-8' )
    } )

    afterAll( async () => {
        await rm( TEST_CWD, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'reports warning when group has no tools or schemas key', async () => {
        const { result } = await FlowMcpCli.status( { 'cwd': TEST_CWD } )

        expect( result[ 'status' ] ).toBe( true )

        const groupsCheck = result[ 'checks' ]
            .find( ( { name } ) => {
                const isGroups = name === 'groups'

                return isGroups
            } )

        expect( groupsCheck ).toBeDefined()
        expect( groupsCheck[ 'ok' ] ).toBe( false )
        expect( groupsCheck[ 'warnings' ] ).toBeDefined()

        const hasMissingArrayWarning = groupsCheck[ 'warnings' ]
            .find( ( w ) => {
                const matches = w.includes( 'emptygroup' ) && w.includes( 'Must have "tools" or "schemas" array' )

                return matches
            } )

        expect( hasMissingArrayWarning ).toBeDefined()
    } )
} )


describe( 'status — defaultGroup references non-existent group (line 3585)', () => {
    const TEST_CWD = join( tmpdir(), 'flowmcp-deep-status-bad-default' )
    const LOCAL_DIR = join( TEST_CWD, '.flowmcp' )

    beforeAll( async () => {
        await mkdir( LOCAL_DIR, { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'nonexistent',
            'groups': {
                'other-group': {
                    'tools': [ 'deepcfgsrc/simple.mjs::ping' ]
                }
            }
        }

        await writeFile( join( LOCAL_DIR, 'config.json' ), JSON.stringify( localConfig, null, 4 ), 'utf-8' )
    } )

    afterAll( async () => {
        await rm( TEST_CWD, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'reports warning when defaultGroup points to missing group', async () => {
        const { result } = await FlowMcpCli.status( { 'cwd': TEST_CWD } )

        expect( result[ 'status' ] ).toBe( true )

        const groupsCheck = result[ 'checks' ]
            .find( ( { name } ) => {
                const isGroups = name === 'groups'

                return isGroups
            } )

        expect( groupsCheck ).toBeDefined()
        expect( groupsCheck[ 'ok' ] ).toBe( false )
        expect( groupsCheck[ 'warnings' ] ).toBeDefined()

        const hasDefaultWarning = groupsCheck[ 'warnings' ]
            .find( ( w ) => {
                const matches = w.includes( 'nonexistent' ) && w.includes( 'does not reference an existing group' )

                return matches
            } )

        expect( hasDefaultWarning ).toBeDefined()
    } )
} )


describe( 'validate — defaultGroup points to non-existent group (line 4621)', () => {
    const TEST_CWD = join( tmpdir(), 'flowmcp-deep-validate-missing-default' )
    const LOCAL_DIR = join( TEST_CWD, '.flowmcp' )

    beforeAll( async () => {
        await mkdir( LOCAL_DIR, { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'missing',
            'groups': {
                'actual-group': {
                    'tools': [ 'deepcfgsrc/simple.mjs::ping' ]
                }
            }
        }

        await writeFile( join( LOCAL_DIR, 'config.json' ), JSON.stringify( localConfig, null, 4 ), 'utf-8' )
    } )

    afterAll( async () => {
        await rm( TEST_CWD, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'returns error when defaultGroup key does not match any group', async () => {
        const { result } = await FlowMcpCli.validate( { 'schemaPath': undefined, 'cwd': TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Default group' )
        expect( result[ 'error' ] ).toContain( 'missing' )
        expect( result[ 'error' ] ).toContain( 'not found' )
    } )
} )


describe( 'callTool — no group and no active tools (lines 4636-4649)', () => {
    const TEST_CWD = join( tmpdir(), 'flowmcp-deep-calltool-no-group' )
    const LOCAL_DIR = join( TEST_CWD, '.flowmcp' )

    beforeAll( async () => {
        await mkdir( LOCAL_DIR, { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'groups': {
                'some-group': {
                    'tools': [ 'deepcfgsrc/simple.mjs::ping' ]
                }
            }
        }

        await writeFile( join( LOCAL_DIR, 'config.json' ), JSON.stringify( localConfig, null, 4 ), 'utf-8' )
    } )

    afterAll( async () => {
        await rm( TEST_CWD, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'returns error when group is undefined and no defaultGroup or active tools exist', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'ping_deepcfgsrc',
            'jsonArgs': '{}',
            'group': undefined,
            'cwd': TEST_CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
    } )
} )


describe( 'validate — directory with schema file that has no main export (line 5606)', () => {
    const NO_MAIN_DIR = join( tmpdir(), `flowmcp-deep-validate-nomain-${Date.now()}` )

    beforeAll( async () => {
        await mkdir( NO_MAIN_DIR, { recursive: true } )
        await writeFile( join( NO_MAIN_DIR, 'empty.mjs' ), 'export const other = { foo: true }\n', 'utf-8' )
    } )

    afterAll( async () => {
        await rm( NO_MAIN_DIR, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'collects loadError for schema files without main export', async () => {
        const { result } = await FlowMcpCli.validate( { 'schemaPath': NO_MAIN_DIR } )

        expect( result[ 'total' ] ).toBe( 1 )
        expect( result[ 'results' ] ).toBeDefined()
        expect( result[ 'results' ].length ).toBe( 1 )

        const entry = result[ 'results' ][ 0 ]

        expect( entry[ 'file' ] ).toBe( 'empty.mjs' )
        expect( entry[ 'status' ] ).toBe( false )
    } )
} )
