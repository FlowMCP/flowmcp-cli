/**
 * FlowMCP — MIT License
 *
 * DISCLAIMER: This code orchestrates calls to third-party APIs. Each API has
 * its own Terms of Services. FlowMCP makes no representation about TOS
 * compliance, data licensing, or fitness for any purpose. Users are solely
 * responsible for reviewing and adhering to each API provider's terms.
 *
 * For more information, see LICENSE.md and DISCLAIMER.md in the repo root.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { ADDON_REGISTRY } from '../data/addons.mjs'


const PACKAGE_JSON_PATH = path.resolve(
    path.dirname( fileURLToPath( import.meta.url ) ),
    '..',
    '..',
    'package.json'
)


/**
 * AddonLoader
 *
 * Resolves a FlowMCP resource source-key (e.g. `sqlite-gtfs`) to the
 * implementing add-on module via dynamic import.
 *
 * Memo 051 REV-04 — Kap. 5.4 (discovery, github:-pattern, NO NPM),
 * Kap. 7.4 (add-on import — file: for local dev, github: for prod),
 * Kap. 3.3 (auto-injection — addon loaded from addonSource).
 */
class AddonLoader {
    static async loadAddon( { sourceKey } ) {
        const { status, messages } = AddonLoader.#validationLoadAddon( { sourceKey } )
        if( !status ) { throw new Error( messages.join( '; ' ) ) }

        const entry = ADDON_REGISTRY[ sourceKey ]
        if( !entry ) {
            throw new Error( `Add-on '${sourceKey}' not in ADDON_REGISTRY` )
        }

        const addonName = entry.name
        const source = await AddonLoader.#detectSource( { addonName } )

        let addonModule
        try {
            addonModule = await import( addonName )
        } catch( err ) {
            // Memo 149 Strang C — coded rethrow (ADN-001).
            throw new Error( `ADN-001 addon: Failed to load addon '${addonName}': ${err.message}` )
        }

        return { addonName, addonModule, source }
    }


    static async #detectSource( { addonName } ) {
        try {
            const raw = await readFile( PACKAGE_JSON_PATH, 'utf-8' )
            const pkg = JSON.parse( raw )
            const deps = pkg.dependencies || {}
            const dependencyValue = deps[ addonName ]

            if( typeof dependencyValue !== 'string' ) {
                return 'live'
            }

            const isLocal = dependencyValue.startsWith( 'file:' )

            return isLocal ? 'local' : 'live'
        } catch( err ) {
            // Memo 149 Strang C (CLI-001) — benign fallback: an unreadable/absent
            // package.json means we cannot tell local from live, so default to 'live'.
            // Coded to stderr so the census/doctor see it; stdout JSON stays clean.
            process.stderr.write( `CLI-001 detectSource: package.json unreadable, defaulting to 'live': ${err.message}\n` )

            return 'live'
        }
    }


    static #validationLoadAddon( { sourceKey } ) {
        const struct = { status: false, messages: [] }

        if( sourceKey === undefined || sourceKey === null ) {
            struct.messages.push( 'sourceKey is required' )
            return struct
        }

        if( typeof sourceKey !== 'string' ) {
            struct.messages.push( 'sourceKey must be a string' )
            return struct
        }

        if( sourceKey.length === 0 ) {
            struct.messages.push( 'sourceKey must not be empty' )
            return struct
        }

        struct.status = true
        return struct
    }
}


export { AddonLoader }
