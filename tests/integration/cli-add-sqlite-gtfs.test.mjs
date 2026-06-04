import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, copyFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTestHome } from '../helpers/test-home.mjs'


const execFileAsync = promisify( execFile )

const REPO_ROOT = dirname( dirname( dirname( fileURLToPath( import.meta.url ) ) ) )
const FIXTURE_DIR = join(
    REPO_ROOT,
    'node_modules',
    'geo-gtfs-toolkit',
    'tests',
    'fixtures',
    'synthetic-gtfs'
)
const FIXTURE_DB = join( FIXTURE_DIR, 'synthetic-gtfs.db' )
const POC_SCHEMA_FIXTURE = join( REPO_ROOT, 'tests', 'integration', 'fixtures', 'gtfsde-transit-v2.mjs' )

const ENV_KEY = 'FLOWMCP_RESOURCES'
const originalResources = process.env[ ENV_KEY ]


// FlowMcpCli must be imported AFTER createTestHome registers the os.homedir mock.
const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


const home = createTestHome( { suite: 'cli-add-sqlite-gtfs' } )

let cwd
let resourcesDir
let schemaFile
let addResult
let stdoutBuffer


function captureConsole() {
    const original = console.log
    stdoutBuffer = []
    console.log = ( ...args ) => {
        stdoutBuffer.push( args.map( ( a ) => String( a ) ).join( ' ' ) )
    }
    return () => { console.log = original }
}


beforeAll( async () => {
    await home.setup()

    cwd = join( home.root, 'cwd' )
    resourcesDir = join( home.globalConfigDir, 'resources' )
    schemaFile = join( home.root, 'schemas', 'gtfsde-transit-v2.mjs' )

    await mkdir( cwd, { recursive: true } )
    await mkdir( resourcesDir, { recursive: true } )
    await mkdir( dirname( schemaFile ), { recursive: true } )

    await writeFile(
        home.globalConfigPath,
        JSON.stringify( { initialized: true, sources: {} }, null, 4 ),
        'utf-8'
    )

    if( !existsSync( FIXTURE_DB ) ) {
        await execFileAsync( 'node', [ 'build-fixture.mjs' ], { cwd: FIXTURE_DIR } )
    }
    if( !existsSync( FIXTURE_DB ) ) {
        throw new Error( `Synthetic fixture DB missing after build attempt: ${FIXTURE_DB}` )
    }

    await copyFile( FIXTURE_DB, join( resourcesDir, 'gtfs-de.db' ) )

    process.env[ ENV_KEY ] = resourcesDir

    // Materialize the POC schema into the test home so the resolved file path
    // sits under our isolated tree. Schema content mirrors PRD-25 verbatim.
    const pocContent = `export const main = {
    namespace: 'gtfsde',
    name: 'gtfsde-transit-v2',
    version: '4.1.0',
    resources: [
        {
            source: 'sqlite-gtfs',
            mode: 'file-based',
            path: '\${FLOWMCP_RESOURCES}/gtfs-de.db',
            addon: 'geo-gtfs-toolkit',
            addonSource: 'github:FlowMCP/geo-gtfs-toolkit'
        }
    ]
}
`
    await writeFile( schemaFile, pocContent, 'utf-8' )

    const restoreConsole = captureConsole()
    addResult = await FlowMcpCli.add( { toolName: schemaFile, cwd, force: false } )
    restoreConsole()
} )


afterAll( async () => {
    if( originalResources === undefined ) {
        delete process.env[ ENV_KEY ]
    } else {
        process.env[ ENV_KEY ] = originalResources
    }
    await home.teardown()
} )


describe( 'flowmcp add — sqlite-gtfs POC against synthetic fixture (PRD-26)', () => {
    it( 'POC schema fixture file exists and is importable', async () => {
        await access( POC_SCHEMA_FIXTURE, constants.R_OK )
        const mod = await import( POC_SCHEMA_FIXTURE )
        expect( mod.schema ).toBeDefined()
        expect( mod.schema.namespace ).toBe( 'gtfsde' )
    } )


    it( 'add completes without error (status=true)', () => {
        expect( addResult ).toBeDefined()
        expect( addResult.result ).toBeDefined()
        expect( addResult.result.status ).toBe( true )
        expect( addResult.result.namespace ).toBe( 'gtfsde' )
        expect( addResult.result.addon ).toBe( 'geo-gtfs-toolkit' )
        expect( addResult.result.sourceKey ).toBe( 'sqlite-gtfs' )
    } )


    it( 'console output contains the "Seal: sqlite-gtfs" marker', () => {
        const joined = stdoutBuffer.join( '\n' )
        expect( joined ).toMatch( /Seal: sqlite-gtfs/ )
    } )


    it( 'schema is registered in the sqlite-gtfs seal cache', async () => {
        const cachePath = join( home.globalConfigDir, 'cache', 'sqlite-gtfs', 'gtfsde-gtfsde-transit-v2.json' )
        await access( cachePath, constants.R_OK )

        const { readFile } = await import( 'node:fs/promises' )
        const raw = await readFile( cachePath, 'utf-8' )
        const entry = JSON.parse( raw )

        expect( entry.schemaName ).toBe( 'gtfsde-transit-v2' )
        expect( entry.schemaNamespace ).toBe( 'gtfsde' )
        expect( entry.meta.qualitySeal ).toBe( 'sqlite-gtfs' )
    } )


    it( 'auto-tools registered: searchStops, searchRoutes, getDepartures, getShapeForRoute', () => {
        const toolNames = ( addResult.result.tools || [] ).map( ( t ) => t.name )

        expect( toolNames ).toContain( 'gtfsde.searchStops' )
        expect( toolNames ).toContain( 'gtfsde.searchRoutes' )
        expect( toolNames ).toContain( 'gtfsde.getDepartures' )
        expect( toolNames ).toContain( 'gtfsde.getShapeForRoute' )
    } )


    it( 'getFlexBookingRules is NOT registered (synthetic fixture has no flex)', () => {
        const toolNames = ( addResult.result.tools || [] ).map( ( t ) => t.name )

        expect( toolNames ).not.toContain( 'gtfsde.getFlexBookingRules' )
    } )


    it( 'all registered tools are flagged as auto-injected', () => {
        const tools = addResult.result.tools || []
        expect( tools.length ).toBeGreaterThan( 0 )

        tools
            .forEach( ( tool ) => {
                expect( tool.auto ).toBe( true )
            } )
    } )


    it( 'flowmcp list returns auto-tools after add', async () => {
        const { result: listResult } = await FlowMcpCli.list( { cwd } )

        const autoTools = ( listResult.tools || [] ).filter( ( t ) => t.auto === true )
        const names = autoTools.map( ( t ) => t.name )

        expect( names ).toContain( 'gtfsde.searchStops' )
        expect( names ).toContain( 'gtfsde.searchRoutes' )
    } )


    it( 're-add is idempotent (status still true, same tool count)', async () => {
        const restoreConsole = captureConsole()
        const { result: secondResult } = await FlowMcpCli.add( { toolName: schemaFile, cwd, force: true } )
        restoreConsole()

        expect( secondResult.status ).toBe( true )
        expect( secondResult.tools.length ).toBe( ( addResult.result.tools || [] ).length )

        const namesFirst = ( addResult.result.tools || [] ).map( ( t ) => t.name ).sort()
        const namesSecond = ( secondResult.tools || [] ).map( ( t ) => t.name ).sort()
        expect( namesSecond ).toEqual( namesFirst )
    } )
} )
