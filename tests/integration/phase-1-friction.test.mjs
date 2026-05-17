import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { createTestHome } from '../helpers/test-home.mjs'


const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


const SOURCE_NAME = 'phase1src'


function schemaFile( { namespace, requiredKeys = [], routeName = 'ping' } ) {
    return `export const main = {
    namespace: '${namespace}',
    name: '${namespace} API',
    description: 'Test schema',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://example.com',
    requiredServerParams: ${JSON.stringify( requiredKeys )},
    headers: {},
    routes: {
        ${routeName}: { method: 'GET', description: 'Test', path: '/', parameters: [] }
    }
}
`
}


describe( 'Phase 1 friction — empty env (Memo 032 PRD-12)', () => {
    const testHome = createTestHome( { suite: 'phase1-friction' } )
    const sourceDir = join( testHome.schemasDir, SOURCE_NAME )
    let projectDir


    beforeAll( async () => {
        await testHome.setup()
        projectDir = join( testHome.root, 'project' )
        await mkdir( join( projectDir, '.flowmcp' ), { recursive: true } )
        await mkdir( sourceDir, { recursive: true } )

        await writeFile( join( sourceDir, 'testschema.mjs' ), schemaFile( {
            'namespace': 'testschema',
            'requiredKeys': [ 'TEST_KEY' ],
            'routeName': 'sample'
        } ), 'utf-8' )

        const registry = {
            'name': SOURCE_NAME,
            'version': '1.0.0',
            'schemaSpec': '2.0.0',
            'schemas': [
                { 'namespace': 'testschema', 'file': 'testschema.mjs', 'name': 'testschema', 'requiredServerParams': [ 'TEST_KEY' ] }
            ]
        }

        await writeFile( join( sourceDir, '_registry.json' ), JSON.stringify( registry, null, 4 ), 'utf-8' )

        const globalConfig = {
            'envPath': testHome.envPath(),
            'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc', 'schemaSpec': '2.0.0' },
            'initialized': new Date().toISOString(),
            'sources': { [SOURCE_NAME]: { 'type': 'builtin', 'schemaCount': 1 } }
        }

        await writeFile( testHome.globalConfigPath, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
    } )


    afterAll( async () => {
        await testHome.teardown()
    } )


    beforeEach( async () => {
        // Reset env, local config and namespace cache for each scenario
        await rm( testHome.envPath(), { force: true } )
        await rm( join( projectDir, '.flowmcp', '.env' ), { force: true } )
        await rm( join( projectDir, '.flowmcp', 'config.json' ), { force: true } )
        await rm( join( projectDir, '.flowmcp', 'namespace-index.json' ), { force: true } )

        await writeFile( join( projectDir, '.flowmcp', 'config.json' ), JSON.stringify( {
            'root': '~/.flowmcp',
            'tools': []
        }, null, 4 ), 'utf-8' )
    } )


    it( 'A: doctor reports missing keys when env is empty', async () => {
        await writeFile( testHome.envPath(), '', 'utf-8' )

        const { result } = await FlowMcpCli.devEnvDoctor( {
            'json': true,
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( Array.isArray( result[ 'missing' ] ) ).toBe( true )
        expect( result[ 'missing' ].length ).toBeGreaterThan( 0 )
        expect( result[ 'missing' ] ).toContain( 'TEST_KEY' )
    } )


    it( 'B: add blocks when key missing without --force', async () => {
        await writeFile( testHome.envPath(), '', 'utf-8' )

        const { result } = await FlowMcpCli.add( {
            'toolName': 'testschema/tool/sample',
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'TEST_KEY' )
    } )


    it( 'C: add --force succeeds with warning', async () => {
        await writeFile( testHome.envPath(), '', 'utf-8' )

        const { result } = await FlowMcpCli.add( {
            'toolName': 'testschema/tool/sample',
            'cwd': projectDir,
            'force': true
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'added' ] ).toBe( 'testschema/tool/sample' )
    } )


    it( 'D: env-resolve returns empty sources when no env file exists', async () => {
        // No env file at all (global config has envPath set but file is absent)
        await rm( testHome.envPath(), { force: true } )

        const { envObject, sources } = await FlowMcpCli._testResolveEnv( { cwd: projectDir } )

        expect( envObject ).toEqual( {} )
        expect( sources[ 'global' ] ).toBeNull()
        expect( sources[ 'local' ] ).toBeNull()
    } )
} )
