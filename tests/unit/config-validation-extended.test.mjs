import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'


const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
const VALID_INITIALIZED = '2026-02-20T12:00:00.000Z'

let originalGlobalConfig = null
let tempCwdBase = null


const writeGlobalConfig = async ( { config } ) => {
    await mkdir( GLOBAL_CONFIG_DIR, { 'recursive': true } )
    await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( config, null, 4 ), 'utf-8' )
}


const createTempCwd = async ( { localConfig } ) => {
    const id = randomUUID().slice( 0, 8 )
    const tempCwd = join( tempCwdBase, `cwd-${id}` )
    const localDir = join( tempCwd, '.flowmcp' )
    await mkdir( localDir, { 'recursive': true } )

    if( localConfig !== null ) {
        await writeFile(
            join( localDir, 'config.json' ),
            JSON.stringify( localConfig, null, 4 ),
            'utf-8'
        )
    }

    return { tempCwd }
}


const findCheck = ( { checks, name } ) => {
    const found = checks
        .find( ( check ) => {
            const isMatch = check[ 'name' ] === name

            return isMatch
        } )

    return found || null
}


beforeAll( async () => {
    tempCwdBase = join( tmpdir(), `flowmcp-test-${randomUUID().slice( 0, 8 )}` )
    await mkdir( tempCwdBase, { 'recursive': true } )

    if( existsSync( GLOBAL_CONFIG_PATH ) ) {
        originalGlobalConfig = await readFile( GLOBAL_CONFIG_PATH, 'utf-8' )
    }
} )


afterAll( async () => {
    if( originalGlobalConfig !== null ) {
        await writeFile( GLOBAL_CONFIG_PATH, originalGlobalConfig, 'utf-8' )
    }

    try {
        await rm( tempCwdBase, { 'recursive': true, 'force': true } )
    } catch {
        // ignore cleanup errors
    }
} )


