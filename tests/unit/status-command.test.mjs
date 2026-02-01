import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import { VALID_GLOBAL_CONFIG, VALID_LOCAL_CONFIG } from '../helpers/config.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )

let originalGlobalConfig = null
let globalConfigExisted = false

beforeAll( async () => {
    try {
        const { readFile } = await import( 'node:fs/promises' )
        originalGlobalConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        globalConfigExisted = true
    } catch {
        globalConfigExisted = false
    }
} )

afterAll( async () => {
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }
} )


describe( 'FlowMcpCli.status', () => {
    it( 'returns error when not initialized', async () => {
        const nonExistentCwd = join( tmpdir(), 'flowmcp-status-test-nonexistent' )
        await mkdir( nonExistentCwd, { recursive: true } )

        if( !globalConfigExisted ) {
            const { result } = await FlowMcpCli.status( { cwd: nonExistentCwd } )

            expect( result[ 'status' ] ).toBe( false )
            expect( result[ 'error' ] ).toContain( 'Not initialized' )
        }

        await rm( nonExistentCwd, { recursive: true, force: true } )
    } )


    it( 'returns config when initialized', async () => {
        await mkdir( GLOBAL_CONFIG_DIR, { recursive: true } )
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( VALID_GLOBAL_CONFIG, null, 4 ), 'utf-8' )

        const testCwd = join( tmpdir(), 'flowmcp-status-test-valid' )
        await mkdir( testCwd, { recursive: true } )

        const { result } = await FlowMcpCli.status( { cwd: testCwd } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'config' ] ).toBeDefined()
        expect( result[ 'config' ][ 'envPath' ] ).toBe( VALID_GLOBAL_CONFIG[ 'envPath' ] )
        expect( result[ 'config' ][ 'flowmcpCore' ] ).toBeDefined()
        expect( result[ 'config' ][ 'flowmcpCore' ][ 'version' ] ).toBe( '1.4.2' )
        expect( result[ 'config' ] ).toHaveProperty( 'envExists' )
        expect( result[ 'config' ][ 'initialized' ] ).toBe( VALID_GLOBAL_CONFIG[ 'initialized' ] )

        await rm( testCwd, { recursive: true, force: true } )
    } )
} )
