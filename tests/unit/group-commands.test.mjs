import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import { VALID_LOCAL_CONFIG_WITH_GROUPS } from '../helpers/config.mjs'


const TEST_CWD = join( tmpdir(), 'flowmcp-cli-group-test' )
const LOCAL_CONFIG_DIR = join( TEST_CWD, '.flowmcp' )
const LOCAL_CONFIG_PATH = join( LOCAL_CONFIG_DIR, 'config.json' )

beforeAll( async () => {
    await mkdir( LOCAL_CONFIG_DIR, { recursive: true } )
    await writeFile( LOCAL_CONFIG_PATH, JSON.stringify( VALID_LOCAL_CONFIG_WITH_GROUPS, null, 4 ), 'utf-8' )
} )

afterAll( async () => {
    await rm( TEST_CWD, { recursive: true, force: true } )
} )


describe( 'FlowMcpCli.validationGroupAdd', () => {
    it( 'rejects missing name', () => {
        const { status, messages } = FlowMcpCli.validationGroupAdd( { name: undefined } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'rejects null name', () => {
        const { status, messages } = FlowMcpCli.validationGroupAdd( { name: null } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'rejects non-string name', () => {
        const { status, messages } = FlowMcpCli.validationGroupAdd( { name: 42 } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'rejects empty name', () => {
        const { status, messages } = FlowMcpCli.validationGroupAdd( { name: '   ' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must not be empty' )
    } )


    it( 'accepts valid name', () => {
        const { status, messages } = FlowMcpCli.validationGroupAdd( { name: 'my-group' } )

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
