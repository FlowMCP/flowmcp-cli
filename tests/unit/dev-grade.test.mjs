import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import { writeFile, mkdir, rm, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { constants } from 'node:fs'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


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
    tools: {
        getThing: {
            method: 'GET',
            path: '/thing',
            description: 'Get a thing',
            parameters: [],
            tests: [ { _description: 't1' }, { _description: 't2' }, { _description: 't3' } ],
            output: { mimeType: 'application/json', schema: { type: 'object', description: 'X', properties: { ok: { type: 'string', description: 'ok' } } } }
        }
    }
}
`


const STUB_V4_PASSING = {
    GradeReporter: {
        buildEvalPrompts: ( { schema: _schema } ) => {
            return {
                'evalPrompts': [
                    { 'dimension': 'whenToUse', 'prompt': 'Rate description...' },
                    { 'dimension': 'parameters', 'prompt': 'Rate parameters...' }
                ]
            }
        },
        grade: ( { schemaId, deterministicResult, scores: _scores, validatorVersion: _vv } ) => {
            const avg = _scores.reduce( ( a, s ) => a + s.score, 0 ) / _scores.length
            const grade = deterministicResult.status === 'PASS' && avg >= 3.5 ? 'B' : 'F'
            return {
                grade,
                'report': { schemaId, 'averageScore': avg, 'validatorVersion': _vv, grade },
                'suggestedFileName': `${schemaId.replace( /\//g, '_' )}-2026-05-18.json`
            }
        }
    },
    MainValidator: {
        validate: ( { main: _main } ) => {
            return { 'status': true, 'messages': [] }
        }
    },
    MetaGenerator: {
        generate: ( { tool, toolName: _toolName } ) => {
            return {
                meta: {
                    isReadOnly: tool.method === 'GET',
                    isConcurrencySafe: true,
                    isDestructive: false,
                    searchHint: tool.description || '',
                    aliases: [],
                    alwaysLoad: false
                }
            }
        }
    }
}


const STUB_V4_FAILING_VALIDATOR = {
    ...STUB_V4_PASSING,
    MainValidator: {
        validate: ( { main: _main } ) => {
            return { 'status': false, 'messages': [ 'VAL001: bogus error' ] }
        }
    }
}


beforeEach( () => {
    FlowMcpCli.__testInjectV4( { 'v4': null } )
} )


describe( 'grade — input validation', () => {
    it( 'errors when schema path is missing', async () => {
        const { result } = await FlowMcpCli.grade( { 'cwd': tmpdir(), 'path': '' } )
        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Missing schema path' )
    } )

    it( 'errors when neither --emit-prompts nor --consume-scores is set', async () => {
        const tmpCwd = join( tmpdir(), `grade-mode-${Date.now()}` )
        await mkdir( tmpCwd, { recursive: true } )
        await writeFile( join( tmpCwd, 'schema.mjs' ), VALID_SCHEMA_CONTENT, 'utf-8' )

        const { result } = await FlowMcpCli.grade( { 'cwd': tmpCwd, 'path': 'schema.mjs' } )
        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Mode required' )

        await rm( tmpCwd, { recursive: true, force: true } )
    } )

    it( 'errors when schema file does not exist', async () => {
        const { result } = await FlowMcpCli.grade( { 'cwd': tmpdir(), 'path': 'nonexistent.mjs', 'emitPrompts': true } )
        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Schema file not found' )
    } )
} )


describe( 'grade — v4 not available', () => {
    it( 'returns status: false with v4 error and fix hint', async () => {
        const tmpCwd = join( tmpdir(), `grade-no-v4-${Date.now()}` )
        await mkdir( tmpCwd, { recursive: true } )
        await writeFile( join( tmpCwd, 'schema.mjs' ), VALID_SCHEMA_CONTENT, 'utf-8' )

        FlowMcpCli.__testInjectV4( { 'v4': {} } )
        const { result } = await FlowMcpCli.grade( { 'cwd': tmpCwd, 'path': 'schema.mjs', 'emitPrompts': true } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'flowmcp-core v4' )
        expect( result.fix ).toBeDefined()

        await rm( tmpCwd, { recursive: true, force: true } )
    } )
} )


