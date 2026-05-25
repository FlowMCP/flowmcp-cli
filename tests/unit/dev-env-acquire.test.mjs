import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { createTestHome } from '../helpers/test-home.mjs'


const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


const SOURCE_NAME = 'acquiresrc'


function schemaFile( { namespace, requiredKeys } ) {
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
        ping: { method: 'GET', description: 'Ping', path: '/ping', parameters: [] }
    }
}
`
}


describe( 'FlowMcpCli.devEnvAcquire (Memo 032 PRD-08)', () => {
    const testHome = createTestHome( { suite: 'acquire' } )
    const sourceDir = join( testHome.schemasDir, SOURCE_NAME )
    let projectDir


    beforeAll( async () => {
        await testHome.setup()
        projectDir = join( testHome.root, 'project' )
        await mkdir( join( projectDir, '.flowmcp' ), { recursive: true } )
        await mkdir( sourceDir, { recursive: true } )

        await writeFile( join( sourceDir, 'gov.mjs' ), schemaFile( {
            'namespace': 'gov',
            'requiredKeys': [ 'NASA_API_KEY', 'CONGRESS_API_KEY' ]
        } ), 'utf-8' )

        await writeFile( join( sourceDir, 'sci.mjs' ), schemaFile( {
            'namespace': 'sci',
            'requiredKeys': [ 'EBIRD_API_KEY' ]
        } ), 'utf-8' )

        const registry = {
            'name': SOURCE_NAME,
            'version': '1.0.0',
            'schemaSpec': '4.0.0',
            'schemas': [
                { 'namespace': 'gov', 'file': 'gov.mjs', 'name': 'gov', 'requiredServerParams': [ 'NASA_API_KEY', 'CONGRESS_API_KEY' ] },
                { 'namespace': 'sci', 'file': 'sci.mjs', 'name': 'sci', 'requiredServerParams': [ 'EBIRD_API_KEY' ] }
            ]
        }

        await writeFile( join( sourceDir, '_registry.json' ), JSON.stringify( registry, null, 4 ), 'utf-8' )

        const globalConfig = {
            'envPath': testHome.envPath(),
            'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc', 'schemaSpec': '4.0.0' },
            'initialized': new Date().toISOString(),
            'sources': { [SOURCE_NAME]: { 'type': 'builtin', 'schemaCount': 2 } }
        }

        await writeFile( testHome.globalConfigPath, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
        await writeFile( testHome.envPath(), '', 'utf-8' )
    } )


    afterAll( async () => {
        await testHome.teardown()
    } )


    beforeEach( async () => {
        await rm( join( projectDir, '.flowmcp', 'namespace-index.json' ), { force: true } )
    } )


    it( 'lists all missing keys with guidance (default text mode)', async () => {
        const { result } = await FlowMcpCli.devEnvAcquire( {
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'count' ] ).toBeGreaterThanOrEqual( 3 )
    } )


    it( 'filters by --key to a single entry (json mode)', async () => {
        const { result } = await FlowMcpCli.devEnvAcquire( {
            'key': 'NASA_API_KEY',
            'json': true,
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'count' ] ).toBe( 1 )
        expect( result[ 'entries' ][ 0 ][ 'key' ] ).toBe( 'NASA_API_KEY' )
        expect( result[ 'entries' ][ 0 ][ 'authMode' ] ).toBe( 'free-instant' )
        expect( result[ 'entries' ][ 0 ][ 'signupUrl' ] ).toContain( 'nasa' )
    } )


    it( 'filters by --mode to a single auth mode (json mode)', async () => {
        const { result } = await FlowMcpCli.devEnvAcquire( {
            'mode': 'government-us',
            'json': true,
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'count' ] ).toBeGreaterThanOrEqual( 1 )

        const allUsGov = result[ 'entries' ]
            .every( ( entry ) => {
                const matches = entry[ 'authMode' ] === 'government-us'

                return matches
            } )

        expect( allUsGov ).toBe( true )
    } )


    it( 'print-guide returns a markdown export of missing keys', async () => {
        const { result } = await FlowMcpCli.devEnvAcquire( {
            'printGuide': true,
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( typeof result[ 'markdown' ] ).toBe( 'string' )
        expect( result[ 'markdown' ] ).toContain( '## NASA_API_KEY' )
        expect( result[ 'markdown' ] ).toContain( 'Signup URL:' )
    } )
} )
