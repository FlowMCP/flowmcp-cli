import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { writeFile, mkdir, copyFile, readFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createTestHome } from '../helpers/test-home.mjs'


// Memo 094 P3 — E2E proof that the generalised sqlite add-on pipeline drives
// the published geojson + csv add-ons (not just gtfs). Mirrors the
// sqlite-gtfs-pipeline test: real add->call when the sibling toolkit fixture
// DB is present (local), graceful RES033 when absent (CI without siblings).

const REPO_ROOT = dirname( dirname( dirname( fileURLToPath( import.meta.url ) ) ) )
const SIBLINGS_ROOT = dirname( REPO_ROOT )

const ADDONS = [
    {
        sourceKey: 'sqlite-geojson',
        addonName: 'geojson-sqlite-toolkit',
        fixtureDb: join( SIBLINGS_ROOT, 'geojson-sqlite-toolkit', 'tests', 'fixtures', 'synthetic-geojson', 'synthetic-geojson.db' ),
        dbFileName: 'places-geojson.db',
        namespace: 'placesgeo',
        schemaName: 'places-geojson-v1'
    },
    {
        sourceKey: 'sqlite-csv',
        addonName: 'csv-tsv-sqlite-toolkit',
        fixtureDb: join( SIBLINGS_ROOT, 'csv-tsv-sqlite-toolkit', 'tests', 'fixtures', 'synthetic-csv', 'synthetic-csv.db' ),
        dbFileName: 'places-csv.db',
        namespace: 'placescsv',
        schemaName: 'places-csv-v1'
    }
]

// FlowMcpCli must be imported AFTER createTestHome registers the os.homedir mock.
const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )

const originalEnv = process.env.FLOWMCP_RESOURCES


ADDONS
    .forEach( ( addon ) => {
        describe( `flowmcp add/call ${addon.sourceKey} add-on (Memo 094 P3 E2E)`, () => {
            let home
            let cwd
            let resourcesDir
            let schemaPath
            let badSchemaPath
            let fixtureExists


            beforeEach( async () => {
                home = createTestHome( { 'suite': `sqlite-${addon.sourceKey}` } )
                await home.setup()

                cwd = join( home.root, 'cwd' )
                resourcesDir = join( home.root, 'resources' )
                schemaPath = join( home.root, `${addon.schemaName}.mjs` )
                badSchemaPath = join( home.root, `${addon.schemaName}-bad.mjs` )

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
                    await access( addon.fixtureDb, constants.R_OK )
                    fixtureExists = true
                } catch { /* sibling toolkit not checked out — graceful degrade */ }

                if( fixtureExists ) {
                    await copyFile( addon.fixtureDb, join( resourcesDir, addon.dbFileName ) )
                }

                const schemaContent = `export const main = {
    namespace: '${addon.namespace}',
    name: '${addon.schemaName}',
    version: '4.1.0',
    resources: [
        {
            source: '${addon.sourceKey}',
            mode: 'file-based',
            path: '\${FLOWMCP_RESOURCES}/${addon.dbFileName}',
            addon: '${addon.addonName}'
        }
    ]
}
`
                await writeFile( schemaPath, schemaContent, 'utf-8' )

                const badSchemaContent = `export const main = {
    namespace: '${addon.namespace}',
    name: '${addon.schemaName}-bad',
    version: '4.1.0',
    resources: [
        {
            source: '${addon.sourceKey}',
            mode: 'in-memory',
            addon: '${addon.addonName}'
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


            it( 'runs the full add pipeline with the sibling fixture (or fails gracefully if absent)', async () => {
                const { result } = await FlowMcpCli.add( { 'toolName': schemaPath, cwd, 'force': false } )

                if( fixtureExists ) {
                    expect( result.status ).toBe( true )
                    expect( result.namespace ).toBe( addon.namespace )
                    expect( result.addon ).toBe( addon.addonName )
                    expect( result.sourceKey ).toBe( addon.sourceKey )
                    expect( Array.isArray( result.tools ) ).toBe( true )
                    expect( result.tools.length ).toBeGreaterThan( 0 )
                } else {
                    expect( result.status ).toBe( false )
                    expect( result.error ).toMatch( /RES033/ )
                }
            } )


            it( 'aborts with RES030 when the schema declares mode in-memory', async () => {
                const { result } = await FlowMcpCli.add( { 'toolName': badSchemaPath, cwd, 'force': false } )

                expect( result.status ).toBe( false )
                expect( result.error ).toMatch( /RES030/ )
            } )


            it( 'writes the seal cache into the per-source directory (C3)', async () => {
                if( !fixtureExists ) { return }

                await FlowMcpCli.add( { 'toolName': schemaPath, cwd, 'force': true } )

                const cachePath = join(
                    home.globalConfigDir,
                    'cache',
                    addon.sourceKey,
                    `${addon.namespace}-${addon.schemaName}.json`
                )
                const raw = await readFile( cachePath, 'utf-8' )
                const entry = JSON.parse( raw )

                expect( entry.sourceKey ).toBe( addon.sourceKey )
                expect( entry.meta.qualitySeal ).toBe( addon.sourceKey )
                expect( Array.isArray( entry.tools ) ).toBe( true )
            } )


            it( 'routes flowmcp call to the addon handler and returns real rows', async () => {
                if( !fixtureExists ) { return }

                await FlowMcpCli.add( { 'toolName': schemaPath, cwd, 'force': true } )

                const { result: callResult } = await FlowMcpCli.callTool( {
                    'toolName': `${addon.namespace}.featuresInBBox`,
                    'jsonArgs': JSON.stringify( { 'minLon': -180, 'maxLon': 180, 'minLat': -90, 'maxLat': 90, 'limit': 10 } ),
                    'group': undefined,
                    cwd,
                    'noCache': true,
                    'refresh': false
                } )

                expect( callResult.status ).toBe( true )
                expect( callResult.toolName ).toBe( `${addon.namespace}.featuresInBBox` )
                expect( Array.isArray( callResult.content ) ).toBe( true )
            } )
        } )
    } )
