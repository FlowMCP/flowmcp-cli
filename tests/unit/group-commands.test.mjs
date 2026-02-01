import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import { VALID_LOCAL_CONFIG_WITH_GROUPS, VALID_GLOBAL_CONFIG } from '../helpers/config.mjs'


const TEST_CWD = join( tmpdir(), 'flowmcp-cli-group-test' )
const LOCAL_CONFIG_DIR = join( TEST_CWD, '.flowmcp' )
const LOCAL_CONFIG_PATH = join( LOCAL_CONFIG_DIR, 'config.json' )

const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
let globalConfigExistedBefore = false

beforeAll( async () => {
    try {
        await access( GLOBAL_CONFIG_PATH )
        globalConfigExistedBefore = true
    } catch {
        globalConfigExistedBefore = false
        await mkdir( GLOBAL_CONFIG_DIR, { recursive: true } )
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( VALID_GLOBAL_CONFIG, null, 4 ), 'utf-8' )
    }

    await mkdir( LOCAL_CONFIG_DIR, { recursive: true } )
    await writeFile( LOCAL_CONFIG_PATH, JSON.stringify( VALID_LOCAL_CONFIG_WITH_GROUPS, null, 4 ), 'utf-8' )
} )

afterAll( async () => {
    await rm( TEST_CWD, { recursive: true, force: true } )
} )


