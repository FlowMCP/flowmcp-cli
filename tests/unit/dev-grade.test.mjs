import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import { writeFile, mkdir, rm, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { constants } from 'node:fs'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


// ─── helpers ─────────────────────────────────────────────────────────────────

async function fileExists( filePath ) {
    try {
        await access( filePath, constants.F_OK )

        return true
    } catch {
        return false
    }
}


const VALID_SCHEMA_CONTENT = `export const main = {
    namespace: 'demo',
    name: 'Demo API',
    version: '4.0.0',
    description: 'A test schema for grading',
    docs: [],
    tags: [ 'test' ],
    root: 'https://example.com',
    requiredServerParams: [],
    headers: {},
    tools: {}
}
`

const INVALID_SCHEMA_CONTENT = `export const main = {
    namespace: 'broken',
    version: '4.0.0'
}
`


// ─── stub v4 that returns Grade B ────────────────────────────────────────────

const MOCK_EVAL_RESPONSES = [
    { 'score': 80, 'feedback': 'Good description.', 'dimension': 'description' },
    { 'score': 75, 'feedback': 'Acceptable structure.', 'dimension': 'structure' },
    { 'score': 78, 'feedback': 'Solid tags.', 'dimension': 'tags' }
]

const STUB_V4_PASSING = {
    GradeReporter: {
        buildEvalPrompts: ( { schema: _schema } ) => {
            return {
                'prompts': [
                    { 'dimension': 'description', 'content': 'Evaluate description' },
                    { 'dimension': 'structure', 'content': 'Evaluate structure' },
                    { 'dimension': 'tags', 'content': 'Evaluate tags' }
                ]
            }
        },
        grade: ( { schema: _schema, evalResponses: _evalResponses } ) => {
            return { 'grade': 'B', 'score': 77, 'dimensions': MOCK_EVAL_RESPONSES }
        }
    },
    MainValidator: {
        validate: ( { schema: _schema } ) => {
            return { 'status': true, 'errors': [] }
        }
    }
}

const STUB_V4_FAILING = {
    GradeReporter: {
        buildEvalPrompts: ( { schema: _schema } ) => {
            return { 'prompts': [] }
        },
        grade: ( { schema: _schema, evalResponses: _evalResponses } ) => {
            return { 'grade': 'F', 'score': 0, 'dimensions': [] }
        }
    },
    MainValidator: {
        validate: ( { schema: _schema } ) => {
            return { 'status': false, 'errors': [ { 'code': 'V001', 'message': 'Missing required field "name"' } ] }
        }
    }
}


// ─── setup: inject null to reset between groups ───────────────────────────────

beforeEach( () => {
    FlowMcpCli.__testInjectV4( { 'v4': null } )
} )


// ─── test 1: v4 not available ─────────────────────────────────────────────────

describe( 'grade — v4 not available', () => {
    let tmpCwd

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-grade-no-v4-${Date.now()}` )
        await mkdir( tmpCwd, { recursive: true } )
        await writeFile( join( tmpCwd, 'schema.mjs' ), VALID_SCHEMA_CONTENT, 'utf-8' )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, 'force': true } ).catch( () => {} )
    } )

    it( 'returns status: false with v4 error and fix hint', async () => {
        // #v4Override is null (reset in beforeEach), dynamic import will fail → simulates missing v4
        // We inject an empty object so the guard triggers: no GradeReporter or MainValidator
        FlowMcpCli.__testInjectV4( { 'v4': {} } )

        const { result } = await FlowMcpCli.grade( { 'cwd': tmpCwd, 'path': 'schema.mjs', 'mock': false } )

        expect( result[ 'status' ] ).toBe( false )
        expect( typeof result[ 'error' ] ).toBe( 'string' )
        expect( result[ 'error' ] ).toContain( 'GradeReporter' )
        expect( typeof result[ 'fix' ] ).toBe( 'string' )
        expect( result[ 'fix' ] ).toContain( 'v4' )
    } )
} )


// ─── test 2: mock flag + valid schema → Grade B ───────────────────────────────

describe( 'grade — mock mode with valid schema', () => {
    let tmpCwd

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-grade-mock-b-${Date.now()}` )
        await mkdir( tmpCwd, { recursive: true } )
        await writeFile( join( tmpCwd, 'schema.mjs' ), VALID_SCHEMA_CONTENT, 'utf-8' )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, 'force': true } ).catch( () => {} )
    } )

    it( 'produces Grade B report with status: true', async () => {
        FlowMcpCli.__testInjectV4( { 'v4': STUB_V4_PASSING } )

        const { result } = await FlowMcpCli.grade( { 'cwd': tmpCwd, 'path': 'schema.mjs', 'mock': true } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'grade' ] ).toBe( 'B' )
        expect( typeof result[ 'score' ] ).toBe( 'number' )
        expect( result[ 'validationPassed' ] ).toBe( true )
    } )

    it( 'includes topDimensions in result', async () => {
        FlowMcpCli.__testInjectV4( { 'v4': STUB_V4_PASSING } )

        const { result } = await FlowMcpCli.grade( { 'cwd': tmpCwd, 'path': 'schema.mjs', 'mock': true } )

        expect( Array.isArray( result[ 'topDimensions' ] ) ).toBe( true )
        expect( result[ 'topDimensions' ].length ).toBeLessThanOrEqual( 3 )
    } )
} )


