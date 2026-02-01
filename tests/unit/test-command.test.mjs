import { describe, it, expect } from '@jest/globals'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


describe( 'FlowMcpCli.test', () => {
    it( 'returns error when schemaPath is missing', async () => {
        const { result } = await FlowMcpCli.test( { schemaPath: undefined, route: undefined, cwd: '/tmp' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'messages' ] ).toBeDefined()
        expect( result[ 'messages' ].length ).toBeGreaterThan( 0 )
    } )


    it( 'returns error when not initialized', async () => {
        const { result } = await FlowMcpCli.test( {
            schemaPath: './some-schema.mjs',
            route: undefined,
            cwd: '/tmp/nonexistent-project-12345'
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toBeDefined()
    } )
} )
