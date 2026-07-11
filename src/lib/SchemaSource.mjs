/**
 * FlowMCP — MIT License
 *
 * SchemaSource (Memo 152 PRD-017 / D-04) — schemaFolders[] path resolution: turn
 * a schema ref (`<source>/<rest>`) into an on-disk file path. This is the CLI
 * side of the boundary (WHERE a schema lives); LOADING it (reading the module,
 * resolving handlers/libraries) moves to core in PRD-018. Depends on ConfigStore
 * for the source-dir resolution.
 *
 * NOTE (G-12, PRD-020): the localSources fallback lives in ConfigStore
 * (resolveSourceDir); #listSources itself stays in FlowMcpCli until PRD-018 lifts
 * its schema-loading back-dependency (#listSchemaFiles → core).
 */

import { join } from 'node:path'

import { ConfigStore } from './ConfigStore.mjs'


class SchemaSource {
    static async resolveSchemaPath( { schemaRef } ) {
        if( typeof schemaRef !== 'string' || schemaRef.length === 0 ) {
            return { filePath: join( ConfigStore.schemasDir(), String( schemaRef ) ), isLocal: false }
        }

        const slashIndex = schemaRef.indexOf( '/' )
        if( slashIndex === -1 ) {
            return { filePath: join( ConfigStore.schemasDir(), schemaRef ), isLocal: false }
        }

        const sourceName = schemaRef.slice( 0, slashIndex )
        const rest = schemaRef.slice( slashIndex + 1 )
        const { sourceDir, isLocal } = await ConfigStore.resolveSourceDir( { sourceName } )
        const filePath = join( sourceDir, rest )

        return { filePath, isLocal }
    }


    // Memo 149 Strang B (F4=B) — single source of truth for a schema's on-disk file
    // path. callTool (param + handler path), serve and the resource-query path all
    // resolve through here.
    static async resolveSchemaFilePath( { schemaRef } ) {
        if( !schemaRef ) {
            return { filePath: '' }
        }

        const { filePath } = await SchemaSource.resolveSchemaPath( { schemaRef } )

        return { filePath }
    }
}


export { SchemaSource }
