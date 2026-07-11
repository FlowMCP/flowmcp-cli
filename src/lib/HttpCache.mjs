import { readFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'

import { appConfig } from '../data/config.mjs'
import { ConfigStore } from './ConfigStore.mjs'
import { FsUtils } from './FsUtils.mjs'
import { CliOutput } from './CliOutput.mjs'


// Memo 152 / PRD-019 (D-08) — the HTTP response-cache primitives used by the call
// path: the cache base dir, the deterministic cache key (namespace/route + a sorted
// param hash) and the read/write of a { meta, data } cache entry. The `flowmcp cache`
// command (status/clear) lives in src/commands/CacheCommand.mjs and calls cacheDir().
class HttpCache {
    static cacheDir() {
        const dir = join( ConfigStore.globalConfigDir(), appConfig[ 'cacheDirName' ] )

        return dir
    }


    static buildCacheKey( { namespace, routeName, userParams } ) {
        const hasParams = Object.keys( userParams ).length > 0
        if( !hasParams ) {
            const cacheKey = `${namespace}/${routeName}.json`

            return { cacheKey }
        }

        const sortedJson = JSON.stringify(
            Object.keys( userParams )
                .sort()
                .reduce( ( acc, key ) => {
                    acc[ key ] = userParams[ key ]

                    return acc
                }, {} )
        )

        const paramHash = createHash( 'sha256' )
            .update( sortedJson )
            .digest( 'hex' )
            .slice( 0, 12 )
        const cacheKey = `${namespace}/${routeName}/${paramHash}.json`

        return { cacheKey }
    }


    static async readCache( { cacheKey } ) {
        const cachePath = join( HttpCache.cacheDir(), cacheKey )

        try {
            const raw = await readFile( cachePath, 'utf-8' )
            const cached = JSON.parse( raw )
            const { meta, data } = cached

            const now = new Date()
            const expiresAt = new Date( meta[ 'expiresAt' ] )
            const isExpired = now >= expiresAt

            return { data, meta, isExpired, cachePath }
        } catch( err ) {
            CliOutput.emitCoded( { 'code': 'CCH-001', 'location': 'readCache: cache read failed', err } )

            return { data: null, meta: null, isExpired: true, cachePath }
        }
    }


    static async writeCache( { cacheKey, data, ttl } ) {
        const cachePath = join( HttpCache.cacheDir(), cacheKey )
        const cacheDirectory = dirname( cachePath )
        await mkdir( cacheDirectory, { recursive: true } )

        const now = new Date()
        const expiresAt = new Date( now.getTime() + ttl * 1000 )
        const dataString = JSON.stringify( data )

        const cacheEntry = {
            'meta': {
                'fetchedAt': now.toISOString(),
                'expiresAt': expiresAt.toISOString(),
                ttl,
                'size': dataString.length
            },
            data
        }

        // Cache refresh is a deliberate, named overwrite (Memo 068 R2 verschärft) — never silent.
        await FsUtils.writeGuarded( { 'path': cachePath, 'content': JSON.stringify( cacheEntry, null, 2 ), 'onExists': 'overwrite' } )

        return { cachePath, meta: cacheEntry[ 'meta' ] }
    }
}


export { HttpCache }
