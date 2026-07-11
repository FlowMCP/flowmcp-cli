import { describe, it, expect, beforeAll } from '@jest/globals'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import { seedInitializedGlobalConfig } from '../helpers/seed-home.mjs'


beforeAll( async () => {
    await seedInitializedGlobalConfig()
} )


describe( 'PRD-006: #validateOnlyFilter', () => {
    it( 'returns null filter when only is undefined', () => {
        const { filter, error } = FlowMcpCli._testHook_validateOnlyFilter( { 'only': undefined } )

        expect( filter ).toBe( null )
        expect( error ).toBe( null )
    } )


    it( 'returns null filter when only is empty string', () => {
        const { filter, error } = FlowMcpCli._testHook_validateOnlyFilter( { 'only': '' } )

        expect( filter ).toBe( null )
        expect( error ).toBe( null )
    } )


    it( 'maps "tools" to singular internal discriminator', () => {
        const { filter, error } = FlowMcpCli._testHook_validateOnlyFilter( { 'only': 'tools' } )

        expect( error ).toBe( null )
        expect( filter ).toEqual( [ 'tool' ] )
    } )


    it( 'handles comma-separated values', () => {
        const { filter, error } = FlowMcpCli._testHook_validateOnlyFilter( { 'only': 'tools,resources' } )

        expect( error ).toBe( null )
        expect( filter ).toEqual( [ 'tool', 'resource' ] )
    } )


    it( 'trims whitespace', () => {
        const { filter, error } = FlowMcpCli._testHook_validateOnlyFilter( { 'only': ' tools , resources ' } )

        expect( error ).toBe( null )
        expect( filter ).toEqual( [ 'tool', 'resource' ] )
    } )


    it( 'maps "selections" to "selection-member"', () => {
        const { filter, error } = FlowMcpCli._testHook_validateOnlyFilter( { 'only': 'selections' } )

        expect( error ).toBe( null )
        expect( filter ).toEqual( [ 'selection-member' ] )
    } )


    it( 'returns error for invalid value', () => {
        const { filter, error } = FlowMcpCli._testHook_validateOnlyFilter( { 'only': 'foo' } )

        expect( filter ).toBe( null )
        expect( error ).toContain( 'Invalid --only values: foo' )
        expect( error ).toContain( 'Allowed: tools, resources, skills, prompts, selections' )
    } )


    it( 'returns error listing all invalid values', () => {
        const { filter, error } = FlowMcpCli._testHook_validateOnlyFilter( { 'only': 'tools,foo,bar' } )

        expect( filter ).toBe( null )
        expect( error ).toContain( 'foo, bar' )
    } )
} )


describe( 'PRD-006: #computeDeclared', () => {
    it( 'detects tools as declared when present (even if empty object)', () => {
        const { declared } = FlowMcpCli._testHook_computeDeclared( {
            'main': { 'tools': {} }
        } )

        expect( declared[ 'tool' ] ).toBe( true )
        expect( declared[ 'resource' ] ).toBe( false )
        expect( declared[ 'skill' ] ).toBe( false )
        expect( declared[ 'prompt' ] ).toBe( false )
        expect( declared[ 'selection-member' ] ).toBe( false )
    } )


    it( 'accepts legacy "routes" key for tools', () => {
        const { declared } = FlowMcpCli._testHook_computeDeclared( {
            'main': { 'tools': {} }
        } )

        expect( declared[ 'tool' ] ).toBe( true )
    } )


    it( 'detects all primitives when all declared', () => {
        const { declared } = FlowMcpCli._testHook_computeDeclared( {
            'main': {
                'tools': {},
                'resources': {},
                'skills': [],
                'prompts': [],
                'selection': {}
            }
        } )

        expect( declared[ 'tool' ] ).toBe( true )
        expect( declared[ 'resource' ] ).toBe( true )
        expect( declared[ 'skill' ] ).toBe( true )
        expect( declared[ 'prompt' ] ).toBe( true )
        expect( declared[ 'selection-member' ] ).toBe( true )
    } )


    it( 'handles undefined main gracefully', () => {
        const { declared } = FlowMcpCli._testHook_computeDeclared( { 'main': undefined } )

        expect( declared[ 'tool' ] ).toBe( false )
        expect( declared[ 'resource' ] ).toBe( false )
    } )
} )