describe( 'FlowMcpCli.status with malformed global config', () => {
    const baseGlobalConfig = {
        'envPath': '/tmp/flowmcp-test-fake.env',
        'initialized': VALID_INITIALIZED,
        'flowmcpCore': {
            'version': '2.0.0',
            'schemaSpec': '2.0.0'
        }
    }


    test( 'reports missing envPath warning', async () => {
        const config = { ...baseGlobalConfig }
        delete config[ 'envPath' ]
        await writeGlobalConfig( { config } )

        const { tempCwd } = await createTempCwd( { 'localConfig': null } )
        const { result } = await FlowMcpCli.status( { 'cwd': tempCwd } )

        const globalCheck = findCheck( { 'checks': result[ 'checks' ], 'name': 'globalConfig' } )
        expect( globalCheck ).not.toBeNull()
        expect( globalCheck[ 'ok' ] ).toBe( false )
        expect( globalCheck[ 'warnings' ] ).toBeDefined()

        const hasEnvPathWarning = globalCheck[ 'warnings' ]
            .some( ( w ) => {
                const matches = w.includes( 'envPath' )

                return matches
            } )

        expect( hasEnvPathWarning ).toBe( true )
    } )


    test( 'reports non-string envPath warning', async () => {
        const config = { ...baseGlobalConfig, 'envPath': 42 }
        await writeGlobalConfig( { config } )

        const { tempCwd } = await createTempCwd( { 'localConfig': null } )
        const { result } = await FlowMcpCli.status( { 'cwd': tempCwd } )

        const globalCheck = findCheck( { 'checks': result[ 'checks' ], 'name': 'globalConfig' } )
        expect( globalCheck ).not.toBeNull()
        expect( globalCheck[ 'ok' ] ).toBe( false )
        expect( globalCheck[ 'warnings' ] ).toBeDefined()

        const hasEnvPathWarning = globalCheck[ 'warnings' ]
            .some( ( w ) => {
                const matches = w.includes( 'envPath' )

                return matches
            } )

        expect( hasEnvPathWarning ).toBe( true )
    } )


    test( 'reports non-string initialized warning', async () => {
        const config = { ...baseGlobalConfig, 'initialized': 42 }
        await writeGlobalConfig( { config } )

        const { tempCwd } = await createTempCwd( { 'localConfig': null } )
        const { result } = await FlowMcpCli.status( { 'cwd': tempCwd } )

        const globalCheck = findCheck( { 'checks': result[ 'checks' ], 'name': 'globalConfig' } )
        expect( globalCheck ).not.toBeNull()
        expect( globalCheck[ 'ok' ] ).toBe( false )
        expect( globalCheck[ 'warnings' ] ).toBeDefined()

        const hasInitializedWarning = globalCheck[ 'warnings' ]
            .some( ( w ) => {
                const matches = w.includes( 'initialized' )

                return matches
            } )

        expect( hasInitializedWarning ).toBe( true )
    } )


    test( 'reports missing flowmcpCore warning', async () => {
        const config = { ...baseGlobalConfig }
        delete config[ 'flowmcpCore' ]
        await writeGlobalConfig( { config } )

        const { tempCwd } = await createTempCwd( { 'localConfig': null } )
        const { result } = await FlowMcpCli.status( { 'cwd': tempCwd } )

        const globalCheck = findCheck( { 'checks': result[ 'checks' ], 'name': 'globalConfig' } )
        expect( globalCheck ).not.toBeNull()
        expect( globalCheck[ 'ok' ] ).toBe( false )
        expect( globalCheck[ 'warnings' ] ).toBeDefined()

        const hasCoreWarning = globalCheck[ 'warnings' ]
            .some( ( w ) => {
                const matches = w.includes( 'flowmcpCore' )

                return matches
            } )

        expect( hasCoreWarning ).toBe( true )
    } )


    test( 'reports non-object flowmcpCore warning', async () => {
        const config = { ...baseGlobalConfig, 'flowmcpCore': 'string' }
        await writeGlobalConfig( { config } )

        const { tempCwd } = await createTempCwd( { 'localConfig': null } )
        const { result } = await FlowMcpCli.status( { 'cwd': tempCwd } )

        const globalCheck = findCheck( { 'checks': result[ 'checks' ], 'name': 'globalConfig' } )
        expect( globalCheck ).not.toBeNull()
        expect( globalCheck[ 'ok' ] ).toBe( false )
        expect( globalCheck[ 'warnings' ] ).toBeDefined()

        const hasCoreWarning = globalCheck[ 'warnings' ]
            .some( ( w ) => {
                const matches = w.includes( 'flowmcpCore' ) && w.includes( 'object' )

                return matches
            } )

        expect( hasCoreWarning ).toBe( true )
    } )


    test( 'reports missing flowmcpCore.version warning', async () => {
        const config = {
            ...baseGlobalConfig,
            'flowmcpCore': { 'schemaSpec': '2.0.0' }
        }
        await writeGlobalConfig( { config } )

        const { tempCwd } = await createTempCwd( { 'localConfig': null } )
        const { result } = await FlowMcpCli.status( { 'cwd': tempCwd } )

        const globalCheck = findCheck( { 'checks': result[ 'checks' ], 'name': 'globalConfig' } )
        expect( globalCheck ).not.toBeNull()
        expect( globalCheck[ 'ok' ] ).toBe( false )
        expect( globalCheck[ 'warnings' ] ).toBeDefined()

        const hasVersionWarning = globalCheck[ 'warnings' ]
            .some( ( w ) => {
                const matches = w.includes( 'flowmcpCore.version' )

                return matches
            } )

        expect( hasVersionWarning ).toBe( true )
    } )


    test( 'reports missing flowmcpCore.schemaSpec warning', async () => {
        const config = {
            ...baseGlobalConfig,
            'flowmcpCore': { 'version': '2.0.0' }
        }
        await writeGlobalConfig( { config } )

        const { tempCwd } = await createTempCwd( { 'localConfig': null } )
        const { result } = await FlowMcpCli.status( { 'cwd': tempCwd } )

        const globalCheck = findCheck( { 'checks': result[ 'checks' ], 'name': 'globalConfig' } )
        expect( globalCheck ).not.toBeNull()
        expect( globalCheck[ 'ok' ] ).toBe( false )
        expect( globalCheck[ 'warnings' ] ).toBeDefined()

        const hasSchemaSpecWarning = globalCheck[ 'warnings' ]
            .some( ( w ) => {
                const matches = w.includes( 'flowmcpCore.schemaSpec' )

                return matches
            } )

        expect( hasSchemaSpecWarning ).toBe( true )
    } )


    test( 'reports non-object sources warning', async () => {
        const config = { ...baseGlobalConfig, 'sources': 'invalid' }
        await writeGlobalConfig( { config } )

        const { tempCwd } = await createTempCwd( { 'localConfig': null } )
        const { result } = await FlowMcpCli.status( { 'cwd': tempCwd } )

        const globalCheck = findCheck( { 'checks': result[ 'checks' ], 'name': 'globalConfig' } )
        expect( globalCheck ).not.toBeNull()
        expect( globalCheck[ 'ok' ] ).toBe( false )
        expect( globalCheck[ 'warnings' ] ).toBeDefined()

        const hasSourcesWarning = globalCheck[ 'warnings' ]
            .some( ( w ) => {
                const matches = w.includes( 'sources' )

                return matches
            } )

        expect( hasSourcesWarning ).toBe( true )
    } )
} )


