import { join } from 'node:path'

import { appConfig } from '../data/config.mjs'
import { ConfigStore } from './ConfigStore.mjs'
import { FsUtils } from './FsUtils.mjs'


// Memo 152 / PRD-019 (D-08) — the shared env helpers extracted from FlowMcpCli.
// These are reused across the handler/call/search/serve/env-tools paths, so they
// are public statics (no back-reference to FlowMcpCli). Depends only on
// ConfigStore/FsUtils + appConfig + node builtins.
class EnvResolver {
    /**
     * Resolve the effective env object from local + global sources.
     *   1. Local: <cwd>/.flowmcp/.env (project-specific override, optional)
     *   2. Global: configured envPath in ~/.flowmcp/config.json, or fallback ~/.flowmcp/.env
     *
     * Local keys override global keys when both present (merge, not replace).
     *
     * @param {Object} params
     * @param {string} params.cwd - Current working directory
     * @returns {Promise<{envObject: Object, sources: {local: string|null, global: string|null}}>}
     */
    static async resolveEnv( { cwd } ) {
        const localEnvPath = join( cwd, appConfig[ 'localConfigDirName' ], '.env' )
        const globalConfigPath = ConfigStore.globalConfigPath()
        const { data: globalConfig } = await FsUtils.readJson( { filePath: globalConfigPath } )
        const configuredGlobalEnv = ( globalConfig && globalConfig[ 'envPath' ] )
            ? globalConfig[ 'envPath' ]
            : join( ConfigStore.globalConfigDir(), appConfig[ 'defaultEnvFileName' ] )

        let globalEnv = {}
        let globalSourcePath = null
        const { data: globalContent } = await FsUtils.readText( { filePath: configuredGlobalEnv } )
        if( globalContent !== null ) {
            globalEnv = EnvResolver.parseEnvFile( { envContent: globalContent } ).envObject
            globalSourcePath = configuredGlobalEnv
        }

        let localEnv = {}
        let localSourcePath = null
        const { data: localContent } = await FsUtils.readText( { filePath: localEnvPath } )
        if( localContent !== null ) {
            localEnv = EnvResolver.parseEnvFile( { envContent: localContent } ).envObject
            localSourcePath = localEnvPath
        }

        const envObject = { ...globalEnv, ...localEnv }

        return {
            envObject,
            'sources': {
                'local': localSourcePath,
                'global': globalSourcePath
            }
        }
    }


    static parseEnvFile( { envContent } ) {
        const envObject = envContent
            .split( '\n' )
            .filter( ( line ) => {
                const isValid = line.includes( '=' ) && !line.startsWith( '#' )

                return isValid
            } )
            .reduce( ( acc, line ) => {
                const separatorIndex = line.indexOf( '=' )
                const key = line.slice( 0, separatorIndex ).trim()
                const value = line.slice( separatorIndex + 1 ).trim()
                acc[ key ] = value

                return acc
            }, {} )

        return { envObject }
    }


    static buildServerParams( { envObject, requiredServerParams } ) {
        const serverParams = requiredServerParams
            .reduce( ( acc, paramName ) => {
                const value = envObject[ paramName ]
                // Memo 119 Kap 5a — an empty/whitespace env value is treated as MISSING,
                // not injected as an empty credential. Injecting '' fired a live request
                // with an empty key (401) that was recorded as a false FAIL; omitting it
                // routes the schema to the key-gated "not evaluable" path (DPT-007),
                // consistent with how `search`/`list` flag a tool as disabled.
                if( EnvResolver.isKeyFilled( { value } ) ) {
                    acc[ paramName ] = value
                }

                return acc
            }, {} )

        return { serverParams }
    }


    /**
     * Check whether an env value is "filled" (non-placeholder, sufficiently long, real).
     * Used by env doctor to bucket keys into filled vs missing.
     */
    static isKeyFilled( { value } ) {
        if( value === undefined || value === null ) {
            return false
        }

        if( typeof value !== 'string' ) {
            return false
        }

        const trimmed = value.trim()
        if( trimmed.length === 0 ) {
            return false
        }

        // No minimum-length heuristic: many valid credentials are short — usernames
        // (GEONAMES_USERNAME, REGIONALSTATISTIK_USERNAME) and short API keys (OMDb
        // keys are 8 chars). A length gate produced false "missing" reports. Empty
        // and placeholder checks are the real signal.
        const placeholders = [ 'your_key_here', '<your-key', '# Example', 'YOUR_KEY', 'TODO' ]
        const lowered = trimmed.toLowerCase()
        const isPlaceholder = placeholders
            .find( ( pattern ) => {
                const match = lowered.includes( pattern.toLowerCase() )

                return match
            } )

        if( isPlaceholder ) {
            return false
        }

        return true
    }
}


export { EnvResolver }
