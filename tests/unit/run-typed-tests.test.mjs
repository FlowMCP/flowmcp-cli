import { jest, describe, it, expect, beforeAll } from '@jest/globals'


// Mock the flowmcp facade so #executeTest tool + resource paths are deterministic.
// SkillValidator / SelectionValidator / MainValidator / MetaGenerator pass through
// to the real v4 modules (via the ./v4 alias) so validate paths are unaffected.
const { SkillValidator, SelectionValidator, MainValidator, MetaGenerator, CatalogIndex, IdResolver } = await import( 'flowmcp/v4' )

jest.unstable_mockModule( 'flowmcp', () => {
    return {
        SkillValidator,
        SelectionValidator,
        MainValidator,
        MetaGenerator,
        CatalogIndex,
        IdResolver,
        'FlowMCP': {
            'fetch': async ( { routeName, userParams } ) => {
                // Simulate failure for a special marker route
                if( routeName === 'shouldFail' ) {
                    return {
                        'status': false,
                        'messages': [ 'mock tool failure' ],
                        'dataAsString': null
                    }
                }

                return {
                    'status': true,
                    'messages': [],
                    'dataAsString': JSON.stringify( { routeName, userParams } )
                }
            },
            'executeResource': async ( { resourceName, queryName, userParams } ) => {
                if( queryName === 'failingQuery' ) {
                    return {
                        'struct': {
                            'status': false,
                            'messages': [ 'mock resource failure' ],
                            'data': null,
                            'dataAsString': null
                        }
                    }
                }

                return {
                    'struct': {
                        'status': true,
                        'messages': [],
                        'data': [ { resourceName, queryName, userParams } ],
                        'dataAsString': null
                    }
                }
            },
            // Unused by tests but referenced elsewhere in FlowMcpCli — keep as no-op stubs
            'createHandlers': () => {
                return { 'handlerMap': {}, 'resourceHandlerMap': {} }
            },
            'resolveSharedLists': async () => {
                return { 'sharedLists': {} }
            }
        }
    }
} )


const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


