import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'


// Memo 152 / PRD-020 (F-11) — Dispatch-Roundtrip coverage for the tree dispatcher
// in src/index.mjs (previously 0 direct suites). Each test drives the real CLI as a
// subprocess (the execFile pattern of cli-grading-dispatch.test.mjs) and proves that
// index.mjs routes a command to the correct FlowMcpCli command surface: the response
// is the command's OWN output/error, never the generic unknown-command fallback.
// Removed routes (import-agent, catalog link/unlink, run --group) get negative tests.

jest.setTimeout( 30000 )


const here = dirname( fileURLToPath( import.meta.url ) )
const cliBin = join( here, '..', '..', 'src', 'index.mjs' )


let sandboxHome


beforeAll( async () => {
    // Isolated HOME so the subprocess never reads the developer's real ~/.flowmcp —
    // deterministic output + test-isolation (never touch the real home, Memo 032).
    sandboxHome = await mkdtemp( join( tmpdir(), 'flowmcp-dispatch-home-' ) )
} )


afterAll( async () => {
    await rm( sandboxHome, { recursive: true, force: true } )
} )


const runCli = ( { args } ) => {
    return new Promise( ( resolve ) => {
        const env = { ...process.env, 'HOME': sandboxHome, 'USERPROFILE': sandboxHome }
        const child = execFile( process.execPath, [ cliBin, ...args ], { 'encoding': 'utf8', 'cwd': sandboxHome, env }, ( error, stdout, stderr ) => {
            const code = error && typeof error.code === 'number' ? error.code : 0
            resolve( { stdout, stderr, code } )
        } )
        // Close stdin so an interactive command (init) gets EOF instead of hanging.
        child.stdin.end()
    } )
}


// A routed command produces its own JSON envelope, never the top-level
// `Unknown command "<x>"` fallback from main().
const expectRouted = ( { stdout } ) => {
    expect( stdout ).not.toContain( 'Unknown command "' )
    const parsed = JSON.parse( stdout )
    expect( typeof parsed ).toBe( 'object' )

    return parsed
}


