import { describe, it, expect, beforeAll } from '@jest/globals'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'

import Database from 'better-sqlite3'

import { PrivateCommand } from '../../src/commands/PrivateCommand.mjs'
import { SearchCommand } from '../../src/commands/SearchCommand.mjs'
import { CallCommand } from '../../src/commands/CallCommand.mjs'


// Memo 157 / Phase 3 (PRD-07) — v4 resource-query test hardening. Three assertions:
//   1. Round-Trip — `private call <fixture> <queryName>_<namespace>` resolves AND returns data
//      (covers Kap 2 resource-query resolution + Kap 3 private-call resource support).
//   2. Live-Schema — a REGISTERED sqlite resource schema is callable via `call` and enumerable
//      via search / list-tools (the wiring runs against a real registered schema + real DB).
//   3. Guard — the name search advertises == the name call resolves == the name serve registers
//      (`${queryName}_${namespace}`); a markdown `about` resource (no queries) is NOT advertised.
//
// The database lives under the per-suite mocked home (never the real ~/.flowmcp). SELECT-only
// SQL, so the SecurityScanner on the private path passes.

const here = dirname( fileURLToPath( import.meta.url ) )
const RESOURCE_SRC = join( here, '..', 'fixtures', 'private', 'resource-src' )
const FIXTURE = join( RESOURCE_SRC, 'providers', 'privres-schema.mjs' )
const cwd = process.cwd()


beforeAll( async () => {
    // Real DB under the mocked home — the fixture's `database: '~/.flowmcp/data/priv157.db'`
    // resolves here via os.homedir() (mocked into <repo>/.test-home).
    const dbPath = join( homedir(), '.flowmcp', 'data', 'priv157.db' )
    await mkdir( dirname( dbPath ), { recursive: true } )

    const db = new Database( dbPath )
    db.exec( 'CREATE TABLE IF NOT EXISTS items ( id INTEGER PRIMARY KEY, label TEXT )' )
    db.exec( 'DELETE FROM items' )
    const insert = db.prepare( 'INSERT INTO items ( id, label ) VALUES ( ?, ? )' )
    insert.run( 1, 'alpha' )
    insert.run( 2, 'bravo' )
    insert.run( 3, 'charlie' )
    db.close()

    // Register the fixture folder as a schemaFolder so call / search / list see it.
    const globalConfigDir = join( homedir(), '.flowmcp' )
    const config = {
        'envPath': join( globalConfigDir, '.env' ),
        'flowmcpCore': { 'version': '4.0.0', 'commit': 'test', 'schemaSpec': '4.0.0' },
        'initialized': new Date().toISOString(),
        'schemaFolders': [
            { 'name': 'resfix', 'path': RESOURCE_SRC }
        ]
    }
    await writeFile( join( globalConfigDir, '.env' ), '', 'utf-8' )
    await writeFile( join( globalConfigDir, 'config.json' ), JSON.stringify( config, null, 4 ), 'utf-8' )
} )


describe( 'PRD-07 Assertion 1 — round-trip: private call resolves a resource query and returns data', () => {
    it( 'returns rows for `listItems_privres` via the wire-name', async () => {
        const { result } = await PrivateCommand.call( {
            'schemaPath': FIXTURE, 'toolName': 'listItems_privres', 'jsonArgs': '{"limit":5}', cwd
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolName' ] ).toBe( 'listItems_privres' )
        expect( Array.isArray( result[ 'content' ] ) ).toBe( true )
        expect( result[ 'content' ].length ).toBe( 3 )
        expect( result[ 'content' ][ 0 ] ).toEqual( { id: 1, label: 'alpha' } )
    } )


    it( 'also resolves the raw query name and returns a single row for `itemById`', async () => {
        const { result } = await PrivateCommand.call( {
            'schemaPath': FIXTURE, 'toolName': 'itemById', 'jsonArgs': '{"id":2}', cwd
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'content' ] ).toEqual( [ { id: 2, label: 'bravo' } ] )
    } )


    it( 'fails loud with PRV-007 for an unknown query (no silent default)', async () => {
        const { result } = await PrivateCommand.call( {
            'schemaPath': FIXTURE, 'toolName': 'noSuchQuery_privres', 'jsonArgs': '{}', cwd
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'PRV-007' )
        expect( result[ 'fix' ] ).toContain( 'listItems_privres' )
    } )
} )


describe( 'PRD-07 Assertion 2 — live schema: a registered resource query is callable via `call`', () => {
    it( 'resolves `listItems_privres` through the registered call path with real data', async () => {
        const { result } = await CallCommand.callTool( {
            'toolName': 'listItems_privres', 'jsonArgs': '{"limit":2}', cwd
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( Array.isArray( result[ 'data' ] ) || Array.isArray( result[ 'content' ] ) ).toBe( true )
        const rows = result[ 'data' ] !== undefined ? result[ 'data' ] : result[ 'content' ]
        expect( rows[ 0 ] ).toEqual( { id: 1, label: 'alpha' } )
    } )
} )


describe( 'PRD-07 Assertion 3 — guard: search == call == serve name, about-markdown skipped', () => {
    it( 'search advertises per-query `${queryName}_${namespace}`, not the resource name', async () => {
        const { tools } = await SearchCommand.listAvailableTools()
        const names = tools.map( ( t ) => t[ 'toolName' ] )

        expect( names ).toContain( 'listItems_privres' )
        expect( names ).toContain( 'itemById_privres' )
        // The resource container name is NOT a callable tool.
        expect( names ).not.toContain( 'itemsDb_privres' )
        // The markdown `about` resource has no queries and must not be advertised.
        expect( names ).not.toContain( 'guide_privres' )
    } )


    it( '`call list-tools` enumerates the same per-query names', async () => {
        const { result } = await CallCommand.callListTools( { cwd } )
        const names = result[ 'tools' ].map( ( t ) => t[ 'toolName' ] )

        expect( names ).toContain( 'listItems_privres' )
        expect( names ).toContain( 'itemById_privres' )
        expect( names ).not.toContain( 'guide_privres' )
    } )


    it( 'the search-advertised name is exactly the private-call-resolvable name (contract)', async () => {
        const { tools } = await SearchCommand.listAvailableTools()
        const advertised = tools
            .filter( ( t ) => t[ 'namespace' ] === 'privres' && t[ 'type' ] === 'resource' )
            .map( ( t ) => t[ 'toolName' ] )
            .sort()

        // Same convention serve uses (`${queryName}_${namespace}`, ServeCommand) and call resolves.
        expect( advertised ).toEqual( [ 'itemById_privres', 'listItems_privres' ] )
    } )
} )
