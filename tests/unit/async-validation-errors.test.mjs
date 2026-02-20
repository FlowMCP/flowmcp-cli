import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )

const VALID_CONFIG = {
    'envPath': '/tmp/test.env',
    'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc123', 'schemaSpec': '2.0.0' },
    'initialized': '2026-02-20T12:00:00.000Z'
}

const TEST_CWD = join( tmpdir(), 'flowmcp-cli-async-val' )

let originalGlobalConfig = null
let globalConfigExisted = false


beforeAll( async () => {
    try {
        originalGlobalConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        globalConfigExisted = true
    } catch {
        globalConfigExisted = false
    }

    await mkdir( GLOBAL_CONFIG_DIR, { recursive: true } )
    await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( VALID_CONFIG, null, 4 ), 'utf-8' )
    await mkdir( TEST_CWD, { recursive: true } )
} )


afterAll( async () => {
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    await rm( TEST_CWD, { recursive: true, force: true } )
} )


describe( 'FlowMcpCli.groupAppend validation failure paths', () => {
    it( 'returns validation error for undefined name', async () => {
        const { result } = await FlowMcpCli.groupAppend( { name: undefined, tools: 'demo/ping.mjs', cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
    } )


    it( 'returns validation error for non-string tools', async () => {
        const { result } = await FlowMcpCli.groupAppend( { name: 'grp', tools: 42, cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
    } )
} )


describe( 'FlowMcpCli.groupRemove validation failure paths', () => {
    it( 'returns validation error for undefined name', async () => {
        const { result } = await FlowMcpCli.groupRemove( { name: undefined, tools: 'demo/ping.mjs', cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
    } )


    it( 'returns validation error for non-string tools', async () => {
        const { result } = await FlowMcpCli.groupRemove( { name: 'grp', tools: 42, cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
    } )
} )


describe( 'FlowMcpCli.promptSearch validation failure in async method', () => {
    it( 'returns validation error for undefined query', async () => {
        const { result } = await FlowMcpCli.promptSearch( { query: undefined, cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
    } )
} )


describe( 'FlowMcpCli.promptShow validation failure in async method', () => {
    it( 'returns validation error for undefined group', async () => {
        const { result } = await FlowMcpCli.promptShow( { group: undefined, name: 'test', cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
    } )


    it( 'returns validation error for undefined name', async () => {
        const { result } = await FlowMcpCli.promptShow( { group: 'test', name: undefined, cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
    } )
} )


describe( 'FlowMcpCli.promptAdd validation failure in async method', () => {
    it( 'returns validation error for undefined group', async () => {
        const { result } = await FlowMcpCli.promptAdd( { group: undefined, name: 'test', file: 'test.md', cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
    } )


    it( 'returns validation error for all undefined params', async () => {
        const { result } = await FlowMcpCli.promptAdd( { group: undefined, name: undefined, file: undefined, cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ].length ).toBe( 3 )
    } )
} )


describe( 'FlowMcpCli.promptRemove validation failure in async method', () => {
    it( 'returns validation error for undefined group', async () => {
        const { result } = await FlowMcpCli.promptRemove( { group: undefined, name: 'test', cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
    } )
} )


describe( 'FlowMcpCli.validate init failure in async method', () => {
    it( 'returns validation error for non-string schemaPath', async () => {
        const { result } = await FlowMcpCli.validate( { schemaPath: 42 } )

        expect( result[ 'status' ] ).toBe( false )
    } )
} )


describe( 'FlowMcpCli.groupRemove with schemas key migration', () => {
    it( 'removes tool from group using schemas key and migrates to tools', async () => {
        const cwd = join( tmpdir(), 'flowmcp-cli-async-val-migration' )
        const configDir = join( cwd, '.flowmcp' )
        await mkdir( configDir, { recursive: true } )

        const config = {
            'root': '~/.flowmcp',
            'defaultGroup': 'test',
            'groups': {
                'test': {
                    'description': 'Test',
                    'schemas': [ 'demo/ping.mjs', 'demo/other.mjs' ]
                }
            }
        }

        await writeFile(
            join( configDir, 'config.json' ),
            JSON.stringify( config, null, 4 ),
            'utf-8'
        )

        const { result } = await FlowMcpCli.groupRemove( { name: 'test', tools: 'demo/ping.mjs', cwd } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'tools' ] ).toHaveLength( 1 )
        expect( result[ 'tools' ][ 0 ] ).toBe( 'demo/other.mjs' )

        const configRaw = await readFile( join( configDir, 'config.json' ), 'utf-8' )
        const updatedConfig = JSON.parse( configRaw )

        expect( updatedConfig[ 'groups' ][ 'test' ][ 'tools' ] ).toBeDefined()
        expect( updatedConfig[ 'groups' ][ 'test' ][ 'schemas' ] ).toBeUndefined()

        await rm( cwd, { recursive: true, force: true } )
    } )
} )


describe( 'FlowMcpCli.groupSetDefault validation failure in async method', () => {
    it( 'returns validation error for non-string name', async () => {
        const { result } = await FlowMcpCli.groupSetDefault( { name: 42, cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
    } )
} )