describe( 'PRD-005: #executeTest dispatcher + #runTypedTests aggregator', () => {
    describe( '#executeTest — primitive routing', () => {
        it( 'routes tool primitive to FlowMCP.fetch and returns PASS shape', async () => {
            const typedTest = {
                'primitive': 'tool',
                'name': 'getThing',
                'schemaRef': 'test/ns',
                'test': { '_description': 't', 'userParams': { 'id': '42' } },
                'context': { 'routeName': 'getThing' }
            }

            const result = await FlowMcpCli._testHook_executeTest( {
                typedTest,
                'schemaMain': { 'namespace': 'test/ns', 'tools': { 'getThing': {} } }
            } )

            expect( result[ 'primitive' ] ).toBe( 'tool' )
            expect( result[ 'status' ] ).toBe( true )
            expect( result[ 'error' ] ).toBe( null )
            expect( typeof result[ 'durationMs' ] ).toBe( 'number' )
            expect( result[ 'output' ] ).toContain( 'getThing' )
        } )


        it( 'maps tool failure (status false) to error message', async () => {
            const typedTest = {
                'primitive': 'tool',
                'name': 'shouldFail',
                'schemaRef': 'test/ns',
                'test': { '_description': 'fail', 'userParams': {} },
                'context': { 'routeName': 'shouldFail' }
            }

            const result = await FlowMcpCli._testHook_executeTest( {
                typedTest,
                'schemaMain': { 'namespace': 'test/ns', 'tools': { 'shouldFail': {} } }
            } )

            expect( result[ 'status' ] ).toBe( false )
            expect( result[ 'error' ] ).toBe( 'mock tool failure' )
            expect( result[ 'primitive' ] ).toBe( 'tool' )
        } )


        it( 'routes resource primitive to FlowMCP.executeResource and returns PASS', async () => {
            const typedTest = {
                'primitive': 'resource',
                'name': 'db1.searchA',
                'schemaRef': 'test/ns',
                'test': { '_description': 'r', 'userParams': { 'q': 'berlin' } },
                'context': { 'resourceName': 'db1', 'queryName': 'searchA' }
            }

            const schemaMain = {
                'namespace': 'test/ns',
                'resources': {
                    'db1': { 'queries': { 'searchA': {} } }
                }
            }

            const result = await FlowMcpCli._testHook_executeTest( {
                typedTest,
                schemaMain
            } )

            expect( result[ 'primitive' ] ).toBe( 'resource' )
            expect( result[ 'status' ] ).toBe( true )
            expect( result[ 'output' ] ).toContain( 'db1' )
        } )


        it( 'returns FAIL when resource not found in schema', async () => {
            const typedTest = {
                'primitive': 'resource',
                'name': 'missing.q',
                'schemaRef': 'test/ns',
                'test': { '_description': 'r', 'userParams': {} },
                'context': { 'resourceName': 'missing', 'queryName': 'q' }
            }

            const result = await FlowMcpCli._testHook_executeTest( {
                typedTest,
                'schemaMain': { 'namespace': 'test/ns', 'resources': {} }
            } )

            expect( result[ 'status' ] ).toBe( false )
            expect( result[ 'error' ] ).toContain( 'missing' )
        } )


        it( 'maps resource execution failure (struct.status=false) to error', async () => {
            const typedTest = {
                'primitive': 'resource',
                'name': 'db1.failingQuery',
                'schemaRef': 'test/ns',
                'test': { '_description': 'r', 'userParams': {} },
                'context': { 'resourceName': 'db1', 'queryName': 'failingQuery' }
            }

            const schemaMain = {
                'namespace': 'test/ns',
                'resources': { 'db1': { 'queries': { 'failingQuery': {} } } }
            }

            const result = await FlowMcpCli._testHook_executeTest( {
                typedTest,
                schemaMain
            } )

            expect( result[ 'status' ] ).toBe( false )
            expect( result[ 'error' ] ).toBe( 'mock resource failure' )
            expect( result[ 'primitive' ] ).toBe( 'resource' )
        } )


        it( 'skill primitive is validated structurally via the real v4 SkillValidator — valid passes', async () => {
            const typedTest = {
                'primitive': 'skill',
                'name': 'analyze',
                'schemaRef': 'test/ns',
                'test': { '_description': 's', 'userParams': {} },
                'context': { 'skill': { 'name': 'analyze', 'version': 'flowmcp/4.0.0', 'whenToUse': 'analysis', 'type': 'namespace', 'description': 'd', 'content': 'do', 'output': 'o' }, 'kind': 'structural' }
            }

            const result = await FlowMcpCli._testHook_executeTest( {
                typedTest,
                'schemaMain': { 'namespace': 'test/ns', 'tools': {}, 'resources': {} }
            } )

            expect( result[ 'primitive' ] ).toBe( 'skill' )
            expect( result[ 'status' ] ).toBe( true )
            expect( result[ 'output' ] ).toContain( 'skill-structural:analyze' )
        } )


        it( 'skill primitive fails structurally when required v4 fields are missing', async () => {
            const typedTest = {
                'primitive': 'skill',
                'name': 'analyze',
                'schemaRef': 'test/ns',
                'test': { '_description': 's', 'userParams': {} },
                'context': { 'skill': { 'name': 'analyze', 'content': '{{x}}' }, 'kind': 'structural' }
            }

            const result = await FlowMcpCli._testHook_executeTest( {
                typedTest,
                'schemaMain': { 'namespace': 'test/ns', 'tools': {}, 'resources': {} }
            } )

            expect( result[ 'primitive' ] ).toBe( 'skill' )
            expect( result[ 'status' ] ).toBe( false )
            expect( result[ 'error' ] ).not.toBeNull()
        } )


        it( 'prompt primitive passes the structural field check when it carries a string name', async () => {
            const typedTest = {
                'primitive': 'prompt',
                'name': 'p1',
                'schemaRef': 'test/ns',
                'test': { '_description': 'p', 'userParams': {} },
                'context': { 'prompt': { 'name': 'p1' } }
            }

            const result = await FlowMcpCli._testHook_executeTest( {
                typedTest,
                'schemaMain': { 'namespace': 'test/ns' }
            } )

            expect( result[ 'primitive' ] ).toBe( 'prompt' )
            expect( result[ 'status' ] ).toBe( true )
            expect( result[ 'output' ] ).toContain( 'prompt-structural:p1' )
        } )


        it( 'prompt primitive fails the structural field check without a string name', async () => {
            const typedTest = {
                'primitive': 'prompt',
                'name': 'p1',
                'schemaRef': 'test/ns',
                'test': { '_description': 'p', 'userParams': {} },
                'context': { 'prompt': { 'name': 99 } }
            }

            const result = await FlowMcpCli._testHook_executeTest( {
                typedTest,
                'schemaMain': { 'namespace': 'test/ns' }
            } )

            expect( result[ 'primitive' ] ).toBe( 'prompt' )
            expect( result[ 'status' ] ).toBe( false )
        } )


        it( 'selection-member primitive is validated structurally via the real v4 SelectionValidator — empty selection fails', async () => {
            const typedTest = {
                'primitive': 'selection-member',
                'name': 'frictiontest/tool/getThing',
                'schemaRef': 'test/ns/sel',
                'test': { '_description': 'sel', 'userParams': {} },
                'context': { 'memberId': 'frictiontest/tool/getThing', 'memberType': 'tool' }
            }

            const result = await FlowMcpCli._testHook_executeTest( {
                typedTest,
                'schemaMain': { 'namespace': 'test/ns/sel', 'selection': {} }
            } )

            expect( result[ 'primitive' ] ).toBe( 'selection-member' )
            expect( result[ 'status' ] ).toBe( false )
            expect( result[ 'output' ] ).toContain( 'selection-member:' )
        } )


        it( 'unknown primitive returns FAIL with descriptive error', async () => {
            const typedTest = {
                'primitive': 'bogus',
                'name': 'x',
                'schemaRef': 'test/ns',
                'test': { '_description': '', 'userParams': {} },
                'context': {}
            }

            const result = await FlowMcpCli._testHook_executeTest( {
                typedTest,
                'schemaMain': { 'namespace': 'test/ns' }
            } )

            expect( result[ 'status' ] ).toBe( false )
            expect( result[ 'error' ] ).toContain( 'unknown primitive' )
        } )


        it( 'all result objects contain status, error, output, durationMs, primitive — no undefined', async () => {
            const primitives = [ 'tool', 'resource', 'skill', 'prompt', 'selection-member' ]

            const checks = await primitives
                .reduce( ( p, prim ) => p.then( async ( acc ) => {
                    const typedTest = {
                        'primitive': prim,
                        'name': `${prim}-name`,
                        'schemaRef': 'test/ns',
                        'test': { '_description': '', 'userParams': {} },
                        'context': prim === 'tool'
                            ? { 'routeName': 'okRoute' }
                            : prim === 'resource'
                                ? { 'resourceName': 'db1', 'queryName': 'searchA' }
                                : prim === 'skill'
                                    ? { 'skill': { 'name': 'x', 'content': '' }, 'kind': 'structural' }
                                    : prim === 'prompt'
                                        ? { 'prompt': { 'name': 'p' } }
                                        : { 'memberId': 'a/tool/b', 'memberType': 'tool' }
                    }

                    const r = await FlowMcpCli._testHook_executeTest( {
                        typedTest,
                        'schemaMain': {
                            'namespace': 'test/ns',
                            'resources': { 'db1': { 'queries': { 'searchA': {} } } }
                        }
                    } )

                    acc.push( r )

                    return acc
                } ), Promise.resolve( [] ) )

            checks
                .forEach( ( r ) => {
                    expect( r[ 'status' ] ).toBeDefined()
                    expect( r ).toHaveProperty( 'error' )
                    expect( r ).toHaveProperty( 'output' )
                    expect( typeof r[ 'durationMs' ] ).toBe( 'number' )
                    expect( typeof r[ 'primitive' ] ).toBe( 'string' )
                } )
        } )
    } )


    describe( '#executeTest — output capture (preview vs full, JSON-mode fix)', () => {
        const bigPayload = 'x'.repeat( 500 )
        const typedTest = {
            'primitive': 'tool',
            'name': 'getThing',
            'schemaRef': 'test/ns',
            'test': { '_description': 'big', 'userParams': { 'big': bigPayload } },
            'context': { 'routeName': 'getThing' }
        }
        const schemaMain = { 'namespace': 'test/ns', 'tools': { 'getThing': {} } }


        it( 'truncates output to a 200-char preview by default (human/terminal mode)', async () => {
            const result = await FlowMcpCli._testHook_executeTest( {
                typedTest,
                schemaMain
            } )

            expect( result[ 'output' ].length ).toBe( 200 )
        } )


        it( 'returns the full, untruncated output when fullOutput=true (JSON mode)', async () => {
            const result = await FlowMcpCli._testHook_executeTest( {
                typedTest,
                schemaMain,
                'fullOutput': true
            } )

            expect( result[ 'output' ].length ).toBeGreaterThan( 200 )
            expect( result[ 'output' ] ).toContain( bigPayload )
        } )
    } )


    describe( '#runTypedTests — aggregation', () => {
        it( 'collects typed results + builds byPrimitive summary (all PASS)', async () => {
            const main = {
                'namespace': 'agg/ns',
                'tools': {
                    'getOne': { 'tests': [ { '_description': 't1', 'id': '1' } ] }
                },
                'resources': {
                    'db1': {
                        'queries': {
                            'searchA': { 'tests': [ { '_description': 'r1', 'q': 'x' } ] }
                        }
                    }
                },
                'skills': [
                    { 'name': 'sk', 'version': 'flowmcp/4.0.0', 'whenToUse': 'when testing', 'type': 'namespace', 'description': 'd', 'content': 'hello', 'output': 'o', 'tests': [ { '_description': 'sk-t' } ] }
                ],
                'prompts': [
                    { 'name': 'pr', 'tests': [ { '_description': 'pr-t' } ] }
                ]
            }

            const { results, summary } = await FlowMcpCli._testHook_runTypedTests( { main } )

            expect( results.length ).toBe( 4 )
            expect( summary[ 'overall' ] ).toBe( 'PASS' )
            expect( summary[ 'byPrimitive' ][ 'tool' ] ).toEqual( { 'pass': 1, 'fail': 0 } )
            expect( summary[ 'byPrimitive' ][ 'resource' ] ).toEqual( { 'pass': 1, 'fail': 0 } )
            expect( summary[ 'byPrimitive' ][ 'skill' ] ).toEqual( { 'pass': 1, 'fail': 0 } )
            expect( summary[ 'byPrimitive' ][ 'prompt' ] ).toEqual( { 'pass': 1, 'fail': 0 } )
        } )


        it( 'overall=FAIL when any single test fails', async () => {
            const main = {
                'namespace': 'agg/ns',
                'tools': {
                    'getOne': { 'tests': [ { '_description': 't1' } ] },
                    'shouldFail': { 'tests': [ { '_description': 'will fail' } ] }
                }
            }

            const { results, summary } = await FlowMcpCli._testHook_runTypedTests( { main } )

            expect( results.length ).toBe( 2 )
            expect( summary[ 'overall' ] ).toBe( 'FAIL' )
            expect( summary[ 'byPrimitive' ][ 'tool' ] ).toEqual( { 'pass': 1, 'fail': 1 } )
        } )


        it( 'each result entry carries primitive + name + schemaRef from typed test', async () => {
            const main = {
                'namespace': 'agg/ns',
                'tools': { 'getOne': { 'tests': [ { '_description': 't' } ] } }
            }

            const { results } = await FlowMcpCli._testHook_runTypedTests( { main } )

            const r = results[ 0 ]
            expect( r[ 'primitive' ] ).toBe( 'tool' )
            expect( r[ 'name' ] ).toBe( 'getOne' )
            expect( r[ 'schemaRef' ] ).toBe( 'agg/ns' )
        } )


        it( 'empty main produces zero results, overall PASS, empty byPrimitive', async () => {
            const { results, summary } = await FlowMcpCli._testHook_runTypedTests( {
                'main': { 'namespace': 'empty/ns' }
            } )

            expect( results.length ).toBe( 0 )
            expect( summary[ 'overall' ] ).toBe( 'PASS' )
            expect( summary[ 'byPrimitive' ] ).toEqual( {} )
        } )
    } )
} )
