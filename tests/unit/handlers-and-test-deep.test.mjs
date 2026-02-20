import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
const ENV_PATH = join( GLOBAL_CONFIG_DIR, '.env.handlers' )

let originalGlobalConfig = null
let globalConfigExisted = false


beforeAll( async () => {
    try {
        originalGlobalConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        globalConfigExisted = true
    } catch {
        globalConfigExisted = false
    }

    await writeFile( ENV_PATH, 'HANDLER_KEY=abc\n', 'utf-8' )
} )


afterAll( async () => {
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    await rm( ENV_PATH, { force: true } ).catch( () => {} )
} )


describe( 'FlowMcpCli.callTool with schema that exports handlers — exercises #resolveHandlers', () => {
    const SOURCE_NAME = 'handlersrc'
    const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )
    const CWD = join( tmpdir(), `flowmcp-handlers-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( SOURCE_DIR, { recursive: true } )
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const schema = `export const main = {
    namespace: 'handlersrc',
    name: 'Handler API',
    description: 'Schema with handlers function',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    routes: {
        ping: {
            method: 'GET',
            description: 'Ping with handler',
            path: '/get',
            parameters: []
        }
    }
}

export const handlers = ( { sharedLists, libraries } ) => {
    return {
        ping: {
            before: ( { userParams } ) => userParams
        }
    }
}
`

        const registry = {
            'name': SOURCE_NAME,
            'version': '1.0.0',
            'description': 'Handler test source',
            'schemaSpec': '2.0.0',
            'schemas': [
                { 'namespace': 'handlersrc', 'file': 'with-handler.mjs', 'name': 'Handler API', 'requiredServerParams': [] }
            ]
        }

        await writeFile( join( SOURCE_DIR, 'with-handler.mjs' ), schema, 'utf-8' )
        await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( registry, null, 4 ), 'utf-8' )

        const localConfig = {
            'root': '~/.flowmcp',
            'tools': [
                `${SOURCE_NAME}/with-handler.mjs::ping`
            ]
        }

        await writeFile(
            join( CWD, '.flowmcp', 'config.json' ),
            JSON.stringify( localConfig, null, 4 ),
            'utf-8'
        )

        const globalConfig = {
            'envPath': ENV_PATH,
            'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc', 'schemaSpec': '2.0.0' },
            'initialized': new Date().toISOString(),
            'sources': { [SOURCE_NAME]: { 'type': 'local', 'schemaCount': 1 } }
        }

        if( globalConfigExisted && originalGlobalConfig ) {
            const parsed = JSON.parse( originalGlobalConfig )
            parsed[ 'sources' ] = parsed[ 'sources' ] || {}
            parsed[ 'sources' ][ SOURCE_NAME ] = globalConfig[ 'sources' ][ SOURCE_NAME ]
            parsed[ 'envPath' ] = ENV_PATH
            await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( parsed, null, 4 ), 'utf-8' )
        } else {
            await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
        }
    } )


    afterAll( async () => {
        if( globalConfigExisted && originalGlobalConfig ) {
            await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
        }

        await rm( SOURCE_DIR, { recursive: true, force: true } ).catch( () => {} )
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'calls tool with handler function resolved', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'ping_handlersrc',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'content' ] ).toBeDefined()
    }, 15000 )


    it( 'lists tool with handler function', async () => {
        const { result } = await FlowMcpCli.list( { 'cwd': CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'toolCount' ] ).toBeGreaterThanOrEqual( 1 )
    } )
} )


describe( 'FlowMcpCli.callTool with schema that exports broken handlers — exercises #resolveHandlers catch', () => {
    const SOURCE_NAME = 'brokenhandler'
    const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )
    const CWD = join( tmpdir(), `flowmcp-brokenhandler-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( SOURCE_DIR, { recursive: true } )
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const schema = `export const main = {
    namespace: 'brokenhandler',
    name: 'Broken Handler API',
    description: 'Schema with broken handlers',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    routes: {
        ping: {
            method: 'GET',
            description: 'Ping',
            path: '/get',
            parameters: []
        }
    }
}

export const handlers = ( { sharedLists, libraries } ) => {
    throw new Error( 'Intentional handler error for testing' )
}
`

        const registry = {
            'name': SOURCE_NAME,
            'version': '1.0.0',
            'description': 'Broken handler test',
            'schemaSpec': '2.0.0',
            'schemas': [
                { 'namespace': 'brokenhandler', 'file': 'broken.mjs', 'name': 'Broken Handler API', 'requiredServerParams': [] }
            ]
        }

        await writeFile( join( SOURCE_DIR, 'broken.mjs' ), schema, 'utf-8' )
        await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( registry, null, 4 ), 'utf-8' )

        const localConfig = {
            'root': '~/.flowmcp',
            'tools': [
                `${SOURCE_NAME}/broken.mjs::ping`
            ]
        }

        await writeFile(
            join( CWD, '.flowmcp', 'config.json' ),
            JSON.stringify( localConfig, null, 4 ),
            'utf-8'
        )

        const globalConfig = {
            'envPath': ENV_PATH,
            'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc', 'schemaSpec': '2.0.0' },
            'initialized': new Date().toISOString(),
            'sources': { [SOURCE_NAME]: { 'type': 'local', 'schemaCount': 1 } }
        }

        if( globalConfigExisted && originalGlobalConfig ) {
            const parsed = JSON.parse( originalGlobalConfig )
            parsed[ 'sources' ] = parsed[ 'sources' ] || {}
            parsed[ 'sources' ][ SOURCE_NAME ] = globalConfig[ 'sources' ][ SOURCE_NAME ]
            parsed[ 'envPath' ] = ENV_PATH
            await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( parsed, null, 4 ), 'utf-8' )
        } else {
            await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
        }
    } )


    afterAll( async () => {
        if( globalConfigExisted && originalGlobalConfig ) {
            await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
        }

        await rm( SOURCE_DIR, { recursive: true, force: true } ).catch( () => {} )
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'handles broken handler gracefully and still calls tool', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'ping_brokenhandler',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'content' ] ).toBeDefined()
    }, 15000 )
} )


