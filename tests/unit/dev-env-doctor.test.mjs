import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { createTestHome } from '../helpers/test-home.mjs'


const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


const SOURCE_NAME = 'doctorsrc'


function makeRegistry( { schemas } ) {
    return {
        'name': SOURCE_NAME,
        'version': '1.0.0',
        'description': 'Doctor test source',
        'schemaSpec': '2.0.0',
        schemas
    }
}


function schemaFile( { namespace, requiredKeys = [] } ) {
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
        ping: {
            method: 'GET',
            description: 'Ping',
            path: '/ping',
            parameters: []
        }
    }
}
`
}


describe( 'FlowMcpCli.devEnvDoctor (Memo 032 PRD-09)', () => {
    const testHome = createTestHome( { suite: 'doctor' } )
    const sourceDir = join( testHome.schemasDir, SOURCE_NAME )
    let projectDir


    beforeAll( async () => {
        await testHome.setup()
        projectDir = join( testHome.root, 'project' )
        await mkdir( join( projectDir, '.flowmcp' ), { recursive: true } )
        await mkdir( sourceDir, { recursive: true } )

        await writeFile( join( sourceDir, 'alpha.mjs' ), schemaFile( {
            'namespace': 'alpha',
            'requiredKeys': [ 'ALPHA_KEY', 'SHARED_KEY' ]
        } ), 'utf-8' )

        await writeFile( join( sourceDir, 'beta.mjs' ), schemaFile( {
            'namespace': 'beta',
            'requiredKeys': [ 'BETA_KEY' ]
        } ), 'utf-8' )

        const registry = makeRegistry( {
            'schemas': [
                { 'namespace': 'alpha', 'file': 'alpha.mjs', 'name': 'alpha', 'requiredServerParams': [ 'ALPHA_KEY', 'SHARED_KEY' ] },
                { 'namespace': 'beta', 'file': 'beta.mjs', 'name': 'beta', 'requiredServerParams': [ 'BETA_KEY' ] }
            ]
        } )

        await writeFile( join( sourceDir, '_registry.json' ), JSON.stringify( registry, null, 4 ), 'utf-8' )
    } )


    afterAll( async () => {
        await testHome.teardown()
    } )


    beforeEach( async () => {
        await rm( testHome.envPath(), { force: true } )
        await rm( testHome.globalConfigPath, { force: true } )
        await rm( join( projectDir, '.flowmcp', 'namespace-index.json' ), { force: true } )

        const globalConfig = {
            'envPath': testHome.envPath(),
            'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc', 'schemaSpec': '2.0.0' },
            'initialized': new Date().toISOString(),
            'sources': { [SOURCE_NAME]: { 'type': 'builtin', 'schemaCount': 2 } }
        }

        await writeFile( testHome.globalConfigPath, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
    } )


    it( 'buckets keys into filled, missing and unused (json mode)', async () => {
        await writeFile( testHome.envPath(), [
            'ALPHA_KEY=this-is-a-real-key-12345',
            'UNUSED_KEY=this-key-is-unused-too',
            ''
        ].join( '\n' ), 'utf-8' )

        const { result } = await FlowMcpCli.devEnvDoctor( {
            'json': true,
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'filled' ] ).toContain( 'ALPHA_KEY' )
        expect( result[ 'missing' ] ).toContain( 'SHARED_KEY' )
        expect( result[ 'missing' ] ).toContain( 'BETA_KEY' )
        expect( result[ 'unused' ] ).toContain( 'UNUSED_KEY' )
        expect( result[ 'required' ] ).toEqual( expect.arrayContaining( [ 'ALPHA_KEY', 'BETA_KEY', 'SHARED_KEY' ] ) )
    } )


    it( 'strict mode sets process.exitCode to 1 when keys are missing', async () => {
        await writeFile( testHome.envPath(), 'ALPHA_KEY=real-key-1234567890\n', 'utf-8' )

        const previousExitCode = process.exitCode
        process.exitCode = 0

        const { result } = await FlowMcpCli.devEnvDoctor( {
            'json': true,
            'strict': true,
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( process.exitCode ).toBe( 1 )

        process.exitCode = previousExitCode
    } )


    it( 'fix-template returns KEY= template for missing keys', async () => {
        await writeFile( testHome.envPath(), 'ALPHA_KEY=real-key-1234567890\n', 'utf-8' )

        const { result } = await FlowMcpCli.devEnvDoctor( {
            'fixTemplate': true,
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'template' ] ).toContain( 'BETA_KEY=' )
        expect( result[ 'template' ] ).toContain( 'SHARED_KEY=' )
        expect( result[ 'template' ] ).not.toContain( 'ALPHA_KEY=' )
    } )


    it( 'schema filter restricts to a single namespace', async () => {
        await writeFile( testHome.envPath(), '', 'utf-8' )

        const { result } = await FlowMcpCli.devEnvDoctor( {
            'schema': 'beta',
            'json': true,
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'missing' ] ).toContain( 'BETA_KEY' )
        expect( result[ 'missing' ] ).not.toContain( 'ALPHA_KEY' )
        expect( result[ 'missing' ] ).not.toContain( 'SHARED_KEY' )
    } )


    it( 'rejects placeholder values as not-filled', async () => {
        await writeFile( testHome.envPath(), [
            'ALPHA_KEY=your_key_here',
            'BETA_KEY=short',
            'SHARED_KEY=this-is-a-real-key-12345',
            ''
        ].join( '\n' ), 'utf-8' )

        const { result } = await FlowMcpCli.devEnvDoctor( {
            'json': true,
            'cwd': projectDir
        } )

        expect( result[ 'missing' ] ).toContain( 'ALPHA_KEY' )
        expect( result[ 'missing' ] ).toContain( 'BETA_KEY' )
        expect( result[ 'filled' ] ).toContain( 'SHARED_KEY' )
    } )


    it( 'print-signups produces a missing-key list with signup URLs from the guide', async () => {
        await writeFile( testHome.envPath(), 'ALPHA_KEY=real-key-1234567890\n', 'utf-8' )

        const { result } = await FlowMcpCli.devEnvDoctor( {
            'printSignups': true,
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( typeof result[ 'signups' ] ).toBe( 'string' )
        // BETA_KEY is not in the acquisition guide, so the line should still appear
        // with a fallback "no signup URL" note
        expect( result[ 'signups' ] ).toContain( 'BETA_KEY' )
        expect( result[ 'signups' ] ).toContain( 'SHARED_KEY' )
    } )
} )
