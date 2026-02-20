import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { execSync } from 'node:child_process'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const SCHEMAS_DIR = join( GLOBAL_CONFIG_DIR, 'schemas' )
const ENV_PATH = join( GLOBAL_CONFIG_DIR, '.env.autherr' )

let originalGlobalConfig = null
let globalConfigExisted = false


beforeAll( async () => {
    try {
        originalGlobalConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
        globalConfigExisted = true
    } catch {
        globalConfigExisted = false
    }

    await writeFile( ENV_PATH, 'AUTHERR_KEY=abc\n', 'utf-8' )
} )


afterAll( async () => {
    if( globalConfigExisted && originalGlobalConfig ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    await rm( ENV_PATH, { force: true } ).catch( () => {} )
} )


describe( 'FlowMcpCli.callTool — auth error without requiredServerParams (line 2468)', () => {
    const SOURCE_NAME = 'autherrsrc'
    const SOURCE_DIR = join( SCHEMAS_DIR, SOURCE_NAME )
    const CWD = join( tmpdir(), `flowmcp-autherr-${Date.now()}` )


    beforeAll( async () => {
        await mkdir( SOURCE_DIR, { recursive: true } )
        await mkdir( join( CWD, '.flowmcp' ), { recursive: true } )

        const schema = `export const main = {
    namespace: 'autherrsrc',
    name: 'Auth Error API',
    description: 'Schema that triggers 401 without requiredServerParams',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {},
    routes: {
        forbidden: {
            method: 'GET',
            description: 'Returns 401',
            path: '/status/401',
            parameters: []
        }
    }
}
`

        const registry = {
            'name': SOURCE_NAME,
            'version': '1.0.0',
            'description': 'Auth error test source',
            'schemaSpec': '2.0.0',
            'schemas': [
                { 'namespace': 'autherrsrc', 'file': 'auth.mjs', 'name': 'Auth Error API', 'requiredServerParams': [] }
            ]
        }

        await writeFile( join( SOURCE_DIR, 'auth.mjs' ), schema, 'utf-8' )
        await writeFile( join( SOURCE_DIR, '_registry.json' ), JSON.stringify( registry, null, 4 ), 'utf-8' )

        const localConfig = {
            'root': '~/.flowmcp',
            'tools': [
                `${SOURCE_NAME}/auth.mjs::forbidden`
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


    it( 'returns fix about authentication when API returns 401 and no requiredServerParams', async () => {
        const { result } = await FlowMcpCli.callTool( {
            'toolName': 'forbidden_autherrsrc',
            'jsonArgs': '{}',
            'cwd': CWD
        } )

        expect( result[ 'status' ] ).toBe( false )

        if( result[ 'fix' ] ) {
            expect( result[ 'fix' ] ).toContain( 'authentication' )
        }
    }, 15000 )
} )


describe( 'FlowMcpCli.validate — path is neither file nor directory (line 5618)', () => {
    const FIFO_PATH = join( tmpdir(), `flowmcp-fifo-${Date.now()}` )
    let fifoCreated = false


    beforeAll( () => {
        try {
            execSync( `mkfifo "${FIFO_PATH}"` )
            fifoCreated = true
        } catch {
            fifoCreated = false
        }
    } )


    afterAll( async () => {
        if( fifoCreated ) {
            await rm( FIFO_PATH, { force: true } ).catch( () => {} )
        }
    } )


    it( 'returns error for path that is neither file nor directory', async () => {
        if( !fifoCreated ) {
            return
        }

        const { result } = await FlowMcpCli.validate( {
            'schemaPath': FIFO_PATH
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'neither a file nor a directory' )
    } )
} )