// ─── test 3: mock flag + failing validation → Grade F ────────────────────────

describe( 'grade — mock mode with schema failing deterministic validation', () => {
    let tmpCwd

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-grade-mock-f-${Date.now()}` )
        await mkdir( tmpCwd, { recursive: true } )
        await writeFile( join( tmpCwd, 'schema.mjs' ), INVALID_SCHEMA_CONTENT, 'utf-8' )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, 'force': true } ).catch( () => {} )
    } )

    it( 'produces Grade F report immediately without calling LLM', async () => {
        FlowMcpCli.__testInjectV4( { 'v4': STUB_V4_FAILING } )

        const { result } = await FlowMcpCli.grade( { 'cwd': tmpCwd, 'path': 'schema.mjs', 'mock': true } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'grade' ] ).toBe( 'F' )
        expect( result[ 'score' ] ).toBe( 0 )
        expect( result[ 'validationPassed' ] ).toBe( false )
        expect( Array.isArray( result[ 'validationErrors' ] ) ).toBe( true )
        expect( result[ 'validationErrors' ].length ).toBeGreaterThan( 0 )
    } )
} )


// ─── test 4: missing schema path ──────────────────────────────────────────────

describe( 'grade — missing schema path', () => {
    let tmpCwd

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-grade-no-path-${Date.now()}` )
        await mkdir( tmpCwd, { recursive: true } )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, 'force': true } ).catch( () => {} )
    } )

    it( 'returns status: false with usage hint', async () => {
        const { result } = await FlowMcpCli.grade( { 'cwd': tmpCwd, 'path': undefined, 'mock': false } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Missing schema path' )
        expect( typeof result[ 'fix' ] ).toBe( 'string' )
    } )
} )


// ─── test 5: schema path does not exist ───────────────────────────────────────

