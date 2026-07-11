import { readFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { appConfig } from '../data/config.mjs'
import { CliOutput } from './CliOutput.mjs'
import { FsUtils } from './FsUtils.mjs'


// Memo 152 / PRD-018 (D-07) — the namespace-index cache IO stays CLI-side. The
// catalog BUILD moved to core (CatalogIndex); only reading/writing the on-disk
// cache file (<cwd>/.flowmcp/namespace-index.json) belongs to the CLI. The file
// format is FROZEN (mcp-geo-app reads it, Memo 128) — this module never reshapes
// the index, it only serializes/deserializes it.
class NamespaceIndexCache {
    static async cachePath( { cwd } ) {
        const cachePath = join( cwd, appConfig[ 'localConfigDirName' ], 'namespace-index.json' )
        await mkdir( join( cwd, appConfig[ 'localConfigDirName' ] ), { recursive: true } )

        return { cachePath }
    }


    static async write( { cwd, index } ) {
        try {
            const { cachePath } = await NamespaceIndexCache.cachePath( { cwd } )
            // Namespace-index cache refresh is a deliberate, named overwrite (Memo 068 R2).
            await FsUtils.writeGuarded( { 'path': cachePath, 'content': JSON.stringify( index, null, 4 ), 'onExists': 'overwrite' } )

            return { 'success': true, 'path': cachePath }
        } catch( err ) {
            return { 'success': false, 'error': `CCH-008 writeNamespaceIndexCache: ${err.message}` }
        }
    }


    static async read( { cwd } ) {
        try {
            const { cachePath } = await NamespaceIndexCache.cachePath( { cwd } )

            let content
            try {
                content = await readFile( cachePath, 'utf-8' )
            } catch( err ) {
                CliOutput.emitCoded( { 'code': 'CCH-009', 'location': 'readNamespaceIndexCache: cache read failed', err } )
                return { 'exists': false, 'index': null }
            }

            try {
                const index = JSON.parse( content )

                return { 'exists': true, index, 'stale': false }
            } catch( parseErr ) {
                return { 'exists': true, 'index': null, 'stale': true, 'error': `CCH-010 readNamespaceIndexCache: ${parseErr.message}` }
            }
        } catch( err ) {
            return { 'exists': false, 'index': null, 'error': `CCH-011 readNamespaceIndexCache: ${err.message}` }
        }
    }
}


export { NamespaceIndexCache }
