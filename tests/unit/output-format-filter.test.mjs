import { describe, it, expect, beforeAll } from '@jest/globals'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import { GradingDeterministic } from '../../src/commands/grading/GradingDeterministic.mjs'
import { seedInitializedGlobalConfig } from '../helpers/seed-home.mjs'


beforeAll( async () => {
    await seedInitializedGlobalConfig()
} )


describe( 'PRD-006: #validateOnlyFilter', () => {
    it( 'returns null filter when only is undefined', () => {
        const { filter, error } = GradingDeterministic.validateOnlyFilter( { 'only': undefined } )

        expect( filter ).toBe( null )
        expect( error ).toBe( null )
    } )


    it( 'returns null filter when only is empty string', () => {
        const { filter, error } = GradingDeterministic.validateOnlyFilter( { 'only': '' } )

        expect( filter ).toBe( null )
        expect( error ).toBe( null )
    } )


    it( 'maps "tools" to singular internal discriminator', () => {
        const { filter, error } = GradingDeterministic.validateOnlyFilter( { 'only': 'tools' } )

        expect( error ).toBe( null )
        expect( filter ).toEqual( [ 'tool' ] )
    } )


    it( 'handles comma-separated values', () => {
        const { filter, error } = GradingDeterministic.validateOnlyFilter( { 'only': 'tools,resources' } )

        expect( error ).toBe( null )
        expect( filter ).toEqual( [ 'tool', 'resource' ] )
    } )


    it( 'trims whitespace', () => {
        const { filter, error } = GradingDeterministic.validateOnlyFilter( { 'only': ' tools , resources ' } )

        expect( error ).toBe( null )
        expect( filter ).toEqual( [ 'tool', 'resource' ] )
    } )


    it( 'maps "selections" to "selection-member"', () => {
        const { filter, error } = GradingDeterministic.validateOnlyFilter( { 'only': 'selections' } )

        expect( error ).toBe( null )
        expect( filter ).toEqual( [ 'selection-member' ] )
    } )


    it( 'returns error for invalid value', () => {
        const { filter, error } = GradingDeterministic.validateOnlyFilter( { 'only': 'foo' } )

        expect( filter ).toBe( null )
        expect( error ).toContain( 'Invalid --only values: foo' )
        expect( error ).toContain( 'Allowed: tools, resources, skills, prompts, selections' )
    } )


    it( 'returns error listing all invalid values', () => {
        const { filter, error } = GradingDeterministic.validateOnlyFilter( { 'only': 'tools,foo,bar' } )

        expect( filter ).toBe( null )
        expect( error ).toContain( 'foo, bar' )
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
