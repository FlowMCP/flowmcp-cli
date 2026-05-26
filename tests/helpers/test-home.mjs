import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'


const REPO_ROOT = dirname( dirname( dirname( fileURLToPath( import.meta.url ) ) ) )


// NOTE: The `node:os` mock now lives in the global Jest setup
// (tests/setup/global-home-mock.mjs, wired via setupFiles). It mocks
// homedir() AND tmpdir() repo-wide BEFORE any test module is imported, so a
// module-level `join( homedir(), '.flowmcp' )` binding can no longer escape
// to the real home. createTestHome only switches the active home directory
// by writing globalThis.__FLOWMCP_TEST_HOME__; the global mock reads it.


function createTestHome( { suite } ) {
    const id = `${suite}-${randomBytes( 4 ).toString( 'hex' )}`
    const root = join( REPO_ROOT, '.test-home', id )
    const globalConfigDir = join( root, '.flowmcp' )

    return {
        root,
        globalConfigDir,
        globalConfigPath: join( globalConfigDir, 'config.json' ),
        schemasDir: join( globalConfigDir, 'schemas' ),
        cacheDir: join( globalConfigDir, 'cache' ),
        tmpDir: join( root, 'tmp' ),
        envPath: ( suffix = '' ) => join( globalConfigDir, `.env${suffix}` ),
        async setup() {
            await mkdir( globalConfigDir, { recursive: true } )
            await mkdir( join( root, 'tmp' ), { recursive: true } )
            globalThis.__FLOWMCP_TEST_HOME__ = root
        },
        async teardown() {
            // Restore to the per-file default home (never null) so homedir()
            // can never fall back to the real home after teardown.
            globalThis.__FLOWMCP_TEST_HOME__ = globalThis.__FLOWMCP_DEFAULT_TEST_HOME__ ?? root
            const attempts = [ 1, 2, 3 ]
            const result = await attempts
                .reduce( async ( prev, attempt ) => {
                    const done = await prev
                    if( done ) { return true }
                    try {
                        await rm( root, { recursive: true, force: true } )
                        return true
                    } catch( err ) {
                        if( attempt === attempts.length ) { return true }
                        await new Promise( ( res ) => setTimeout( res, 100 * attempt ) )
                        return false
                    }
                }, Promise.resolve( false ) )
            return result
        }
    }
}


export { createTestHome }
