import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )

let originalGlobalConfig = null
let globalConfigExisted = false


const NOLISTS_SOURCE = 'nolistssrc'
const NOLISTS_DIR = join( SCHEMAS_DIR, NOLISTS_SOURCE )
const NOLISTS_ENV = join( GLOBAL_CONFIG_DIR, '.env.nolists' )

const BROKENLISTS_SOURCE = 'brokenlistsrc'
const BROKENLISTS_DIR = join( SCHEMAS_DIR, BROKENLISTS_SOURCE )
const BROKENLISTS_LISTS_DIR = join( BROKENLISTS_DIR, '_lists' )


const SCHEMA_NO_LISTS = `export const main = {
    namespace: 'nolistssrc',
    name: 'No Lists API',
    description: 'Schema with sharedLists but no _lists dir',
    version: '4.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    sharedLists: [ 'nonexistent' ],
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


const SCHEMA_BROKEN_LISTS = `export const main = {
    namespace: 'brokenlistsrc',
    name: 'Broken Lists API',
    description: 'Schema referencing a broken shared list file',
    version: '4.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    sharedLists: [ 'broken' ],
    tools: {
        ping: {
            method: 'GET',
            description: 'Ping',
            path: '/get',
            parameters: [
                {
                    position: { key: 'item', value: '{{USER_PARAM}}', location: 'query' },
                    z: { primitive: 'enum({{broken}})', options: [] }
                }
            ]
        }
    }
}
`


const BROKEN_LIST_CONTENT = `throw new Error('broken list')\n`


const NOLISTS_REGISTRY = {
    'name': NOLISTS_SOURCE,
    'version': '1.0.0',
    'description': 'No lists test source',
    'schemaSpec': '4.0.0',
    'schemas': [
        {
            'namespace': 'nolistssrc',
            'file': 'nolists.mjs',
            'name': 'No Lists API',
            'requiredServerParams': []
        }
    ]
}


const BROKENLISTS_REGISTRY = {
    'name': BROKENLISTS_SOURCE,
    'version': '1.0.0',
    'description': 'Broken lists test source',
    'schemaSpec': '4.0.0',
    'schemas': [
        {
            'namespace': 'brokenlistsrc',
            'file': 'brokenlists.mjs',
            'name': 'Broken Lists API',
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

    await mkdir( NOLISTS_DIR, { recursive: true } )
    await writeFile( join( NOLISTS_DIR, 'nolists.mjs' ), SCHEMA_NO_LISTS, 'utf-8' )
    await writeFile( join( NOLISTS_DIR, '_registry.json' ), JSON.stringify( NOLISTS_REGISTRY, null, 4 ), 'utf-8' )

    await mkdir( BROKENLISTS_LISTS_DIR, { recursive: true } )
    await writeFile( join( BROKENLISTS_DIR, 'brokenlists.mjs' ), SCHEMA_BROKEN_LISTS, 'utf-8' )
    await writeFile( join( BROKENLISTS_DIR, '_registry.json' ), JSON.stringify( BROKENLISTS_REGISTRY, null, 4 ), 'utf-8' )
    await writeFile( join( BROKENLISTS_LISTS_DIR, 'broken.mjs' ), BROKEN_LIST_CONTENT, 'utf-8' )

    await writeFile( NOLISTS_ENV, 'NOLISTS_KEY=abc\n', 'utf-8' )

    const sourcesPayload = {
        [NOLISTS_SOURCE]: { 'type': 'local', 'schemaCount': 1 },
        [BROKENLISTS_SOURCE]: { 'type': 'local', 'schemaCount': 1 }
    }

    if( globalConfigExisted && originalGlobalConfig ) {
        const parsed = JSON.parse( originalGlobalConfig )
        parsed[ 'sources' ] = parsed[ 'sources' ] || {}
        parsed[ 'sources' ][ NOLISTS_SOURCE ] = sourcesPayload[ NOLISTS_SOURCE ]
        parsed[ 'sources' ][ BROKENLISTS_SOURCE ] = sourcesPayload[ BROKENLISTS_SOURCE ]
        parsed[ 'envPath' ] = NOLISTS_ENV
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( parsed, null, 4 ), 'utf-8' )
    } else {
        const globalConfig = {
            'envPath': NOLISTS_ENV,
            'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc', 'schemaSpec': '4.0.0' },
            'initialized': new Date().toISOString(),
            'sources': sourcesPayload
        }

        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
    }
} )


afterAll( async () => {
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    await rm( NOLISTS_DIR, { recursive: true, force: true } ).catch( () => {} )
    await rm( BROKENLISTS_DIR, { recursive: true, force: true } ).catch( () => {} )
    await rm( NOLISTS_ENV, { force: true } ).catch( () => {} )
} )


describe( 'callTool with sharedLists but no _lists dir — fail-loud LST-001 (Memo 149 Strang B/C, No Silent Defaults)', () => {
    const CWD = join( tmpdir(), `flowmcp-nolists-call-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'tools': [
                `${NOLISTS_SOURCE}/nolists.mjs::ping`
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


    it( 'fails loud with LST-001 when a declared sharedList has no _lists dir — never a silent content:[]', async () => {
        // Memo 149 Strang B/C: pre-149 this call silently succeeded with an empty
        // sharedLists ({} fallback) — exactly the evmChains content:[] class of bug. The
        // declared-but-unresolvable list must now surface a coded error instead.
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'ping_nolistssrc',
            'jsonArgs': '{}',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toMatch( /LST-001/ )
    }, 15000 )
} )


describe( 'list with sharedLists but no _lists dir — exercises #resolveSharedListsForSchema with null listsDir', () => {
    const CWD = join( tmpdir(), `flowmcp-nolists-list-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'nolists-group',
            'groups': {
                'nolists-group': {
                    'tools': [
                        `${NOLISTS_SOURCE}/nolists.mjs::ping`
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


    it( 'lists tools gracefully when _lists directory does not exist', async () => {
        const { result } = await FlowMcpCli.list( { 'cwd': CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolCount' ] ).toBeGreaterThanOrEqual( 1 )

        const pingTool = result[ 'tools' ]
            .find( ( t ) => {
                const isMatch = t[ 'name' ] === 'ping_nolistssrc'

                return isMatch
            } )

        expect( pingTool ).toBeDefined()
    } )
} )


describe( 'list with broken shared list file — exercises #resolveSharedListsForSchema catch block', () => {
    const CWD = join( tmpdir(), `flowmcp-brokenlists-list-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'broken-group',
            'groups': {
                'broken-group': {
                    'tools': [
                        `${BROKENLISTS_SOURCE}/brokenlists.mjs::ping`
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


    it( 'handles broken list file gracefully — catch sets sharedLists to empty object', async () => {
        const { result } = await FlowMcpCli.list( { 'cwd': CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolCount' ] ).toBeGreaterThanOrEqual( 1 )

        const pingTool = result[ 'tools' ]
            .find( ( t ) => {
                const isMatch = t[ 'name' ] === 'ping_brokenlistsrc'

                return isMatch
            } )

        expect( pingTool ).toBeDefined()
    } )
} )
