import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )

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
    await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( { 'envPath': '/tmp/test.env' }, null, 4 ), 'utf-8' )
} )

afterAll( async () => {
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }
} )


describe( 'FlowMcpCli methods when not initialized', () => {
    it( 'groupAppend returns init error when not initialized', async () => {
        const { result } = await FlowMcpCli.groupAppend( { name: 'test', tools: 'demo/ping.mjs', cwd: '/tmp' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'init' )
    } )


    it( 'groupRemove returns init error when not initialized', async () => {
        const { result } = await FlowMcpCli.groupRemove( { name: 'test', tools: 'demo/ping.mjs', cwd: '/tmp' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'init' )
    } )


    it( 'groupList returns init error when not initialized', async () => {
        const { result } = await FlowMcpCli.groupList( { cwd: '/tmp' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'init' )
    } )


    it( 'groupSetDefault returns init error when not initialized', async () => {
        const { result } = await FlowMcpCli.groupSetDefault( { name: 'test', cwd: '/tmp' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'init' )
    } )


    it( 'promptList returns init error when not initialized', async () => {
        const { result } = await FlowMcpCli.promptList( { cwd: '/tmp' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'init' )
    } )


    it( 'promptSearch returns init error when not initialized', async () => {
        const { result } = await FlowMcpCli.promptSearch( { query: 'test', cwd: '/tmp' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'init' )
    } )


    it( 'promptShow returns init error when not initialized', async () => {
        const { result } = await FlowMcpCli.promptShow( { group: 'test', name: 'test', cwd: '/tmp' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'init' )
    } )


    it( 'promptAdd returns init error when not initialized', async () => {
        const { result } = await FlowMcpCli.promptAdd( { group: 'test', name: 'test', file: 'test.md', cwd: '/tmp' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'init' )
    } )


    it( 'promptRemove returns init error when not initialized', async () => {
        const { result } = await FlowMcpCli.promptRemove( { group: 'test', name: 'test', cwd: '/tmp' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'init' )
    } )


    it( 'validate returns init error when not initialized', async () => {
        const { result } = await FlowMcpCli.validate( { schemaPath: '/tmp/test.mjs' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'init' )
    } )


    it( 'test returns init error when not initialized', async () => {
        const { result } = await FlowMcpCli.test( { schemaPath: '/tmp/test.mjs', route: undefined, cwd: '/tmp' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'init' )
    } )


    it( 'callListTools returns init error when not initialized', async () => {
        const { result } = await FlowMcpCli.callListTools( { cwd: '/tmp' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'init' )
    } )


    it( 'callTool returns init error when not initialized', async () => {
        const { result } = await FlowMcpCli.callTool( { toolName: 'test', cwd: '/tmp' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'init' )
    } )


    it( 'search returns init error when not initialized', async () => {
        const { result } = await FlowMcpCli.search( { query: 'test' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'init' )
    } )


    it( 'add returns init error when not initialized', async () => {
        const { result } = await FlowMcpCli.add( { toolName: 'test', cwd: '/tmp' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'init' )
    } )


    it( 'remove returns init error when not initialized', async () => {
        const { result } = await FlowMcpCli.remove( { toolName: 'test', cwd: '/tmp' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'init' )
    } )


    it( 'list returns init error when not initialized', async () => {
        const { result } = await FlowMcpCli.list( { cwd: '/tmp' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'init' )
    } )


    it( 'schemas returns init error when not initialized', async () => {
        const { result } = await FlowMcpCli.schemas()

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
        expect( result[ 'error' ] ).toContain( 'init' )
    } )
} )
