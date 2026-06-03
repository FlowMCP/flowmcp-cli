import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'

import { createTestHome } from '../helpers/test-home.mjs'


const BROKEN_VAR = 'FLOWMCP_NONEXISTENT_VAR'
const originalBroken = process.env[ BROKEN_VAR ]


const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


const home = createTestHome( { suite: 'cli-error-res035' } )

let cwd
let schemaFile
let addResult
let stdoutBuffer


function captureConsole() {
    const original = console.log
    stdoutBuffer = []
    console.log = ( ...args ) => {
        stdoutBuffer.push( args.map( ( a ) => String( a ) ).join( ' ' ) )
    }
    return () => { console.log = original }
}


beforeAll( async () => {
    await home.setup()

    delete process.env[ BROKEN_VAR ]

    cwd = join( home.root, 'cwd' )
    schemaFile = join( home.root, 'schemas', 'gtfsde-broken-path.mjs' )

    await mkdir( cwd, { recursive: true } )
    await mkdir( dirname( schemaFile ), { recursive: true } )

    await writeFile(
        home.globalConfigPath,
        JSON.stringify( { initialized: true, sources: {} }, null, 4 ),
        'utf-8'
    )

    const brokenContent = `export const main = {
    namespace: 'gtfsde',
    name: 'gtfsde-broken-path',
    version: '4.1.0',
    resources: [
        {
            source: 'sqlite-gtfs',
            mode: 'file-based',
            path: '\${${BROKEN_VAR}}/foo.db',
            addon: 'geo-gtfs-toolkit',
            addonSource: 'github:FlowMCP/gtfs-sqlite-toolkit'
        }
    ]
}
`
    await writeFile( schemaFile, brokenContent, 'utf-8' )

    const restoreConsole = captureConsole()
    addResult = await FlowMcpCli.add( { toolName: schemaFile, cwd, force: false } )
    restoreConsole()
} )


afterAll( async () => {
    if( originalBroken === undefined ) {
        delete process.env[ BROKEN_VAR ]
    } else {
        process.env[ BROKEN_VAR ] = originalBroken
    }
    await home.teardown()
} )


describe( 'flowmcp add — RES035 (unresolvable path variable) error path (PRD-29)', () => {
    it( 'add fails (status=false) when path references an unset FlowMCP variable', () => {
        expect( addResult ).toBeDefined()
        expect( addResult.result ).toBeDefined()
        expect( addResult.result.status ).toBe( false )
    } )


    it( 'error message references RES035', () => {
        expect( addResult.result.error ).toBeDefined()
        expect( addResult.result.error ).toMatch( /RES035/ )
    } )


    it( `error message names the unresolved variable (${BROKEN_VAR})`, () => {
        expect( addResult.result.error ).toMatch( new RegExp( BROKEN_VAR ) )
    } )


    it( 'no seal-cache entry is written for the rejected schema', async () => {
        const cachePath = join( home.globalConfigDir, 'cache', 'sqlite-gtfs', 'gtfsde-gtfsde-broken-path.json' )

        let cacheExists = false
        try {
            await access( cachePath, constants.F_OK )
            cacheExists = true
        } catch {
            cacheExists = false
        }

        expect( cacheExists ).toBe( false )
    } )


    it( 'flowmcp list does not contain gtfsde.* auto-tools after rejected add', async () => {
        const { result: listResult } = await FlowMcpCli.list( { cwd } )

        const tools = listResult.tools || []
        const gtfsdeTools = tools.filter( ( t ) => typeof t.name === 'string' && t.name.startsWith( 'gtfsde.' ) )

        expect( gtfsdeTools ).toEqual( [] )
    } )


    it( `env variable ${BROKEN_VAR} stays unset throughout the test`, () => {
        expect( process.env[ BROKEN_VAR ] ).toBeUndefined()
    } )
} )
