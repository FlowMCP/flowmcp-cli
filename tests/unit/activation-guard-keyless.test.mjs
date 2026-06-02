import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { createTestHome } from '../helpers/test-home.mjs'


const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


const SOURCE_NAME = 'geosrc'


function schemaFile( { namespace, requiredKeys = [], routeName = 'ping' } ) {
    return `export const main = {
    namespace: '${namespace}',
    name: '${namespace} API',
    description: 'Test schema',
    version: '4.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://example.com',
    requiredServerParams: ${JSON.stringify( requiredKeys )},
    headers: {},
    tools: {
        ${routeName}: { method: 'GET', description: 'Test', path: '/', parameters: [] }
    }
}
`
}


// Memo 092 PRD-L (decision #6): keyless-first activation. The guard must
// partition mixed provider sets instead of all-or-nothing blocking.
describe( 'activation guard — keyless-first (Memo 092 PRD-L)', () => {
    const testHome = createTestHome( { suite: 'keyless' } )
    const sourceDir = join( testHome.schemasDir, SOURCE_NAME )
    let projectDir


    beforeAll( async () => {
        await testHome.setup()
        projectDir = join( testHome.root, 'project' )
        await mkdir( join( projectDir, '.flowmcp' ), { recursive: true } )
        await mkdir( sourceDir, { recursive: true } )

        // keyless provider (no key needed)
        await writeFile( join( sourceDir, 'nominatim.mjs' ), schemaFile( {
            'namespace': 'nominatim',
            'requiredKeys': [],
            'routeName': 'forward'
        } ), 'utf-8' )

        // key-gated provider (needs a real API key)
        await writeFile( join( sourceDir, 'geoapify.mjs' ), schemaFile( {
            'namespace': 'geoapify',
            'requiredKeys': [ 'GEOAPIFY_API_KEY' ],
            'routeName': 'forward'
        } ), 'utf-8' )

        // keyless provider whose only required param is a non-secret identity
        // param (NOMINATIM_USER_AGENT). Must NOT be treated as a blocking key.
        await writeFile( join( sourceDir, 'nominatim-ua.mjs' ), schemaFile( {
            'namespace': 'nominatimua',
            'requiredKeys': [ 'NOMINATIM_USER_AGENT' ],
            'routeName': 'forward'
        } ), 'utf-8' )

        const registry = {
            'name': SOURCE_NAME,
            'version': '1.0.0',
            'schemaSpec': '4.0.0',
            'schemas': [
                { 'namespace': 'nominatim', 'file': 'nominatim.mjs', 'name': 'nominatim', 'requiredServerParams': [] },
                { 'namespace': 'geoapify', 'file': 'geoapify.mjs', 'name': 'geoapify', 'requiredServerParams': [ 'GEOAPIFY_API_KEY' ] },
                { 'namespace': 'nominatimua', 'file': 'nominatim-ua.mjs', 'name': 'nominatimua', 'requiredServerParams': [ 'NOMINATIM_USER_AGENT' ] }
            ]
        }

        await writeFile( join( sourceDir, '_registry.json' ), JSON.stringify( registry, null, 4 ), 'utf-8' )

        const globalConfig = {
            'envPath': testHome.envPath(),
            'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc', 'schemaSpec': '4.0.0' },
            'initialized': new Date().toISOString(),
            'sources': { [SOURCE_NAME]: { 'type': 'builtin', 'schemaCount': 3 } }
        }

        await writeFile( testHome.globalConfigPath, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
    } )


    afterAll( async () => {
        await testHome.teardown()
    } )


    beforeEach( async () => {
        await rm( testHome.envPath(), { force: true } )
        await rm( join( projectDir, '.flowmcp', 'config.json' ), { force: true } )
        await rm( join( projectDir, '.flowmcp', 'namespace-index.json' ), { force: true } )
        await writeFile( join( projectDir, '.flowmcp', 'config.json' ), JSON.stringify( {
            'root': '~/.flowmcp',
            'tools': []
        }, null, 4 ), 'utf-8' )
    } )


    // (a) keyless provider activates with no keys present
    it( 'activates a keyless provider when no keys are present (public add path)', async () => {
        await writeFile( testHome.envPath(), '', 'utf-8' )

        const { result } = await FlowMcpCli.add( {
            'toolName': 'nominatim/tool/forward',
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'added' ] ).toBe( 'nominatim/tool/forward' )
    } )


    // (a) partition: keyless activates, key-gated degraded — in ONE guard call
    it( 'partitions mixed set: keyless activatable, key-gated degraded', async () => {
        await writeFile( testHome.envPath(), '', 'utf-8' )

        const { allowed, activatableRefs, degraded } = await FlowMcpCli._testActivationGuard( {
            'schemaFiles': [ `${SOURCE_NAME}/nominatim.mjs`, `${SOURCE_NAME}/geoapify.mjs` ],
            'cwd': projectDir,
            'toolName': 'geo-set'
        } )

        expect( allowed ).toBe( true )
        expect( activatableRefs ).toContain( `${SOURCE_NAME}/nominatim.mjs` )
        expect( activatableRefs ).not.toContain( `${SOURCE_NAME}/geoapify.mjs` )

        const degradedNamespaces = degraded
            .map( ( d ) => d[ 'namespace' ] )
        expect( degradedNamespaces ).toContain( 'geoapify' )

        const degradedKeys = degraded
            .reduce( ( acc, d ) => acc.concat( d[ 'missingKeys' ] ), [] )
        expect( degradedKeys ).toContain( 'GEOAPIFY_API_KEY' )
    } )


    // (b) key-gated provider still blocks without key
    it( 'blocks a key-gated-only provider without a key (no keyless sibling)', async () => {
        await writeFile( testHome.envPath(), '', 'utf-8' )

        const { result } = await FlowMcpCli.add( {
            'toolName': 'geoapify/tool/forward',
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toMatch( /no keyless provider/ )
        expect( result[ 'error' ] ).toContain( 'GEOAPIFY_API_KEY' )
    } )


    // (b) key-gated provider works with --force
    it( 'activates a key-gated provider with --force despite missing key', async () => {
        await writeFile( testHome.envPath(), '', 'utf-8' )

        const { result } = await FlowMcpCli.add( {
            'toolName': 'geoapify/tool/forward',
            'cwd': projectDir,
            'force': true
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'added' ] ).toBe( 'geoapify/tool/forward' )
    } )


    // (b) key-gated provider activates when the key IS present
    it( 'activates a key-gated provider when its key is filled', async () => {
        await writeFile( testHome.envPath(), 'GEOAPIFY_API_KEY=real-key-with-enough-length\n', 'utf-8' )

        const { result } = await FlowMcpCli.add( {
            'toolName': 'geoapify/tool/forward',
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'added' ] ).toBe( 'geoapify/tool/forward' )
    } )


    // (c) a _USER_AGENT identity param does NOT block activation
    it( 'does NOT block activation on a missing _USER_AGENT identity param (public add path)', async () => {
        await writeFile( testHome.envPath(), '', 'utf-8' )

        const { result } = await FlowMcpCli.add( {
            'toolName': 'nominatimua/tool/forward',
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'added' ] ).toBe( 'nominatimua/tool/forward' )
    } )


    // (c) guard-level: identity param is non-blocking, surfaced as setup hint
    it( 'treats _USER_AGENT as non-blocking with an explicit setup hint', async () => {
        await writeFile( testHome.envPath(), '', 'utf-8' )

        const { allowed, activatableRefs, degraded } = await FlowMcpCli._testActivationGuard( {
            'schemaFiles': [ `${SOURCE_NAME}/nominatim-ua.mjs` ],
            'cwd': projectDir,
            'toolName': 'nominatim-ua'
        } )

        expect( allowed ).toBe( true )
        expect( activatableRefs ).toContain( `${SOURCE_NAME}/nominatim-ua.mjs` )
        expect( degraded.length ).toBe( 0 )
    } )
} )
