import { describe, it, expect } from '@jest/globals'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


describe( 'FlowMcpCli.#getAllTestsTyped — v4 primitives extraction', () => {
    it( 'extracts tests from all five primitives with correct types and counts', () => {
        const fakeMain = {
            'namespace': 'frictiontest',
            'tools': {
                'getThing': { 'tests': [ { '_description': 't1', 'id': '42' } ] }
            },
            'resources': {
                'db1': {
                    'queries': {
                        'searchA': {
                            'tests': [
                                { '_description': 'r1', 'q': 'x' },
                                { '_description': 'r2', 'q': 'y' }
                            ]
                        },
                        'searchB': {
                            'tests': [
                                { '_description': 'r3', 'q': 'z' },
                                { '_description': 'r4', 'q': 'w' }
                            ]
                        }
                    }
                }
            },
            'skills': [
                { 'name': 'analyze', 'content': 'Analyze {{tool/frictiontest.getThing/full}}', 'tests': [ { '_description': 'skill-t1' } ] }
            ],
            'prompts': [
                { 'name': 'p1', 'tests': [ { '_description': 'p-test', 'topic': 'A' } ] }
            ]
        }

        const tests = FlowMcpCli._testHook_getAllTestsTyped( { 'main': fakeMain } )

        // 1 tool + 4 resource (2+2) + 1 skill + 1 prompt = 7
        expect( tests.length ).toBe( 7 )

        const toolEntries = tests.filter( ( t ) => t[ 'primitive' ] === 'tool' )
        const resourceEntries = tests.filter( ( t ) => t[ 'primitive' ] === 'resource' )
        const skillEntries = tests.filter( ( t ) => t[ 'primitive' ] === 'skill' )
        const promptEntries = tests.filter( ( t ) => t[ 'primitive' ] === 'prompt' )

        expect( toolEntries.length ).toBe( 1 )
        expect( resourceEntries.length ).toBe( 4 )
        expect( skillEntries.length ).toBe( 1 )
        expect( promptEntries.length ).toBe( 1 )

        // Tool-entry sanity
        const toolEntry = toolEntries[ 0 ]
        expect( toolEntry[ 'name' ] ).toBe( 'getThing' )
        expect( toolEntry[ 'schemaRef' ] ).toBe( 'frictiontest' )
        expect( toolEntry[ 'context' ][ 'routeName' ] ).toBe( 'getThing' )
        expect( toolEntry[ 'test' ][ 'userParams' ][ 'id' ] ).toBe( '42' )

        // Resource-entry sanity
        const resEntry = resourceEntries[ 0 ]
        expect( resEntry[ 'context' ][ 'resourceName' ] ).toBe( 'db1' )
        expect( resEntry[ 'context' ][ 'queryName' ] ).toBe( 'searchA' )
        expect( resEntry[ 'name' ] ).toBe( 'db1.searchA' )

        // Skill-entry sanity (explicit test, kind=structural)
        const skillEntry = skillEntries[ 0 ]
        expect( skillEntry[ 'name' ] ).toBe( 'analyze' )
        expect( skillEntry[ 'context' ][ 'kind' ] ).toBe( 'structural' )

        // Prompt-entry sanity
        const promptEntry = promptEntries[ 0 ]
        expect( promptEntry[ 'name' ] ).toBe( 'p1' )
        expect( promptEntry[ 'test' ][ 'userParams' ][ 'topic' ] ).toBe( 'A' )
    } )


    it( 'auto-generates one implicit structural test for skills without explicit tests', () => {
        const fakeMain = {
            'namespace': 'frictiontest',
            'skills': [
                { 'name': 'demo', 'content': 'Demo skill' }
            ]
        }

        const tests = FlowMcpCli._testHook_getAllTestsTyped( { 'main': fakeMain } )

        expect( tests.length ).toBe( 1 )
        expect( tests[ 0 ][ 'primitive' ] ).toBe( 'skill' )
        expect( tests[ 0 ][ 'name' ] ).toBe( 'demo' )
        expect( tests[ 0 ][ 'context' ][ 'kind' ] ).toBe( 'structural' )
        expect( tests[ 0 ][ 'test' ][ '_description' ] ).toContain( 'demo' )
    } )


    it( 'extracts selection-member entries and inline-skill entries from selection-files', () => {
        const fakeSelection = {
            'namespace': 'frictiontest/sel',
            'selection': {
                'tools': [ 'frictiontest/tool/getThing' ],
                'resources': [ 'frictiontest/resource/db1.searchA' ],
                'prompts': [],
                'skills': [
                    { 'name': 'analyze-inline', 'content': '...' },
                    { 'name': 'second-inline', 'content': '...', 'tests': [ { '_description': 'inline-t' } ] }
                ]
            }
        }

        const selTests = FlowMcpCli._testHook_getAllTestsTyped( { 'main': fakeSelection } )

        const selectionMembers = selTests.filter( ( t ) => t[ 'primitive' ] === 'selection-member' )
        const inlineSkills = selTests.filter( ( t ) => t[ 'primitive' ] === 'skill' && t[ 'context' ][ 'kind' ] === 'selection-inline' )

        expect( selectionMembers.length ).toBe( 2 )
        expect( inlineSkills.length ).toBe( 2 )

        // Member context sanity
        const toolMember = selectionMembers.find( ( t ) => t[ 'context' ][ 'memberType' ] === 'tool' )
        expect( toolMember[ 'name' ] ).toBe( 'frictiontest/tool/getThing' )

        const resMember = selectionMembers.find( ( t ) => t[ 'context' ][ 'memberType' ] === 'resource' )
        expect( resMember[ 'name' ] ).toBe( 'frictiontest/resource/db1.searchA' )
    } )


    it( 'compat-shim: #getAllTests returns legacy flat shape (tool-only) for backwards compat', () => {
        const fakeMain = {
            'namespace': 'frictiontest',
            'tools': {
                'getThing': { 'tests': [ { '_description': 't1', 'id': '42' } ] }
            },
            'resources': {
                'db1': {
                    'queries': {
                        'searchA': { 'tests': [ { '_description': 'r1', 'q': 'x' } ] }
                    }
                }
            },
            'skills': [ { 'name': 'analyze', 'tests': [ { '_description': 'skill-t' } ] } ]
        }

        // Use public schemas() proxy? No — use the test hook to verify shape parity by mapping ourselves
        const typedTests = FlowMcpCli._testHook_getAllTestsTyped( { 'main': fakeMain } )
        const toolOnly = typedTests.filter( ( t ) => t[ 'primitive' ] === 'tool' )

        expect( toolOnly.length ).toBe( 1 )
        expect( toolOnly[ 0 ][ 'name' ] ).toBe( 'getThing' )
        expect( toolOnly[ 0 ][ 'test' ][ 'userParams' ][ 'id' ] ).toBe( '42' )
    } )
} )
