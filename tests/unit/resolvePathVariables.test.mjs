import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import os from 'node:os'
import path from 'node:path'

import { PathVariableResolver } from '../../src/path/resolvePathVariables.mjs'


describe( 'PathVariableResolver.resolvePathVariables', () => {
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


    it( 'resolves ${FLOWMCP_RESOURCES} from env when set', () => {
        process.env.FLOWMCP_RESOURCES = '/tmp/custom-resources'
        const result = PathVariableResolver.resolvePathVariables( { path: '${FLOWMCP_RESOURCES}/gtfs-de.db' } )

        expect( result.source ).toBe( 'env' )
        expect( result.isDefault ).toBe( false )
        expect( result.resolvedPath ).toBe( path.resolve( '/tmp/custom-resources/gtfs-de.db' ) )
    } )


    it( 'falls back to default ~/.flowmcp/resources when env is unset', () => {
        const result = PathVariableResolver.resolvePathVariables( { path: '${FLOWMCP_RESOURCES}/gtfs-de.db' } )

        expect( result.source ).toBe( 'default' )
        expect( result.isDefault ).toBe( true )
        const expected = path.resolve( path.join( os.homedir(), '.flowmcp', 'resources', 'gtfs-de.db' ) )
        expect( result.resolvedPath ).toBe( expected )
    } )


    it( 'expands tilde prefix via os.homedir()', () => {
        const result = PathVariableResolver.resolvePathVariables( { path: '~/foo.db' } )

        expect( result.source ).toBe( 'home' )
        expect( result.isDefault ).toBe( false )
        expect( result.resolvedPath ).toBe( path.resolve( path.join( os.homedir(), 'foo.db' ) ) )
    } )


    it( 'returns literal path when no variables are present', () => {
        const result = PathVariableResolver.resolvePathVariables( { path: '/abs/foo.db' } )

        expect( result.source ).toBe( 'literal' )
        expect( result.isDefault ).toBe( false )
        expect( result.resolvedPath ).toBe( path.resolve( '/abs/foo.db' ) )
    } )


    it( 'throws RES035 on unknown FlowMCP variable', () => {
        expect( () => PathVariableResolver.resolvePathVariables( { path: '${FLOWMCP_XYZ}/foo' } ) )
            .toThrow( /RES035/ )
    } )


    it( 'expands ${HOME} as alternative to tilde', () => {
        const result = PathVariableResolver.resolvePathVariables( { path: '${HOME}/foo.db' } )

        expect( result.source ).toBe( 'home' )
        expect( result.resolvedPath ).toBe( path.resolve( path.join( os.homedir(), 'foo.db' ) ) )
    } )


    it( 'throws on missing path', () => {
        expect( () => PathVariableResolver.resolvePathVariables( { } ) )
            .toThrow( /required/ )
    } )


    it( 'throws on non-string path', () => {
        expect( () => PathVariableResolver.resolvePathVariables( { path: 123 } ) )
            .toThrow( /must be a string/ )
    } )


    it( 'throws on empty path', () => {
        expect( () => PathVariableResolver.resolvePathVariables( { path: '' } ) )
            .toThrow( /must not be empty/ )
    } )
} )
