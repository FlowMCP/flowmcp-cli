import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'

import { SqliteGtfsResourceValidator } from '../../src/validators/SqliteGtfsResourceValidator.mjs'


describe( 'SqliteGtfsResourceValidator.validateResources', () => {
    const originalEnv = process.env.FLOWMCP_RESOURCES


    beforeEach( () => {
        delete process.env.FLOWMCP_RESOURCES
    } )


    afterEach( () => {
        if( originalEnv === undefined ) {
            delete process.env.FLOWMCP_RESOURCES
        } else {
            process.env.FLOWMCP_RESOURCES = originalEnv
        }
    } )


    it( 'returns no errors for a fully-valid sqlite-gtfs resource', () => {
        const resources = [
            {
                source: 'sqlite-gtfs',
                mode: 'file-based',
                path: '${FLOWMCP_RESOURCES}/gtfs-de.db',
                addon: 'gtfs-sqlite-toolkit'
            }
        ]
        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        expect( errors ).toEqual( [] )
    } )


    it( 'emits RES030 when mode is not file-based', () => {
        const resources = [
            {
                source: 'sqlite-gtfs',
                mode: 'in-memory',
                addon: 'gtfs-sqlite-toolkit'
            }
        ]
        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        const codes = errors.map( ( e ) => e.code )
        expect( codes ).toContain( 'RES030' )
    } )


    it( 'emits RES031 when addon is missing', () => {
        const resources = [
            {
                source: 'sqlite-gtfs',
                mode: 'file-based',
                path: '${FLOWMCP_RESOURCES}/foo.db'
            }
        ]
        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        const codes = errors.map( ( e ) => e.code )
        expect( codes ).toContain( 'RES031' )
    } )


    it( 'emits RES035 when path-variable is unknown', () => {
        const resources = [
            {
                source: 'sqlite-gtfs',
                mode: 'file-based',
                path: '${FLOWMCP_XYZ}/foo.db',
                addon: 'gtfs-sqlite-toolkit'
            }
        ]
        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        const codes = errors.map( ( e ) => e.code )
        expect( codes ).toContain( 'RES035' )
    } )


    it( 'does NOT emit RES035 for ${FLOWMCP_RESOURCES} with unset env (default fallback)', () => {
        const resources = [
            {
                source: 'sqlite-gtfs',
                mode: 'file-based',
                path: '${FLOWMCP_RESOURCES}/foo.db',
                addon: 'gtfs-sqlite-toolkit'
            }
        ]
        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        const codes = errors.map( ( e ) => e.code )
        expect( codes ).not.toContain( 'RES035' )
    } )


    it( 'ignores non-sqlite-gtfs resources entirely', () => {
        const resources = [
            { source: 'sqlite', mode: 'in-memory' },
            { source: 'markdown', path: 'foo.md' },
            { source: 'http', url: 'https://example.com' }
        ]
        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        expect( errors ).toEqual( [] )
    } )


    it( 'reports error path index for arrays', () => {
        const resources = [
            { source: 'sqlite', mode: 'in-memory' },
            { source: 'sqlite-gtfs', mode: 'in-memory', addon: 'gtfs-sqlite-toolkit' }
        ]
        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        const err = errors.find( ( e ) => e.code === 'RES030' )
        expect( err.path ).toBe( 'main.resources[1].mode' )
    } )


    it( 'throws on missing resources arg', () => {
        expect( () => SqliteGtfsResourceValidator.validateResources( { } ) )
            .toThrow( /required/ )
    } )


    it( 'throws on non-array resources', () => {
        expect( () => SqliteGtfsResourceValidator.validateResources( { resources: 'foo' } ) )
            .toThrow( /must be an array/ )
    } )
} )


// Memo 094 P3 — the validator is generalised across ALL registered sqlite
// add-on sources (ADDON_REGISTRY), not just sqlite-gtfs.
describe( 'SqliteGtfsResourceValidator — generalised sqlite add-on sources', () => {
    it( 'validates a fully-valid sqlite-geojson resource without errors', () => {
        const resources = [
            {
                source: 'sqlite-geojson',
                mode: 'file-based',
                path: '${FLOWMCP_RESOURCES}/places.db',
                addon: 'geojson-sqlite-toolkit'
            }
        ]
        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        expect( errors ).toEqual( [] )
    } )


    it( 'emits RES030 for a sqlite-geojson resource with in-memory mode (dynamic source in message)', () => {
        const resources = [
            {
                source: 'sqlite-geojson',
                mode: 'in-memory',
                addon: 'geojson-sqlite-toolkit'
            }
        ]
        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        const res030 = errors.find( ( e ) => e.code === 'RES030' )
        expect( res030 ).toBeDefined()
        expect( res030.message ).toContain( 'sqlite-geojson' )
    } )


    it( 'emits RES031 for a sqlite-csv resource missing the addon field', () => {
        const resources = [
            {
                source: 'sqlite-csv',
                mode: 'file-based',
                path: '${FLOWMCP_RESOURCES}/places.db'
            }
        ]
        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        const res031 = errors.find( ( e ) => e.code === 'RES031' )
        expect( res031 ).toBeDefined()
        expect( res031.message ).toContain( 'sqlite-csv' )
    } )


    it( 'ignores a source that is NOT in ADDON_REGISTRY', () => {
        const resources = [
            { source: 'sqlite-unknown', mode: 'in-memory' }
        ]
        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        expect( errors ).toEqual( [] )
    } )
} )
