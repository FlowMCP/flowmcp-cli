import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals'
import { writeFile, mkdir, copyFile, rm, readFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTestHome } from '../helpers/test-home.mjs'


const REPO_ROOT = dirname( dirname( dirname( fileURLToPath( import.meta.url ) ) ) )
const TOOLKIT_FIXTURE_DB = join(
    dirname( REPO_ROOT ),
    'geo-gtfs-toolkit',
    'tests',
    'fixtures',
    'synthetic-gtfs',
    'synthetic-gtfs.db'
)

// FlowMcpCli must be imported AFTER createTestHome registers the os.homedir mock.
const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )

const originalEnv = process.env.FLOWMCP_RESOURCES


let home
let cwd
let resourcesDir
let schemaPath
let badSchemaPath
let fixtureExists


beforeEach( async () => {
    home = createTestHome( { 'suite': 'sqlite-gtfs-pipeline' } )
    await home.setup()

    cwd = join( home.root, 'cwd' )
    resourcesDir = join( home.root, 'resources' )
    schemaPath = join( home.root, 'gtfsde-transit-v2.mjs' )
    badSchemaPath = join( home.root, 'gtfsde-bad.mjs' )

    await mkdir( cwd, { recursive: true } )
    await mkdir( resourcesDir, { recursive: true } )

    await writeFile(
        join( home.globalConfigDir, 'config.json' ),
        JSON.stringify( { 'initialized': true, 'sources': {} }, null, 4 ),
        'utf-8'
    )

    process.env.FLOWMCP_RESOURCES = resourcesDir

    fixtureExists = false
    try {
        await access( TOOLKIT_FIXTURE_DB, constants.R_OK )
        fixtureExists = true
    } catch { /* */ }

    if( fixtureExists ) {
        await copyFile( TOOLKIT_FIXTURE_DB, join( resourcesDir, 'gtfs-de.db' ) )
    }

    const schemaContent = `export const main = {
    namespace: 'gtfsde',
    name: 'gtfsde-transit-v2',
    version: '4.1.0',
    resources: [
        {
            source: 'sqlite-gtfs',
            mode: 'file-based',
            path: '\${FLOWMCP_RESOURCES}/gtfs-de.db',
            addon: 'geo-gtfs-toolkit'
        }
    ]
}
`
    await writeFile( schemaPath, schemaContent, 'utf-8' )

    const badSchemaContent = `export const main = {
    namespace: 'gtfsde',
    name: 'gtfsde-bad',
    version: '4.1.0',
    resources: [
        {
            source: 'sqlite-gtfs',
            mode: 'in-memory',
            addon: 'geo-gtfs-toolkit'
        }
    ]
}
`
    await writeFile( badSchemaPath, badSchemaContent, 'utf-8' )
} )


afterEach( async () => {
    if( originalEnv === undefined ) {
        delete process.env.FLOWMCP_RESOURCES
    } else {
        process.env.FLOWMCP_RESOURCES = originalEnv
    }

    await home.teardown()
} )


