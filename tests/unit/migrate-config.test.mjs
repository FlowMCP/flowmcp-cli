import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { constants } from 'node:fs'

import { createTestHome } from '../helpers/test-home.mjs'

const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


const testHome = createTestHome( { suite: 'migrate-config' } )


beforeAll( async () => {
    await testHome.setup()
} )


afterAll( async () => {
    await testHome.teardown()
} )


// ─── helpers ────────────────────────────────────────────────────────────────

function makeSchemaContent( { namespace, routes = {} } ) {
    const routesStr = Object.entries( routes )
        .map( ( [ name ] ) => {
            return `        '${name}': { method: 'GET', description: '${name}', path: '/${name}', parameters: [] }`
        } )
        .join( ',\n' )

    return `export const main = {
    namespace: '${namespace}',
    name: '${namespace} API',
    description: 'Test schema for migrate-config',
    version: '2.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://example.com',
    requiredServerParams: [],
    headers: {},
    routes: {
${routesStr}
    }
}
`
}


async function fileExists( filePath ) {
    try {
        await access( filePath, constants.F_OK )

        return true
    } catch {
        return false
    }
}


// ─── test 1: no config ──────────────────────────────────────────────────────

describe( 'migrateConfig — no config file', () => {
    let tmpCwd

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-mc-no-config-${Date.now()}` )
        await mkdir( tmpCwd, { recursive: true } )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'returns status: false with error message when config does not exist', async () => {
        const { result } = await FlowMcpCli.migrateConfig( { 'cwd': tmpCwd, 'isGlobal': false, 'dryRun': false } )

        expect( result[ 'status' ] ).toBe( false )
        expect( typeof result[ 'error' ] ).toBe( 'string' )
        expect( result[ 'error' ] ).toContain( 'Config not found at' )
    } )
} )


// ─── test 2: already migrated ─────────────────────────────────────────────

describe( 'migrateConfig — all entries already in v4 Spec-ID form', () => {
    let tmpCwd

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-mc-already-${Date.now()}` )
        await mkdir( join( tmpCwd, '.flowmcp' ), { recursive: true } )

        const config = {
            'root': '~/.flowmcp',
            'groups': {
                'default': {
                    'description': '',
                    'tools': [
                        'etherscan/tool/getContractAbi',
                        'moralis/tool/getBlock'
                    ]
                }
            }
        }
        await writeFile( join( tmpCwd, '.flowmcp', 'config.json' ), JSON.stringify( config, null, 4 ), 'utf-8' )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'all entries skipped, no backup written', async () => {
        const { result } = await FlowMcpCli.migrateConfig( { 'cwd': tmpCwd, 'isGlobal': false, 'dryRun': false } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'entriesSkipped' ] ).toBe( 2 )
        expect( result[ 'entriesMigrated' ] ).toBe( 0 )
        expect( result[ 'entriesFailed' ] ).toBe( 0 )
        expect( result[ 'backup' ] ).toBeNull()
    } )

    it( 'changes array has action: skipped for each entry', async () => {
        const { result } = await FlowMcpCli.migrateConfig( { 'cwd': tmpCwd, 'isGlobal': false, 'dryRun': false } )

        result[ 'changes' ]
            .forEach( ( change ) => {
                expect( change[ 'action' ] ).toBe( 'skipped' )
            } )
    } )
} )


// ─── test 3: old format with routeName ────────────────────────────────────