describe( 'index.mjs dispatch — help / version', () => {
    it( 'routes --version to the version stamp', async () => {
        const { stdout } = await runCli( { 'args': [ '--version' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'status' ] ).toBe( true )
        expect( typeof parsed[ 'name' ] ).toBe( 'string' )
        expect( parsed[ 'version' ] ).toMatch( /^\d+\.\d+\.\d+/ )
    } )

    it( 'routes the `version` command to the version stamp', async () => {
        const { stdout } = await runCli( { 'args': [ 'version' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'status' ] ).toBe( true )
        expect( parsed[ 'version' ] ).toMatch( /^\d+\.\d+\.\d+/ )
    } )

    it( 'no command prints the usage help', async () => {
        const { stdout } = await runCli( { 'args': [] } )

        expect( stdout ).toContain( 'Usage:' )
    } )

    it( '--help prints the usage help', async () => {
        const { stdout } = await runCli( { 'args': [ '--help' ] } )

        expect( stdout ).toContain( 'Usage:' )
    } )

    it( 'routes how-to to the getting-started guide', async () => {
        const { stdout } = await runCli( { 'args': [ 'how-to' ] } )

        expect( stdout ).toContain( 'How to use' )
        expect( stdout ).not.toContain( 'Unknown command "' )
    } )

    it( 'routes `dev --help` to the dev help (dev-prefix branch)', async () => {
        const { stdout } = await runCli( { 'args': [ 'dev', '--help' ] } )

        expect( stdout.length ).toBeGreaterThan( 0 )
        expect( stdout ).not.toContain( 'Unknown command "' )
    } )
} )


describe( 'index.mjs dispatch — discovery (search / list / schemas)', () => {
    it( 'routes `search <query>` to SearchCommand', async () => {
        const { stdout } = await runCli( { 'args': [ 'search', 'dune' ] } )
        const parsed = expectRouted( { stdout } )

        expect( typeof parsed[ 'status' ] ).toBe( 'boolean' )
    } )

    it( 'routes `list` to ListCommand', async () => {
        const { stdout } = await runCli( { 'args': [ 'list' ] } )

        expectRouted( { stdout } )
    } )

    it( 'routes `schemas` to ValidateCommand.schemas', async () => {
        const { stdout } = await runCli( { 'args': [ 'schemas' ] } )

        expectRouted( { stdout } )
    } )
} )


describe( 'index.mjs dispatch — call branch', () => {
    it( 'routes `call list-tools` to callListTools', async () => {
        const { stdout } = await runCli( { 'args': [ 'call', 'list-tools' ] } )

        expectRouted( { stdout } )
    } )

    it( 'routes `call <tool> <json>` to callTool (passthrough)', async () => {
        const { stdout } = await runCli( { 'args': [ 'call', 'some_tool', '{}' ] } )
        const parsed = expectRouted( { stdout } )

        expect( parsed[ 'status' ] ).toBe( false )
    } )
} )


describe( 'index.mjs dispatch — cache branch', () => {
    it( 'routes `cache status` to cacheStatus', async () => {
        const { stdout } = await runCli( { 'args': [ 'cache', 'status' ] } )
        const parsed = expectRouted( { stdout } )

        expect( parsed[ 'status' ] ).toBe( true )
    } )

    it( 'an unknown cache sub-command hits the cache-branch fallback', async () => {
        const { stdout } = await runCli( { 'args': [ 'cache', 'bogus' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'error' ] ).toContain( 'Unknown cache command' )
    } )
} )


describe( 'index.mjs dispatch — diagnostics (status / doctor)', () => {
    it( 'routes `status` to the status method', async () => {
        const { stdout } = await runCli( { 'args': [ 'status' ] } )
        const parsed = expectRouted( { stdout } )

        expect( parsed[ 'status' ] ).toBe( true )
        expect( Array.isArray( parsed[ 'checks' ] ) ).toBe( true )
    } )

    it( 'routes `doctor` to the structural health check (coded error, exits 1)', async () => {
        const { stdout, code } = await runCli( { 'args': [ 'doctor' ] } )
        const parsed = JSON.parse( stdout )

        expect( stdout ).not.toContain( 'Unknown command "' )
        expect( parsed[ 'status' ] ).toBe( false )
        // No config in the sandbox home -> DoctorCommand short-circuits with a coded
        // structural error (CFG-001), proving the route reached the doctor surface.
        expect( parsed[ 'code' ] ).toBe( 'CFG-001' )
        expect( code ).toBe( 1 )
    } )
} )


describe( 'index.mjs dispatch — run (stdio MCP server) removed (Memo 158)', () => {
    it( 'the removed `run` command falls through to the Unknown-command surface', async () => {
        const { stdout } = await runCli( { 'args': [ 'run' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'status' ] ).toBe( false )
        expect( parsed[ 'error' ] ).toContain( 'Unknown command' )
    } )
} )


describe( 'index.mjs dispatch — catalog / skill / validate-catalog', () => {
    it( 'routes `catalog sources` to catalogSources', async () => {
        const { stdout } = await runCli( { 'args': [ 'catalog', 'sources' ] } )
        const parsed = expectRouted( { stdout } )

        expect( parsed[ 'status' ] ).toBe( true )
    } )

    it( 'the removed `catalog link` hits the catalog-branch fallback (G-12)', async () => {
        const { stdout } = await runCli( { 'args': [ 'catalog', 'link', 'x' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'error' ] ).toBe( 'Unknown catalog command "link".' )
    } )

    it( 'the removed `catalog unlink` hits the catalog-branch fallback (G-12)', async () => {
        const { stdout } = await runCli( { 'args': [ 'catalog', 'unlink', 'x' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'error' ] ).toBe( 'Unknown catalog command "unlink".' )
    } )

    it( 'routes `skill generate <tool>` to generateSkill', async () => {
        const { stdout } = await runCli( { 'args': [ 'skill', 'generate', 'demoTool' ] } )

        expectRouted( { stdout } )
    } )

    it( 'routes `validate-catalog <dir>` to validateCatalog', async () => {
        const { stdout } = await runCli( { 'args': [ 'validate-catalog', '/nope' ] } )
        const parsed = JSON.parse( stdout )

        expect( stdout ).not.toContain( 'Unknown command "' )
        expect( parsed[ 'status' ] ).toBe( false )
    } )
} )


describe( 'index.mjs dispatch — prompt / lists / selection', () => {
    it( 'routes `prompt list` to promptList', async () => {
        const { stdout } = await runCli( { 'args': [ 'prompt', 'list' ] } )

        expectRouted( { stdout } )
    } )

    it( 'routes `lists` to listSharedLists', async () => {
        const { stdout } = await runCli( { 'args': [ 'lists' ] } )

        expectRouted( { stdout } )
    } )

    it( 'routes `selection list` to selectionList', async () => {
        const { stdout } = await runCli( { 'args': [ 'selection', 'list' ] } )
        const parsed = expectRouted( { stdout } )

        expect( parsed[ 'status' ] ).toBe( true )
    } )
} )


describe( 'index.mjs dispatch — allowlist branch', () => {
    it( 'routes `allowlist list` to the allowlist command', async () => {
        const { stdout } = await runCli( { 'args': [ 'allowlist', 'list' ] } )
        const parsed = expectRouted( { stdout } )

        expect( parsed[ 'action' ] ).toBe( 'list' )
    } )

    it( 'bare `allowlist` hits the allowlist-branch fallback', async () => {
        const { stdout } = await runCli( { 'args': [ 'allowlist' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'error' ] ).toContain( 'Missing or unknown allowlist sub-command' )
    } )
} )


describe( 'index.mjs dispatch — env branch (+ dev-prefix strip)', () => {
    it( 'routes `env doctor --json` to EnvCommand', async () => {
        const { stdout } = await runCli( { 'args': [ 'env', 'doctor', '--json' ] } )
        const parsed = expectRouted( { stdout } )

        expect( parsed[ 'status' ] ).toBe( true )
    } )

    it( 'bare `env` hits the env-branch fallback', async () => {
        const { stdout } = await runCli( { 'args': [ 'env' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'error' ] ).toContain( 'Missing or unknown env sub-command' )
    } )

    it( '`dev env` strips the dev prefix and routes to the env branch', async () => {
        const { stdout } = await runCli( { 'args': [ 'dev', 'env' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'error' ] ).toContain( 'Missing or unknown env sub-command' )
    } )
} )


describe( 'index.mjs dispatch — resource branch', () => {
    it( 'routes `resource migrate` to resourceMigrate', async () => {
        const { stdout } = await runCli( { 'args': [ 'resource', 'migrate', '--dry-run' ] } )

        expectRouted( { stdout } )
    } )

    it( 'an unknown resource sub-command hits the resource-branch fallback', async () => {
        const { stdout } = await runCli( { 'args': [ 'resource', 'bogus' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'error' ] ).toBe( 'Unknown resource command "bogus".' )
    } )
} )


describe( 'index.mjs dispatch — schema-check / migrate / migrate-config', () => {
    it( 'routes `schema-check <path>` to ValidateCommand.validate', async () => {
        const { stdout } = await runCli( { 'args': [ 'schema-check', '/nope.mjs' ] } )

        expectRouted( { stdout } )
    } )

    it( 'routes `migrate <path>` to MigrateCommand.migrate', async () => {
        const { stdout } = await runCli( { 'args': [ 'migrate', '/nope.mjs' ] } )

        expectRouted( { stdout } )
    } )

    it( 'routes `migrate-config` to MigrateCommand.migrateConfig', async () => {
        const { stdout } = await runCli( { 'args': [ 'migrate-config', '--dry-run' ] } )

        expectRouted( { stdout } )
    } )
} )


describe( 'index.mjs dispatch — grading branch (gap-fill vs cli-grading-dispatch)', () => {
    it( 'routes `grading deterministic` (no target) to gradingDeterministic', async () => {
        const { stdout } = await runCli( { 'args': [ 'grading', 'deterministic' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'status' ] ).toBe( false )
        expect( parsed[ 'error' ] ).toContain( 'Missing grading target' )
    } )

    it( 'routes `grading config` to gradingConfig', async () => {
        const { stdout } = await runCli( { 'args': [ 'grading', 'config' ] } )

        expect( stdout ).not.toContain( 'Missing or unknown grading sub-command' )
        expect( stdout ).not.toContain( 'Unknown command "' )
        JSON.parse( stdout )
    } )
} )


describe( 'index.mjs dispatch — init', () => {
    it( 'routes `init` to the setup command (no unknown-command fallback, no hang)', async () => {
        const { stdout, stderr } = await runCli( { 'args': [ 'init' ] } )
        const blob = stdout + stderr

        expect( blob ).not.toContain( 'Unknown command "init"' )
    } )
} )


describe( 'index.mjs dispatch — removed / unknown top-level routes', () => {
    it( 'the removed `import-agent` route yields the unknown-command fallback (G-11)', async () => {
        const { stdout } = await runCli( { 'args': [ 'import-agent', 'x' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'error' ] ).toBe( 'Unknown command "import-agent".' )
        expect( parsed[ 'fix' ] ).toContain( '--help' )
    } )

    it( 'a genuinely unknown command yields the unknown-command fallback', async () => {
        const { stdout } = await runCli( { 'args': [ 'totally-not-a-command' ] } )
        const parsed = JSON.parse( stdout )

        expect( parsed[ 'error' ] ).toBe( 'Unknown command "totally-not-a-command".' )
    } )
} )
