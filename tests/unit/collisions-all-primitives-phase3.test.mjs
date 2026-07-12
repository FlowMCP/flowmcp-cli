import { describe, it, expect } from '@jest/globals'

import { CatalogIndex } from 'flowmcp'


// PRD-009 — collision tracking is extended from tools to ALL four primitives
// (resources / prompts / skills were last-wins before). The visible warning names
// the involved sources and the copyable "<source>:<spec-id>" fix.

function schemaEntry( { namespace, file, source, resources = {}, prompts = {}, skills = [] } ) {
    return {
        'main': {
            namespace,
            'name': `${namespace} API`,
            'version': '4.0.0',
            'tools': {},
            resources,
            prompts,
            skills
        },
        file,
        source
    }
}


describe( 'PRD-009 — resource collision', () => {
    it( 'two folders with the same resource produce a collision entry', async () => {
        const schemas = [
            schemaEntry( { 'namespace': 'gtfs', 'file': 'a.mjs', 'source': 'Dev', 'resources': { 'stops': {} } } ),
            schemaEntry( { 'namespace': 'gtfs', 'file': 'b.mjs', 'source': 'Prod', 'resources': { 'stops': {} } } )
        ]

        const { index } = await CatalogIndex.build( { schemas } )
        const collision = index[ 'collisions' ]
            .find( ( c ) => c[ 'specId' ] === 'gtfs/resource/stops' )

        expect( collision ).toBeDefined()
        expect( collision[ 'sources' ] ).toContain( 'Dev' )
        expect( collision[ 'sources' ] ).toContain( 'Prod' )
    } )
} )


describe( 'PRD-009 — prompt collision', () => {
    it( 'two folders with the same prompt produce a collision entry', async () => {
        const schemas = [
            schemaEntry( { 'namespace': 'core', 'file': 'a.mjs', 'source': 'Dev', 'prompts': { 'greet': {} } } ),
            schemaEntry( { 'namespace': 'core', 'file': 'b.mjs', 'source': 'Prod', 'prompts': { 'greet': {} } } )
        ]

        const { index } = await CatalogIndex.build( { schemas } )
        const collision = index[ 'collisions' ]
            .find( ( c ) => c[ 'specId' ] === 'core/prompt/greet' )

        expect( collision ).toBeDefined()
    } )
} )


describe( 'PRD-009 — skill collision', () => {
    it( 'two folders with the same skill name produce a collision entry', async () => {
        const schemas = [
            schemaEntry( { 'namespace': 'geo', 'file': 'a.mjs', 'source': 'Dev', 'skills': [ { 'name': 'lookup' } ] } ),
            schemaEntry( { 'namespace': 'geo', 'file': 'b.mjs', 'source': 'Prod', 'skills': [ { 'name': 'lookup' } ] } )
        ]

        const { index } = await CatalogIndex.build( { schemas } )
        const collision = index[ 'collisions' ]
            .find( ( c ) => c[ 'specId' ] === 'geo/skill/lookup' )

        expect( collision ).toBeDefined()
    } )

    it( 'a skill without a name is skipped (no crash)', async () => {
        const schemas = [
            schemaEntry( { 'namespace': 'geo', 'file': 'a.mjs', 'source': 'Dev', 'skills': [ {} ] } )
        ]

        const { index } = await CatalogIndex.build( { schemas } )

        expect( index[ 'collisions' ].length ).toBe( 0 )
    } )
} )


describe( 'PRD-009 — collision warning formatter', () => {
    it( 'returns [] when there are no collisions', () => {
        const { warnings } = CatalogIndex.formatCollisionWarnings( { 'collisions': [] } )

        expect( warnings ).toEqual( [] )
    } )

    it( 'names both sources and the copyable <source>:<spec-id> fix', () => {
        const collisions = [
            { 'specId': 'etherscan/tool/getBalance', 'files': [ 'a.mjs', 'b.mjs' ], 'sources': [ 'Development', 'Production' ] }
        ]

        const { warnings } = CatalogIndex.formatCollisionWarnings( { collisions } )

        expect( warnings.length ).toBe( 1 )
        expect( warnings[ 0 ][ 'message' ] ).toMatch( /etherscan\/tool\/getBalance/ )
        expect( warnings[ 0 ][ 'message' ] ).toMatch( /Development:etherscan\/tool\/getBalance/ )
        expect( warnings[ 0 ][ 'message' ] ).toMatch( /Production:etherscan\/tool\/getBalance/ )
    } )
} )
