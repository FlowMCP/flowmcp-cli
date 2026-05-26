import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rm } from 'node:fs/promises'


// Memo 068 — runs once after the whole suite. Removes the per-file default
// homes that the global home-mock creates under <repo>/.test-home so they do
// not accumulate across runs. (createTestHome cleans its own per-suite dirs;
// this catches the global defaults that have no afterAll hook.)
export default async function globalTeardown() {
    const repoRoot = dirname( dirname( dirname( fileURLToPath( import.meta.url ) ) ) )
    const testHomeRoot = join( repoRoot, '.test-home' )

    await rm( testHomeRoot, { recursive: true, force: true } )
}
