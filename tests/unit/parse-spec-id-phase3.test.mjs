import { describe, it, expect } from '@jest/globals'

import { FlowMCP, IdResolver } from 'flowmcp'
import { ServeCommand } from '../../src/commands/ServeCommand.mjs'


// Local re-implementation of the former __testOnly_planServeToolNames hook: plans
// the pre-serve dedup over a list of tool entries exactly like the serve loop,
// using the public core FlowMCP.buildToolName + ServeCommand.disambiguateToolName.
function planServeToolNames( { entries } ) {
    const registeredToolNames = new Set()
    const plan = entries
        .map( ( entry ) => {
            const { routeName, namespace, source } = entry
            const { toolName: baseName } = FlowMCP.buildToolName( { routeName, namespace } )
            const decided = ServeCommand.disambiguateToolName( { baseName, routeName, namespace, source, registeredToolNames } )

            return { baseName, 'finalName': decided.finalName, 'skip': decided.skip, 'note': decided.note }
        } )

    return { plan, 'registeredNames': [ ...registeredToolNames ] }
}


// ─── PRD-007 — bare namespace (slashCount === 0) ─────────────────────────────

describe( 'PRD-007 — #parseSpecId bare namespace', () => {
    it( 'parses a bare namespace as type "namespace"', () => {
        const parsed = IdResolver.parseSpecId( { 'specId': 'etherscan' } )

        expect( parsed.valid ).toBe( true )
        expect( parsed.type ).toBe( 'namespace' )
        expect( parsed.namespace ).toBe( 'etherscan' )
        expect( parsed.source ).toBe( null )
    } )

    it( 'accepts hyphenated lowercase namespaces', () => {
        const parsed = IdResolver.parseSpecId( { 'specId': 'open-plz' } )

        expect( parsed.valid ).toBe( true )
        expect( parsed.type ).toBe( 'namespace' )
    } )

    it( 'rejects an upper-case namespace (no silent normalize)', () => {
        const parsed = IdResolver.parseSpecId( { 'specId': 'Etherscan' } )

        expect( parsed.valid ).toBe( false )
        expect( parsed.error ).toMatch( /Invalid namespace/ )
    } )
} )


// ─── PRD-007 — schema / tool / selection forms keep their shape ──────────────

describe( 'PRD-007 — #parseSpecId schema / tool / selection', () => {
    it( '1 slash = schema', () => {
        const parsed = IdResolver.parseSpecId( { 'specId': 'etherscan/balance' } )

        expect( parsed.valid ).toBe( true )
        expect( parsed.type ).toBe( 'schema' )
        expect( parsed.namespace ).toBe( 'etherscan' )
        expect( parsed.name ).toBe( 'balance' )
    } )

    it( '2 slashes = tool', () => {
        const parsed = IdResolver.parseSpecId( { 'specId': 'etherscan/tool/getBalance' } )

        expect( parsed.valid ).toBe( true )
        expect( parsed.type ).toBe( 'tool' )
        expect( parsed.name ).toBe( 'getBalance' )
    } )

    it( '2 slashes = selection', () => {
        const parsed = IdResolver.parseSpecId( { 'specId': 'core/selection/mvp' } )

        expect( parsed.valid ).toBe( true )
        expect( parsed.type ).toBe( 'selection' )
        expect( parsed.name ).toBe( 'mvp' )
    } )

    it( '3 slashes = hard error with example', () => {
        const parsed = IdResolver.parseSpecId( { 'specId': 'foo/bar/baz/qux' } )

        expect( parsed.valid ).toBe( false )
        expect( parsed.error ).toMatch( /Valid forms/ )
        expect( parsed.error ).toMatch( /etherscan\/tool\/getBalance/ )
    } )
} )


// ─── PRD-011 — teaching error texts ──────────────────────────────────────────

describe( 'PRD-011 — #parseSpecId teaching errors', () => {
    it( 'a 3-slash id names all valid forms (1 slash = schema, 2 slashes = tool)', () => {
        const parsed = IdResolver.parseSpecId( { 'specId': 'foo/bar/baz/qux' } )

        expect( parsed.error ).toMatch( /1 slash = schema/ )
        expect( parsed.error ).toMatch( /2 slashes = tool/ )
    } )

    it( 'an unknown 2-slash type explains the expected types with an example', () => {
        const parsed = IdResolver.parseSpecId( { 'specId': 'etherscan/bogus/foo' } )

        expect( parsed.valid ).toBe( false )
        expect( parsed.error ).toMatch( /tool\|resource\|prompt\|skill\|selection\|agent/ )
        expect( parsed.error ).toMatch( /etherscan\/tool\/foo/ )
    } )
} )


// ─── PRD-008 — optional <source>: prefix ─────────────────────────────────────

