import { describe, it, expect } from '@jest/globals'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'



describe( 'FlowMcpCli.validationPromptAdd — non-string branches', () => {
    it( 'rejects non-string group', () => {
        const { status, messages } = FlowMcpCli.validationPromptAdd( { group: 42, name: 'test-prompt', file: 'test.md' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'rejects non-string name', () => {
        const { status, messages } = FlowMcpCli.validationPromptAdd( { group: 'test-group', name: 42, file: 'test.md' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'rejects empty name', () => {
        const { status, messages } = FlowMcpCli.validationPromptAdd( { group: 'test-group', name: '', file: 'test.md' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must not be empty' )
    } )


    it( 'rejects non-string file', () => {
        const { status, messages } = FlowMcpCli.validationPromptAdd( { group: 'test-group', name: 'test-prompt', file: 42 } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'rejects empty file', () => {
        const { status, messages } = FlowMcpCli.validationPromptAdd( { group: 'test-group', name: 'test-prompt', file: '' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must not be empty' )
    } )
} )


describe( 'FlowMcpCli.validationPromptRemove — non-string branches', () => {
    it( 'rejects non-string group', () => {
        const { status, messages } = FlowMcpCli.validationPromptRemove( { group: 42, name: 'test-prompt' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'rejects empty group', () => {
        const { status, messages } = FlowMcpCli.validationPromptRemove( { group: '', name: 'test-prompt' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must not be empty' )
    } )


    it( 'rejects non-string name', () => {
        const { status, messages } = FlowMcpCli.validationPromptRemove( { group: 'test-group', name: 42 } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'rejects empty name', () => {
        const { status, messages } = FlowMcpCli.validationPromptRemove( { group: 'test-group', name: '' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must not be empty' )
    } )
} )


describe( 'FlowMcpCli.validationPromptShow — non-string branches', () => {
    it( 'rejects non-string group', () => {
        const { status, messages } = FlowMcpCli.validationPromptShow( { group: 42, name: 'test-prompt' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'rejects empty group', () => {
        const { status, messages } = FlowMcpCli.validationPromptShow( { group: '', name: 'test-prompt' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must not be empty' )
    } )


    it( 'rejects non-string name', () => {
        const { status, messages } = FlowMcpCli.validationPromptShow( { group: 'test-group', name: 42 } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'rejects empty name', () => {
        const { status, messages } = FlowMcpCli.validationPromptShow( { group: 'test-group', name: '' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must not be empty' )
    } )
} )


describe( 'FlowMcpCli.validationPromptSearch — non-string branches', () => {
    it( 'rejects non-string query', () => {
        const { status, messages } = FlowMcpCli.validationPromptSearch( { query: 42 } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )
} )