describe( 'grade --emit-prompts mode', () => {
    let tmpCwd

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `grade-emit-${Date.now()}` )
        await mkdir( tmpCwd, { recursive: true } )
        await writeFile( join( tmpCwd, 'schema.mjs' ), VALID_SCHEMA_CONTENT, 'utf-8' )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'writes prompts.json and state.json with correct schema-id slug', async () => {
        FlowMcpCli.__testInjectV4( { 'v4': STUB_V4_PASSING } )

        const { result } = await FlowMcpCli.grade( {
            'cwd': tmpCwd,
            'path': 'schema.mjs',
            'emitPrompts': true,
            'workdir': 'proofs/grade-work'
        } )

        expect( result.status ).toBe( true )
        expect( result.mode ).toBe( 'emit-prompts' )
        expect( result.schemaIdSlug ).toBe( 'demo_schema' )
        expect( result.promptsPath ).toMatch( /demo_schema\/prompts\.json$/ )
        expect( result.statePath ).toMatch( /demo_schema\/state\.json$/ )
        expect( await fileExists( result.promptsPath ) ).toBe( true )
        expect( await fileExists( result.statePath ) ).toBe( true )

        const promptsContent = JSON.parse( await readFile( result.promptsPath, 'utf-8' ) )
        expect( promptsContent.scoringProtocol ).toBe( 'v1' )
        expect( promptsContent.scoringInstructions ).toContain( 'Schema-Bewerter' )
        expect( Array.isArray( promptsContent.prompts ) ).toBe( true )
        expect( promptsContent.prompts.length ).toBe( 2 )

        const stateContent = JSON.parse( await readFile( result.statePath, 'utf-8' ) )
        expect( stateContent.status ).toBe( 'prompts-emitted' )
        expect( stateContent.phases.promptsEmitted ).toBeDefined()
        expect( stateContent.phases.scoresReceived ).toBeNull()
    } )

    it( 'skips on second invocation (NO-OVERWRITE skip default)', async () => {
        FlowMcpCli.__testInjectV4( { 'v4': STUB_V4_PASSING } )

        const { result } = await FlowMcpCli.grade( {
            'cwd': tmpCwd,
            'path': 'schema.mjs',
            'emitPrompts': true,
            'workdir': 'proofs/grade-work'
        } )

        expect( result.status ).toBe( true )
        expect( result.skipped ).toBe( true )
    } )

    it( 'aborts when --on-conflict=abort and prompts.json exists', async () => {
        FlowMcpCli.__testInjectV4( { 'v4': STUB_V4_PASSING } )

        const { result } = await FlowMcpCli.grade( {
            'cwd': tmpCwd,
            'path': 'schema.mjs',
            'emitPrompts': true,
            'workdir': 'proofs/grade-work',
            'onConflict': 'abort'
        } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'NO-OVERWRITE conflict' )
    } )
} )


