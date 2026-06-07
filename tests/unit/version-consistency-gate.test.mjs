import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import { seedInitializedGlobalConfig } from '../helpers/seed-home.mjs'


// Memo 119 P3 / PRD-3.1 — the version-consistency gate: a schema declaring a 4.x
// version must be SHAPED like v4 (no populated v2 `routes`, no v3 `skills`, <=8
// tools). Because v4 reuses the v2 transport, a mis-declared schema otherwise only
// fails at runtime; this gate fails it at structural validation time.

const TEST_DIR = join( tmpdir(), 'flowmcp-cli-version-gate-test' )

function tool( { name } ) {
    return {
        method: 'GET', path: `/${name}`, description: `${name} tool`,
        parameters: [],
        tests: [ { _description: 't1' }, { _description: 't2' } ],
        output: { mimeType: 'application/json', schema: { type: 'object', description: 'r', properties: { ok: { type: 'string', description: 'ok' } } } }
    }
}

function v4Base( { extra = {}, toolNames = [ 'getThing' ] } = {} ) {
    const tools = toolNames
        .reduce( ( acc, name ) => { acc[ name ] = tool( { name } ); return acc }, {} )

    return {
        namespace: 'gatetest', name: 'gatetest', description: 'Version-gate fixture.',
        version: '4.0.0', docs: [], tags: [ 'test' ], root: 'https://example.com',
        requiredServerParams: [], headers: {}, tools, ...extra
    }
}

async function writeSchema( { fileName, main } ) {
    const path = join( TEST_DIR, fileName )
    await writeFile( path, `export const main = ${JSON.stringify( main, null, 4 )}\n`, 'utf-8' )

    return path
}

beforeAll( async () => {
    await seedInitializedGlobalConfig()
    await mkdir( TEST_DIR, { recursive: true } )
} )

afterAll( async () => {
    await rm( TEST_DIR, { recursive: true, force: true } )
} )


describe( 'v4 version-consistency gate', () => {
    it( 'flags a 4.x schema that declares populated v2 routes (VERSION-001)', async () => {
        const main = v4Base( { extra: { routes: { legacy: { method: 'GET', path: '/x', description: 'd', parameters: [] } } } } )
        const schemaPath = await writeSchema( { fileName: 'with-routes.mjs', main } )

        const { result } = await FlowMcpCli.validate( { schemaPath } )

        expect( result.results[ 0 ].status ).toBe( false )
        expect( result.results[ 0 ].messages.join( ' ' ) ).toContain( 'VERSION-001' )
    } )

    it( 'flags a 4.x schema that declares v3 skills (VERSION-002)', async () => {
        const main = v4Base( { extra: { skills: [ { name: 'legacySkill' } ] } } )
        const schemaPath = await writeSchema( { fileName: 'with-skills.mjs', main } )

        const { result } = await FlowMcpCli.validate( { schemaPath } )

        expect( result.results[ 0 ].status ).toBe( false )
        expect( result.results[ 0 ].messages.join( ' ' ) ).toContain( 'VERSION-002' )
    } )

    it( 'flags a 4.x schema with more than 8 tools (VERSION-003)', async () => {
        const toolNames = [ 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9' ]
        const main = v4Base( { toolNames } )
        const schemaPath = await writeSchema( { fileName: 'nine-tools.mjs', main } )

        const { result } = await FlowMcpCli.validate( { schemaPath } )

        expect( result.results[ 0 ].status ).toBe( false )
        expect( result.results[ 0 ].messages.join( ' ' ) ).toContain( 'VERSION-003' )
    } )

    it( 'does NOT flag a well-shaped v4 schema (no VERSION-* errors)', async () => {
        const main = v4Base( { extra: { routes: {}, skills: [] }, toolNames: [ 'a', 'b' ] } )
        const schemaPath = await writeSchema( { fileName: 'clean-v4.mjs', main } )

        const { result } = await FlowMcpCli.validate( { schemaPath } )

        expect( result.results[ 0 ].messages.join( ' ' ) ).not.toContain( 'VERSION-00' )
    } )
} )