describe( 'grade — schema path does not exist', () => {
    let tmpCwd

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-grade-not-found-${Date.now()}` )
        await mkdir( tmpCwd, { recursive: true } )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, 'force': true } ).catch( () => {} )
    } )

    it( 'returns status: false with file not found error', async () => {
        const { result } = await FlowMcpCli.grade( { 'cwd': tmpCwd, 'path': 'ghost-schema.mjs', 'mock': false } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'not found' )
        expect( typeof result[ 'fix' ] ).toBe( 'string' )
    } )
} )


// ─── test 6: no ANTHROPIC_API_KEY without mock ────────────────────────────────

describe( 'grade — missing ANTHROPIC_API_KEY without --mock', () => {
    let tmpCwd
    let savedApiKey

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-grade-no-key-${Date.now()}` )
        await mkdir( tmpCwd, { recursive: true } )
        await writeFile( join( tmpCwd, 'schema.mjs' ), VALID_SCHEMA_CONTENT, 'utf-8' )

        savedApiKey = process.env[ 'ANTHROPIC_API_KEY' ]
        delete process.env[ 'ANTHROPIC_API_KEY' ]
    } )

    afterAll( async () => {
        if( savedApiKey !== undefined ) {
            process.env[ 'ANTHROPIC_API_KEY' ] = savedApiKey
        }

        await rm( tmpCwd, { recursive: true, 'force': true } ).catch( () => {} )
    } )

    it( 'returns status: false with missing API key error and fix hint', async () => {
        FlowMcpCli.__testInjectV4( { 'v4': STUB_V4_PASSING } )

        const { result } = await FlowMcpCli.grade( { 'cwd': tmpCwd, 'path': 'schema.mjs', 'mock': false } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'ANTHROPIC_API_KEY' )
        expect( result[ 'fix' ] ).toContain( '--mock' )
    } )
} )


// ─── test 7: report file written to .grade-reports/ ──────────────────────────

describe( 'grade — report file written to default .grade-reports/', () => {
    let tmpCwd

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-grade-report-${Date.now()}` )
        await mkdir( tmpCwd, { recursive: true } )
        await writeFile( join( tmpCwd, 'schema.mjs' ), VALID_SCHEMA_CONTENT, 'utf-8' )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, 'force': true } ).catch( () => {} )
    } )

    it( 'writes report file to .grade-reports/ with correct filename pattern', async () => {
        FlowMcpCli.__testInjectV4( { 'v4': STUB_V4_PASSING } )

        const { result } = await FlowMcpCli.grade( { 'cwd': tmpCwd, 'path': 'schema.mjs', 'mock': true } )

        expect( result[ 'status' ] ).toBe( true )

        const exists = await fileExists( result[ 'reportPath' ] )
        expect( exists ).toBe( true )

        const fileName = result[ 'reportPath' ].split( '/' ).pop()
        expect( fileName ).toMatch( /^demo-\d{4}-\d{2}-\d{2}\.json$/ )

        expect( result[ 'reportPath' ] ).toContain( '.grade-reports' )
    } )

    it( 'report file contains valid JSON with grade and score', async () => {
        FlowMcpCli.__testInjectV4( { 'v4': STUB_V4_PASSING } )

        const { result } = await FlowMcpCli.grade( { 'cwd': tmpCwd, 'path': 'schema.mjs', 'mock': true } )
        const raw = await readFile( result[ 'reportPath' ], 'utf-8' )
        const report = JSON.parse( raw )

        expect( report ).toHaveProperty( 'grade' )
        expect( report ).toHaveProperty( 'score' )
        expect( report ).toHaveProperty( 'schemaId' )
        expect( report ).toHaveProperty( 'date' )
    } )
} )


// ─── test 8: --output flag overrides default dir ──────────────────────────────

describe( 'grade — --output flag overrides default dir', () => {
    let tmpCwd
    let customOutputDir

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-grade-output-${Date.now()}` )
        await mkdir( tmpCwd, { recursive: true } )
        await writeFile( join( tmpCwd, 'schema.mjs' ), VALID_SCHEMA_CONTENT, 'utf-8' )
        customOutputDir = join( tmpCwd, 'custom-reports' )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, 'force': true } ).catch( () => {} )
    } )

    it( 'writes report to --output directory instead of .grade-reports/', async () => {
        FlowMcpCli.__testInjectV4( { 'v4': STUB_V4_PASSING } )

        const { result } = await FlowMcpCli.grade( {
            'cwd': tmpCwd,
            'path': 'schema.mjs',
            'mock': true,
            'outputDir': 'custom-reports'
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'reportPath' ] ).toContain( 'custom-reports' )
        expect( result[ 'reportPath' ] ).not.toContain( '.grade-reports' )

        const exists = await fileExists( result[ 'reportPath' ] )
        expect( exists ).toBe( true )
    } )
} )
