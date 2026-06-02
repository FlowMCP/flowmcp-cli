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


// Memo 096 — geojson/csv add-on sources are URL-only (mode: 'url'). The
// converter/file-based/seal path was removed (F3=B). gtfs stays file-based.
describe( 'SqliteGtfsResourceValidator — URL-mode add-on sources (Memo 096)', () => {
    it( 'validates a fully-valid sqlite-geojson url resource without errors', () => {
        const resources = [
            {
                source: 'sqlite-geojson',
                mode: 'url',
                url: 'https://example.org/places.geojson',
                addon: 'geojson-sqlite-toolkit'
            }
        ]
        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        expect( errors ).toEqual( [] )
    } )


    it( 'validates a fully-valid sqlite-csv url resource with parseConfig', () => {
        const resources = [
            {
                source: 'sqlite-csv',
                mode: 'url',
                url: 'https://example.org/places.csv',
                addon: 'csv-tsv-sqlite-toolkit',
                parseConfig: { delimiter: ',', header: true }
            }
        ]
        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        expect( errors ).toEqual( [] )
    } )


    it( 'emits RES043 for a sqlite-geojson resource with file-based mode (converter path removed)', () => {
        const resources = [
            {
                source: 'sqlite-geojson',
                mode: 'file-based',
                path: '${FLOWMCP_RESOURCES}/places.db',
                addon: 'geojson-sqlite-toolkit'
            }
        ]
        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        const res043 = errors.find( ( e ) => e.code === 'RES043' )
        expect( res043 ).toBeDefined()
        expect( res043.message ).toContain( 'sqlite-geojson' )
    } )


    it( 'emits RES044 for a sqlite-geojson url resource with a non-HTTPS url', () => {
        const resources = [
            {
                source: 'sqlite-geojson',
                mode: 'url',
                url: 'http://example.org/places.geojson',
                addon: 'geojson-sqlite-toolkit'
            }
        ]
        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        const res044 = errors.find( ( e ) => e.code === 'RES044' )
        expect( res044 ).toBeDefined()
    } )


    it( 'emits RES045 for a sqlite-csv url resource missing parseConfig (no silent default)', () => {
        const resources = [
            {
                source: 'sqlite-csv',
                mode: 'url',
                url: 'https://example.org/places.csv',
                addon: 'csv-tsv-sqlite-toolkit'
            }
        ]
        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        const res045 = errors.find( ( e ) => e.code === 'RES045' )
        expect( res045 ).toBeDefined()
    } )


    it( 'emits RES031 for a sqlite-csv url resource missing the addon field', () => {
        const resources = [
            {
                source: 'sqlite-csv',
                mode: 'url',
                url: 'https://example.org/places.csv',
                parseConfig: { delimiter: ',', header: true }
            }
        ]
        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        const res031 = errors.find( ( e ) => e.code === 'RES031' )
        expect( res031 ).toBeDefined()
        expect( res031.message ).toContain( 'sqlite-csv' )
    } )


    it( 'emits RES043 when mode url is used on file-based sqlite-gtfs', () => {
        const resources = [
            {
                source: 'sqlite-gtfs',
                mode: 'url',
                url: 'https://example.org/feed.zip',
                addon: 'gtfs-sqlite-toolkit'
            }
        ]
        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        const res043 = errors.find( ( e ) => e.code === 'RES043' )
        expect( res043 ).toBeDefined()
    } )


    it( 'ignores a source that is NOT in ADDON_REGISTRY', () => {
        const resources = [
            { source: 'sqlite-unknown', mode: 'in-memory' }
        ]
        const { errors } = SqliteGtfsResourceValidator.validateResources( { resources } )

        expect( errors ).toEqual( [] )
    } )
} )
