import { describe, it, expect, beforeAll } from '@jest/globals'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'

import { PrivateCommand } from '../../src/commands/PrivateCommand.mjs'
import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


// Memo 152 / PRD-021 (E-04, E-05) — the `private call` leaf. Path-addressed, ad-hoc
// schema call on the core v4 Pipeline (scan ACTIVE). The schema is never registered,
// so it stays structurally invisible to search/list/serve. All fixtures are
// executeRequest-only (network-free), so the suite is deterministic and never hits the wire.

const here = dirname( fileURLToPath( import.meta.url ) )
const FIX = join( here, '..', 'fixtures', 'private' )
const CLEAN = join( FIX, 'clean-schema.mjs' )
const FORBIDDEN = join( FIX, 'forbidden-schema.mjs' )
const SHAREDLIST = join( FIX, 'sharedlist-schema.mjs' )
const LISTS_DIR = join( FIX, 'lists' )
const PUBLIC_SRC = join( FIX, 'public-src' )

const cwd = process.cwd()


beforeAll( async () => {
    // A configured schemaFolders[] source (the PUBLIC fixture) so list/search have
    // something to enumerate — the private fixtures must NEVER appear alongside it.
    // Written into the per-suite mocked home (never the real ~/.flowmcp).
    const globalConfigDir = join( homedir(), '.flowmcp' )
    const config = {
        'envPath': join( globalConfigDir, '.env' ),
        'flowmcpCore': { 'version': '4.0.0', 'commit': 'test', 'schemaSpec': '4.0.0' },
        'initialized': new Date().toISOString(),
        'schemaFolders': [ { 'name': 'pubsrc', 'path': PUBLIC_SRC } ]
    }
    await writeFile( join( globalConfigDir, 'config.json' ), JSON.stringify( config, null, 4 ), 'utf-8' )
} )


