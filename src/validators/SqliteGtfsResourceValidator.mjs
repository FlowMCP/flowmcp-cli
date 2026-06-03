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

import { PathVariableResolver } from '../path/resolvePathVariables.mjs'
import { ADDON_REGISTRY } from '../data/addons.mjs'


/**
 * SqliteGtfsResourceValidator
 *
 * Structural validation for any registered sqlite add-on resource
 * (`source` is a key in ADDON_REGISTRY, e.g. `sqlite-gtfs`, `geo-geojson`,
 * `geo-csv`). Emits RES030 (mode), RES031 (addon), and RES035 (path-variable).
 *
 * Memo 051 REV-04 — Kap. 4.2 (RES030..RES035 codes), Kap. 7.1 (validate command),
 * Kap. 3.3 (Auto-Injection-Pfad Schritt 1 — Spec-Validator).
 *
 * NOTE: RES032 (no seal), RES033 (cannot open), RES034 (spec drift) are
 * pipeline-only and emitted by `flowmcp add` (PRD-18). This validator
 * intentionally performs NO disk I/O on the DB file.
 */
class SqliteGtfsResourceValidator {
    static validateResources( { resources } ) {
        const { status, messages } = SqliteGtfsResourceValidator.#validationValidateResources( { resources } )
        if( !status ) { throw new Error( messages.join( '; ' ) ) }

        const errors = []

        resources
            .forEach( ( resource, index ) => {
                if( !resource || ADDON_REGISTRY[ resource.source ] === undefined ) { return }

                const { source, mode, addon } = resource
                const basePath = `main.resources[${index}]`

                const addonValid = typeof addon === 'string' && addon.length > 0
                if( !addonValid ) {
                    errors.push( {
                        code: 'RES031',
                        severity: 'error',
                        message: `source '${source}' requires non-empty 'addon' field (add-on package name).`,
                        path: `${basePath}.addon`
                    } )
                }

                const registryEntry = ADDON_REGISTRY[ source ]

                // urlMode sources (geo-geojson, geo-csv) are URL-only (Memo 096 — F3=B,
                // the converter/seal path was removed). File-based sources (sqlite-gtfs) reject url.
                if( registryEntry.urlMode ) {
                    if( mode !== 'url' ) {
                        errors.push( {
                            code: 'RES043',
                            severity: 'error',
                            message: `source '${source}' requires mode 'url' (got: ${mode === undefined ? 'undefined' : mode}). The converter/file-based path was removed (Memo 096).`,
                            path: `${basePath}.mode`
                        } )
                        return
                    }
                    SqliteGtfsResourceValidator.#validateUrlMode( { resource, basePath, errors } )
                    return
                }

                if( mode === 'url' ) {
                    errors.push( {
                        code: 'RES043',
                        severity: 'error',
                        message: `mode 'url' is not supported by source '${source}'. Only geo-geojson and geo-csv support URL mode.`,
                        path: `${basePath}.mode`
                    } )
                    return
                }

                SqliteGtfsResourceValidator.#validateFileMode( { resource, basePath, errors } )
            } )

        return { errors }
    }


    static #validateUrlMode( { resource, basePath, errors } ) {
        const { source, url, parseConfig } = resource

        // RES044 — url is required and MUST use HTTPS.
        const urlValid = typeof url === 'string' && url.startsWith( 'https://' )
        if( !urlValid ) {
            errors.push( {
                code: 'RES044',
                severity: 'error',
                message: `mode 'url' requires an HTTPS 'url' field (got: ${url === undefined ? 'undefined' : url}).`,
                path: `${basePath}.url`
            } )
        }

        // RES045 — geo-csv in url mode requires a parseConfig object (no silent default).
        if( source === 'geo-csv' ) {
            const parseConfigValid = parseConfig !== null && typeof parseConfig === 'object' && !Array.isArray( parseConfig )
            if( !parseConfigValid ) {
                errors.push( {
                    code: 'RES045',
                    severity: 'error',
                    message: `source 'geo-csv' with mode 'url' requires a 'parseConfig' object. No silent default.`,
                    path: `${basePath}.parseConfig`
                } )
            }
        }
    }


    static #validateFileMode( { resource, basePath, errors } ) {
        const { source, mode, path: resourcePath } = resource

        // RES030 — file-based sources require mode 'file-based'.
        if( mode !== 'file-based' ) {
            errors.push( {
                code: 'RES030',
                severity: 'error',
                message: `source '${source}' requires mode 'file-based' (got: ${mode === undefined ? 'undefined' : mode}). in-memory is not allowed.`,
                path: `${basePath}.mode`
            } )
        }

        const pathIsString = typeof resourcePath === 'string' && resourcePath.length > 0
        if( pathIsString && /\$\{FLOWMCP_[A-Z_]+\}/.test( resourcePath ) ) {
            try {
                PathVariableResolver.resolvePathVariables( { path: resourcePath } )
            } catch( err ) {
                const isRes035 = /^RES035/.test( err.message )
                if( isRes035 ) {
                    errors.push( {
                        code: 'RES035',
                        severity: 'error',
                        message: err.message,
                        path: `${basePath}.path`
                    } )
                } else {
                    errors.push( {
                        code: 'RES035',
                        severity: 'error',
                        message: `Path variable in '${resourcePath}' could not be resolved: ${err.message}`,
                        path: `${basePath}.path`
                    } )
                }
            }
        }
    }


    static #validationValidateResources( { resources } ) {
        const struct = { status: false, messages: [] }

        if( resources === undefined || resources === null ) {
            struct.messages.push( 'resources is required' )
            return struct
        }

        if( !Array.isArray( resources ) ) {
            struct.messages.push( 'resources must be an array' )
            return struct
        }

        struct.status = true
        return struct
    }
}


export { SqliteGtfsResourceValidator }
