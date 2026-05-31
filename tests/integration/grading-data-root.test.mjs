import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


// The grading-data island root is configurable. Precedence (all explicit, no
// silent default): --grading-data flag (cwd-relative) > FLOWMCP_GRADING_DATA env
// (cwd-relative) > "gradingDataDir" in the GLOBAL ~/.flowmcp/config.json
// (home-relative) > default ~/.flowmcp/grading.
//
// os.homedir() is mocked into <repo>/.test-home by the global-home setup, so the
// "global home" here is the sandbox — the real ~/.flowmcp is never touched.

const here = dirname( fileURLToPath( import.meta.url ) )
const providerFixture = join( here, 'fixtures', 'grading-provider' )

let cwd = null
const savedEnv = process.env[ 'FLOWMCP_GRADING_DATA' ]

const homeFlowmcp = () => join( homedir(), '.flowmcp' )


beforeEach( async () => {
    cwd = await mkdtemp( join( tmpdir(), 'grading-root-' ) )
    delete process.env[ 'FLOWMCP_GRADING_DATA' ]
    // Reset the shared sandbox-home state between cases (config + default island).
    await rm( join( homeFlowmcp(), 'config.json' ), { force: true } )
    await rm( join( homeFlowmcp(), 'grading' ), { recursive: true, force: true } )
    await mkdir( homeFlowmcp(), { recursive: true } )
} )

afterEach( async () => {
    if( savedEnv === undefined ) { delete process.env[ 'FLOWMCP_GRADING_DATA' ] }
    else { process.env[ 'FLOWMCP_GRADING_DATA' ] = savedEnv }
    await rm( join( homeFlowmcp(), 'config.json' ), { force: true } )
    await rm( join( homeFlowmcp(), 'grading' ), { recursive: true, force: true } )
    if( cwd !== null ) { await rm( cwd, { recursive: true, force: true } ) }
} )

const writeGlobalConfig = async ( { dataDir } ) => {
    await mkdir( homeFlowmcp(), { recursive: true } )
    await writeFile( join( homeFlowmcp(), 'config.json' ), JSON.stringify( { gradingDataDir: dataDir }, null, 4 ), 'utf-8' )
}

const importInto = ( opts ) => FlowMcpCli.gradingImport( { cwd, 'path': providerFixture, onConflict: null, gradingDataDir: null, json: true, ...opts } )


describe( 'grading-data root is configurable (global ~/.flowmcp)', () => {
    it( 'default lands in ~/.flowmcp/grading', async () => {
        const { result } = await importInto( {} )
        expect( result.status ).toBe( true )
        expect( existsSync( join( homeFlowmcp(), 'grading', 'providers', result.namespace ) ) ).toBe( true )
    } )

    it( 'config.json "gradingDataDir" (home-relative) overrides the default', async () => {
        await writeGlobalConfig( { dataDir: 'configured-island' } )
        const { result } = await importInto( {} )
        expect( result.status ).toBe( true )
        expect( existsSync( join( homeFlowmcp(), 'configured-island', 'providers', result.namespace ) ) ).toBe( true )
        expect( existsSync( join( homeFlowmcp(), 'grading' ) ) ).toBe( false )
    } )

    it( 'FLOWMCP_GRADING_DATA env (cwd-relative) wins over config.json', async () => {
        await writeGlobalConfig( { dataDir: 'configured-island' } )
        process.env[ 'FLOWMCP_GRADING_DATA' ] = 'env-island'
        const { result } = await importInto( {} )
        expect( result.status ).toBe( true )
        expect( existsSync( join( cwd, 'env-island', 'providers', result.namespace ) ) ).toBe( true )
    } )

    it( '--grading-data flag (cwd-relative) wins over env and config.json', async () => {
        await writeGlobalConfig( { dataDir: 'configured-island' } )
        process.env[ 'FLOWMCP_GRADING_DATA' ] = 'env-island'
        const { result } = await importInto( { gradingDataDir: 'flag-island' } )
        expect( result.status ).toBe( true )
        expect( existsSync( join( cwd, 'flag-island', 'providers', result.namespace ) ) ).toBe( true )
        expect( existsSync( join( cwd, 'env-island' ) ) ).toBe( false )
    } )
} )
