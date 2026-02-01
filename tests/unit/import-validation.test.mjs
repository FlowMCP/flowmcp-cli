import { describe, it, expect } from '@jest/globals'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import { VALID_GITHUB_URL } from '../helpers/config.mjs'


describe( 'FlowMcpCli.validationImport', () => {
    it( 'rejects missing url', () => {
        const { status, messages } = FlowMcpCli.validationImport( { url: undefined } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'url' )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'rejects null url', () => {
        const { status, messages } = FlowMcpCli.validationImport( { url: null } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'rejects non-string url', () => {
        const { status, messages } = FlowMcpCli.validationImport( { url: 123 } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'rejects non-github url', () => {
        const { status, messages } = FlowMcpCli.validationImport( { url: 'https://gitlab.com/some/repo' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 1 )
        expect( messages[ 0 ] ).toContain( 'GitHub repository URL' )
    } )


    it( 'accepts valid github url', () => {
        const { status, messages } = FlowMcpCli.validationImport( { url: VALID_GITHUB_URL } )

        expect( status ).toBe( true )
        expect( messages.length ).toBe( 0 )
    } )


    it( 'accepts github url with .git suffix', () => {
        const { status, messages } = FlowMcpCli.validationImport( { url: `${VALID_GITHUB_URL}.git` } )

        expect( status ).toBe( true )
        expect( messages.length ).toBe( 0 )
    } )
} )
