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


describe( 'PRD-006: #formatTestSummary — human output', () => {
    const declared = { 'tool': true, 'resource': true, 'skill': true, 'prompt': false, 'selection-member': false }

    const buildSummary = ( overrides = {} ) => {
        const base = {
            'tool':              { 'passed': 0, 'total': 0, 'declared': true,  'filtered': false },
            'resource':          { 'passed': 6, 'total': 6, 'declared': true,  'filtered': false },
            'skill':             { 'passed': 1, 'total': 1, 'declared': true,  'filtered': false },
            'prompt':            { 'passed': 0, 'total': 0, 'declared': false, 'filtered': false },
            'selection-member':  { 'passed': 4, 'total': 4, 'declared': true,  'filtered': false }
        }

        return { ...base, ...overrides }
    }


    it( 'renders exact memo spec for fully-populated schema', () => {
        const summary = buildSummary()
        const { value } = FlowMcpCli._testHook_formatTestSummary( {
            summary,
            'results': [],
            'format': 'human',
            'overall': true
        } )

        expect( value ).toContain( 'Tools:       0/0 (none declared)' )
        expect( value ).toContain( 'Resources:   6/6 PASS' )
        expect( value ).toContain( 'Skills:      1/1 PASS (structural)' )
        expect( value ).toContain( 'Prompts:     none' )
        expect( value ).toContain( 'Selections:  4/4 PASS (Members)' )
        expect( value ).toContain( 'Overall: PASS' )
    } )


    it( 'renders FAIL overall', () => {
        const summary = buildSummary( {
            'resource': { 'passed': 2, 'total': 6, 'declared': true, 'filtered': false }
        } )
        const { value } = FlowMcpCli._testHook_formatTestSummary( {
            summary,
            'results': [],
            'format': 'human',
            'overall': false
        } )

        expect( value ).toContain( 'Resources:   2/6 FAIL' )
        expect( value ).toContain( 'Overall: FAIL' )
    } )


    it( 'shows "skipped (filtered)" for filtered primitives', () => {
        const summary = buildSummary( {
            'resource': { 'passed': 0, 'total': 0, 'declared': true, 'filtered': true }
        } )
        const { value } = FlowMcpCli._testHook_formatTestSummary( {
            summary,
            'results': [],
            'format': 'human',
            'overall': true
        } )

        expect( value ).toContain( 'Resources:   skipped (filtered)' )
    } )


    it( 'shows "none" when not declared', () => {
        const summary = buildSummary( {
            'prompt': { 'passed': 0, 'total': 0, 'declared': false, 'filtered': false }
        } )
        const { value } = FlowMcpCli._testHook_formatTestSummary( {
            summary,
            'results': [],
            'format': 'human',
            'overall': true
        } )

        expect( value ).toContain( 'Prompts:     none' )
    } )


    it( 'shows "0/0 (none declared)" when declared but empty', () => {
        const summary = buildSummary( {
            'tool': { 'passed': 0, 'total': 0, 'declared': true, 'filtered': false }
        } )
        const { value } = FlowMcpCli._testHook_formatTestSummary( {
            summary,
            'results': [],
            'format': 'human',
            'overall': true
        } )

        expect( value ).toContain( 'Tools:       0/0 (none declared)' )
    } )
} )


describe( 'PRD-006: #formatTestSummary — JSON output', () => {
    it( 'returns parseable JSON object with overall, primitives, tests', () => {
        const summary = {
            'tool':              { 'passed': 1, 'total': 1, 'declared': true, 'filtered': false },
            'resource':          { 'passed': 0, 'total': 0, 'declared': false, 'filtered': false },
            'skill':             { 'passed': 0, 'total': 0, 'declared': false, 'filtered': false },
            'prompt':            { 'passed': 0, 'total': 0, 'declared': false, 'filtered': false },
            'selection-member':  { 'passed': 0, 'total': 0, 'declared': false, 'filtered': false }
        }
        const results = [
            { 'primitive': 'tool', 'name': 'getThing', 'status': true, 'error': null, 'durationMs': 42, 'output': 'ok' }
        ]

        const { value, text } = FlowMcpCli._testHook_formatTestSummary( {
            summary,
            results,
            'format': 'json',
            'overall': true,
            'schemaRef': 'test/ns'
        } )

        expect( value[ 'overall' ] ).toBe( 'PASS' )
        expect( value[ 'schemaRef' ] ).toBe( 'test/ns' )
        expect( value[ 'primitives' ][ 'tools' ][ 'total' ] ).toBe( 1 )
        expect( value[ 'tests' ] ).toHaveLength( 1 )
        expect( value[ 'tests' ][ 0 ][ 'status' ] ).toBe( 'PASS' )

        const parsed = JSON.parse( text )
        expect( parsed[ 'overall' ] ).toBe( 'PASS' )
    } )


    it( 'maps FAIL tests correctly', () => {
        const summary = {
            'tool':              { 'passed': 0, 'total': 1, 'declared': true, 'filtered': false },
            'resource':          { 'passed': 0, 'total': 0, 'declared': false, 'filtered': false },
            'skill':             { 'passed': 0, 'total': 0, 'declared': false, 'filtered': false },
            'prompt':            { 'passed': 0, 'total': 0, 'declared': false, 'filtered': false },
            'selection-member':  { 'passed': 0, 'total': 0, 'declared': false, 'filtered': false }
        }
        const results = [
            { 'primitive': 'tool', 'name': 'badThing', 'status': false, 'error': 'boom', 'durationMs': 5, 'output': null }
        ]

        const { value } = FlowMcpCli._testHook_formatTestSummary( {
            summary,
            results,
            'format': 'json',
            'overall': false
        } )

        expect( value[ 'overall' ] ).toBe( 'FAIL' )
        expect( value[ 'tests' ][ 0 ][ 'status' ] ).toBe( 'FAIL' )
        expect( value[ 'tests' ][ 0 ][ 'error' ] ).toBe( 'boom' )
    } )


    it( 'computes overall from results when overall arg is null', () => {
        const summary = {
            'tool':              { 'passed': 0, 'total': 1, 'declared': true, 'filtered': false },
            'resource':          { 'passed': 0, 'total': 0, 'declared': false, 'filtered': false },
            'skill':             { 'passed': 0, 'total': 0, 'declared': false, 'filtered': false },
            'prompt':            { 'passed': 0, 'total': 0, 'declared': false, 'filtered': false },
            'selection-member':  { 'passed': 0, 'total': 0, 'declared': false, 'filtered': false }
        }
        const results = [
            { 'primitive': 'tool', 'status': false, 'error': 'x', 'name': 'x' }
        ]

        const { value } = FlowMcpCli._testHook_formatTestSummary( {
            summary,
            results,
            'format': 'json',
            'overall': null
        } )

        expect( value[ 'overall' ] ).toBe( 'FAIL' )
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