describe( 'PRD-006: #aggregateByPrimitive', () => {
    it( 'aggregates pass/fail per primitive', () => {
        const results = [
            { 'primitive': 'tool', 'status': true },
            { 'primitive': 'tool', 'status': true },
            { 'primitive': 'resource', 'status': true },
            { 'primitive': 'resource', 'status': false }
        ]
        const declared = { 'tool': true, 'resource': true, 'skill': false, 'prompt': false, 'selection-member': false }

        const { summary } = FlowMcpCli._testHook_aggregateByPrimitive( {
            results,
            declared,
            'filter': null
        } )

        expect( summary[ 'tool' ][ 'passed' ] ).toBe( 2 )
        expect( summary[ 'tool' ][ 'total' ] ).toBe( 2 )
        expect( summary[ 'tool' ][ 'declared' ] ).toBe( true )
        expect( summary[ 'tool' ][ 'filtered' ] ).toBe( false )
        expect( summary[ 'resource' ][ 'passed' ] ).toBe( 1 )
        expect( summary[ 'resource' ][ 'total' ] ).toBe( 2 )
    } )


    it( 'marks non-matching primitives as filtered when filter is set', () => {
        const declared = { 'tool': true, 'resource': true, 'skill': false, 'prompt': false, 'selection-member': false }

        const { summary } = FlowMcpCli._testHook_aggregateByPrimitive( {
            'results': [],
            declared,
            'filter': [ 'tool' ]
        } )

        expect( summary[ 'tool' ][ 'filtered' ] ).toBe( false )
        expect( summary[ 'resource' ][ 'filtered' ] ).toBe( true )
        expect( summary[ 'skill' ][ 'filtered' ] ).toBe( true )
    } )


    it( 'distinguishes "not declared" from "declared empty"', () => {
        const declared = { 'tool': true, 'resource': false, 'skill': false, 'prompt': false, 'selection-member': false }

        const { summary } = FlowMcpCli._testHook_aggregateByPrimitive( {
            'results': [],
            declared,
            'filter': null
        } )

        expect( summary[ 'tool' ][ 'declared' ] ).toBe( true )
        expect( summary[ 'tool' ][ 'total' ] ).toBe( 0 )
        expect( summary[ 'resource' ][ 'declared' ] ).toBe( false )
    } )


    it( 'handles undefined results without crashing', () => {
        const { summary } = FlowMcpCli._testHook_aggregateByPrimitive( {
            'results': undefined,
            'declared': undefined,
            'filter': null
        } )

        expect( summary[ 'tool' ][ 'total' ] ).toBe( 0 )
        expect( summary[ 'tool' ][ 'declared' ] ).toBe( false )
    } )
} )


// Memo 102 / PRD-002 — the invalid --only check migrated from "dev test" onto
// "grading deterministic". The #validateOnlyFilter allowlist is reused, so the
// same error message surfaces (no duplication). The exit-code-1 mapping was a
// dev-test-specific detail and is not part of the deterministic single-mode.
describe( 'PRD-002: invalid --only on grading deterministic', () => {
    it( 'returns the #validateOnlyFilter error for an invalid --only value', async () => {
        const { result } = await FlowMcpCli.gradingDeterministic( {
            'cwd': '/tmp',
            'target': 'demoapi/demoapi',
            'gradingDataDir': '.flowmcp/grading',
            'withKeys': false,
            'only': 'invalidPrimitive',
            'json': false
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Invalid --only values' )
        expect( result[ 'error' ] ).toContain( 'invalidPrimitive' )
    } )
} )