describe( 'private call — happy path on the v4 Pipeline (E-04)', () => {
    it( 'runs a clean fixture by wire tool-name and returns data', async () => {
        const { result } = await PrivateCommand.call( {
            'schemaPath': CLEAN, 'toolName': 'ping_privfix', 'jsonArgs': '{"name":"world"}', cwd
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolName' ] ).toBe( 'ping_privfix' )
        expect( result[ 'content' ][ 'greeting' ] ).toBe( 'hello world' )
    } )

    it( 'also accepts the raw route name and resolves to the wire name', async () => {
        const { result } = await PrivateCommand.call( {
            'schemaPath': CLEAN, 'toolName': 'ping', 'jsonArgs': '{"name":"alice"}', cwd
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolName' ] ).toBe( 'ping_privfix' )
        expect( result[ 'content' ][ 'greeting' ] ).toBe( 'hello alice' )
    } )

    it( 'resolves a ~-prefixed path', async () => {
        // The mocked homedir is <repo>/.test-home/<suite>; place a copy there is
        // overkill — instead assert ~ expansion reaches a not-found (PRV-002), proving
        // the tilde was expanded to the mocked home rather than left literal.
        const { result } = await PrivateCommand.call( {
            'schemaPath': '~/definitely-not-here.mjs', 'toolName': 'ping', 'jsonArgs': '{}', cwd
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'code' ] ).toBe( 'PRV-002' )
        expect( result[ 'error' ] ).toContain( homedir() )
    } )
} )


describe( 'private call — security scan is ALWAYS active on the private path (E-04, F16=A)', () => {
    it( 'rejects a forbidden-pattern fixture BEFORE importing it (marker never set)', async () => {
        // The fixture flips globalThis.__PRIV_FORBIDDEN_LOADED__ on import. A correct
        // run scans first, rejects, and never imports — so the marker stays undefined.
        globalThis.__PRIV_FORBIDDEN_LOADED__ = undefined

        const { result } = await PrivateCommand.call( {
            'schemaPath': FORBIDDEN, 'toolName': 'danger', 'jsonArgs': '{}', cwd
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'code' ] ).toBe( 'PRV-006' )
        expect( result[ 'error' ] ).toContain( 'SEC' )
        expect( globalThis.__PRIV_FORBIDDEN_LOADED__ ).toBeUndefined()
    } )
} )


describe( 'private call — structural invisibility (E-04, 148-F4 "A by construction")', () => {
    it( 'the command module never touches the merge/registration machinery or the statics chain', async () => {
        const source = await readFile( join( here, '..', '..', 'src', 'commands', 'PrivateCommand.mjs' ), 'utf-8' )

        // The HARD grep assertions from PRD-021, encoded as a test.
        expect( source ).not.toMatch( /resolveAllSchemas|listSources|SchemaSource/ )
        expect( source ).not.toMatch( /loadSchemasFromPath|resolveSharedListsForSchema|resolveHandlers/ )
        // It DOES route through the core v4 Pipeline.
        expect( source ).toMatch( /Pipeline\.load/ )
    } )

    it( 'is CLI-only — there is no `private serve` variant (F24=A)', async () => {
        const indexSource = await readFile( join( here, '..', '..', 'src', 'index.mjs' ), 'utf-8' )

        expect( indexSource ).not.toContain( 'private serve' )
        // The private branch exposes exactly one sub-command: `call`.
        const privateBlock = indexSource.slice( indexSource.indexOf( 'const privateBranch' ) )
        const childrenSlice = privateBlock.slice( 0, privateBlock.indexOf( '}\n\n\nconst listsBranch' ) )
        expect( childrenSlice ).toContain( "'call'" )
        expect( childrenSlice ).not.toContain( "'serve'" )
    } )

    it( 'a private fixture never appears in list/search — before OR after a private call', async () => {
        const { result: listBefore } = await FlowMcpCli.list( { cwd } )
        const listBeforeStr = JSON.stringify( listBefore )
        expect( listBeforeStr ).toContain( 'pubfix' )
        expect( listBeforeStr ).not.toContain( 'privfix' )

        const { result: called } = await PrivateCommand.call( {
            'schemaPath': CLEAN, 'toolName': 'ping_privfix', 'jsonArgs': '{"name":"x"}', cwd
        } )
        expect( called[ 'status' ] ).toBe( true )

        const { result: listAfter } = await FlowMcpCli.list( { cwd } )
        const listAfterStr = JSON.stringify( listAfter )
        expect( listAfterStr ).not.toContain( 'privfix' )
        expect( listAfterStr ).toContain( 'pubfix' )

        const { result: searchResult } = await FlowMcpCli.search( { 'query': 'priv' } )
        expect( JSON.stringify( searchResult ) ).not.toContain( 'privfix' )
    } )
} )


describe( 'private call — --lists-dir matrix (E-05)', () => {
    it( 'WITH --lists-dir resolves the shared list and the tool runs', async () => {
        const { result } = await PrivateCommand.call( {
            'schemaPath': SHAREDLIST, 'toolName': 'pickColor', 'jsonArgs': '{"color":"red"}', 'listsDir': LISTS_DIR, cwd
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolName' ] ).toBe( 'pick_color_privlist' )
        expect( result[ 'content' ][ 'picked' ] ).toBe( 'red' )
    } )

    it( 'WITHOUT --lists-dir + a declared sharedLists ref fails loud with LST-001 (no silent {})', async () => {
        const { result } = await PrivateCommand.call( {
            'schemaPath': SHAREDLIST, 'toolName': 'pickColor', 'jsonArgs': '{"color":"red"}', cwd
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'LST-001' )
    } )

    it( 'a normal fixture without any sharedLists ref runs without --lists-dir', async () => {
        const { result } = await PrivateCommand.call( {
            'schemaPath': CLEAN, 'toolName': 'ping_privfix', 'jsonArgs': '{"name":"nobody"}', cwd
        } )

        expect( result[ 'status' ] ).toBe( true )
    } )
} )


describe( 'private call — no silent defaults, every arg validated', () => {
    it( 'missing schema path → PRV-001', async () => {
        const { result } = await PrivateCommand.call( { 'schemaPath': undefined, 'toolName': 'x', 'jsonArgs': '{}', cwd } )
        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'code' ] ).toBe( 'PRV-001' )
    } )

    it( 'path not found → PRV-002', async () => {
        const { result } = await PrivateCommand.call( { 'schemaPath': '/nope/x.mjs', 'toolName': 'x', 'jsonArgs': '{}', cwd } )
        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'code' ] ).toBe( 'PRV-002' )
    } )

    it( 'missing tool name → PRV-003', async () => {
        const { result } = await PrivateCommand.call( { 'schemaPath': CLEAN, 'toolName': '', 'jsonArgs': '{}', cwd } )
        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'code' ] ).toBe( 'PRV-003' )
    } )

    it( 'invalid JSON → PRV-004', async () => {
        const { result } = await PrivateCommand.call( { 'schemaPath': CLEAN, 'toolName': 'ping', 'jsonArgs': '{bad', cwd } )
        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'code' ] ).toBe( 'PRV-004' )
    } )

    it( 'a --lists-dir that does not exist → PRV-005', async () => {
        const { result } = await PrivateCommand.call( { 'schemaPath': CLEAN, 'toolName': 'ping', 'jsonArgs': '{}', 'listsDir': '/nope/lists', cwd } )
        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'code' ] ).toBe( 'PRV-005' )
    } )

    it( 'unknown tool → PRV-007 listing the available tools', async () => {
        const { result } = await PrivateCommand.call( { 'schemaPath': CLEAN, 'toolName': 'nope', 'jsonArgs': '{}', cwd } )
        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'code' ] ).toBe( 'PRV-007' )
        expect( result[ 'fix' ] ).toContain( 'ping_privfix' )
    } )
} )


describe( 'private call — facade delegation (index.mjs surface)', () => {
    it( 'FlowMcpCli.privateCall delegates to the command module', async () => {
        const { result } = await FlowMcpCli.privateCall( {
            'schemaPath': CLEAN, 'toolName': 'ping_privfix', 'jsonArgs': '{"name":"facade"}', 'listsDir': null, cwd
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'content' ][ 'greeting' ] ).toBe( 'hello facade' )
    } )
} )
