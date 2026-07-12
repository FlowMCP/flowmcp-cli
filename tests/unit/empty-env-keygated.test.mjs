import { describe, it, expect, afterEach } from '@jest/globals'
import { homedir } from 'node:os'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import { ModuleRegistry } from '../../src/lib/ModuleRegistry.mjs'
import * as realGrading from 'flowmcp-grading'
import { seedGradingSchemaFolder } from '../helpers/seed-grading-source.mjs'


const here = dirname( fileURLToPath( import.meta.url ) )
const keygateFixture = join( here, '..', 'integration', 'fixtures', 'grading-keygate' )


// Memo 119 P3 / PRD-3.2 — an EMPTY env value for a requiredServerParam must be
// treated as MISSING (key-gated, DPT-007), not injected as an empty credential
// that fires a live 401 recorded as a false FAIL. With the key omitted the real
// DataPretest short-circuits to key-gated and makes NO network call.

async function freshCwd() {
    return mkdtemp( join( tmpdir(), 'grading-keygate-cwd-' ) )
}

async function writeGlobalEnv( { content } ) {
    const dir = join( homedir(), '.flowmcp' )
    await mkdir( dir, { recursive: true } )
    await writeFile( join( dir, '.env' ), content, 'utf-8' )
}


describe( 'gradingDeterministic — empty .env value is key-gated, not a FAIL', () => {
    afterEach( () => { ModuleRegistry.inject( { grading: null } ) } )

    it( 'an EMPTY SOME_KEY routes the schema to key-gated (DPT-007), not FAIL', async () => {
        await seedGradingSchemaFolder( { providerFixture: keygateFixture, namespace: 'keygate', sourceName: 'keygate-src' } )
        await writeGlobalEnv( { content: 'SOME_KEY=\n' } )

        const cwd = await freshCwd()
        ModuleRegistry.inject( { grading: realGrading } )

        const { result } = await FlowMcpCli.gradingDeterministic( { cwd, target: 'keygate/keygate', gradingDataDir: '.flowmcp/grading', withKeys: true, only: null, dryRun: true, json: true } )

        expect( result.pretest ).toBeDefined()
        expect( result.pretest.keyGated ).toBe( true )

        const errorText = JSON.stringify( result.pretest.errors || [] )
        expect( errorText ).toContain( 'DPT-007' )
        // It must NOT be reported as a data FAIL (no DPT-004 empty-data failure).
        expect( errorText ).not.toContain( 'DPT-004' )
    } )
} )
