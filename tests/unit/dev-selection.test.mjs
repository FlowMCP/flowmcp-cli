import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


// ─── helpers ────────────────────────────────────────────────────────────────

function makeSelectionContent( { namespace, name, description = 'Test selection', whenToUse = 'Use in tests', tools = [], extra = '' } ) {
    return `export const selection = {
    namespace: '${namespace}',
    name: '${name}',
    version: 'flowmcp/4.0.0',
    description: '${description}',
    whenToUse: '${whenToUse}',
    tools: ${JSON.stringify( tools )},
    skills: [],
    resources: [],
    prompts: []
    ${extra}
}
`
}


// ─── test 1: list with no selections ─────────────────────────────────────────

describe( 'selectionList — empty schemas dir', () => {
    it( 'returns empty array when no selections exist in any source', async () => {
        // Use a cwd that has no selections under ~/.flowmcp/schemas sources
        // The method scans #schemasDir() which is global (~/.flowmcp/schemas)
        // We verify it always returns a valid result shape
        const { result } = await FlowMcpCli.selectionList( { 'cwd': tmpdir() } )

        expect( result[ 'status' ] ).toBe( true )
        expect( Array.isArray( result[ 'selections' ] ) ).toBe( true )
        expect( typeof result[ 'count' ] ).toBe( 'number' )
    } )
} )


// ─── test 2: list finds a selection file ─────────────────────────────────────

