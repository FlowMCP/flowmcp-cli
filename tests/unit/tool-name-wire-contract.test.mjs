import { describe, it, expect } from '@jest/globals'

import { FlowMCP } from 'flowmcp'


// Memo 152 / PRD-012 (B-09) — Wire-Contract regression guard.
//
// Tool names (e.g. `geo_station_geo`) are a Wire-Contract: agents and docs
// reference them by exact string, so the core-hoisted buildToolName (B-04) must
// stay BYTE-IDENTICAL to the former CLI copy. The golden values below were
// captured from the pre-de-fork CLI (#buildToolName at commit 8e09597, the base
// of FLOWMCP-152-cli-v4) via __testOnly_buildToolName. This suite proves the
// core FlowMCP.buildToolName (behind __testOnly_buildToolName) reproduces them
// exactly, in both modes (with/without source-suffix, incl. cap + sanitize).

describe( 'Tool-name Wire-Contract — byte-identical to pre-de-fork CLI', () => {
    const goldens = [
        {
            'label': 'geo_station_geo (the canonical Wire fixture)',
            'input': { 'routeName': 'geoStation', 'namespace': 'geo' },
            'expected': 'geo_station_geo'
        },
        {
            'label': 'standard case',
            'input': { 'routeName': 'ping', 'namespace': 'demo' },
            'expected': 'ping_demo'
        },
        {
            'label': 'camelCase -> snake_case',
            'input': { 'routeName': 'getBlockNumber', 'namespace': 'evm' },
            'expected': 'get_block_number_evm'
        },
        {
            'label': 'source-suffix (disambiguate) mode',
            'input': { 'routeName': 'geoStation', 'namespace': 'geo', 'source': 'privateFolder', 'disambiguate': true },
            'expected': 'geo_station_geo_private_folder'
        },
        {
            'label': 'sanitize case (: - /) with source-suffix',
            'input': { 'routeName': 'get-block/number:x', 'namespace': 'evm-chain', 'source': 'my-src', 'disambiguate': true },
            'expected': 'get_block_numberx_evm_chain_my_src'
        },
        {
            'label': '63-char cap reserves room for the source suffix',
            'input': { 'routeName': 'aVeryLongRouteNameThatKeepsGoingAndGoingWellPastLimits', 'namespace': 'someHugeNamespaceAlsoLong', 'source': 'srcCoordinateLong', 'disambiguate': true },
            'expected': 'a_very_long_route_name_that_keeps_going_and_src_coordinate_long'
        },
        {
            'label': '63-char cap without source',
            'input': { 'routeName': 'aVeryLongRouteNameThatKeepsGoingAndGoingWellPastSixtyThree', 'namespace': 'someHugeNamespaceAlsoQuiteLong' },
            'expected': 'a_very_long_route_name_that_keeps_going_and_going_well_past_six'
        }
    ]

    goldens
        .forEach( ( { label, input, expected } ) => {
            it( `reproduces "${expected}" — ${label}`, () => {
                const { toolName } = FlowMCP.buildToolName( input )

                expect( toolName ).toBe( expected )
                expect( toolName.length ).toBeLessThanOrEqual( 63 )
            } )
        } )
} )
