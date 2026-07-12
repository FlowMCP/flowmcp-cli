import { describe, it, expect, beforeAll } from '@jest/globals'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'

import { PrivateCommand } from '../../src/commands/PrivateCommand.mjs'
import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import { SchemaLoaderBridge } from '../../src/lib/SchemaLoaderBridge.mjs'


// Memo 152 / PRD-023 (E-08) — the 148 promises frozen as an end-to-end matrix.
//
// PRD-021 built the private leaf and PRD-022 hardened the scanner + library gate; this
// suite proves the FIVE Memo-148 promises (148 REV-02 Phase-1 test plan) plus the H-12
// building block, at the integration level, so a future refactor cannot break them
// silently (the CLI split already showed "byte-identical" does not hold):
//
//   Zusage 1 — the private path scans BEFORE import(); a forbidden pattern aborts, no load.
//   Zusage 2 — a clean executeRequest schema (Mail-SQLite reference style) runs via private call.
//   Zusage 3 — a private fixture appears in NEITHER list NOR search NOR the serve tool source.
//   Zusage 4 — the TRUSTED path still loads geo.mjs/inkar.mjs-style schemas (real top-level
//              imports) scan-free, while the SAME file is rejected on the private path (F16=A).
//   Zusage 5 — an unresolvable requiredLibrary fails loud with LIB-001 on the private path
//              (Memo-150 model, no silent allowlist fallback).
//   H-12     — a private fixture WITH a markdown resource validates via the v4 MainValidator
//              (f1fafff), i.e. markdown resources are accepted on the private path.
//
// All fixtures are executeRequest-only (network-free) so the suite is deterministic and
// never touches the wire. os.homedir() is mocked into <repo>/.test-home, so the real
// ~/.flowmcp is never read or written.

const here = dirname( fileURLToPath( import.meta.url ) )
const FIX = join( here, '..', 'fixtures', 'private' )
const CLEAN = join( FIX, 'clean-schema.mjs' )
const FORBIDDEN = join( FIX, 'forbidden-schema.mjs' )
const LIB_NOLIB = join( FIX, 'lib-unresolvable-schema.mjs' )
const MARKDOWN = join( FIX, 'markdown-schema.mjs' )
const PUBLIC_SRC = join( FIX, 'public-src' )
const TRUSTED_SRC = join( FIX, 'trusted-src' )
const TRUSTED_IMPORT = join( TRUSTED_SRC, 'providers', 'trusted-import-schema.mjs' )

const cwd = process.cwd()


beforeAll( async () => {
    // Two registered (trusted) schemaFolders[] sources: the plain public fixture and the
    // geo/inkar-style import fixture. list/search/serve enumerate exactly these — the
    // private fixtures (privfix/privdanger/privnolib/privmd) must NEVER appear alongside
    // them. Written into the per-suite mocked home, never the real ~/.flowmcp.
    const globalConfigDir = join( homedir(), '.flowmcp' )
    const config = {
        'envPath': join( globalConfigDir, '.env' ),
        'flowmcpCore': { 'version': '4.0.0', 'commit': 'test', 'schemaSpec': '4.0.0' },
        'initialized': new Date().toISOString(),
        'schemaFolders': [
            { 'name': 'pubsrc', 'path': PUBLIC_SRC },
            { 'name': 'trustsrc', 'path': TRUSTED_SRC }
        ]
    }
    await writeFile( join( globalConfigDir, 'config.json' ), JSON.stringify( config, null, 4 ), 'utf-8' )
} )


describe( 'E-08 Zusage 1 — the private path scans BEFORE import()', () => {
    it( 'rejects a forbidden-pattern fixture and never imports it (marker stays undefined)', async () => {
        globalThis.__PRIV_FORBIDDEN_LOADED__ = undefined

        const { result } = await PrivateCommand.call( {
            'schemaPath': FORBIDDEN, 'toolName': 'danger', 'jsonArgs': '{}', cwd
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'code' ] ).toBe( 'PRV-006' )
        expect( result[ 'error' ] ).toContain( 'SEC' )
        // The module-load side effect never fired — proof the scan runs before import.
        expect( globalThis.__PRIV_FORBIDDEN_LOADED__ ).toBeUndefined()
    } )
} )