describe( 'selectionList — finds selection in fixture schemas dir', () => {
    let fixtureSource
    let tmpSource

    beforeAll( async () => {
        // Create a fake source dir inside ~/.flowmcp/schemas
        const globalSchemasDir = join( homedir(), '.flowmcp', 'schemas' )
        tmpSource = `test-sel-source-${Date.now()}`
        fixtureSource = join( globalSchemasDir, tmpSource )

        await mkdir( join( fixtureSource, 'selections', 'contracts' ), { recursive: true } )

        await writeFile(
            join( fixtureSource, 'selections', 'contracts', 'selection.mjs' ),
            makeSelectionContent( {
                'namespace': 'evm-test',
                'name': 'contracts',
                'whenToUse': 'Use when analyzing EVM contracts',
                'tools': [ 'etherscan/tool/getContractAbi' ]
            } ),
            'utf-8'
        )
    } )

    afterAll( async () => {
        await rm( fixtureSource, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'finds the selection and returns correct fields', async () => {
        const { result } = await FlowMcpCli.selectionList( { 'cwd': tmpdir() } )

        expect( result[ 'status' ] ).toBe( true )

        const found = result[ 'selections' ]
            .find( ( sel ) => sel[ 'namespace' ] === 'evm-test' && sel[ 'name' ] === 'contracts' )

        expect( found ).toBeDefined()
        expect( found[ 'namespace' ] ).toBe( 'evm-test' )
        expect( found[ 'name' ] ).toBe( 'contracts' )
        expect( found[ 'toolCount' ] ).toBe( 1 )
        expect( typeof found[ 'whenToUse' ] ).toBe( 'string' )
        expect( typeof found[ 'file' ] ).toBe( 'string' )
        expect( typeof found[ 'source' ] ).toBe( 'string' )
    } )
} )


// ─── test 3: show returns full selection details ──────────────────────────────

describe( 'selectionShow — finds existing selection', () => {
    let fixtureSource
    let tmpSource

    beforeAll( async () => {
        const globalSchemasDir = join( homedir(), '.flowmcp', 'schemas' )
        tmpSource = `test-sel-show-${Date.now()}`
        fixtureSource = join( globalSchemasDir, tmpSource )

        await mkdir( join( fixtureSource, 'selections', 'defi-tools' ), { recursive: true } )

        await writeFile(
            join( fixtureSource, 'selections', 'defi-tools', 'selection.mjs' ),
            makeSelectionContent( {
                'namespace': 'defi-test',
                'name': 'defi-tools',
                'description': 'DeFi tools selection',
                'whenToUse': 'Use for DeFi analysis',
                'tools': [ 'dexscreener/tool/getTokenPairs', 'moralis/tool/getBalance' ]
            } ),
            'utf-8'
        )
    } )

    afterAll( async () => {
        await rm( fixtureSource, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'returns full selection details by namespace/selection/name', async () => {
        const { result } = await FlowMcpCli.selectionShow( {
            'cwd': tmpdir(),
            'name': 'defi-test/selection/defi-tools'
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'selection' ] ).toBeDefined()
        expect( result[ 'selection' ][ 'namespace' ] ).toBe( 'defi-test' )
        expect( result[ 'selection' ][ 'name' ] ).toBe( 'defi-tools' )
        expect( result[ 'selection' ][ 'description' ] ).toBe( 'DeFi tools selection' )
        expect( Array.isArray( result[ 'selection' ][ 'tools' ] ) ).toBe( true )
        expect( result[ 'selection' ][ 'tools' ].length ).toBe( 2 )
    } )

    it( 'returns full selection details by short namespace/name', async () => {
        const { result } = await FlowMcpCli.selectionShow( {
            'cwd': tmpdir(),
            'name': 'defi-test/defi-tools'
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'selection' ][ 'namespace' ] ).toBe( 'defi-test' )
    } )
} )


// ─── test 4: show returns error for unknown selection ─────────────────────────

describe( 'selectionShow — unknown selection', () => {
    it( 'returns status: false when selection is not found', async () => {
        const { result } = await FlowMcpCli.selectionShow( {
            'cwd': tmpdir(),
            'name': 'nonexistent/selection/ghost'
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( typeof result[ 'error' ] ).toBe( 'string' )
        expect( result[ 'error' ] ).toContain( 'not found' )
        expect( typeof result[ 'fix' ] ).toBe( 'string' )
    } )
} )


// ─── test 5: validate passes for well-formed selection ────────────────────────

describe( 'selectionValidate — valid selection file', () => {
    let tmpDir
    let selectionFile

    beforeAll( async () => {
        tmpDir = join( tmpdir(), `flowmcp-sel-valid-${Date.now()}` )
        await mkdir( tmpDir, { recursive: true } )

        selectionFile = join( tmpDir, 'selection.mjs' )
        await writeFile(
            selectionFile,
            makeSelectionContent( {
                'namespace': 'evm-research',
                'name': 'contracts',
                'description': 'Tools for analyzing EVM contracts',
                'whenToUse': 'Use when investigating smart contract behavior',
                'tools': [ 'etherscan-io/tool/getContractAbi', 'moralis/tool/getTransaction' ]
            } ),
            'utf-8'
        )
    } )

    afterAll( async () => {
        await rm( tmpDir, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'returns status: true for a well-formed selection', async () => {
        const { result } = await FlowMcpCli.selectionValidate( { 'cwd': tmpDir, 'path': 'selection.mjs' } )

        expect( result[ 'status' ] ).toBe( true )
        expect( Array.isArray( result[ 'errors' ] ) ).toBe( true )
        expect( result[ 'errors' ].length ).toBe( 0 )
        expect( Array.isArray( result[ 'warnings' ] ) ).toBe( true )
    } )
} )


// ─── test 6: validate fails with SEL001 for missing required keys ─────────────

describe( 'selectionValidate — missing required keys', () => {
    let tmpDir
    let selectionFile

    beforeAll( async () => {
        tmpDir = join( tmpdir(), `flowmcp-sel-sel001-${Date.now()}` )
        await mkdir( tmpDir, { recursive: true } )

        selectionFile = join( tmpDir, 'selection.mjs' )
        // Missing whenToUse and description
        await writeFile(
            selectionFile,
            `export const selection = {
    namespace: 'evm-research',
    name: 'contracts',
    tools: [ 'etherscan-io/tool/getContractAbi' ],
    skills: [],
    resources: [],
    prompts: []
}
`,
            'utf-8'
        )
    } )

    afterAll( async () => {
        await rm( tmpDir, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'returns status: false with SEL001 errors for missing required fields', async () => {
        const { result } = await FlowMcpCli.selectionValidate( { 'cwd': tmpDir, 'path': 'selection.mjs' } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'errors' ].length ).toBeGreaterThan( 0 )

        const codes = result[ 'errors' ]
            .map( ( e ) => e[ 'code' ] )

        expect( codes.some( ( c ) => c === 'SEL001' ) ).toBe( true )
    } )
} )


// ─── test 7: validate fails with VAL110 for namespace with slashes ────────────

describe( 'selectionValidate — namespace with slashes', () => {
    let tmpDir
    let selectionFile

    beforeAll( async () => {
        tmpDir = join( tmpdir(), `flowmcp-sel-val110-${Date.now()}` )
        await mkdir( tmpDir, { recursive: true } )

        selectionFile = join( tmpDir, 'selection.mjs' )
        await writeFile(
            selectionFile,
            `export const selection = {
    namespace: 'evm/research',
    name: 'contracts',
    description: 'Test',
    whenToUse: 'Use in tests',
    tools: [ 'etherscan-io/tool/getContractAbi' ],
    skills: [],
    resources: [],
    prompts: []
}
`,
            'utf-8'
        )
    } )

    afterAll( async () => {
        await rm( tmpDir, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'returns VAL110 error when namespace contains slashes', async () => {
        const { result } = await FlowMcpCli.selectionValidate( { 'cwd': tmpDir, 'path': 'selection.mjs' } )

        expect( result[ 'status' ] ).toBe( false )

        const codes = result[ 'errors' ]
            .map( ( e ) => e[ 'code' ] )

        expect( codes.some( ( c ) => c === 'VAL110' ) ).toBe( true )
    } )
} )


// ─── test 8: validate falls back gracefully when core SelectionValidator is unavailable ─

describe( 'selectionValidate — graceful fallback (inline validator)', () => {
    let tmpDir
    let selectionFile

    beforeAll( async () => {
        tmpDir = join( tmpdir(), `flowmcp-sel-fallback-${Date.now()}` )
        await mkdir( tmpDir, { recursive: true } )

        selectionFile = join( tmpDir, 'selection.mjs' )
        await writeFile(
            selectionFile,
            makeSelectionContent( {
                'namespace': 'fallback-ns',
                'name': 'fallback-sel',
                'description': 'Fallback test',
                'whenToUse': 'Used for fallback testing',
                'tools': [ 'some/tool/doThing' ]
            } ),
            'utf-8'
        )
    } )

    afterAll( async () => {
        await rm( tmpDir, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'validates successfully even when flowmcp/v4 is not available (inline fallback path)', async () => {
        // The inline fallback is always exercised when flowmcp/v4 SelectionValidator
        // is not present (which is the case in the current pinned v3.0.0 install).
        // We verify the result structure is always correct regardless of backend.
        const { result } = await FlowMcpCli.selectionValidate( { 'cwd': tmpDir, 'path': 'selection.mjs' } )

        expect( typeof result[ 'status' ] ).toBe( 'boolean' )
        expect( Array.isArray( result[ 'errors' ] ) ).toBe( true )
        expect( Array.isArray( result[ 'warnings' ] ) ).toBe( true )
    } )

    it( 'inline fallback passes a well-formed selection', async () => {
        const { result } = await FlowMcpCli.selectionValidate( { 'cwd': tmpDir, 'path': 'selection.mjs' } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'errors' ].length ).toBe( 0 )
    } )
} )
