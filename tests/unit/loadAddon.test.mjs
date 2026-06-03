import { describe, it, expect } from '@jest/globals'

import { AddonLoader } from '../../src/addons/loadAddon.mjs'


describe( 'AddonLoader.loadAddon', () => {
    it( 'loads gtfs-sqlite-toolkit for sourceKey sqlite-gtfs', async () => {
        const result = await AddonLoader.loadAddon( { sourceKey: 'sqlite-gtfs' } )

        expect( result.addonName ).toBe( 'geo-gtfs-toolkit' )
        expect( [ 'live', 'local' ] ).toContain( result.source )
        expect( typeof result.addonModule.FlowMcpAdapter ).toBe( 'function' )
    } )


    it( 'throws when sourceKey is unknown', async () => {
        await expect( AddonLoader.loadAddon( { sourceKey: 'sqlite-unknown' } ) )
            .rejects.toThrow( /not in ADDON_REGISTRY/ )
    } )


    it( 'throws when sourceKey is missing', async () => {
        await expect( AddonLoader.loadAddon( { } ) )
            .rejects.toThrow( /required/ )
    } )


    it( 'throws when sourceKey is not a string', async () => {
        await expect( AddonLoader.loadAddon( { sourceKey: 42 } ) )
            .rejects.toThrow( /must be a string/ )
    } )


    it( 'throws when sourceKey is empty', async () => {
        await expect( AddonLoader.loadAddon( { sourceKey: '' } ) )
            .rejects.toThrow( /must not be empty/ )
    } )
} )
