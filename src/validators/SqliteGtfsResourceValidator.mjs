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


/**
 * SqliteGtfsResourceValidator
 *
 * Structural validation for `source: 'sqlite-gtfs'` resources.
 * Emits RES030 (mode), RES031 (addon), and RES035 (path-variable).
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
                if( !resource || resource.source !== 'sqlite-gtfs' ) { return }

                const { mode, addon, path: resourcePath } = resource
                const basePath = `main.resources[${index}]`

                if( mode !== 'file-based' ) {
                    errors.push( {
                        code: 'RES030',
                        severity: 'error',
                        message: `source 'sqlite-gtfs' requires mode 'file-based' (got: ${mode === undefined ? 'undefined' : mode}). in-memory is not allowed.`,
                        path: `${basePath}.mode`
                    } )
                }

                const addonValid = typeof addon === 'string' && addon.length > 0
                if( !addonValid ) {
                    errors.push( {
                        code: 'RES031',
                        severity: 'error',
                        message: `source 'sqlite-gtfs' requires non-empty 'addon' field (add-on package name).`,
                        path: `${basePath}.addon`
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
            } )

        return { errors }
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
