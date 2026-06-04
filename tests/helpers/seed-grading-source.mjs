import { homedir } from 'node:os'
import { mkdir, writeFile, readFile, readdir, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, basename } from 'node:path'


// Memo 102 Phase 2 / PRD-003 (B2) — the grading run now reads the schema to be
// graded LIVE from schemaFolders[], not from the island import snapshot. The
// grading tests therefore have to register the provider fixture in the test
// home's schemaFolders[] so #resolveSchemasForTarget finds it.
//
// This helper builds a schemaFolders-shaped source root under the (mocked) test
// home — <home>/grading-source/v4.0.0/providers/<namespace>/<schema>.mjs — by
// copying every .mjs from the flat provider fixture into providers/<namespace>/,
// then writes (merging) the test-home global config with a schemaFolders[] entry
// pointing at it. homedir() resolves into <repo>/.test-home via the global mock.


async function seedGradingSchemaFolder( { providerFixture, namespace, sourceName = 'grading-dev' } ) {
    const globalConfigDir = join( homedir(), '.flowmcp' )
    await mkdir( globalConfigDir, { recursive: true } )

    const sourceRoot = join( homedir(), 'grading-source', 'v4.0.0' )
    const providerDir = join( sourceRoot, 'providers', namespace )
    await mkdir( providerDir, { recursive: true } )

    const entries = await readdir( providerFixture )
    const schemaFiles = entries
        .filter( ( name ) => name.endsWith( '.mjs' ) )
        .filter( ( name ) => basename( name ).startsWith( '_' ) === false )

    await schemaFiles
        .reduce( ( promise, name ) => promise.then( async () => {
            await copyFile( join( providerFixture, name ), join( providerDir, name ) )
        } ), Promise.resolve() )

    const configPath = join( globalConfigDir, 'config.json' )
    let config = {
        'envPath': join( globalConfigDir, '.env' ),
        'flowmcpCore': { 'version': '2.0.0', 'commit': 'test-seed', 'schemaSpec': '2.0.0' },
        'initialized': '2026-06-04T12:00:00.000Z'
    }
    if( existsSync( configPath ) === true ) {
        const raw = await readFile( configPath, 'utf-8' )
        config = JSON.parse( raw )
    }

    const existingFolders = Array.isArray( config[ 'schemaFolders' ] ) ? config[ 'schemaFolders' ] : []
    const withoutDup = existingFolders
        .filter( ( entry ) => entry[ 'name' ] !== sourceName )
    config[ 'schemaFolders' ] = withoutDup
        .concat( [ { 'name': sourceName, 'path': sourceRoot } ] )
    if( config[ 'initialized' ] === undefined ) {
        config[ 'initialized' ] = '2026-06-04T12:00:00.000Z'
    }

    await writeFile( configPath, JSON.stringify( config, null, 4 ), 'utf-8' )

    return { sourceRoot, providerDir, configPath, sourceName }
}


export { seedGradingSchemaFolder }
