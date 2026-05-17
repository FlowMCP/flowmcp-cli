import { jest, describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import { writeFile, mkdir, rm, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { createTestHome } from '../helpers/test-home.mjs'


// Inquirer mock — controlled via globalThis flag
let confirmAnswer = true

jest.unstable_mockModule( 'inquirer', () => {
    const promptFn = async () => {
        return { 'confirmed': confirmAnswer }
    }

    return {
        'default': { 'prompt': promptFn },
        'prompt': promptFn
    }
} )


const { FlowMcpCli } = await import( '../../src/task/FlowMcpCli.mjs' )


describe( 'FlowMcpCli env backup/restore/diff (Memo 032 PRD-11)', () => {
    const testHome = createTestHome( { suite: 'backup' } )
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
        await rm( testHome.envPath(), { force: true } )
        await rm( join( projectDir, '.flowmcp', '.env' ), { force: true } )
        await rm( testHome.globalConfigPath, { force: true } )
        await rm( join( testHome.globalConfigDir, '.env-backups' ), { recursive: true, force: true } )
        confirmAnswer = true
    } )


    it( 'backup creates a snapshot file in .env-backups', async () => {
        await writeFile( testHome.envPath(), 'API_KEY=abc-1234567890\nSECRET=zzz-9876543210\n', 'utf-8' )
        await writeFile( testHome.globalConfigPath, JSON.stringify( { 'envPath': testHome.envPath() } ), 'utf-8' )

        const { result } = await FlowMcpCli.devEnvBackup( { 'cwd': projectDir } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'source' ] ).toBe( testHome.envPath() )
        expect( result[ 'backup' ] ).toContain( '.env-backups' )

        const backupContent = await readFile( result[ 'backup' ], 'utf-8' )
        expect( backupContent ).toContain( 'API_KEY=abc-1234567890' )

        const backupFiles = await readdir( join( testHome.globalConfigDir, '.env-backups' ) )
        expect( backupFiles.length ).toBe( 1 )
        expect( backupFiles[ 0 ] ).toMatch( /^\d{4}-\d{2}-\d{2}T/ )
    } )


    it( 'backup errors when no env file is present', async () => {
        const { result } = await FlowMcpCli.devEnvBackup( { 'cwd': projectDir } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'No env file' )
    } )


    it( 'restore confirms with user, then writes backup to global env path', async () => {
        const backupDir = join( testHome.globalConfigDir, '.env-backups' )
        await mkdir( backupDir, { recursive: true } )
        const backupFile = join( backupDir, '2026-01-01T00-00-00.000Z.env' )
        await writeFile( backupFile, 'RESTORED_KEY=restored-value-1234\n', 'utf-8' )

        confirmAnswer = true

        const { result } = await FlowMcpCli.devEnvRestore( {
            'file': backupFile,
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'restored' ] ).toBe( testHome.envPath() )

        const restored = await readFile( testHome.envPath(), 'utf-8' )
        expect( restored ).toContain( 'RESTORED_KEY=restored-value-1234' )
    } )


    it( 'restore aborts cleanly when user declines confirmation', async () => {
        const backupDir = join( testHome.globalConfigDir, '.env-backups' )
        await mkdir( backupDir, { recursive: true } )
        const backupFile = join( backupDir, '2026-01-01T00-00-00.000Z.env' )
        await writeFile( backupFile, 'KEEP_OUT=value-should-not-restore\n', 'utf-8' )

        confirmAnswer = false

        const { result } = await FlowMcpCli.devEnvRestore( {
            'file': backupFile,
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'cancelled' )
    } )


    it( 'restore returns error when backup file does not exist', async () => {
        const { result } = await FlowMcpCli.devEnvRestore( {
            'file': join( testHome.globalConfigDir, 'no-such-file.env' ),
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'not found' )
    } )


    it( 'diff returns only key NAMES, never values', async () => {
        await writeFile( testHome.envPath(), [
            'SHARED_KEY=current-value-aaaaaa',
            'ONLY_CURRENT=current-only-aaaaaa',
            ''
        ].join( '\n' ), 'utf-8' )
        await writeFile( testHome.globalConfigPath, JSON.stringify( { 'envPath': testHome.envPath() } ), 'utf-8' )

        const backupDir = join( testHome.globalConfigDir, '.env-backups' )
        await mkdir( backupDir, { recursive: true } )
        const backupFile = join( backupDir, 'diff-backup.env' )
        await writeFile( backupFile, [
            'SHARED_KEY=backup-value-bbbbbb',
            'ONLY_BACKUP=backup-only-bbbbbb',
            ''
        ].join( '\n' ), 'utf-8' )

        const { result } = await FlowMcpCli.devEnvDiff( {
            'file': backupFile,
            'cwd': projectDir
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'onlyInCurrent' ] ).toContain( 'ONLY_CURRENT' )
        expect( result[ 'onlyInBackup' ] ).toContain( 'ONLY_BACKUP' )
        expect( result[ 'valueDiffKeys' ] ).toContain( 'SHARED_KEY' )

        // Security: never leak values
        const serialized = JSON.stringify( result )
        expect( serialized ).not.toContain( 'current-value-aaaaaa' )
        expect( serialized ).not.toContain( 'backup-value-bbbbbb' )
        expect( serialized ).not.toContain( 'current-only-aaaaaa' )
        expect( serialized ).not.toContain( 'backup-only-bbbbbb' )
    } )
} )
