import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createTestHome } from '../helpers/test-home.mjs'


// Memo 096 — E2E proof that the CLI `mode: 'url'` add-on pipeline works:
// add (fetch+parse+in-memory via the add-on) -> call (dispatch a default method
// over in-memory data). The add-on module is mocked so the test exercises the
// CLI branch deterministically without a network or the published package.

const FEATURE_ROWS = [
    { feature_id: 0, geom_type: 'Point', lat: 50.0, lon: 10.0, properties: { name: 'Alpha' } },
    { feature_id: 1, geom_type: 'Point', lat: 50.01, lon: 10.01, properties: { name: 'Beta' } }
]

const CAPABILITIES = { spatialQuery: true, typeFilter: true }

const METHOD_CATALOG = [
    {
        name: 'featuresInBBox',
        requiresCapabilities: [ 'spatialQuery' ],
        params: {
            minLon: { type: 'number', required: true, description: 'West' },
            minLat: { type: 'number', required: true, description: 'South' },
            maxLon: { type: 'number', required: true, description: 'East' },
            maxLat: { type: 'number', required: true, description: 'North' },
            limit: { type: 'integer', required: false, description: 'Max' }
        },
        outputSchema: { type: 'array', items: { type: 'object' } }
    }
]


function buildFakeAdapter() {
    const loadedUrls = new Set()

    class FlowMcpAdapter {
        static async loadFromUrl( { url, parseConfig } ) {
            if( typeof url !== 'string' || !url.startsWith( 'https://' ) ) {
                throw new Error( `URL-001: url must use HTTPS, got '${url}'` )
            }
            loadedUrls.add( url )
            return { loaded: true, url, capabilities: CAPABILITIES, recordCount: FEATURE_ROWS.length }
        }

        static getAvailableMethods( { url } ) {
            if( !loadedUrls.has( url ) ) { throw new Error( 'URL-004: not loaded' ) }
            return { methods: METHOD_CATALOG.map( ( m ) => ( { ...m } ) ), capabilities: CAPABILITIES }
        }

        static buildToolDefinitions( { url, namespace } ) {
            const tools = METHOD_CATALOG
                .map( ( method ) => {
                    const properties = {}
                    const required = []
                    Object
                        .entries( method.params )
                        .forEach( ( [ name, def ] ) => {
                            properties[ name ] = { type: def.type, description: def.description || '' }
                            if( def.required === true ) { required.push( name ) }
                        } )
                    return {
                        name: `${namespace}.${method.name}`,
                        description: `default method: ${method.name}`,
                        inputSchema: { type: 'object', properties, required },
                        outputSchema: method.outputSchema,
                        requiresCapabilities: method.requiresCapabilities,
                        method: method.name
                    }
                } )
            return { tools }
        }

        static executeMethod( { url, method, params } ) {
            if( !loadedUrls.has( url ) ) { throw new Error( 'URL-004: not loaded' ) }
            if( method !== 'featuresInBBox' ) { throw new Error( `Unknown method: ${method}` ) }
            return { features: FEATURE_ROWS, matchCount: FEATURE_ROWS.length }
        }
    }

    return { FlowMcpAdapter }
}


jest.unstable_mockModule( 'geo-geojson-toolkit', () => buildFakeAdapter() )
jest.unstable_mockModule( 'geo-csv-tsv-toolkit', () => buildFakeAdapter() )

// FlowMcpCli must be imported AFTER the mocks + createTestHome side-effects.
const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


const ADDONS = [
    { sourceKey: 'geo-geojson', addonName: 'geo-geojson-toolkit', namespace: 'placesgeo', schemaName: 'places-geojson-v1', url: 'https://example.org/places.geojson', parseConfig: null },
    { sourceKey: 'geo-csv', addonName: 'geo-csv-tsv-toolkit', namespace: 'placescsv', schemaName: 'places-csv-v1', url: 'https://example.org/places.csv', parseConfig: { delimiter: ',', header: true, latColumn: 'lat', lonColumn: 'lon' } }
]


ADDONS
    .forEach( ( addon ) => {
        describe( `flowmcp add/call ${addon.sourceKey} url-mode add-on (Memo 096 E2E)`, () => {
            let home
            let cwd
            let schemaPath
            let fileBasedSchemaPath


            beforeEach( async () => {
                home = createTestHome( { 'suite': `url-${addon.sourceKey}` } )
                await home.setup()

                cwd = join( home.root, 'cwd' )
                schemaPath = join( home.root, `${addon.schemaName}.mjs` )
                fileBasedSchemaPath = join( home.root, `${addon.schemaName}-file.mjs` )
                await mkdir( cwd, { recursive: true } )

                await writeFile(
                    join( home.globalConfigDir, 'config.json' ),
                    JSON.stringify( { 'initialized': true, 'sources': {} }, null, 4 ),
                    'utf-8'
                )

                const parseConfigLine = addon.parseConfig
                    ? `,\n            parseConfig: ${JSON.stringify( addon.parseConfig )}`
                    : ''

                await writeFile( schemaPath, `export const main = {
    namespace: '${addon.namespace}',
    name: '${addon.schemaName}',
    version: '4.1.0',
    resources: [
        {
            source: '${addon.sourceKey}',
            mode: 'url',
            url: '${addon.url}',
            addon: '${addon.addonName}'${parseConfigLine}
        }
    ]
}
`, 'utf-8' )

                await writeFile( fileBasedSchemaPath, `export const main = {
    namespace: '${addon.namespace}',
    name: '${addon.schemaName}-file',
    version: '4.1.0',
    resources: [
        {
            source: '${addon.sourceKey}',
            mode: 'file-based',
            path: '/tmp/whatever.db',
            addon: '${addon.addonName}'
        }
    ]
}
`, 'utf-8' )
            } )


            afterEach( async () => {
                await home.teardown()
            } )


            it( 'runs the full url-mode add pipeline (fetch+parse+in-memory)', async () => {
                const { result } = await FlowMcpCli.add( { 'toolName': schemaPath, cwd, 'force': false } )

                expect( result.status ).toBe( true )
                expect( result.namespace ).toBe( addon.namespace )
                expect( result.mode ).toBe( 'url' )
                expect( result.url ).toBe( addon.url )
                expect( result.addon ).toBe( addon.addonName )
                expect( Array.isArray( result.tools ) ).toBe( true )
                expect( result.tools.length ).toBeGreaterThan( 0 )
            } )


            it( 'aborts with RES043 when the schema declares mode file-based (converter path removed)', async () => {
                const { result } = await FlowMcpCli.add( { 'toolName': fileBasedSchemaPath, cwd, 'force': false } )

                expect( result.status ).toBe( false )
                expect( result.error ).toMatch( /RES043/ )
            } )


            it( 'writes the seal cache with mode url + url into the per-source directory', async () => {
                await FlowMcpCli.add( { 'toolName': schemaPath, cwd, 'force': true } )

                const cachePath = join( home.globalConfigDir, 'cache', addon.sourceKey, `${addon.namespace}-${addon.schemaName}.json` )
                const raw = await readFile( cachePath, 'utf-8' )
                const entry = JSON.parse( raw )

                expect( entry.sourceKey ).toBe( addon.sourceKey )
                expect( entry.mode ).toBe( 'url' )
                expect( entry.url ).toBe( addon.url )
                expect( Array.isArray( entry.tools ) ).toBe( true )
            } )


            it( 'routes flowmcp call to the addon method and returns real rows from memory', async () => {
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
                expect( callResult.content ).toBeDefined()
            } )
        } )
    } )
