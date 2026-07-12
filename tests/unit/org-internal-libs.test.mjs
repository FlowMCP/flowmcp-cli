import { describe, it, expect } from '@jest/globals'

import { OrgInternalLibs } from '../../src/lib/OrgInternalLibs.mjs'


// Memo 152 / PRD-027 (doctor gap b) — the org-internal classifier maps FlowMCP-org libraries
// (github-only, not on npm) to a `github:FlowMCP/<repo>` install token, and plain npm packages
// to their bare name.
describe( 'OrgInternalLibs', () => {
    describe( 'isOrgInternal()', () => {
        it( 'recognizes a FlowMCP-org add-on toolkit', () => {
            const { orgInternal } = OrgInternalLibs.isOrgInternal( { lib: 'time-csv-toolkit' } )

            expect( orgInternal ).toBe( true )
        } )

        it( 'recognizes a geo-* org add-on', () => {
            const { orgInternal } = OrgInternalLibs.isOrgInternal( { lib: 'geo-idbridge-toolkit' } )

            expect( orgInternal ).toBe( true )
        } )

        it( 'treats a normal npm package as not org-internal', () => {
            const { orgInternal } = OrgInternalLibs.isOrgInternal( { lib: 'ethers' } )

            expect( orgInternal ).toBe( false )
        } )
    } )


    describe( 'installTargetFor()', () => {
        it( 'returns a github:FlowMCP/<repo> token for an org-internal lib', () => {
            const { installTarget } = OrgInternalLibs.installTargetFor( { lib: 'rpc-benchmark' } )

            expect( installTarget ).toBe( 'github:FlowMCP/rpc-benchmark' )
        } )

        it( 'returns the bare name for an npm lib', () => {
            const { installTarget } = OrgInternalLibs.installTargetFor( { lib: 'better-sqlite3' } )

            expect( installTarget ).toBe( 'better-sqlite3' )
        } )
    } )


    describe( 'buildInstallTargets()', () => {
        it( 'builds a per-lib map mixing org-internal and npm libs', () => {
            const { installTargets } = OrgInternalLibs.buildInstallTargets( {
                libs: [ 'time-csv-toolkit', 'ethers', 'geo-dzt-toolkit' ]
            } )

            expect( installTargets ).toEqual( {
                'time-csv-toolkit': 'github:FlowMCP/time-csv-toolkit',
                'ethers': 'ethers',
                'geo-dzt-toolkit': 'github:FlowMCP/geo-dzt-toolkit'
            } )
        } )

        it( 'returns an empty map for a non-array input (no throw, no silent guess)', () => {
            const { installTargets } = OrgInternalLibs.buildInstallTargets( { libs: null } )

            expect( installTargets ).toEqual( {} )
        } )
    } )
} )