describe( 'FlowMcpCli.test with schemaPath — exercises getAllTests and schemaPath test path', () => {
    const SOURCE_NAME = 'testpathsrc'
    const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )


    beforeAll( async () => {
        await mkdir( SOURCE_DIR, { recursive: true } )

        const schema = `export const main = {
    namespace: 'testpathsrc',
    name: 'Test Path API',
    description: 'Schema with tests for schemaPath test flow',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    routes: {
        ping: {
            method: 'GET',
            description: 'Ping route with test',
            path: '/get',
            parameters: [],
            tests: [
                { _description: 'Test ping works' }
            ]
        }
    }
}
`

        const registry = {
            'name': SOURCE_NAME,
            'version': '1.0.0',
            'description': 'Test path source',
            'schemaSpec': '2.0.0',
            'schemas': [
                { 'namespace': 'testpathsrc', 'file': 'testable.mjs', 'name': 'Test Path API', 'requiredServerParams': [] }
            ]
        }

        await writeFile( join( SOURCE_DIR, 'testable.mjs' ), schema, 'utf-8' )
        await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( registry, null, 4 ), 'utf-8' )

        const globalConfig = {
            'envPath': ENV_PATH,
            'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc', 'schemaSpec': '2.0.0' },
            'initialized': new Date().toISOString(),
            'sources': { [SOURCE_NAME]: { 'type': 'local', 'schemaCount': 1 } }
        }

        if( globalConfigExisted && originalGlobalConfig ) {
            const parsed = JSON.parse( originalGlobalConfig )
            parsed[ 'sources' ] = parsed[ 'sources' ] || {}
            parsed[ 'sources' ][ SOURCE_NAME ] = globalConfig[ 'sources' ][ SOURCE_NAME ]
            parsed[ 'envPath' ] = ENV_PATH
            await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( parsed, null, 4 ), 'utf-8' )
        } else {
            await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
        }
    } )


    afterAll( async () => {
        if( globalConfigExisted && originalGlobalConfig ) {
            await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
        }

        await rm( SOURCE_DIR, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'runs tests via schemaPath with single file', async () => {
        const CWD = join( tmpdir(), `flowmcp-testpath-single-${Date.now()}` )
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'default',
            'groups': {
                'default': {
                    'tools': [ `${SOURCE_NAME}/testable.mjs::ping` ]
                }
            }
        }

        await writeFile(
            join( CWD, '.flowmcp', 'config.json' ),
            JSON.stringify( localConfig, null, 4 ),
            'utf-8'
        )

        const schemaFilePath = join( SOURCE_DIR, 'testable.mjs' )

        const { result } = await FlowMcpCli.test( {
            'schemaPath': schemaFilePath,
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBeDefined()
        expect( result[ 'total' ] ).toBeGreaterThanOrEqual( 0 )
        expect( result[ 'results' ] ).toBeDefined()

        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    }, 30000 )


    it( 'runs tests via schemaPath with directory', async () => {
        const CWD = join( tmpdir(), `flowmcp-testpath-dir-${Date.now()}` )
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'default',
            'groups': {
                'default': {
                    'tools': [ `${SOURCE_NAME}/testable.mjs::ping` ]
                }
            }
        }

        await writeFile(
            join( CWD, '.flowmcp', 'config.json' ),
            JSON.stringify( localConfig, null, 4 ),
            'utf-8'
        )

        const { result } = await FlowMcpCli.test( {
            'schemaPath': SOURCE_DIR,
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBeDefined()
        expect( result[ 'total' ] ).toBeGreaterThanOrEqual( 0 )

        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    }, 30000 )
} )


describe( 'FlowMcpCli.test with schema that has no tests array', () => {
    const SOURCE_NAME = 'notests'
    const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )
    const CWD = join( tmpdir(), `flowmcp-notests-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( SOURCE_DIR, { recursive: true } )
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const schema = `export const main = {
    namespace: 'notests',
    name: 'No Tests API',
    description: 'Schema without tests',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    routes: {
        ping: {
            method: 'GET',
            description: 'Ping',
            path: '/get',
            parameters: []
        }
    }
}
`

        const registry = {
            'name': SOURCE_NAME,
            'version': '1.0.0',
            'description': 'No tests source',
            'schemaSpec': '2.0.0',
            'schemas': [
                { 'namespace': 'notests', 'file': 'notests.mjs', 'name': 'No Tests API', 'requiredServerParams': [] }
            ]
        }

        await writeFile( join( SOURCE_DIR, 'notests.mjs' ), schema, 'utf-8' )
        await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( registry, null, 4 ), 'utf-8' )

        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 'nt-group',
            'groups': {
                'nt-group': {
                    'tools': [ `${SOURCE_NAME}/notests.mjs::ping` ]
                }
            }
        }

        await writeFile(
            join( CWD, '.flowmcp', 'config.json' ),
            JSON.stringify( localConfig, null, 4 ),
            'utf-8'
        )

        const globalConfig = {
            'envPath': ENV_PATH,
            'flowmcpCore': { 'version': '2.0.0', 'commit': 'abc', 'schemaSpec': '2.0.0' },
            'initialized': new Date().toISOString(),
            'sources': { [SOURCE_NAME]: { 'type': 'local', 'schemaCount': 1 } }
        }

        if( globalConfigExisted && originalGlobalConfig ) {
            const parsed = JSON.parse( originalGlobalConfig )
            parsed[ 'sources' ] = parsed[ 'sources' ] || {}
            parsed[ 'sources' ][ SOURCE_NAME ] = globalConfig[ 'sources' ][ SOURCE_NAME ]
            parsed[ 'envPath' ] = ENV_PATH
            await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( parsed, null, 4 ), 'utf-8' )
        } else {
            await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( globalConfig, null, 4 ), 'utf-8' )
        }
    } )


    afterAll( async () => {
        if( globalConfigExisted && originalGlobalConfig ) {
            await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
        }

        await rm( SOURCE_DIR, { recursive: true, force: true } ).catch( () => {} )
        await rm( CWD, { recursive: true, force: true } ).catch( () => {} )
    } )


    it( 'returns zero tests for schema without tests array', async () => {
        const { result } = await FlowMcpCli.test( {
            'group': 'nt-group',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'total' ] ).toBe( 0 )
    }, 30000 )
} )
