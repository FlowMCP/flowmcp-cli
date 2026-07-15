import { describe, test, expect } from '@jest/globals'

import { ServeCommand } from '../../src/commands/ServeCommand.mjs'


// Memo 157 Kap 2 / PRD-03 — a served resource query must carry a real Zod input schema
// built from its `parameters` (was an empty `{}`). ServeCommand.buildResourceQueryZod is the
// single source for that shape; it reuses the core ZodBuilder the tool path uses.
describe( 'ServeCommand.buildResourceQueryZod', () => {
    test( 'builds a real zod shape from query parameters (not empty)', () => {
        const queryDef = {
            parameters: [
                { position: { key: 'keyword', value: '{{USER_PARAM}}' }, z: { primitive: 'string()', options: [ 'min(1)' ] } },
                { position: { key: 'limit', value: '{{USER_PARAM}}' }, z: { primitive: 'number()', options: [ 'min(1)', 'max(100)', 'default(20)' ] } }
            ]
        }

        const zod = ServeCommand.buildResourceQueryZod( { queryDef } )

        expect( Object.keys( zod ).sort() ).toEqual( [ 'keyword', 'limit' ] )
        expect( typeof zod[ 'keyword' ][ 'parse' ] ).toBe( 'function' )
        expect( typeof zod[ 'limit' ][ 'parse' ] ).toBe( 'function' )
    } )


    test( 'the built zod actually validates matching input', () => {
        const queryDef = {
            parameters: [
                { position: { key: 'keyword', value: '{{USER_PARAM}}' }, z: { primitive: 'string()', options: [ 'min(1)' ] } }
            ]
        }

        const zod = ServeCommand.buildResourceQueryZod( { queryDef } )

        expect( zod[ 'keyword' ].parse( 'ethereum' ) ).toBe( 'ethereum' )
        expect( () => zod[ 'keyword' ].parse( '' ) ).toThrow()
    } )


    test( 'returns an empty object for a query with no parameters', () => {
        expect( ServeCommand.buildResourceQueryZod( { queryDef: { parameters: [] } } ) ).toEqual( {} )
        expect( ServeCommand.buildResourceQueryZod( { queryDef: {} } ) ).toEqual( {} )
    } )
} )
