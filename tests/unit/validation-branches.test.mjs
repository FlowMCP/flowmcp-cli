import { describe, it, expect } from '@jest/globals'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


describe( 'FlowMcpCli.validationGroupAppend — non-string branches', () => {
    it( 'rejects non-string name', () => {
        const { status, messages } = FlowMcpCli.validationGroupAppend( { name: 42, tools: 'demo/ping.mjs' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'rejects non-string tools', () => {
        const { status, messages } = FlowMcpCli.validationGroupAppend( { name: 'valid-group', tools: 42 } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'rejects empty tools', () => {
        const { status, messages } = FlowMcpCli.validationGroupAppend( { name: 'valid-group', tools: '' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must not be empty' )
    } )
} )


describe( 'FlowMcpCli.validationGroupRemove — non-string branches', () => {
    it( 'rejects non-string name', () => {
        const { status, messages } = FlowMcpCli.validationGroupRemove( { name: 42, tools: 'demo/ping.mjs' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'rejects empty name', () => {
        const { status, messages } = FlowMcpCli.validationGroupRemove( { name: '', tools: 'demo/ping.mjs' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must not be empty' )
    } )


    it( 'rejects non-string tools', () => {
        const { status, messages } = FlowMcpCli.validationGroupRemove( { name: 'valid-group', tools: 42 } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'rejects empty tools', () => {
        const { status, messages } = FlowMcpCli.validationGroupRemove( { name: 'valid-group', tools: '' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must not be empty' )
    } )
} )


describe( 'FlowMcpCli.validationGroupSetDefault — non-string branches', () => {
    it( 'rejects non-string name', () => {
        const { status, messages } = FlowMcpCli.validationGroupSetDefault( { name: 42 } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )
} )


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


describe( 'FlowMcpCli.validationImport — non-string branches', () => {
    it( 'rejects non-string url', () => {
        const { status, messages } = FlowMcpCli.validationImport( { url: 42 } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'rejects null url', () => {
        const { status, messages } = FlowMcpCli.validationImport( { url: null } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )
} )


describe( 'FlowMcpCli.validationImportRegistry — empty string branch', () => {
    it( 'rejects empty string registryUrl as invalid protocol', () => {
        const { status, messages } = FlowMcpCli.validationImportRegistry( { registryUrl: '' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'URL' )
    } )
} )