describe( 'grade --consume-scores mode', () => {
    let tmpCwd
    let scoresPath

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `grade-consume-${Date.now()}` )
        await mkdir( tmpCwd, { recursive: true } )
        await writeFile( join( tmpCwd, 'schema.mjs' ), VALID_SCHEMA_CONTENT, 'utf-8' )

        scoresPath = join( tmpCwd, 'scores.json' )
        const scoresDoc = {
            'schemaIdSlug': 'demo_schema',
            'scoringProtocol': 'v1',
            'creator': { 'skill': 'test', 'skillVersion': '1.0', 'session': 'test-session' },
            'harness': { 'name': 'claude-code', 'version': '1.0.0', 'model': 'claude-opus-4-7', 'modelContext': '1M' },
            'timestamp': '2026-05-18T03:00:00Z',
            'scores': [
                { 'dimension': 'whenToUse', 'score': 4.0, 'reasoning': 'good' },
                { 'dimension': 'parameters', 'score': 3.5, 'reasoning': 'ok' }
            ]
        }
        await writeFile( scoresPath, JSON.stringify( scoresDoc, null, 4 ), 'utf-8' )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'writes report with all reproducibility metadata', async () => {
        FlowMcpCli.__testInjectV4( { 'v4': STUB_V4_PASSING } )

        const { result } = await FlowMcpCli.grade( {
            'cwd': tmpCwd,
            'path': 'schema.mjs',
            'consumeScores': 'scores.json',
            'reportsDir': 'proofs/grade-reports'
        } )

        expect( result.status ).toBe( true )
        expect( result.mode ).toBe( 'consume-scores' )
        expect( result.grade ).toBe( 'B' )
        expect( result.score ).toBeGreaterThanOrEqual( 3.5 )
        expect( result.reportPath ).toMatch( /demo_schema-\d{4}-\d{2}-\d{2}\.json$/ )
        expect( await fileExists( result.reportPath ) ).toBe( true )

        const reportContent = JSON.parse( await readFile( result.reportPath, 'utf-8' ) )
        expect( reportContent.schemaHash ).toMatch( /^sha256:[a-f0-9]{64}$/ )
        expect( reportContent.creator.skill ).toBe( 'test' )
        expect( reportContent.harness.name ).toBe( 'claude-code' )
        expect( reportContent.harness.model ).toBe( 'claude-opus-4-7' )
        expect( reportContent.timestamps.gradedAt ).toBeDefined()
        expect( reportContent.timestamps.reportedAt ).toBeDefined()
        expect( reportContent.scoringProtocol ).toBe( 'v1' )
        expect( reportContent.validationPassed ).toBe( true )
    } )

    it( 'returns Grade F when validator fails', async () => {
        FlowMcpCli.__testInjectV4( { 'v4': STUB_V4_FAILING_VALIDATOR } )

        const otherCwd = join( tmpdir(), `grade-consume-fail-${Date.now()}` )
        await mkdir( otherCwd, { recursive: true } )
        await writeFile( join( otherCwd, 'schema.mjs' ), VALID_SCHEMA_CONTENT, 'utf-8' )

        const scoresOther = join( otherCwd, 'scores.json' )
        const scoresDoc = {
            'scoringProtocol': 'v1',
            'scores': [ { 'dimension': 'whenToUse', 'score': 4.0 }, { 'dimension': 'parameters', 'score': 3.5 } ]
        }
        await writeFile( scoresOther, JSON.stringify( scoresDoc ), 'utf-8' )

        const { result } = await FlowMcpCli.grade( {
            'cwd': otherCwd,
            'path': 'schema.mjs',
            'consumeScores': 'scores.json'
        } )

        expect( result.status ).toBe( true )
        expect( result.grade ).toBe( 'F' )
        expect( result.validationPassed ).toBe( false )

        await rm( otherCwd, { recursive: true, force: true } )
    } )

    it( 'errors when scores file is missing', async () => {
        FlowMcpCli.__testInjectV4( { 'v4': STUB_V4_PASSING } )

        const { result } = await FlowMcpCli.grade( {
            'cwd': tmpCwd,
            'path': 'schema.mjs',
            'consumeScores': 'nonexistent.json'
        } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Scores file not found' )
    } )

    it( 'errors when scores file has invalid JSON', async () => {
        FlowMcpCli.__testInjectV4( { 'v4': STUB_V4_PASSING } )

        const badJsonPath = join( tmpCwd, 'bad.json' )
        await writeFile( badJsonPath, 'not-valid-json{', 'utf-8' )

        const { result } = await FlowMcpCli.grade( {
            'cwd': tmpCwd,
            'path': 'schema.mjs',
            'consumeScores': 'bad.json'
        } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'Invalid JSON' )
    } )

    it( 'errors when scores has wrong shape', async () => {
        FlowMcpCli.__testInjectV4( { 'v4': STUB_V4_PASSING } )

        const wrongShapePath = join( tmpCwd, 'wrong.json' )
        await writeFile( wrongShapePath, JSON.stringify( { 'scores': 'not-array' } ), 'utf-8' )

        const { result } = await FlowMcpCli.grade( {
            'cwd': tmpCwd,
            'path': 'schema.mjs',
            'consumeScores': 'wrong.json'
        } )

        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'scores' )
    } )
} )