describe( 'migrateConfig — old format path::routeName', () => {
    let tmpCwd
    let schemaDir

    const SCHEMA_SOURCE = 'test-provider-src'
    const SCHEMA_FILE = 'contracts.mjs'

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-mc-routename-${Date.now()}` )
        await mkdir( join( tmpCwd, '.flowmcp' ), { recursive: true } )

        const globalSchemasDir = testHome.schemasDir
        schemaDir = join( globalSchemasDir, SCHEMA_SOURCE )
        await mkdir( schemaDir, { recursive: true } )

        await writeFile(
            join( schemaDir, SCHEMA_FILE ),
            makeSchemaContent( { 'namespace': 'etherscan', 'routes': { 'getContractAbi': {}, 'getSourceCode': {} } } ),
            'utf-8'
        )

        const config = {
            'root': '~/.flowmcp',
            'groups': {
                'default': {
                    'description': '',
                    'tools': [
                        `${SCHEMA_SOURCE}/${SCHEMA_FILE}::getContractAbi`
                    ]
                }
            }
        }
        await writeFile( join( tmpCwd, '.flowmcp', 'config.json' ), JSON.stringify( config, null, 4 ), 'utf-8' )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, force: true } ).catch( () => {} )
        await rm( schemaDir, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'migrates path::routeName to namespace/tool/routeName', async () => {
        const { result } = await FlowMcpCli.migrateConfig( { 'cwd': tmpCwd, 'isGlobal': false, 'dryRun': false } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'entriesMigrated' ] ).toBe( 1 )
        expect( result[ 'entriesSkipped' ] ).toBe( 0 )
        expect( result[ 'entriesFailed' ] ).toBe( 0 )

        const change = result[ 'changes' ][ 0 ]
        expect( change[ 'action' ] ).toBe( 'migrated' )
        expect( change[ 'to' ] ).toEqual( [ 'etherscan/tool/getContractAbi' ] )
    } )

    it( 'writes backup and updates config file on disk', async () => {
        const configPath = join( tmpCwd, '.flowmcp', 'config.json' )
        const backupPath = `${configPath}.bak`
        const backupExists = await fileExists( backupPath )
        expect( backupExists ).toBe( true )

        const updatedRaw = await readFile( configPath, 'utf-8' )
        const updated = JSON.parse( updatedRaw )
        const tools = updated[ 'groups' ][ 'default' ][ 'tools' ]
        expect( tools ).toContain( 'etherscan/tool/getContractAbi' )
        expect( tools.some( ( t ) => t.includes( '::' ) ) ).toBe( false )
    } )
} )


// ─── test 4: old format container (no ::) — expanded to all tools ────────

describe( 'migrateConfig — container entry (no routeName) expands all tools', () => {
    let tmpCwd
    let schemaDir

    const SCHEMA_SOURCE = 'test-moralis-src'
    const SCHEMA_FILE = 'blockchainApi.mjs'

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-mc-container-${Date.now()}` )
        await mkdir( join( tmpCwd, '.flowmcp' ), { recursive: true } )

        const globalSchemasDir = testHome.schemasDir
        schemaDir = join( globalSchemasDir, SCHEMA_SOURCE )
        await mkdir( schemaDir, { recursive: true } )

        await writeFile(
            join( schemaDir, SCHEMA_FILE ),
            makeSchemaContent( {
                'namespace': 'moralis',
                'routes': { 'getBlock': {}, 'getTransaction': {}, 'getBalance': {} }
            } ),
            'utf-8'
        )

        const config = {
            'root': '~/.flowmcp',
            'groups': {
                'blockchain': {
                    'description': '',
                    'tools': [
                        `${SCHEMA_SOURCE}/${SCHEMA_FILE}`
                    ]
                }
            }
        }
        await writeFile( join( tmpCwd, '.flowmcp', 'config.json' ), JSON.stringify( config, null, 4 ), 'utf-8' )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, force: true } ).catch( () => {} )
        await rm( schemaDir, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'expands container to all tool Spec-IDs', async () => {
        const { result } = await FlowMcpCli.migrateConfig( { 'cwd': tmpCwd, 'isGlobal': false, 'dryRun': false } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'entriesMigrated' ] ).toBe( 1 )

        const change = result[ 'changes' ][ 0 ]
        expect( change[ 'action' ] ).toBe( 'migrated' )
        expect( change[ 'to' ] ).toContain( 'moralis/tool/getBlock' )
        expect( change[ 'to' ] ).toContain( 'moralis/tool/getTransaction' )
        expect( change[ 'to' ] ).toContain( 'moralis/tool/getBalance' )
        expect( change[ 'to' ].length ).toBe( 3 )
    } )

    it( 'config on disk contains all expanded Spec-IDs', async () => {
        const configPath = join( tmpCwd, '.flowmcp', 'config.json' )
        const updatedRaw = await readFile( configPath, 'utf-8' )
        const updated = JSON.parse( updatedRaw )
        const tools = updated[ 'groups' ][ 'blockchain' ][ 'tools' ]

        expect( tools ).toContain( 'moralis/tool/getBlock' )
        expect( tools ).toContain( 'moralis/tool/getTransaction' )
        expect( tools ).toContain( 'moralis/tool/getBalance' )
        expect( tools.length ).toBe( 3 )
    } )
} )