describe( 'E-08 Zusage 2 — a clean executeRequest schema runs via private call', () => {
    it( 'returns real data for a network-free reference-style fixture', async () => {
        const { result } = await PrivateCommand.call( {
            'schemaPath': CLEAN, 'toolName': 'ping_privfix', 'jsonArgs': '{"name":"world"}', cwd
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolName' ] ).toBe( 'ping_privfix' )
        expect( result[ 'content' ][ 'greeting' ] ).toBe( 'hello world' )
    } )
} )


describe( 'E-08 Zusage 3 — structural invisibility across list, search AND serve', () => {
    it( 'a private fixture never appears in list (before OR after a private call)', async () => {
        const { result: listBefore } = await FlowMcpCli.list( { cwd } )
        const beforeStr = JSON.stringify( listBefore )
        expect( beforeStr ).toContain( 'pubfix' )
        expect( beforeStr ).not.toContain( 'privfix' )

        const { result: called } = await PrivateCommand.call( {
            'schemaPath': CLEAN, 'toolName': 'ping_privfix', 'jsonArgs': '{"name":"x"}', cwd
        } )
        expect( called[ 'status' ] ).toBe( true )

        const { result: listAfter } = await FlowMcpCli.list( { cwd } )
        expect( JSON.stringify( listAfter ) ).not.toContain( 'privfix' )
    } )

    it( 'a private fixture never appears in search', async () => {
        const { result: searchResult } = await FlowMcpCli.search( { 'query': 'priv' } )
        expect( JSON.stringify( searchResult ) ).not.toContain( 'privfix' )
    } )

    it( 'a private fixture is absent from the serve tool source (resolveAllSchemas)', async () => {
        // ServeCommand.run registers exactly the tools from SchemaLoaderBridge.resolveAllSchemas()
        // (Memo 099 — the whole schemaFolders[] catalog). Enumerating that set is a faithful
        // proxy for "what serve would expose": if the private namespace is absent here, it is
        // structurally invisible to serve as well.
        const { schemas } = await SchemaLoaderBridge.resolveAllSchemas()
        const namespaces = schemas.map( ( entry ) => entry[ 'main' ][ 'namespace' ] )

        expect( namespaces ).toContain( 'pubfix' )
        expect( namespaces ).toContain( 'trustimp' )
        expect( namespaces ).not.toContain( 'privfix' )
        expect( namespaces ).not.toContain( 'privmd' )
    } )
} )


describe( 'E-08 Zusage 4 — the trusted path loads geo/inkar-style imports scan-free (F16=A)', () => {
    it( 'a registered schema with a real top-level import loads and appears in list', async () => {
        // The trusted-import fixture carries `import { createHash } from "node:crypto"` at the
        // top level (geo.mjs:12-13 / inkar.mjs:1-2 analogue). The trusted path never scans, so
        // it loads and is enumerable.
        const { result: listResult } = await FlowMcpCli.list( { cwd } )
        expect( JSON.stringify( listResult ) ).toContain( 'trustimp' )
    } )

    it( 'the SAME file IS rejected on the private path (the private gate does scan)', async () => {
        const { result } = await PrivateCommand.call( {
            'schemaPath': TRUSTED_IMPORT, 'toolName': 'fingerprint', 'jsonArgs': '{"value":"x"}', cwd
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'code' ] ).toBe( 'PRV-006' )
        expect( result[ 'error' ] ).toContain( 'SEC001' )
    } )
} )


describe( 'E-08 Zusage 5 — the library gate is the Memo-150 model on the private path', () => {
    it( 'an unresolvable requiredLibrary fails loud with LIB-001 (no silent fallback)', async () => {
        const { result } = await PrivateCommand.call( {
            'schemaPath': LIB_NOLIB, 'toolName': 'never', 'jsonArgs': '{}', cwd
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'LIB-001' )
    } )
} )


describe( 'E-08 H-12 building block — a private markdown-resource schema validates (f1fafff)', () => {
    it( 'a private fixture with a markdown resource passes the v4 MainValidator and runs', async () => {
        const { result } = await PrivateCommand.call( {
            'schemaPath': MARKDOWN, 'toolName': 'info_privmd', 'jsonArgs': '{"topic":"maps"}', cwd
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolName' ] ).toBe( 'info_privmd' )
        expect( result[ 'content' ][ 'topic' ] ).toBe( 'maps' )
    } )
} )
