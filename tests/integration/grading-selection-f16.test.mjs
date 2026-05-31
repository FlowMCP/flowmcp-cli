import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


// Selection-flow F16 dependency resolver (case a: missing member -> auto-chain
// import from --member-source; report-only without it). Uses the real grading
// module; import is structural (no HTTP) and the Pre-Condition gate blocks before
// Stage 1, so no live API call is made.

let root = null
let cwd = null
let memberSourceRoot = null


const schemaSource = ( { namespace, name } ) => `export const main = {
    namespace: ${JSON.stringify( namespace )},
    name: ${JSON.stringify( name )},
    description: 'Demo schema for the F16 member auto-chain test.',
    version: '4.0.0',
    root: 'https://api.example.com',
    tools: {
        foo: { method: 'GET', path: '/foo', description: 'fetch foo', parameters: [] }
    }
}
export async function handler() { return { status: true } }
`


beforeEach( async () => {
    root = await mkdtemp( join( tmpdir(), 'sel-f16-' ) )
    cwd = root
    // Island with a selection that references an un-imported member demo.thing.
    const selDef = join( root, 'grading-data', 'selections', 'cryptotest', 'selection' )
    await mkdir( selDef, { recursive: true } )
    await writeFile(
        join( selDef, 'cryptotest--2026-01-01T00-00-00Z--abcd1234.json' ),
        JSON.stringify( { selectionId: 'cryptotest', members: [ { schemaId: 'demo.thing' } ], skills: [], personaIds: [ 'decision-maker--crypto-trader' ] }, null, 4 ),
        'utf-8'
    )
    // A member source root containing the demo namespace (thing.mjs).
    memberSourceRoot = join( root, 'member-source' )
    await mkdir( join( memberSourceRoot, 'demo' ), { recursive: true } )
    await writeFile( join( memberSourceRoot, 'demo', 'thing.mjs' ), schemaSource( { namespace: 'demo', name: 'Demo Thing' } ), 'utf-8' )
} )

afterEach( async () => {
    if( root !== null ) { await rm( root, { recursive: true, force: true } ) }
} )


describe( 'grading run <selection> — F16 case (a) member auto-chain', () => {
    it( 'auto-builds the selection index and auto-chains the missing member when --member-source is given', async () => {
        const { result } = await FlowMcpCli.gradingRun( {
            cwd, target: 'cryptotest', phase: null, emitPrompts: true,
            consumeScores: null, onConflict: null, memberSource: memberSourceRoot, json: true
        } )

        const chain = result.dependencyChain || []
        const steps = chain.map( ( s ) => s.step )
        expect( steps ).toContain( 'auto-build-selection-index' )
        expect( steps ).toContain( 'member-auto-chain' )
        const done = chain.some( ( s ) => s.step === 'member-auto-chain' && s.status === 'done' )
        expect( done ).toBe( true )
        // The missing member's namespace was imported into the island.
        expect( existsSync( join( root, 'grading-data', 'providers', 'demo', 'thing' ) ) ).toBe( true )
        // Pre-Condition still blocks (member imported but not stable) — no silent pass.
        expect( result.status ).toBe( false )
        expect( result.error ).toContain( 'PRE-004' )
    } )

    it( 'reports the missing member (no silent import) when --member-source is absent', async () => {
        const { result } = await FlowMcpCli.gradingRun( {
            cwd, target: 'cryptotest', phase: null, emitPrompts: true,
            consumeScores: null, onConflict: null, memberSource: null, json: true
        } )

        const chain = result.dependencyChain || []
        const report = chain.find( ( s ) => s.step === 'member-report' )
        expect( report ).toBeDefined()
        expect( report.missingMembers ).toContain( 'demo.thing' )
        // No source -> the member was NOT imported.
        expect( existsSync( join( root, 'grading-data', 'providers', 'demo' ) ) ).toBe( false )
        expect( result.status ).toBe( false )
    } )
} )