describe( 'flowmcp add sqlite-gtfs schema (PRD-18)', () => {
    it( 'runs the full add pipeline with synthetic fixture (or fails gracefully if fixture absent)', async () => {
        const { result } = await FlowMcpCli.add( { 'toolName': schemaPath, cwd, 'force': false } )

        if( fixtureExists ) {
            expect( result.status ).toBe( true )
            expect( result.namespace ).toBe( 'gtfsde' )
            expect( result.addon ).toBe( 'geo-gtfs-toolkit' )
            expect( result.sourceKey ).toBe( 'sqlite-gtfs' )
            expect( Array.isArray( result.tools ) ).toBe( true )
            expect( result.tools.length ).toBeGreaterThan( 0 )
        } else {
            expect( result.status ).toBe( false )
            expect( result.error ).toMatch( /RES033/ )
        }
    } )


    it( 'aborts with RES030 when the schema has mode in-memory (PRD-17 + PRD-18)', async () => {
        const { result } = await FlowMcpCli.add( { 'toolName': badSchemaPath, cwd, 'force': false } )

        expect( result.status ).toBe( false )
        expect( result.error ).toMatch( /RES030/ )
    } )


    it( 'writes a sqlite-gtfs seal cache entry on successful add (PRD-21)', async () => {
        if( !fixtureExists ) { return }

        await FlowMcpCli.add( { 'toolName': schemaPath, cwd, 'force': true } )

        const cachePath = join( home.globalConfigDir, 'cache', 'sqlite-gtfs', 'gtfsde-gtfsde-transit-v2.json' )
        const raw = await readFile( cachePath, 'utf-8' )
        const entry = JSON.parse( raw )

        expect( entry.schemaName ).toBe( 'gtfsde-transit-v2' )
        expect( entry.schemaNamespace ).toBe( 'gtfsde' )
        expect( entry.meta.qualitySeal ).toBe( 'sqlite-gtfs' )
        expect( Array.isArray( entry.tools ) ).toBe( true )
    } )


    it( 'lists auto-injected tools with auto flag after add (PRD-19)', async () => {
        if( !fixtureExists ) { return }

        await FlowMcpCli.add( { 'toolName': schemaPath, cwd, 'force': true } )

        const { result: listResult } = await FlowMcpCli.list( { cwd } )

        const autoTools = ( listResult.tools || [] )
            .filter( ( t ) => {
                const isAuto = t.auto === true

                return isAuto
            } )

        expect( autoTools.length ).toBeGreaterThan( 0 )
        const names = autoTools.map( ( t ) => { return t.name } )
        expect( names ).toContain( 'gtfsde.searchStops' )
    } )


    it( 'routes flowmcp call to addon handler for auto-tools (PRD-20)', async () => {
        if( !fixtureExists ) { return }

        await FlowMcpCli.add( { 'toolName': schemaPath, cwd, 'force': true } )

        // searchRoutes uses the `routes` base table which is always present
        // in a sealed sqlite-gtfs DB (searchStops requires stops_fts which
        // may not be in every fixture build).
        const { result: callResult } = await FlowMcpCli.callTool( {
            'toolName': 'gtfsde.searchRoutes',
            'jsonArgs': JSON.stringify( { 'name': 'Linie-1', 'limit': 10 } ),
            'group': undefined,
            cwd,
            'noCache': true,
            'refresh': false
        } )

        expect( callResult.status ).toBe( true )
        expect( callResult.toolName ).toBe( 'gtfsde.searchRoutes' )
        expect( callResult.content ).toBeDefined()
        expect( Array.isArray( callResult.content ) ).toBe( true )
    } )


    it( 'returns error for unknown auto-tool name (PRD-20)', async () => {
        if( !fixtureExists ) { return }

        await FlowMcpCli.add( { 'toolName': schemaPath, cwd, 'force': true } )

        const { result: callResult } = await FlowMcpCli.callTool( {
            'toolName': 'gtfsde.doesNotExist',
            'jsonArgs': null,
            'group': undefined,
            cwd,
            'noCache': true,
            'refresh': false
        } )

        // Either routed to addon (RES "not provided") OR fell through to standard tool lookup ("not found in active tools")
        expect( callResult.status ).toBe( false )
    } )
} )


describe( 'flowmcp add sqlite-gtfs — override behavior (PRD-22)', () => {
    it( 'schema-defined tool overrides auto-injected tool with same name', async () => {
        if( !fixtureExists ) { return }

        const overrideSchemaPath = join( home.root, 'gtfsde-override.mjs' )
        const overrideContent = `export const main = {
    namespace: 'gtfsde',
    name: 'gtfsde-override',
    version: '4.1.0',
    resources: [
        {
            source: 'sqlite-gtfs',
            mode: 'file-based',
            path: '\${FLOWMCP_RESOURCES}/gtfs-de.db',
            addon: 'geo-gtfs-toolkit'
        }
    ],
    tools: {
        searchStops: {
            description: 'Custom searchStops override',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } }
        }
    }
}
`
        await writeFile( overrideSchemaPath, overrideContent, 'utf-8' )

        const { result } = await FlowMcpCli.add( { 'toolName': overrideSchemaPath, cwd, 'force': true } )

        expect( result.status ).toBe( true )
        expect( result.overriddenAutoTools ).toContain( 'gtfsde.searchStops' )

        const overriddenTool = result.tools
            .find( ( t ) => {
                const isMatch = t.name === 'gtfsde.searchStops'

                return isMatch
            } )

        expect( overriddenTool ).toBeDefined()
        expect( overriddenTool.auto ).toBe( false )
    } )
} )
