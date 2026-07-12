import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { FsUtils } from '../../src/lib/FsUtils.mjs'
import { createTestHome } from '../helpers/test-home.mjs'


// Memo 068 PRD-002 — the No-Overwrite-Write-Guard. Exercised directly against
// FsUtils.writeGuarded (Memo 152 PRD-020/D-11 — the __testWriteGuarded facade hook
// was removed; tests call the extracted lib module directly).
let testHome


beforeAll( async () => {
    testHome = createTestHome( { 'suite': 'write-guard' } )
    await testHome.setup()
} )


afterAll( async () => {
    await testHome.teardown()
} )


describe( 'PRD-002 — #writeGuarded', () => {
    it( 'writes a new file (onExists omitted)', async () => {
        const target = join( testHome.root, 'new-file.json' )
        const result = await FsUtils.writeGuarded( { 'path': target, 'content': '{"a":1}' } )

        expect( result[ 'written' ] ).toBe( true )
        expect( result[ 'error' ] ).toBe( null )
        expect( await readFile( target, 'utf-8' ) ).toBe( '{"a":1}' )
    } )

    it( 'refuses to overwrite an existing file by default (safe default = error)', async () => {
        const target = join( testHome.root, 'existing-default.json' )
        await FsUtils.writeGuarded( { 'path': target, 'content': 'original' } )

        const result = await FsUtils.writeGuarded( { 'path': target, 'content': 'overwritten' } )

        expect( result[ 'written' ] ).toBe( false )
        expect( result[ 'error' ] ).toMatch( /NO-OVERWRITE/ )
        expect( await readFile( target, 'utf-8' ) ).toBe( 'original' )
    } )

    it( 'refuses to overwrite with explicit onExists:error', async () => {
        const target = join( testHome.root, 'existing-error.json' )
        await FsUtils.writeGuarded( { 'path': target, 'content': 'original' } )

        const result = await FsUtils.writeGuarded( { 'path': target, 'content': 'nope', 'onExists': 'error' } )

        expect( result[ 'written' ] ).toBe( false )
        expect( result[ 'error' ] ).toMatch( /NO-OVERWRITE/ )
        expect( await readFile( target, 'utf-8' ) ).toBe( 'original' )
    } )

    it( 'overwrites only with explicit onExists:overwrite', async () => {
        const target = join( testHome.root, 'existing-overwrite.json' )
        await FsUtils.writeGuarded( { 'path': target, 'content': 'original' } )

        const result = await FsUtils.writeGuarded( { 'path': target, 'content': 'updated', 'onExists': 'overwrite' } )

        expect( result[ 'written' ] ).toBe( true )
        expect( result[ 'error' ] ).toBe( null )
        expect( await readFile( target, 'utf-8' ) ).toBe( 'updated' )
    } )

    it( 'skips silently with explicit onExists:skip (no error, no change)', async () => {
        const target = join( testHome.root, 'existing-skip.json' )
        await FsUtils.writeGuarded( { 'path': target, 'content': 'original' } )

        const result = await FsUtils.writeGuarded( { 'path': target, 'content': 'ignored', 'onExists': 'skip' } )

        expect( result[ 'written' ] ).toBe( false )
        expect( result[ 'skipped' ] ).toBe( true )
        expect( result[ 'error' ] ).toBe( null )
        expect( await readFile( target, 'utf-8' ) ).toBe( 'original' )
    } )

    it( 'creates parent directories for a new nested file', async () => {
        const target = join( testHome.root, 'nested', 'deep', 'file.json' )
        const result = await FsUtils.writeGuarded( { 'path': target, 'content': 'ok' } )

        expect( result[ 'written' ] ).toBe( true )
        expect( await readFile( target, 'utf-8' ) ).toBe( 'ok' )
    } )
} )