// ─── test 5: dry-run — no file writes ─────────────────────────────────────

describe( 'migrateConfig — dry-run: no file writes', () => {
    let tmpCwd
    let schemaDir

    const SCHEMA_SOURCE = 'test-dryrun-src'
    const SCHEMA_FILE = 'api.mjs'
    const ORIGINAL_TOOL = `${SCHEMA_SOURCE}/${SCHEMA_FILE}::ping`

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-mc-dryrun-${Date.now()}` )
        await mkdir( join( tmpCwd, '.flowmcp' ), { recursive: true } )

        const globalSchemasDir = testHome.schemasDir
        schemaDir = join( globalSchemasDir, SCHEMA_SOURCE )
        await mkdir( schemaDir, { recursive: true } )

        await writeFile(
            join( schemaDir, SCHEMA_FILE ),
            makeSchemaContent( { 'namespace': 'demo', 'routes': { 'ping': {} } } ),
            'utf-8'
        )

        const config = {
            'root': '~/.flowmcp',
            'groups': {
                'default': {
                    'description': '',
                    'tools': [ ORIGINAL_TOOL ]
                }
            }
        }
        await writeFile( join( tmpCwd, '.flowmcp', 'config.json' ), JSON.stringify( config, null, 4 ), 'utf-8' )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, force: true } ).catch( () => {} )
        await rm( schemaDir, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'returns dryRun: true and migration plan with no disk writes', async () => {
        const { result } = await FlowMcpCli.migrateConfig( { 'cwd': tmpCwd, 'isGlobal': false, 'dryRun': true } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'dryRun' ] ).toBe( true )
        expect( result[ 'entriesMigrated' ] ).toBe( 1 )
        expect( result[ 'backup' ] ).toBeNull()
    } )

    it( 'config file is unchanged after dry-run', async () => {
        const configPath = join( tmpCwd, '.flowmcp', 'config.json' )
        const raw = await readFile( configPath, 'utf-8' )
        const config = JSON.parse( raw )
        const tools = config[ 'groups' ][ 'default' ][ 'tools' ]

        expect( tools ).toContain( ORIGINAL_TOOL )
    } )

    it( 'backup file does not exist after dry-run', async () => {
        const backupPath = join( tmpCwd, '.flowmcp', 'config.json.bak' )
        const exists = await fileExists( backupPath )
        expect( exists ).toBe( false )
    } )
} )


// ─── test 6: schema not found — entry marked failed ──────────────────────

describe( 'migrateConfig — schema not found', () => {
    let tmpCwd

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-mc-notfound-${Date.now()}` )
        await mkdir( join( tmpCwd, '.flowmcp' ), { recursive: true } )

        const config = {
            'root': '~/.flowmcp',
            'groups': {
                'default': {
                    'description': '',
                    'tools': [
                        'nonexistent-source/ghost-schema.mjs::doThing'
                    ]
                }
            }
        }
        await writeFile( join( tmpCwd, '.flowmcp', 'config.json' ), JSON.stringify( config, null, 4 ), 'utf-8' )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'marks entry as failed, keeps original ref, reports entriesFailed: 1', async () => {
        const { result } = await FlowMcpCli.migrateConfig( { 'cwd': tmpCwd, 'isGlobal': false, 'dryRun': false } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'entriesFailed' ] ).toBe( 1 )
        expect( result[ 'entriesMigrated' ] ).toBe( 0 )

        const change = result[ 'changes' ][ 0 ]
        expect( change[ 'action' ] ).toBe( 'failed' )
        expect( typeof change[ 'reason' ] ).toBe( 'string' )
    } )

    it( 'original ref is preserved in config on disk', async () => {
        const configPath = join( tmpCwd, '.flowmcp', 'config.json' )
        const raw = await readFile( configPath, 'utf-8' )
        const config = JSON.parse( raw )
        const tools = config[ 'groups' ][ 'default' ][ 'tools' ]

        expect( tools ).toContain( 'nonexistent-source/ghost-schema.mjs::doThing' )
    } )
} )


