import { jest } from '@jest/globals'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'


// tests/setup/global-home-mock.mjs -> dirname x3 = repo root
const REPO_ROOT = dirname( dirname( dirname( fileURLToPath( import.meta.url ) ) ) )


// Each test file gets its own home directory under <repo>/.test-home/.
// Set BEFORE any test module is imported, so even a module-level
// `join( homedir(), '.flowmcp' )` binding resolves inside the repo.
const suiteId = `global-${randomBytes( 6 ).toString( 'hex' )}`
const defaultHome = join( REPO_ROOT, '.test-home', suiteId )

mkdirSync( join( defaultHome, '.flowmcp' ), { recursive: true } )
mkdirSync( join( defaultHome, 'tmp' ), { recursive: true } )

globalThis.__FLOWMCP_REPO_ROOT__ = REPO_ROOT
globalThis.__FLOWMCP_DEFAULT_TEST_HOME__ = defaultHome

if( globalThis.__FLOWMCP_TEST_HOME__ === undefined || globalThis.__FLOWMCP_TEST_HOME__ === null ) {
    globalThis.__FLOWMCP_TEST_HOME__ = defaultHome
}


function currentHome() {
    return globalThis.__FLOWMCP_TEST_HOME__ || globalThis.__FLOWMCP_DEFAULT_TEST_HOME__
}


jest.unstable_mockModule( 'node:os', async () => {
    const actual = await jest.requireActual( 'node:os' )

    // Never returns the real home — the structural guarantee. Even after a
    // teardown that nulls __FLOWMCP_TEST_HOME__, we fall back to the per-file
    // default inside <repo>/.test-home, never to actual.homedir().
    function mockedHomedir() {
        return currentHome()
    }

    // tmpdir() is redirected into <home>/tmp so tests that use it as a scratch
    // working directory stay inside the repo. Created lazily to survive
    // per-suite home switches.
    function mockedTmpdir() {
        const tmpPath = join( currentHome(), 'tmp' )
        mkdirSync( tmpPath, { recursive: true } )

        return tmpPath
    }

    const mocked = {
        ...actual,
        homedir: mockedHomedir,
        tmpdir: mockedTmpdir
    }

    return {
        ...mocked,
        default: mocked
    }
} )
