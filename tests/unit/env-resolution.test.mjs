import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import { writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { createTestHome } from '../helpers/test-home.mjs'
import { EnvResolver } from '../../src/lib/EnvResolver.mjs'


describe( 'env resolution: local override + global fallback (Memo 032 PRD-07)', () => {
    const testHome = createTestHome( { suite: 'env-resolution' } )
    let projectDir

    beforeAll( async () => {
        await testHome.setup()
        projectDir = join( testHome.root, 'project' )
        await mkdir( join( projectDir, '.flowmcp' ), { recursive: true } )
    } )

    afterAll( async () => {
        await testHome.teardown()
    } )

    beforeEach( async () => {
        // Reset env files for each test
        await rm( testHome.envPath(), { force: true } )
        await rm( join( projectDir, '.flowmcp', '.env' ), { force: true } )
        await rm( testHome.globalConfigPath, { force: true } )
    } )

    it( 'global-only: returns global keys', async () => {
        await writeFile( testHome.envPath(), 'GLOBAL_KEY=global_value\nSHARED=global\n', 'utf-8' )
        await writeFile( testHome.globalConfigPath, JSON.stringify( { 'envPath': testHome.envPath() } ), 'utf-8' )

        const { envObject, sources } = await EnvResolver.resolveEnv( { cwd: projectDir } )

        expect( envObject[ 'GLOBAL_KEY' ] ).toBe( 'global_value' )
        expect( envObject[ 'SHARED' ] ).toBe( 'global' )
        expect( sources.global ).toBe( testHome.envPath() )
        expect( sources.local ).toBeNull()
    } )

    it( 'local-only: returns local keys', async () => {
        await writeFile( join( projectDir, '.flowmcp', '.env' ), 'LOCAL_KEY=local_value\n', 'utf-8' )

        const { envObject, sources } = await EnvResolver.resolveEnv( { cwd: projectDir } )

        expect( envObject[ 'LOCAL_KEY' ] ).toBe( 'local_value' )
        expect( sources.local ).toBe( join( projectDir, '.flowmcp', '.env' ) )
        expect( sources.global ).toBeNull()
    } )

    it( 'both: local overrides global for matching keys', async () => {
        await writeFile( testHome.envPath(), 'SHARED=global\nONLY_GLOBAL=g\n', 'utf-8' )
        await writeFile( testHome.globalConfigPath, JSON.stringify( { 'envPath': testHome.envPath() } ), 'utf-8' )
        await writeFile( join( projectDir, '.flowmcp', '.env' ), 'SHARED=local\nONLY_LOCAL=l\n', 'utf-8' )

        const { envObject, sources } = await EnvResolver.resolveEnv( { cwd: projectDir } )

        expect( envObject[ 'SHARED' ] ).toBe( 'local' )    // local wins
        expect( envObject[ 'ONLY_GLOBAL' ] ).toBe( 'g' )
        expect( envObject[ 'ONLY_LOCAL' ] ).toBe( 'l' )
        expect( sources.local ).toBe( join( projectDir, '.flowmcp', '.env' ) )
        expect( sources.global ).toBe( testHome.envPath() )
    } )

    it( 'neither: returns empty object', async () => {
        const { envObject, sources } = await EnvResolver.resolveEnv( { cwd: projectDir } )

        expect( envObject ).toEqual( {} )
        expect( sources.local ).toBeNull()
        expect( sources.global ).toBeNull()
    } )
} )