// ─── test 7: idempotent — second run all skipped ──────────────────────────

describe( 'migrateConfig — idempotent: second run skips all', () => {
    let tmpCwd
    let schemaDir

    const SCHEMA_SOURCE = 'test-idem-src'
    const SCHEMA_FILE = 'idemApi.mjs'

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-mc-idem-${Date.now()}` )
        await mkdir( join( tmpCwd, '.flowmcp' ), { recursive: true } )

        const globalSchemasDir = testHome.schemasDir
        schemaDir = join( globalSchemasDir, SCHEMA_SOURCE )
        await mkdir( schemaDir, { recursive: true } )

        await writeFile(
            join( schemaDir, SCHEMA_FILE ),
            makeSchemaContent( { 'namespace': 'idem', 'routes': { 'fetch': {} } } ),
            'utf-8'
        )

        const config = {
            'root': '~/.flowmcp',
            'groups': {
                'default': {
                    'description': '',
                    'tools': [ `${SCHEMA_SOURCE}/${SCHEMA_FILE}::fetch` ]
                }
            }
        }
        await writeFile( join( tmpCwd, '.flowmcp', 'config.json' ), JSON.stringify( config, null, 4 ), 'utf-8' )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, force: true } ).catch( () => {} )
        await rm( schemaDir, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'first run migrates 1 entry', async () => {
        const { result } = await FlowMcpCli.migrateConfig( { 'cwd': tmpCwd, 'isGlobal': false, 'dryRun': false } )

        expect( result[ 'entriesMigrated' ] ).toBe( 1 )
        expect( result[ 'entriesSkipped' ] ).toBe( 0 )
    } )

    it( 'second run skips all entries and writes no second backup', async () => {
        const { result } = await FlowMcpCli.migrateConfig( { 'cwd': tmpCwd, 'isGlobal': false, 'dryRun': false } )

        expect( result[ 'entriesMigrated' ] ).toBe( 0 )
        expect( result[ 'entriesSkipped' ] ).toBe( 1 )
        expect( result[ 'backup' ] ).toBeNull()
    } )
} )


// ─── test 8: result structure ─────────────────────────────────────────────

describe( 'migrateConfig — result structure is complete', () => {
    let tmpCwd

    beforeAll( async () => {
        tmpCwd = join( tmpdir(), `flowmcp-mc-structure-${Date.now()}` )
        await mkdir( join( tmpCwd, '.flowmcp' ), { recursive: true } )

        const config = { 'root': '~/.flowmcp', 'groups': {} }
        await writeFile( join( tmpCwd, '.flowmcp', 'config.json' ), JSON.stringify( config, null, 4 ), 'utf-8' )
    } )

    afterAll( async () => {
        await rm( tmpCwd, { recursive: true, force: true } ).catch( () => {} )
    } )

    it( 'result contains all required keys', async () => {
        const { result } = await FlowMcpCli.migrateConfig( { 'cwd': tmpCwd, 'isGlobal': false, 'dryRun': false } )

        expect( result ).toHaveProperty( 'status' )
        expect( result ).toHaveProperty( 'configPath' )
        expect( result ).toHaveProperty( 'dryRun' )
        expect( result ).toHaveProperty( 'scope' )
        expect( result ).toHaveProperty( 'groupsProcessed' )
        expect( result ).toHaveProperty( 'entriesMigrated' )
        expect( result ).toHaveProperty( 'entriesSkipped' )
        expect( result ).toHaveProperty( 'entriesFailed' )
        expect( result ).toHaveProperty( 'backup' )
        expect( result ).toHaveProperty( 'changes' )
        expect( result[ 'scope' ] ).toBe( 'local' )
    } )
} )
