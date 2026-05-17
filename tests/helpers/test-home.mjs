import { jest } from '@jest/globals'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'


const REPO_ROOT = dirname( dirname( dirname( fileURLToPath( import.meta.url ) ) ) )


// Initialize global state used by the mocked os.homedir
if( globalThis.__FLOWMCP_TEST_HOME__ === undefined ) {
    globalThis.__FLOWMCP_TEST_HOME__ = null
}


jest.unstable_mockModule( 'node:os', async () => {
    const actual = await jest.requireActual( 'node:os' )

    function mockedHomedir() {
        if( globalThis.__FLOWMCP_TEST_HOME__ ) {
            return globalThis.__FLOWMCP_TEST_HOME__
        }

        return actual.homedir()
    }

    const mocked = {
        ...actual,
        homedir: mockedHomedir
    }

    return {
        ...mocked,
        default: mocked
    }
} )


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
        envPath: ( suffix = '' ) => join( globalConfigDir, `.env${suffix}` ),
        async setup() {
            await mkdir( globalConfigDir, { recursive: true } )
            globalThis.__FLOWMCP_TEST_HOME__ = root
        },
        async teardown() {
            globalThis.__FLOWMCP_TEST_HOME__ = null
            await rm( root, { recursive: true, force: true } )
        }
    }
}


export { createTestHome }
