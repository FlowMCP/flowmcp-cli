import { readFile, readdir, unlink, rmdir } from 'node:fs/promises'
import { join } from 'node:path'

import { HttpCache } from '../lib/HttpCache.mjs'
import { CliOutput } from '../lib/CliOutput.mjs'


// Memo 152 / PRD-019 (D-08) — the `flowmcp cache status` / `flowmcp cache clear`
// commands and their FS helpers. Reads the cache base dir from HttpCache; no
// back-reference to FlowMcpCli.
class CacheCommand {
    static async cacheClear( { namespace } ) {
        const cacheBase = HttpCache.cacheDir()

        try {
            if( namespace ) {
                const namespacePath = join( cacheBase, namespace )
                await CacheCommand.#removeDirRecursive( { dirPath: namespacePath } )

                const result = {
                    'status': true,
                    'message': `Cache cleared for namespace "${namespace}".`
                }

                return { result }
            }

            await CacheCommand.#removeDirRecursive( { dirPath: cacheBase } )

            const result = {
                'status': true,
                'message': 'All cache cleared.'
            }

            return { result }
        } catch( err ) {
            const result = CliOutput.error( {
                'error': `CCH-002 cacheClear: Failed to clear cache: ${err.message}`,
                'fix': `Check permissions on ${cacheBase}`
            } )

            return { result }
        }
    }


    static async #removeDirRecursive( { dirPath } ) {
        try {
            const entries = await readdir( dirPath, { withFileTypes: true } )

            await entries
                .reduce( ( promise, entry ) => promise.then( async () => {
                    const entryPath = join( dirPath, entry.name )

                    if( entry.isDirectory() ) {
                        await CacheCommand.#removeDirRecursive( { dirPath: entryPath } )
                    } else {
                        await unlink( entryPath )
                    }
                } ), Promise.resolve() )

            await rmdir( dirPath )
        } catch( err ) {
            // directory doesn't exist, nothing to clear
            CliOutput.emitCoded( { 'code': 'CLI-013', 'location': 'removeDir: recursive dir removal failed', err } )
        }
    }


    static async cacheStatus() {
        const cacheBase = HttpCache.cacheDir()
        const entries = []

        try {
            const namespaces = await readdir( cacheBase, { withFileTypes: true } )

            await namespaces
                .filter( ( entry ) => {
                    const isDir = entry.isDirectory()

                    return isDir
                } )
                .reduce( ( promise, nsEntry ) => promise.then( async () => {
                    const nsPath = join( cacheBase, nsEntry.name )
                    const files = await CacheCommand.#collectCacheFiles( { dirPath: nsPath, prefix: nsEntry.name } )
                    files
                        .forEach( ( file ) => {
                            entries.push( file )
                        } )
                } ), Promise.resolve() )
        } catch( err ) {
            // cache directory doesn't exist yet
            CliOutput.emitCoded( { 'code': 'HLT-003', 'location': 'cacheStatus: cache dir scan failed', err } )
        }

        const totalSize = entries
            .reduce( ( sum, entry ) => {
                const size = sum + ( entry[ 'size' ] || 0 )

                return size
            }, 0 )

        const result = {
            'status': true,
            'cacheDir': cacheBase,
            'totalEntries': entries.length,
            'totalSize': totalSize,
            entries
        }

        return { result }
    }


    static async #collectCacheFiles( { dirPath, prefix } ) {
        const collected = []

        try {
            const items = await readdir( dirPath, { withFileTypes: true } )

            await items
                .reduce( ( promise, item ) => promise.then( async () => {
                    const itemPath = join( dirPath, item.name )

                    if( item.isDirectory() ) {
                        const subFiles = await CacheCommand.#collectCacheFiles( {
                            dirPath: itemPath,
                            prefix: `${prefix}/${item.name}`
                        } )
                        subFiles
                            .forEach( ( file ) => {
                                collected.push( file )
                            } )
                    } else if( item.name.endsWith( '.json' ) ) {
                        try {
                            const raw = await readFile( itemPath, 'utf-8' )
                            const parsed = JSON.parse( raw )
                            const { meta } = parsed

                            const now = new Date()
                            const expiresAt = new Date( meta[ 'expiresAt' ] )
                            const isExpired = now >= expiresAt

                            collected.push( {
                                'key': `${prefix}/${item.name}`,
                                'fetchedAt': meta[ 'fetchedAt' ],
                                'expiresAt': meta[ 'expiresAt' ],
                                'ttl': meta[ 'ttl' ],
                                'size': meta[ 'size' ],
                                'expired': isExpired
                            } )
                        } catch( err ) {
                            // corrupt cache file, skip
                            process.stderr.write( `CCH-003 collectCacheFiles: corrupt cache file skipped: ${err.message}\n` )
                        }
                    }
                } ), Promise.resolve() )
        } catch( err ) {
            // directory doesn't exist
            CliOutput.emitCoded( { 'code': 'CCH-004', 'location': 'collectCacheFiles: cache dir read failed', err } )
        }

        return collected
    }
}


export { CacheCommand }
