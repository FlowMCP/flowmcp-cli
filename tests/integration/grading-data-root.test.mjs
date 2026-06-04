import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdtemp, rm, mkdir, writeFile, readdir, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


// The grading-data island root is configurable. Precedence (all explicit, no
// silent default): --grading-data flag (cwd-relative) > FLOWMCP_GRADING_DATA env
// (cwd-relative) > "gradingDataDir" in the GLOBAL ~/.flowmcp/config.json
// (home-relative) > default ~/.flowmcp/grading.
//
// Memo 102 Phase 2 / PRD-006: the island is built by the first `grading run
// --emit-prompts` (the schema is read live from schemaFolders[]); there is no
// `grading import`. os.homedir() is mocked into <repo>/.test-home, so the "global
// home" here is the sandbox — the real ~/.flowmcp is never touched.

const here = dirname( fileURLToPath( import.meta.url ) )
const providerFixture = join( here, 'fixtures', 'grading-provider' )
const NAMESPACE = 'demoapi'

let cwd = null
const savedEnv = process.env[ 'FLOWMCP_GRADING_DATA' ]

const homeFlowmcp = () => join( homedir(), '.flowmcp' )
const schemaSourceRoot = () => join( homedir(), 'grading-data-source', 'v4.0.0' )


// Build the schemaFolders-shaped source ( providers/<ns>/<schema>.mjs ) from the
// flat provider fixture so the live read resolves the namespace.
const seedSchemaSource = async () => {
    const providerDir = join( schemaSourceRoot(), 'providers', NAMESPACE )
    await mkdir( providerDir, { recursive: true } )
    const entries = await readdir( providerFixture )
    const files = entries
        .filter( ( name ) => name.endsWith( '.mjs' ) )
        .filter( ( name ) => basename( name ).startsWith( '_' ) === false )
    await files
        .reduce( ( promise, name ) => promise.then( async () => {
            await copyFile( join( providerFixture, name ), join( providerDir, name ) )
        } ), Promise.resolve() )
}


beforeEach( async () => {
    cwd = await mkdtemp( join( tmpdir(), 'grading-root-' ) )
    delete process.env[ 'FLOWMCP_GRADING_DATA' ]
    // Reset the shared sandbox-home state between cases (config + default island).
    await rm( join( homeFlowmcp(), 'config.json' ), { force: true } )
    await rm( join( homeFlowmcp(), 'grading' ), { recursive: true, force: true } )
    await rm( schemaSourceRoot(), { recursive: true, force: true } )
    await mkdir( homeFlowmcp(), { recursive: true } )
    await seedSchemaSource()
} )

afterEach( async () => {
    if( savedEnv === undefined ) { delete process.env[ 'FLOWMCP_GRADING_DATA' ] }
    else { process.env[ 'FLOWMCP_GRADING_DATA' ] = savedEnv }
    await rm( join( homeFlowmcp(), 'config.json' ), { force: true } )
    await rm( join( homeFlowmcp(), 'grading' ), { recursive: true, force: true } )
    await rm( schemaSourceRoot(), { recursive: true, force: true } )
    if( cwd !== null ) { await rm( cwd, { recursive: true, force: true } ) }
} )

// Write the global config with the schemaFolders[] source plus any extra keys
// (e.g. gradingDataDir). The schemaFolders entry is always present so the live
// read resolves the `demoapi` namespace.
const writeGlobalConfig = async ( extra = {} ) => {
    await mkdir( homeFlowmcp(), { recursive: true } )
    const config = {
        initialized: '2026-06-04T12:00:00.000Z',
        schemaFolders: [ { name: 'grading-dev', path: schemaSourceRoot() } ],
        ...extra
    }
    await writeFile( join( homeFlowmcp(), 'config.json' ), JSON.stringify( config, null, 4 ), 'utf-8' )
}

const emitInto = ( opts = {} ) => FlowMcpCli.gradingRun( {
    cwd, target: NAMESPACE, phase: null, emitPrompts: true, consumeScores: null,
    onConflict: null, memberSource: null, gradingDataDir: null, gradingExportDir: null,
    maxIterations: null, withKeys: false, json: true, ...opts
} )


describe( 'grading-data root is configurable (global ~/.flowmcp)', () => {
    it( 'default lands in ~/.flowmcp/grading', async () => {
        await writeGlobalConfig()
        const { result } = await emitInto( {} )
        expect( result.status ).toBe( true )
        expect( existsSync( join( homeFlowmcp(), 'grading', 'providers', NAMESPACE ) ) ).toBe( true )
    } )

    it( 'config.json "gradingDataDir" (home-relative) overrides the default', async () => {
        await writeGlobalConfig( { gradingDataDir: 'configured-island' } )
        const { result } = await emitInto( {} )
        expect( result.status ).toBe( true )
        expect( existsSync( join( homeFlowmcp(), 'configured-island', 'providers', NAMESPACE ) ) ).toBe( true )
        expect( existsSync( join( homeFlowmcp(), 'grading' ) ) ).toBe( false )
    } )

    it( 'FLOWMCP_GRADING_DATA env (cwd-relative) wins over config.json', async () => {
        await writeGlobalConfig( { gradingDataDir: 'configured-island' } )
        process.env[ 'FLOWMCP_GRADING_DATA' ] = 'env-island'
        const { result } = await emitInto( {} )
        expect( result.status ).toBe( true )
        expect( existsSync( join( cwd, 'env-island', 'providers', NAMESPACE ) ) ).toBe( true )
    } )

    it( '--grading-data flag (cwd-relative) wins over env and config.json', async () => {
        await writeGlobalConfig( { gradingDataDir: 'configured-island' } )
        process.env[ 'FLOWMCP_GRADING_DATA' ] = 'env-island'
        const { result } = await emitInto( { gradingDataDir: 'flag-island' } )
        expect( result.status ).toBe( true )
        expect( existsSync( join( cwd, 'flag-island', 'providers', NAMESPACE ) ) ).toBe( true )
        expect( existsSync( join( cwd, 'env-island' ) ) ).toBe( false )
    } )
} )
