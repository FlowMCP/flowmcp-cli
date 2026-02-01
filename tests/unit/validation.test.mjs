import { describe, it, expect } from '@jest/globals'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


describe( 'FlowMcpCli.validationValidate', () => {
    it( 'rejects missing schemaPath', () => {
        const { status, messages } = FlowMcpCli.validationValidate( { schemaPath: undefined } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'schemaPath' )
    } )


    it( 'rejects null schemaPath', () => {
        const { status, messages } = FlowMcpCli.validationValidate( { schemaPath: null } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'rejects non-string schemaPath', () => {
        const { status, messages } = FlowMcpCli.validationValidate( { schemaPath: 123 } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'accepts valid string schemaPath', () => {
        const { status, messages } = FlowMcpCli.validationValidate( { schemaPath: './schemas/test.mjs' } )

        expect( status ).toBe( true )
        expect( messages.length ).toBe( 0 )
    } )
} )


describe( 'FlowMcpCli.validationTest', () => {
    it( 'rejects missing schemaPath', () => {
        const { status, messages } = FlowMcpCli.validationTest( { schemaPath: undefined } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'schemaPath' )
    } )


    it( 'rejects null schemaPath', () => {
        const { status, messages } = FlowMcpCli.validationTest( { schemaPath: null } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'rejects non-string schemaPath', () => {
        const { status, messages } = FlowMcpCli.validationTest( { schemaPath: 42 } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'accepts valid string schemaPath', () => {
        const { status, messages } = FlowMcpCli.validationTest( { schemaPath: '/path/to/schema.mjs' } )

        expect( status ).toBe( true )
        expect( messages.length ).toBe( 0 )
    } )
} )


describe( 'FlowMcpCli.validationImport', () => {
    it( 'rejects missing url', () => {
        const { status, messages } = FlowMcpCli.validationImport( { url: undefined } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'rejects non-github url', () => {
        const { status, messages } = FlowMcpCli.validationImport( { url: 'https://gitlab.com/test/repo' } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( 'GitHub' )
    } )


    it( 'accepts valid github url', () => {
        const { status, messages } = FlowMcpCli.validationImport( { url: 'https://github.com/flowmcp/flowMCP-schemas' } )

        expect( status ).toBe( true )
        expect( messages.length ).toBe( 0 )
    } )
} )


describe( 'FlowMcpCli.validationGroupAppend', () => {
    it( 'rejects missing name', () => {
        const { status, messages } = FlowMcpCli.validationGroupAppend( { name: undefined, tools: 'demo/ping.mjs' } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'rejects empty name', () => {
        const { status, messages } = FlowMcpCli.validationGroupAppend( { name: '  ', tools: 'demo/ping.mjs' } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( 'Must not be empty' )
    } )


    it( 'accepts valid name and tools', () => {
        const { status, messages } = FlowMcpCli.validationGroupAppend( { name: 'test-group', tools: 'demo/ping.mjs' } )

        expect( status ).toBe( true )
        expect( messages.length ).toBe( 0 )
    } )
} )


describe( 'FlowMcpCli.validationGroupSetDefault', () => {
    it( 'rejects missing name', () => {
        const { status, messages } = FlowMcpCli.validationGroupSetDefault( { name: undefined } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'rejects empty name', () => {
        const { status, messages } = FlowMcpCli.validationGroupSetDefault( { name: '' } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( 'Must not be empty' )
    } )


    it( 'accepts valid name', () => {
        const { status, messages } = FlowMcpCli.validationGroupSetDefault( { name: 'my-group' } )

        expect( status ).toBe( true )
        expect( messages.length ).toBe( 0 )
    } )
} )
