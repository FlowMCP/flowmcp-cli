import { CatalogIndex } from 'flowmcp'

import { NamespaceIndexCache } from './NamespaceIndexCache.mjs'
import { SchemaLoaderBridge } from './SchemaLoaderBridge.mjs'


// Memo 152 / PRD-019 (D-08 foundation cluster "namespace-index") — the build + get
// orchestration for the namespace-index, extracted from FlowMcpCli. Schema discovery
// stays CLI-side (schemaFolders[] iteration via SchemaLoaderBridge.loadAllSchemas), the
// catalog transform is the core v4 CatalogIndex.build, and the on-disk cache IO lives in
// NamespaceIndexCache. The on-disk file format is FROZEN (mcp-geo-app reads it, Memo 128)
// and D-07 requires namespace-index.json stay BYTE-STABLE — this module preserves the exact
// build pipeline (loadAllSchemas -> CatalogIndex.build) and the exact JSON serialization,
// so a golden fixture before/after is identical.
class NamespaceIndex {
    static async build( { cwd } ) {
        const { schemas } = await SchemaLoaderBridge.loadAllSchemas()

        return CatalogIndex.build( { schemas } )
    }


    static async get( { cwd, forceRebuild = false } ) {
        if( forceRebuild ) {
            const { index } = await NamespaceIndex.build( { cwd } )
            await NamespaceIndexCache.write( { cwd, index } )

            return { index, 'source': 'rebuilt' }
        }

        const { exists, index: cachedIndex, stale } = await NamespaceIndexCache.read( { cwd } )

        if( exists && cachedIndex && !stale ) {
            return { 'index': cachedIndex, 'source': 'cache' }
        }

        const { index } = await NamespaceIndex.build( { cwd } )
        await NamespaceIndexCache.write( { cwd, index } )

        return { index, 'source': 'rebuilt' }
    }


    static async tryGet( { cwd } ) {
        try {
            const { index } = await NamespaceIndex.get( { cwd } )

            return { index }
        } catch {
            return null
        }
    }
}


export { NamespaceIndex }
