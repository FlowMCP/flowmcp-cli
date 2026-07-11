import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import { appConfig } from '../data/config.mjs'
import { CliOutput } from './CliOutput.mjs'


// Memo 152 / PRD-019 (D-08 foundation cluster "handler-libraries") — the CLI's own package
// base + version stamp, extracted from FlowMcpCli so version() and doctor() are decoupled
// from the monolith. `resolveBase` is the CLI package root that ships the allowlisted runtime
// libs (ethers, better-sqlite3); it stays CLI-side and is passed to core (F17=A — the CLI
// computes resolveBases[], core resolves). Because both FlowMcpCli.mjs (src/task/) and this
// module (src/lib/) sit two directories under the repo root, `join( here, '..', '..' )`
// yields the identical base from either location.
class CliBase {
    static resolveBase() {
        // The CLI package root. createRequire wants a referencing filename, so callers anchor
        // on an index.js inside this base (need not exist).
        const here = dirname( fileURLToPath( import.meta.url ) )
        const resolveBase = join( here, '..', '..' )

        return { resolveBase }
    }


    // Memo 149 Strang D — the CLI's own version, read from its package.json (same
    // deterministic base as resolveBase). Answers "which flowmcp is running?" without guessing.
    static cliVersion() {
        try {
            const { resolveBase } = CliBase.resolveBase()
            const pkgPath = join( resolveBase, 'package.json' )
            const raw = readFileSync( pkgPath, 'utf-8' )
            const pkg = JSON.parse( raw )

            return { 'name': pkg[ 'name' ] || appConfig[ 'appName' ], 'version': pkg[ 'version' ] || 'unknown' }
        } catch( err ) {
            CliOutput.emitCoded( { 'code': 'CLI-028', 'location': 'cliVersion: package.json unreadable', err } )

            return { 'name': appConfig[ 'appName' ], 'version': 'unknown' }
        }
    }
}


export { CliBase }
