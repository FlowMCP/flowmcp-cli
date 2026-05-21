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

import os from 'node:os'
import path from 'node:path'


/**
 * PathVariableResolver
 *
 * Resolves FlowMCP variables in resource paths to absolute filesystem paths.
 *
 * Supported variables:
 *   - ${FLOWMCP_RESOURCES} → process.env.FLOWMCP_RESOURCES
 *                            (default: ~/.flowmcp/resources/)
 *   - ${HOME} / ~          → os.homedir() (mandatory, no fallback)
 *
 * Unknown ${FLOWMCP_*} variables throw RES035.
 *
 * Memo 051 REV-04 — Kap. 7.5 (Variable table + directory schema),
 * Kap. 4.2 (RES035 definition), Kap. 8.2 (Seal-check algorithm step 1).
 */
class PathVariableResolver {
    static resolvePathVariables( { path: inputPath } ) {
        const { status, messages } = PathVariableResolver.#validationResolvePathVariables( { path: inputPath } )
        if( !status ) { throw new Error( messages.join( '; ' ) ) }

        const hasFlowMcpResources = inputPath.includes( '${FLOWMCP_RESOURCES}' )
        const hasTildePrefix = inputPath.startsWith( '~/' ) || inputPath === '~'
        const hasHomeVar = inputPath.includes( '${HOME}' )
        const flowMcpVarMatches = inputPath.match( /\$\{FLOWMCP_[A-Z_]+\}/g ) || []

        const unknownFlowMcpVars = flowMcpVarMatches
            .filter( ( token ) => {
                const isKnown = token === '${FLOWMCP_RESOURCES}'

                return !isKnown
            } )

        if( unknownFlowMcpVars.length > 0 ) {
            const first = unknownFlowMcpVars[ 0 ]
            throw new Error( `RES035: ${first} kann nicht aufgeloest werden — unbekannte FlowMCP-Pfad-Variable.` )
        }

        if( hasFlowMcpResources ) {
            const envValue = process.env.FLOWMCP_RESOURCES
            const useEnv = typeof envValue === 'string' && envValue.length > 0
            const resourcesDir = useEnv
                ? envValue
                : path.join( os.homedir(), '.flowmcp', 'resources' )

            const replaced = inputPath.split( '${FLOWMCP_RESOURCES}' ).join( resourcesDir )
            const resolvedPath = path.resolve( replaced )
            const source = useEnv ? 'env' : 'default'
            const isDefault = !useEnv

            return { resolvedPath, isDefault, source }
        }

        if( hasTildePrefix || hasHomeVar ) {
            const home = os.homedir()
            const withoutTilde = inputPath.startsWith( '~/' )
                ? path.join( home, inputPath.slice( 2 ) )
                : inputPath === '~'
                    ? home
                    : inputPath
            const withoutHomeVar = withoutTilde.split( '${HOME}' ).join( home )
            const resolvedPath = path.resolve( withoutHomeVar )

            return { resolvedPath, isDefault: false, source: 'home' }
        }

        const resolvedPath = path.resolve( inputPath )

        return { resolvedPath, isDefault: false, source: 'literal' }
    }


    static #validationResolvePathVariables( { path: inputPath } ) {
        const struct = { status: false, messages: [] }

        if( inputPath === undefined || inputPath === null ) {
            struct.messages.push( 'path is required' )
            return struct
        }

        if( typeof inputPath !== 'string' ) {
            struct.messages.push( 'path must be a string' )
            return struct
        }

        if( inputPath.length === 0 ) {
            struct.messages.push( 'path must not be empty' )
            return struct
        }

        struct.status = true
        return struct
    }
}


export { PathVariableResolver }
