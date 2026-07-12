import { describe, it, expect, afterEach } from '@jest/globals'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import { GradingStatus } from '../../src/commands/grading/GradingStatus.mjs'
import { ModuleRegistry } from '../../src/lib/ModuleRegistry.mjs'
import * as realGrading from 'flowmcp-grading'


// G-13 — About-page consistency check wired into `grading doctor`. These tests
// build a minimal namespace island (one schema snapshot + one About markdown
// resource) and prove the doctor surfaces an About-consistency section: a clean
// About passes, an About missing a tool name is flagged (ABT-004).


const schemaModule = `export const main = {
    namespace: 'aboutns',
    name: 'demo',
    tools: {
        getThing: { description: 'Fetch a thing from the demo provider' }
    }
}
`


// Seed providers/aboutns/demo/{schema, resources/about}. aboutText controls the
// clean (mentions getThing) vs finding (omits getThing) case.
const seedAboutIsland = async ( { gradingDataRoot, aboutText } ) => {
    const schemaDir = join( gradingDataRoot, 'providers', 'aboutns', 'demo', 'schema' )
    await mkdir( schemaDir, { recursive: true } )
    await writeFile( join( schemaDir, 'demo--2026-01-01T00-00-00Z--a1b2c3d4.mjs' ), schemaModule, 'utf-8' )

    const aboutDir = join( gradingDataRoot, 'providers', 'aboutns', 'demo', 'resources', 'about' )
    await mkdir( aboutDir, { recursive: true } )
    await writeFile( join( aboutDir, 'about.md' ), aboutText, 'utf-8' )
}


const freshRoot = async () => {
    return mkdtemp( join( tmpdir(), 'grading-doctor-about-' ) )
}


describe( 'G-13 — AboutConsistencyCheck wired into grading doctor', () => {
    afterEach( () => { ModuleRegistry.inject( { grading: null } ) } )

    it( 'clean About (mentions every tool name) -> checked, passed, no ABT-004', async () => {
        const gradingDataRoot = await freshRoot()
        await seedAboutIsland( {
            gradingDataRoot,
            aboutText: '# demo provider\n\nUse getThing to fetch a thing from the demo provider.\n'
        } )

        const about = await GradingStatus.collectAboutConsistency( { grading: realGrading, target: 'aboutns', gradingDataRoot } )

        expect( about.checked ).toBe( true )
        expect( about.passed ).toBe( true )
        const codes = about.issues.map( ( issue ) => issue.code )
        expect( codes ).not.toContain( 'ABT-004' )
    } )

    it( 'inconsistent About (omits a tool name) -> checked, not passed, ABT-004 surfaced', async () => {
        const gradingDataRoot = await freshRoot()
        await seedAboutIsland( {
            gradingDataRoot,
            aboutText: '# demo provider\n\nThis provider returns some data. No tool names are mentioned here.\n'
        } )

        const about = await GradingStatus.collectAboutConsistency( { grading: realGrading, target: 'aboutns', gradingDataRoot } )

        expect( about.checked ).toBe( true )
        expect( about.passed ).toBe( false )
        const codes = about.issues.map( ( issue ) => issue.code )
        expect( codes ).toContain( 'ABT-004' )
    } )

    it( 'grading doctor result carries an about section that catches the inconsistency', async () => {
        const cwd = await freshRoot()
        const gradingDataRoot = join( cwd, '.flowmcp', 'grading' )
        await seedAboutIsland( {
            gradingDataRoot,
            aboutText: '# demo provider\n\nThis provider returns some data. No tool names are mentioned here.\n'
        } )

        ModuleRegistry.inject( { grading: realGrading } )
        const { result } = await FlowMcpCli.gradingDoctor( { cwd, gradingDataDir: '.flowmcp/grading', target: 'aboutns', json: true } )

        expect( result.status ).toBe( true )
        expect( result.about ).toBeDefined()
        expect( result.about.checked ).toBe( true )
        expect( result.about.passed ).toBe( false )
        const codes = result.about.issues.map( ( issue ) => issue.code )
        expect( codes ).toContain( 'ABT-004' )
    } )
} )