describe( 'PRD-008 — #parseSpecId source coordinate', () => {
    it( 'splits a leading "<source>:" prefix off a namespace', () => {
        const parsed = IdResolver.parseSpecId( { 'specId': 'Production:etherscan' } )

        expect( parsed.valid ).toBe( true )
        expect( parsed.source ).toBe( 'Production' )
        expect( parsed.type ).toBe( 'namespace' )
        expect( parsed.namespace ).toBe( 'etherscan' )
    } )

    it( 'splits a leading "<source>:" prefix off a tool id', () => {
        const parsed = IdResolver.parseSpecId( { 'specId': 'Production:etherscan/tool/getBalance' } )

        expect( parsed.valid ).toBe( true )
        expect( parsed.source ).toBe( 'Production' )
        expect( parsed.type ).toBe( 'tool' )
        expect( parsed.namespace ).toBe( 'etherscan' )
        expect( parsed.name ).toBe( 'getBalance' )
    } )

    it( 'rejects an empty source ("...:foo")', () => {
        const parsed = IdResolver.parseSpecId( { 'specId': ':etherscan' } )

        expect( parsed.valid ).toBe( false )
        expect( parsed.error ).toMatch( /source coordinate/ )
    } )

    it( 'rejects an empty remainder ("source:")', () => {
        const parsed = IdResolver.parseSpecId( { 'specId': 'Production:' } )

        expect( parsed.valid ).toBe( false )
        expect( parsed.error ).toMatch( /nothing after/ )
    } )
} )


// ─── PRD-008 — #buildToolName source append ──────────────────────────────────

describe( 'PRD-008 — #buildToolName source coordinate', () => {
    it( 'keeps the lean name when disambiguate is false (byte-identical baseline)', () => {
        const { toolName } = FlowMCP.buildToolName( { 'routeName': 'getBalance', 'namespace': 'etherscan' } )

        expect( toolName ).toBe( 'get_balance_etherscan' )
    } )

    it( 'a source param without disambiguate does NOT change the name', () => {
        const { toolName } = FlowMCP.buildToolName( { 'routeName': 'getBalance', 'namespace': 'etherscan', 'source': 'Production' } )

        expect( toolName ).toBe( 'get_balance_etherscan' )
    } )

    it( 'appends the source only when disambiguate is true', () => {
        const { toolName } = FlowMCP.buildToolName( { 'routeName': 'getBalance', 'namespace': 'etherscan', 'source': 'Production', 'disambiguate': true } )

        expect( toolName ).toBe( 'get_balance_etherscan_production' )
    } )

    it( 'is deterministic (same input -> same name)', () => {
        const a = FlowMCP.buildToolName( { 'routeName': 'getBalance', 'namespace': 'etherscan', 'source': 'Dev', 'disambiguate': true } )
        const b = FlowMCP.buildToolName( { 'routeName': 'getBalance', 'namespace': 'etherscan', 'source': 'Dev', 'disambiguate': true } )

        expect( a.toolName ).toBe( b.toolName )
    } )

    it( 'respects the 63-char cap with a source suffix', () => {
        const longRoute = 'a'.repeat( 80 )
        const { toolName } = FlowMCP.buildToolName( { 'routeName': longRoute, 'namespace': 'etherscan', 'source': 'Production', 'disambiguate': true } )

        expect( toolName.length ).toBeLessThanOrEqual( 63 )
        expect( toolName.endsWith( '_production' ) ).toBe( true )
    } )
} )


// ─── PRD-008 MUST-HAVE — two same-provider folders produce NO duplicate ───────

describe( 'PRD-008 — pre-serve dedup (serve must start without throw)', () => {
    it( 'two schemaFolders with the same provider register distinct tool names', () => {
        const entries = [
            { 'routeName': 'getBalance', 'namespace': 'etherscan', 'source': 'Development' },
            { 'routeName': 'getBalance', 'namespace': 'etherscan', 'source': 'Production' }
        ]

        const { plan, registeredNames } = planServeToolNames( { entries } )

        // No skips: both can coexist because the source disambiguates them.
        expect( plan.every( ( p ) => p.skip === false ) ).toBe( true )
        // The registered names are UNIQUE — the SDK would otherwise throw.
        expect( new Set( registeredNames ).size ).toBe( registeredNames.length )
        expect( registeredNames.length ).toBe( 2 )
        // First wins the lean name; the second gets the source-qualified name.
        expect( plan[ 0 ][ 'finalName' ] ).toBe( 'get_balance_etherscan' )
        expect( plan[ 1 ][ 'finalName' ] ).toBe( 'get_balance_etherscan_production' )
    } )

    it( 'a non-colliding tool keeps its lean name (no regression)', () => {
        const entries = [
            { 'routeName': 'getBalance', 'namespace': 'etherscan', 'source': 'Development' },
            { 'routeName': 'getPrice', 'namespace': 'moralis', 'source': 'Development' }
        ]

        const { plan } = planServeToolNames( { entries } )

        expect( plan[ 0 ][ 'finalName' ] ).toBe( 'get_balance_etherscan' )
        expect( plan[ 1 ][ 'finalName' ] ).toBe( 'get_price_moralis' )
        expect( plan.every( ( p ) => p.skip === false ) ).toBe( true )
    } )

    it( 'a duplicate with NO source coordinate is skipped, never throws', () => {
        // No source -> the second occurrence cannot be disambiguated, so it is
        // skipped (with a note) instead of crashing the SDK.
        const entries = [
            { 'routeName': 'getBalance', 'namespace': 'etherscan', 'source': null },
            { 'routeName': 'getBalance', 'namespace': 'etherscan', 'source': null }
        ]

        const { plan, registeredNames } = planServeToolNames( { entries } )

        expect( plan[ 0 ][ 'skip' ] ).toBe( false )
        expect( plan[ 1 ][ 'skip' ] ).toBe( true )
        expect( plan[ 1 ][ 'note' ] ).toMatch( /cannot be disambiguated/ )
        expect( registeredNames.length ).toBe( 1 )
    } )
} )
