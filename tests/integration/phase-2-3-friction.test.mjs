import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { createTestHome } from '../helpers/test-home.mjs'


const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


const SOURCE_NAME = 'phase23src'


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


describe( 'Phase 2/3 friction — full coverage (Memo 032 PRD-13)', () => {
    const testHome = createTestHome( { suite: 'phase23-friction' } )
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
            'schemaSpec': '4.0.0',
            'schemas': [
                { 'namespace': 'testschema', 'file': 'testschema.mjs', 'name': 'testschema', 'requiredServerParams': [ 'TEST_KEY' ] }
            ]
        }

        await writeFile( join( sourceDir, '_registry.json' ), JSON.stringify( registry, null, 4 ), 'utf-8' )

        const globalConfig = {
            'envPath': testHome.envPath(),
            'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc', 'schemaSpec': '4.0.0' },
            'initialized': new Date().toISOString(),
            'sources': { [SOURCE_NAME]: { 'type': 'builtin', 'schemaCount': 1 } }
        }

        await writeFile( testHome.globalConfigPath, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
    } )


    afterAll( async () => {
        await testHome.teardown()
    } )


    beforeEach( async () => {
        await rm( testHome.envPath(), { force: true } )
        await rm( join( projectDir, '.flowmcp', '.env' ), { force: true } )
        await rm( join( projectDir, '.flowmcp', 'config.json' ), { force: true } )
        await rm( join( projectDir, '.flowmcp', 'namespace-index.json' ), { force: true } )

        await writeFile( join( projectDir, '.flowmcp', 'config.json' ), JSON.stringify( {
            'root': '~/.flowmcp',
            'tools': []
        }, null, 4 ), 'utf-8' )
    } )


    it( 'A: doctor reports filled when all required keys are present', async () => {
        // Pull required keys via fixTemplate, then fill each with a long dummy value.
        await writeFile( testHome.envPath(), '', 'utf-8' )

        const { result: templateResult } = await FlowMcpCli.devEnvDoctor( {
            'fixTemplate': true,
            'cwd': projectDir
        } )

        expect( templateResult[ 'status' ] ).toBe( true )

        const requiredKeys = templateResult[ 'template' ]
            .split( '\n' )
            .map( ( line ) => line.replace( /=$/, '' ).trim() )
            .filter( ( key ) => key.length > 0 )

        expect( requiredKeys.length ).toBeGreaterThan( 0 )

        const envContent = requiredKeys
            .map( ( key ) => `${key}=valid_test_value_long_enough` )
            .join( '\n' )

        await writeFile( testHome.envPath(), `${envContent}\n`, 'utf-8' )

        const { result } = await FlowMcpCli.devEnvDoctor( {
            'json': true,
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'missing' ] ).toEqual( [] )
        expect( result[ 'filled' ].length ).toBe( requiredKeys.length )
    } )


    it( 'B: add succeeds without --force when keys present', async () => {
        await writeFile( testHome.envPath(), 'TEST_KEY=valid_test_value_long_enough\n', 'utf-8' )

        const { result } = await FlowMcpCli.add( {
            'toolName': 'testschema/tool/sample',
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'added' ] ).toBe( 'testschema/tool/sample' )
    } )


    it( 'D: env-resolve detects local override over global', async () => {
        await writeFile( testHome.envPath(), 'SHARED_KEY=global_value_long_enough\nGLOBAL_ONLY=global_only_value\n', 'utf-8' )
        await writeFile( join( projectDir, '.flowmcp', '.env' ), 'SHARED_KEY=local_value_long_enough\n', 'utf-8' )

        const { envObject, sources } = await FlowMcpCli._testResolveEnv( { cwd: projectDir } )

        expect( envObject[ 'SHARED_KEY' ] ).toBe( 'local_value_long_enough' )
        expect( envObject[ 'GLOBAL_ONLY' ] ).toBe( 'global_only_value' )
        expect( sources[ 'global' ] ).toBe( testHome.envPath() )
        expect( sources[ 'local' ] ).toBe( join( projectDir, '.flowmcp', '.env' ) )
    } )
} )
