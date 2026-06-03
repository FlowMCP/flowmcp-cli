import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, readFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'

import { createTestHome } from '../helpers/test-home.mjs'


const ENV_KEY = 'FLOWMCP_RESOURCES'
const originalResources = process.env[ ENV_KEY ]


const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


const home = createTestHome( { suite: 'cli-error-res032' } )

let cwd
let resourcesDir
let dbPath
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
    dbPath = join( resourcesDir, 'gtfs-de.db' )
    schemaFile = join( home.root, 'schemas', 'gtfsde-transit-v2.mjs' )

    await mkdir( cwd, { recursive: true } )
    await mkdir( resourcesDir, { recursive: true } )
    await mkdir( dirname( schemaFile ), { recursive: true } )

    await writeFile(
        home.globalConfigPath,
        JSON.stringify( { initialized: true, sources: {} }, null, 4 ),
        'utf-8'
    )

    // Construct a plain SQLite DB WITHOUT the qualitySeal entry.
    // The seal-check (PRD-06 verifySeal) must reject this with reason NO_SEAL,
    // surfacing RES032 in the add pipeline (Memo 051 Kap. 4.2, Kap. 8.2).
    const db = new Database( dbPath )
    db.exec( 'CREATE TABLE meta( key TEXT PRIMARY KEY, value TEXT )' )
    db
        .prepare( 'INSERT INTO meta( key, value ) VALUES( ?, ? )' )
        .run( 'buildDate', '2026-05-21T00:00:00Z' )
    db.exec( 'CREATE TABLE stops( stop_id TEXT PRIMARY KEY, stop_name TEXT )' )
    db.exec( 'CREATE TABLE routes( route_id TEXT PRIMARY KEY, route_short_name TEXT )' )
    db.close()

    process.env[ ENV_KEY ] = resourcesDir

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
            addonSource: 'github:FlowMCP/gtfs-sqlite-toolkit'
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


describe( 'flowmcp add — RES032 (DB without seal) error path (PRD-28)', () => {
    it( 'add fails (status=false) when DB has no qualitySeal', () => {
        expect( addResult ).toBeDefined()
        expect( addResult.result ).toBeDefined()
        expect( addResult.result.status ).toBe( false )
    } )


    it( 'error message references RES032', () => {
        expect( addResult.result.error ).toBeDefined()
        expect( addResult.result.error ).toMatch( /RES032/ )
    } )


    it( 'error message identifies the unsealed reason (NO_SEAL)', () => {
        expect( addResult.result.error ).toMatch( /NO_SEAL/ )
    } )


    it( 'no seal-cache entry is written for the rejected schema', async () => {
        const cachePath = join( home.globalConfigDir, 'cache', 'sqlite-gtfs', 'gtfsde-gtfsde-transit-v2.json' )

        let cacheExists = false
        try {
            await access( cachePath, constants.F_OK )
            cacheExists = true
        } catch {
            cacheExists = false
        }

        expect( cacheExists ).toBe( false )
    } )


    it( 'flowmcp list does not contain any gtfsde.* auto-tools after rejected add', async () => {
        const { result: listResult } = await FlowMcpCli.list( { cwd } )

        const tools = listResult.tools || []
        const gtfsdeTools = tools.filter( ( t ) => typeof t.name === 'string' && t.name.startsWith( 'gtfsde.' ) )

        expect( gtfsdeTools ).toEqual( [] )
    } )
} )
