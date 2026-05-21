import { describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { SqliteGtfsResourceValidator } from '../../src/validators/SqliteGtfsResourceValidator.mjs'


const execFileAsync = promisify( execFile )

const REPO_ROOT = dirname( dirname( dirname( fileURLToPath( import.meta.url ) ) ) )
const FIXTURE_DIR = join(
    dirname( REPO_ROOT ),
    'gtfs-sqlite-toolkit',
    'tests',
    'fixtures',
    'synthetic-gtfs'
)
const FIXTURE_DB = join( FIXTURE_DIR, 'synthetic-gtfs.db' )

const NO_SEAL_DIR = join( REPO_ROOT, '.test-home', 'spec-validator-sqlite-gtfs-noseal' )
const NO_SEAL_DB = join( NO_SEAL_DIR, 'no-seal.db' )


const ENV_KEY = 'FLOWMCP_RESOURCES'
const UNKNOWN_VAR = 'FLOWMCP_UNKNOWN_VAR'

const originalResources = process.env[ ENV_KEY ]
const originalUnknown = process.env[ UNKNOWN_VAR ]


beforeAll( async () => {
    if( !existsSync( FIXTURE_DB ) ) {
        await execFileAsync( 'node', [ 'build-fixture.mjs' ], { cwd: FIXTURE_DIR } )
    }

    if( !existsSync( FIXTURE_DB ) ) {
        throw new Error( `Synthetic fixture DB missing after build attempt: ${FIXTURE_DB}` )
    }

    await rm( NO_SEAL_DIR, { recursive: true, force: true } )
    await mkdir( NO_SEAL_DIR, { recursive: true } )

    const db = new Database( NO_SEAL_DB )
    db.exec( 'CREATE TABLE meta( key TEXT PRIMARY KEY, value TEXT )' )
    db
        .prepare( 'INSERT INTO meta( key, value ) VALUES( ?, ? )' )
        .run( 'buildDate', '2026-05-21T00:00:00Z' )
    db.exec( 'CREATE TABLE stops( stop_id TEXT PRIMARY KEY, stop_name TEXT )' )
    db.close()
} )


beforeEach( () => {
    process.env[ ENV_KEY ] = FIXTURE_DIR
    delete process.env[ UNKNOWN_VAR ]
} )


afterEach( () => {
    if( originalResources === undefined ) {
        delete process.env[ ENV_KEY ]
    } else {
        process.env[ ENV_KEY ] = originalResources
    }
    if( originalUnknown === undefined ) {
        delete process.env[ UNKNOWN_VAR ]
    } else {
        process.env[ UNKNOWN_VAR ] = originalUnknown
    }
} )


describe( 'SqliteGtfsResourceValidator — RES030 (mode must be file-based)', () => {
    it( 'emits RES030 with severity error for mode in-memory', () => {
        const resources = [
            {
                source: 'sqlite-gtfs',
                mode: 'in-memory',
                path: '${FLOWMCP_RESOURCES}/synthetic-gtfs.db',
                addon: 'gtfs-sqlite-toolkit'
            }
        ]

        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        expect( errors ).toContainEqual( expect.objectContaining( {
            code: 'RES030',
            severity: 'error'
        } ) )
    } )
} )


describe( 'SqliteGtfsResourceValidator — RES031 (addon field required)', () => {
    it( 'emits RES031 with severity error when addon field is missing', () => {
        const resources = [
            {
                source: 'sqlite-gtfs',
                mode: 'file-based',
                path: '${FLOWMCP_RESOURCES}/synthetic-gtfs.db'
            }
        ]

        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        expect( errors ).toContainEqual( expect.objectContaining( {
            code: 'RES031',
            severity: 'error'
        } ) )
    } )
} )


describe( 'SqliteGtfsResourceValidator — RES032 (DB without seal)', () => {
    it( 'a plain SQLite DB without qualitySeal is detected as unsealed (NO_SEAL)', async () => {
        const { FlowMcpAdapter } = await import( 'gtfs-sqlite-toolkit' )

        const verifyResult = FlowMcpAdapter.verifySeal( { dbPath: NO_SEAL_DB } )

        expect( verifyResult.sealed ).toBe( false )
        expect( verifyResult.reason ).toBe( 'NO_SEAL' )
    } )
} )


describe( 'SqliteGtfsResourceValidator — RES033 (DB cannot be opened)', () => {
    it( 'a path pointing to a nonexistent file is reported by the adapter as DB_UNREADABLE', async () => {
        const { FlowMcpAdapter } = await import( 'gtfs-sqlite-toolkit' )

        const verifyResult = FlowMcpAdapter.verifySeal( {
            dbPath: join( FIXTURE_DIR, 'does-not-exist-dir', 'missing.db' )
        } )

        expect( verifyResult.sealed ).toBe( false )
        expect( verifyResult.reason ).toBe( 'DB_UNREADABLE' )
    } )
} )


describe( 'SqliteGtfsResourceValidator — RES034 (spec revision drift)', () => {
    it( 'a synthetic fixture is sealed with a known specRevision (warning-level check is pipeline-only)', async () => {
        // RES034 is pipeline-only (Memo 051 Kap. 4.2 — emitted by `flowmcp add`),
        // because it requires DB I/O. The structural validator intentionally does
        // NOT perform any disk I/O. This test documents the contract: the synthetic
        // fixture exposes a specRevision via meta, and any pipeline drift check
        // must compare against this value, not classify it as an error.
        const { FlowMcpAdapter } = await import( 'gtfs-sqlite-toolkit' )

        const verifyResult = FlowMcpAdapter.verifySeal( { dbPath: FIXTURE_DB } )

        expect( verifyResult.sealed ).toBe( true )
        expect( typeof verifyResult.meta.specRevision ).toBe( 'string' )
        expect( verifyResult.meta.specRevision.length ).toBeGreaterThan( 0 )
    } )
} )


describe( 'SqliteGtfsResourceValidator — RES035 (path variable unknown)', () => {
    it( 'emits RES035 with severity error for an unknown FLOWMCP_* variable', () => {
        delete process.env[ UNKNOWN_VAR ]

        const resources = [
            {
                source: 'sqlite-gtfs',
                mode: 'file-based',
                path: '${FLOWMCP_UNKNOWN_VAR}/foo.db',
                addon: 'gtfs-sqlite-toolkit'
            }
        ]

        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        expect( errors ).toContainEqual( expect.objectContaining( {
            code: 'RES035',
            severity: 'error'
        } ) )
    } )


    it( 'error message identifies the unresolved variable by name', () => {
        delete process.env[ UNKNOWN_VAR ]

        const resources = [
            {
                source: 'sqlite-gtfs',
                mode: 'file-based',
                path: '${FLOWMCP_UNKNOWN_VAR}/foo.db',
                addon: 'gtfs-sqlite-toolkit'
            }
        ]

        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        const res035 = errors.find( ( e ) => e.code === 'RES035' )
        expect( res035 ).toBeDefined()
        expect( res035.message ).toMatch( /FLOWMCP_UNKNOWN_VAR/ )
    } )
} )


describe( 'SqliteGtfsResourceValidator — positive case (synthetic fixture schema)', () => {
    it( 'a POC schema pointing at the synthetic fixture passes RES030..RES035 validation', () => {
        const resources = [
            {
                source: 'sqlite-gtfs',
                mode: 'file-based',
                path: '${FLOWMCP_RESOURCES}/synthetic-gtfs.db',
                addon: 'gtfs-sqlite-toolkit',
                addonSource: 'github:FlowMCP/gtfs-sqlite-toolkit'
            }
        ]

        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        const codes = errors.map( ( e ) => e.code )
        expect( codes ).not.toContain( 'RES030' )
        expect( codes ).not.toContain( 'RES031' )
        expect( codes ).not.toContain( 'RES035' )
        expect( errors ).toEqual( [] )
    } )
} )
