import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { createTestHome } from '../helpers/test-home.mjs'


const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


const SOURCE_NAME = 'guardsrc'


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


describe( 'add — activation guard (Memo 032 PRD-10)', () => {
    const testHome = createTestHome( { suite: 'guard' } )
    const sourceDir = join( testHome.schemasDir, SOURCE_NAME )
    let projectDir


    beforeAll( async () => {
        await testHome.setup()
        projectDir = join( testHome.root, 'project' )
        await mkdir( join( projectDir, '.flowmcp' ), { recursive: true } )
        await mkdir( sourceDir, { recursive: true } )

        await writeFile( join( sourceDir, 'guarded.mjs' ), schemaFile( {
            'namespace': 'guarded',
            'requiredKeys': [ 'GUARD_KEY' ],
            'routeName': 'guardedRoute'
        } ), 'utf-8' )

        await writeFile( join( sourceDir, 'free.mjs' ), schemaFile( {
            'namespace': 'free',
            'requiredKeys': [],
            'routeName': 'freeRoute'
        } ), 'utf-8' )

        const registry = {
            'name': SOURCE_NAME,
            'version': '1.0.0',
            'schemaSpec': '2.0.0',
            'schemas': [
                { 'namespace': 'guarded', 'file': 'guarded.mjs', 'name': 'guarded', 'requiredServerParams': [ 'GUARD_KEY' ] },
                { 'namespace': 'free', 'file': 'free.mjs', 'name': 'free', 'requiredServerParams': [] }
            ]
        }

        await writeFile( join( sourceDir, '_registry.json' ), JSON.stringify( registry, null, 4 ), 'utf-8' )

        const globalConfig = {
            'envPath': testHome.envPath(),
            'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc', 'schemaSpec': '2.0.0' },
            'initialized': new Date().toISOString(),
            'sources': { [SOURCE_NAME]: { 'type': 'builtin', 'schemaCount': 2 } }
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


    it( 'blocks activation when required keys are missing (no env file)', async () => {
        await writeFile( testHome.envPath(), '', 'utf-8' )

        const { result } = await FlowMcpCli.add( {
            'toolName': 'guarded/tool/guardedRoute',
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'GUARD_KEY' )
        expect( result[ 'fix' ] ).toContain( 'env acquire' )
    } )


    it( 'allows activation with --force even when keys are missing', async () => {
        await writeFile( testHome.envPath(), '', 'utf-8' )

        const { result } = await FlowMcpCli.add( {
            'toolName': 'guarded/tool/guardedRoute',
            'cwd': projectDir,
            'force': true
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'added' ] ).toBe( 'guarded/tool/guardedRoute' )
    } )


    it( 'allows activation when all required keys are present and filled', async () => {
        await writeFile( testHome.envPath(), 'GUARD_KEY=real-key-with-enough-length\n', 'utf-8' )

        const { result } = await FlowMcpCli.add( {
            'toolName': 'guarded/tool/guardedRoute',
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'added' ] ).toBe( 'guarded/tool/guardedRoute' )
    } )


    it( 'does not block schemas with no required keys', async () => {
        await writeFile( testHome.envPath(), '', 'utf-8' )

        const { result } = await FlowMcpCli.add( {
            'toolName': 'free/tool/freeRoute',
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'added' ] ).toBe( 'free/tool/freeRoute' )
    } )
} )