describe( 'FlowMcpCli.validationGroupAppend', () => {
    it( 'rejects missing name', () => {
        const { status, messages } = FlowMcpCli.validationGroupAppend( { name: undefined, tools: 'demo/ping.mjs' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBeGreaterThanOrEqual( 1 )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'rejects null name', () => {
        const { status, messages } = FlowMcpCli.validationGroupAppend( { name: null, tools: 'demo/ping.mjs' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBeGreaterThanOrEqual( 1 )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'rejects non-string name', () => {
        const { status, messages } = FlowMcpCli.validationGroupAppend( { name: 42, tools: 'demo/ping.mjs' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBeGreaterThanOrEqual( 1 )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'rejects empty name', () => {
        const { status, messages } = FlowMcpCli.validationGroupAppend( { name: '   ', tools: 'demo/ping.mjs' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBeGreaterThanOrEqual( 1 )
        expect( messages[ 0 ] ).toContain( 'Must not be empty' )
    } )


    it( 'rejects missing tools', () => {
        const { status, messages } = FlowMcpCli.validationGroupAppend( { name: 'my-group', tools: undefined } )

        expect( status ).toBe( false )
        expect( messages.length ).toBeGreaterThanOrEqual( 1 )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'rejects empty tools', () => {
        const { status, messages } = FlowMcpCli.validationGroupAppend( { name: 'my-group', tools: '   ' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBeGreaterThanOrEqual( 1 )
        expect( messages[ 0 ] ).toContain( 'Must not be empty' )
    } )


    it( 'accepts valid name and tools', () => {
        const { status, messages } = FlowMcpCli.validationGroupAppend( { name: 'my-group', tools: 'demo/ping.mjs' } )

        expect( status ).toBe( true )
        expect( messages.length ).toBe( 0 )
    } )
} )


describe( 'FlowMcpCli.validationGroupRemove', () => {
    it( 'rejects missing name', () => {
        const { status, messages } = FlowMcpCli.validationGroupRemove( { name: undefined, tools: 'demo/ping.mjs' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBeGreaterThanOrEqual( 1 )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'rejects non-string name', () => {
        const { status, messages } = FlowMcpCli.validationGroupRemove( { name: 123, tools: 'demo/ping.mjs' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBeGreaterThanOrEqual( 1 )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'rejects missing tools', () => {
        const { status, messages } = FlowMcpCli.validationGroupRemove( { name: 'my-group', tools: undefined } )

        expect( status ).toBe( false )
        expect( messages.length ).toBeGreaterThanOrEqual( 1 )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'rejects empty tools', () => {
        const { status, messages } = FlowMcpCli.validationGroupRemove( { name: 'my-group', tools: '' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBeGreaterThanOrEqual( 1 )
        expect( messages[ 0 ] ).toContain( 'Must not be empty' )
    } )


    it( 'accepts valid name and tools', () => {
        const { status, messages } = FlowMcpCli.validationGroupRemove( { name: 'my-group', tools: 'demo/ping.mjs' } )

        expect( status ).toBe( true )
        expect( messages.length ).toBe( 0 )
    } )
} )


describe( 'FlowMcpCli.validationGroupSetDefault', () => {
    it( 'rejects missing name', () => {
        const { status, messages } = FlowMcpCli.validationGroupSetDefault( { name: undefined } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'rejects empty name', () => {
        const { status, messages } = FlowMcpCli.validationGroupSetDefault( { name: '' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must not be empty' )
    } )


    it( 'accepts valid name', () => {
        const { status, messages } = FlowMcpCli.validationGroupSetDefault( { name: 'my-defi' } )

        expect( status ).toBe( true )
        expect( messages.length ).toBe( 0 )
    } )
} )


describe( 'FlowMcpCli.groupList', () => {
    it( 'returns empty groups when no config exists', async () => {
        const emptyCwd = join( tmpdir(), 'flowmcp-cli-group-empty' )
        await mkdir( emptyCwd, { recursive: true } )

        const { result } = await FlowMcpCli.groupList( { cwd: emptyCwd } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'defaultGroup' ] ).toBeNull()
        expect( result[ 'groups' ] ).toEqual( {} )

        await rm( emptyCwd, { recursive: true, force: true } )
    } )


    it( 'returns groups when config has groups', async () => {
        const { result } = await FlowMcpCli.groupList( { cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'defaultGroup' ] ).toBe( 'my-defi' )
        expect( result[ 'groups' ] ).toHaveProperty( 'my-defi' )
        expect( result[ 'groups' ][ 'my-defi' ][ 'toolCount' ] ).toBe( 2 )
        expect( result[ 'groups' ] ).toHaveProperty( 'market-data' )
        expect( result[ 'groups' ][ 'market-data' ][ 'toolCount' ] ).toBe( 1 )
    } )
} )


describe( 'FlowMcpCli.groupSetDefault', () => {
    it( 'returns error when no local config exists', async () => {
        const emptyCwd = join( tmpdir(), 'flowmcp-cli-group-noconfig' )
        await mkdir( emptyCwd, { recursive: true } )

        const { result } = await FlowMcpCli.groupSetDefault( { name: 'test', cwd: emptyCwd } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'No local config found' )

        await rm( emptyCwd, { recursive: true, force: true } )
    } )


    it( 'returns error when group does not exist', async () => {
        const { result } = await FlowMcpCli.groupSetDefault( { name: 'nonexistent-group', cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'not found' )
    } )


    it( 'sets default group successfully', async () => {
        const { result } = await FlowMcpCli.groupSetDefault( { name: 'market-data', cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'defaultGroup' ] ).toBe( 'market-data' )
    } )


    it( 'validates missing name parameter', async () => {
        const { result } = await FlowMcpCli.groupSetDefault( { name: undefined, cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
        expect( result[ 'messages' ][ 0 ] ).toContain( 'Missing value' )
    } )
} )


describe( 'FlowMcpCli.groupRemove', () => {
    it( 'returns error when no local config exists', async () => {
        const emptyCwd = join( tmpdir(), 'flowmcp-cli-group-remove-empty' )
        await mkdir( emptyCwd, { recursive: true } )

        const { result } = await FlowMcpCli.groupRemove( { name: 'test', tools: 'demo/ping.mjs', cwd: emptyCwd } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'No local config found' )

        await rm( emptyCwd, { recursive: true, force: true } )
    } )


    it( 'returns error when group does not exist', async () => {
        const { result } = await FlowMcpCli.groupRemove( { name: 'nonexistent', tools: 'demo/ping.mjs', cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'not found' )
    } )


    it( 'removes a tool from an existing group', async () => {
        const removeCwd = join( tmpdir(), 'flowmcp-cli-group-remove-test' )
        const removeConfigDir = join( removeCwd, '.flowmcp' )
        const removeConfigPath = join( removeConfigDir, 'config.json' )

        const config = {
            'root': '~/.flowmcp',
            'defaultGroup': 'test-group',
            'groups': {
                'test-group': {
                    'description': 'Test group',
                    'tools': [
                        'demo/ping.mjs',
                        'demo/other.mjs',
                        'demo/third.mjs'
                    ]
                }
            }
        }

        await mkdir( removeConfigDir, { recursive: true } )
        await writeFile( removeConfigPath, JSON.stringify( config, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.groupRemove( { name: 'test-group', tools: 'demo/ping.mjs', cwd: removeCwd } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'group' ] ).toBe( 'test-group' )
        expect( result[ 'toolCount' ] ).toBe( 2 )
        expect( result[ 'tools' ] ).toEqual( [ 'demo/other.mjs', 'demo/third.mjs' ] )
        expect( result[ 'removed' ] ).toEqual( [ 'demo/ping.mjs' ] )

        await rm( removeCwd, { recursive: true, force: true } )
    } )


    it( 'reports only actually removed tools', async () => {
        const removeCwd = join( tmpdir(), 'flowmcp-cli-group-remove-partial' )
        const removeConfigDir = join( removeCwd, '.flowmcp' )
        const removeConfigPath = join( removeConfigDir, 'config.json' )

        const config = {
            'root': '~/.flowmcp',
            'defaultGroup': 'test-group',
            'groups': {
                'test-group': {
                    'description': '',
                    'tools': [ 'demo/ping.mjs' ]
                }
            }
        }

        await mkdir( removeConfigDir, { recursive: true } )
        await writeFile( removeConfigPath, JSON.stringify( config, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.groupRemove( { name: 'test-group', tools: 'demo/ping.mjs,demo/nonexistent.mjs', cwd: removeCwd } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolCount' ] ).toBe( 0 )
        expect( result[ 'tools' ] ).toEqual( [] )
        expect( result[ 'removed' ] ).toEqual( [ 'demo/ping.mjs' ] )

        await rm( removeCwd, { recursive: true, force: true } )
    } )
} )