describe( 'FlowMcpCli.status with malformed local config', () => {
    const validGlobalConfig = {
        'envPath': '/tmp/flowmcp-test-fake.env',
        'initialized': VALID_INITIALIZED,
        'flowmcpCore': {
            'version': '2.0.0',
            'schemaSpec': '2.0.0'
        }
    }


    beforeEach( async () => {
        await writeGlobalConfig( { 'config': validGlobalConfig } )
    } )


    test( 'reports missing root warning', async () => {
        const localConfig = { 'mode': 'agent' }
        const { tempCwd } = await createTempCwd( { localConfig } )
        const { result } = await FlowMcpCli.status( { 'cwd': tempCwd } )

        const localCheck = findCheck( { 'checks': result[ 'checks' ], 'name': 'localConfig' } )
        expect( localCheck ).not.toBeNull()
        expect( localCheck[ 'ok' ] ).toBe( false )
        expect( localCheck[ 'warnings' ] ).toBeDefined()

        const hasRootWarning = localCheck[ 'warnings' ]
            .some( ( w ) => {
                const matches = w.includes( 'root' )

                return matches
            } )

        expect( hasRootWarning ).toBe( true )
    } )


    test( 'reports non-object groups warning', async () => {
        const localConfig = {
            'root': '~/.flowmcp',
            'groups': 'invalid'
        }
        const { tempCwd } = await createTempCwd( { localConfig } )
        const { result } = await FlowMcpCli.status( { 'cwd': tempCwd } )

        const localCheck = findCheck( { 'checks': result[ 'checks' ], 'name': 'localConfig' } )
        expect( localCheck ).not.toBeNull()
        expect( localCheck[ 'ok' ] ).toBe( false )
        expect( localCheck[ 'warnings' ] ).toBeDefined()

        const hasGroupsWarning = localCheck[ 'warnings' ]
            .some( ( w ) => {
                const matches = w.includes( 'groups' ) && w.includes( 'object' )

                return matches
            } )

        expect( hasGroupsWarning ).toBe( true )
    } )


    test( 'reports non-object group entry warning', async () => {
        const localConfig = {
            'root': '~/.flowmcp',
            'groups': { 'test': 'invalid' }
        }
        const { tempCwd } = await createTempCwd( { localConfig } )
        const { result } = await FlowMcpCli.status( { 'cwd': tempCwd } )

        const localCheck = findCheck( { 'checks': result[ 'checks' ], 'name': 'localConfig' } )
        expect( localCheck ).not.toBeNull()
        expect( localCheck[ 'ok' ] ).toBe( false )
        expect( localCheck[ 'warnings' ] ).toBeDefined()

        const hasGroupEntryWarning = localCheck[ 'warnings' ]
            .some( ( w ) => {
                const matches = w.includes( 'groups.test' ) && w.includes( 'object' )

                return matches
            } )

        expect( hasGroupEntryWarning ).toBe( true )
    } )


    test( 'reports missing tools/schemas array warning', async () => {
        const localConfig = {
            'root': '~/.flowmcp',
            'groups': { 'test': { 'description': 'no tools' } }
        }
        const { tempCwd } = await createTempCwd( { localConfig } )
        const { result } = await FlowMcpCli.status( { 'cwd': tempCwd } )

        const localCheck = findCheck( { 'checks': result[ 'checks' ], 'name': 'localConfig' } )
        expect( localCheck ).not.toBeNull()
        expect( localCheck[ 'ok' ] ).toBe( false )
        expect( localCheck[ 'warnings' ] ).toBeDefined()

        const hasToolsWarning = localCheck[ 'warnings' ]
            .some( ( w ) => {
                const matches = w.includes( 'groups.test' ) && w.includes( 'tools' )

                return matches
            } )

        expect( hasToolsWarning ).toBe( true )
    } )


    test( 'reports non-string tool item warning', async () => {
        const localConfig = {
            'root': '~/.flowmcp',
            'groups': { 'test': { 'tools': [ 42 ] } }
        }
        const { tempCwd } = await createTempCwd( { localConfig } )
        const { result } = await FlowMcpCli.status( { 'cwd': tempCwd } )

        const localCheck = findCheck( { 'checks': result[ 'checks' ], 'name': 'localConfig' } )
        expect( localCheck ).not.toBeNull()
        expect( localCheck[ 'ok' ] ).toBe( false )
        expect( localCheck[ 'warnings' ] ).toBeDefined()

        const hasToolItemWarning = localCheck[ 'warnings' ]
            .some( ( w ) => {
                const matches = w.includes( 'groups.test.tools[0]' ) && w.includes( 'string' )

                return matches
            } )

        expect( hasToolItemWarning ).toBe( true )
    } )


    test( 'reports non-string defaultGroup warning', async () => {
        const localConfig = {
            'root': '~/.flowmcp',
            'defaultGroup': 42
        }
        const { tempCwd } = await createTempCwd( { localConfig } )
        const { result } = await FlowMcpCli.status( { 'cwd': tempCwd } )

        const localCheck = findCheck( { 'checks': result[ 'checks' ], 'name': 'localConfig' } )
        expect( localCheck ).not.toBeNull()
        expect( localCheck[ 'ok' ] ).toBe( false )
        expect( localCheck[ 'warnings' ] ).toBeDefined()

        const hasDefaultGroupWarning = localCheck[ 'warnings' ]
            .some( ( w ) => {
                const matches = w.includes( 'defaultGroup' ) && w.includes( 'string' )

                return matches
            } )

        expect( hasDefaultGroupWarning ).toBe( true )
    } )


    test( 'reports defaultGroup referencing non-existent group', async () => {
        const localConfig = {
            'root': '~/.flowmcp',
            'groups': { 'actual': { 'tools': [] } },
            'defaultGroup': 'nonexistent'
        }
        const { tempCwd } = await createTempCwd( { localConfig } )
        const { result } = await FlowMcpCli.status( { 'cwd': tempCwd } )

        const localCheck = findCheck( { 'checks': result[ 'checks' ], 'name': 'localConfig' } )
        expect( localCheck ).not.toBeNull()
        expect( localCheck[ 'ok' ] ).toBe( false )
        expect( localCheck[ 'warnings' ] ).toBeDefined()

        const hasRefWarning = localCheck[ 'warnings' ]
            .some( ( w ) => {
                const matches = w.includes( 'defaultGroup' ) && w.includes( 'nonexistent' )

                return matches
            } )

        expect( hasRefWarning ).toBe( true )
    } )
} )
