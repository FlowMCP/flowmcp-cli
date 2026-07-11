import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { ConfigStore } from '../lib/ConfigStore.mjs'
import { CliOutput } from '../lib/CliOutput.mjs'


// Memo 152 / PRD-019 (D-08 cluster "catalog-skill", partial) — the two self-contained catalog
// read/validate commands extracted from FlowMcpCli: `catalog sources` (lists the linked local
// sources) and `validate-catalog` (structural registry.json check, CAT001..CAT007). The larger
// generateSkill / generateCatalog members of this cluster, plus importAgent and catalog
// link/unlink, stay in FlowMcpCli untouched (importAgent + link/unlink deletion is PRD-020
// G-11/G-12). FlowMcpCli.catalogSources / validateCatalog stay as public delegations (index.mjs
// + the catalog test call them). No back-reference to FlowMcpCli — lib deps only.
class CatalogCommand {
    static async catalogSources() {
        const { localSources } = await ConfigStore.readLocalSources()

        const linked = Object.entries( localSources )
            .map( ( [ name, entry ] ) => {
                const sourceInfo = { name, 'path': entry[ 'path' ] }

                return sourceInfo
            } )

        const result = {
            'status': true,
            'count': linked.length,
            'sources': linked
        }

        return { result }
    }


    static async validateCatalog( { catalogDir, cwd } ) {
        if( !catalogDir ) {
            return { result: CliOutput.error( { error: 'Missing catalog directory', fix: 'flowmcp validate-catalog <catalog-directory>' } ) }
        }

        const registryPath = join( catalogDir, 'registry.json' )
        let registryData = null

        try {
            const content = await readFile( registryPath, 'utf-8' )
            registryData = JSON.parse( content )
        } catch( err ) {
            return { result: { status: false, errors: [ `CAT001: registry.json must exist in catalog root — ${err.message}` ], warnings: [] } }
        }

        const errors = []
        const warnings = []

        const dirName = catalogDir.split( '/' ).pop()

        if( registryData[ 'name' ] !== dirName ) {
            errors.push( `CAT002: name "${registryData[ 'name' ]}" must match directory name "${dirName}"` )
        }

        const shared = registryData[ 'shared' ] || []

        await Promise.allSettled(
            shared
                .map( async ( entry ) => {
                    const filePath = join( catalogDir, entry[ 'file' ] )

                    try {
                        await stat( filePath )
                    } catch( err ) {
                        errors.push( `CAT003: shared file not found — ${entry[ 'file' ]}` )
                    }
                } )
        )

        const schemas = registryData[ 'schemas' ] || []

        await Promise.allSettled(
            schemas
                .map( async ( entry ) => {
                    const filePath = join( catalogDir, entry[ 'file' ] )

                    try {
                        await stat( filePath )
                    } catch( err ) {
                        errors.push( `CAT004: schema file not found — ${entry[ 'file' ]}` )
                    }
                } )
        )

        const agents = registryData[ 'agents' ] || []

        await Promise.allSettled(
            agents
                .map( async ( entry ) => {
                    const filePath = join( catalogDir, entry[ 'manifest' ] )

                    try {
                        await stat( filePath )
                    } catch( err ) {
                        errors.push( `CAT005: agent manifest not found — ${entry[ 'manifest' ]}` )
                    }
                } )
        )

        const specVersion = registryData[ 'schemaSpec' ] || ''
        const validVersions = [ '2.0.0', '3.0.0' ]

        if( !validVersions.includes( specVersion ) ) {
            errors.push( `CAT007: schemaSpec "${specVersion}" is not a valid FlowMCP specification version` )
        }

        const result = {
            status: errors.length === 0,
            catalog: registryData[ 'name' ] || dirName,
            schemaSpec: specVersion,
            counts: {
                shared: shared.length,
                schemas: schemas.length,
                agents: agents.length
            },
            errors,
            warnings
        }

        return { result }
    }
}


export { CatalogCommand }
