import { jest } from '@jest/globals'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'


// Second line of defense (Memo 068 R1). Even if a test escapes the home/tmp
// mock, any write or delete whose target lies OUTSIDE the repo root throws a
// loud test error instead of silently contaminating the system.
// Reads are never guarded.


function toAbsolute( { target } ) {
    if( typeof target === 'string' ) {
        return resolve( target )
    }

    if( target instanceof URL ) {
        return resolve( fileURLToPath( target ) )
    }

    if( Buffer.isBuffer( target ) ) {
        return resolve( target.toString() )
    }

    // file descriptor / FileHandle — not resolvable to a path, allow through
    return null
}


function assertInside( { target, op } ) {
    const abs = toAbsolute( { target } )
    if( abs === null ) {
        return
    }

    const root = globalThis.__FLOWMCP_REPO_ROOT__
    const inside = abs === root || abs.startsWith( `${root}${sep}` )
    if( inside === false ) {
        throw new Error( `[path-guard] Test attempted to ${op} OUTSIDE repo root.\n  target: ${abs}\n  REPO_ROOT: ${root}` )
    }
}


// Async wrappers (node:fs/promises) reject as promises, matching real fs.
function guardWriteAsync( { fn, op } ) {
    return async ( target, ...rest ) => {
        assertInside( { target, op } )

        return fn( target, ...rest )
    }
}


function guardMoveAsync( { fn, op } ) {
    return async ( source, destination, ...rest ) => {
        assertInside( { 'target': source, op } )
        assertInside( { 'target': destination, op } )

        return fn( source, destination, ...rest )
    }
}


// Sync wrappers (node:fs) throw synchronously, matching real fs.
function guardWriteSync( { fn, op } ) {
    return ( target, ...rest ) => {
        assertInside( { target, op } )

        return fn( target, ...rest )
    }
}


function guardMoveSync( { fn, op } ) {
    return ( source, destination, ...rest ) => {
        assertInside( { 'target': source, op } )
        assertInside( { 'target': destination, op } )

        return fn( source, destination, ...rest )
    }
}


function buildGuarded( { actual } ) {
    return {
        ...actual,
        writeFile: guardWriteAsync( { 'fn': actual.writeFile, 'op': 'writeFile' } ),
        appendFile: guardWriteAsync( { 'fn': actual.appendFile, 'op': 'appendFile' } ),
        mkdir: guardWriteAsync( { 'fn': actual.mkdir, 'op': 'mkdir' } ),
        rm: guardWriteAsync( { 'fn': actual.rm, 'op': 'rm' } ),
        rmdir: guardWriteAsync( { 'fn': actual.rmdir, 'op': 'rmdir' } ),
        unlink: guardWriteAsync( { 'fn': actual.unlink, 'op': 'unlink' } ),
        rename: guardMoveAsync( { 'fn': actual.rename, 'op': 'rename' } ),
        copyFile: guardMoveAsync( { 'fn': actual.copyFile, 'op': 'copyFile' } )
    }
}


function buildGuardedSync( { actual } ) {
    return {
        ...actual,
        writeFileSync: guardWriteSync( { 'fn': actual.writeFileSync, 'op': 'writeFileSync' } ),
        appendFileSync: guardWriteSync( { 'fn': actual.appendFileSync, 'op': 'appendFileSync' } ),
        mkdirSync: guardWriteSync( { 'fn': actual.mkdirSync, 'op': 'mkdirSync' } ),
        rmSync: guardWriteSync( { 'fn': actual.rmSync, 'op': 'rmSync' } ),
        rmdirSync: guardWriteSync( { 'fn': actual.rmdirSync, 'op': 'rmdirSync' } ),
        unlinkSync: guardWriteSync( { 'fn': actual.unlinkSync, 'op': 'unlinkSync' } ),
        renameSync: guardMoveSync( { 'fn': actual.renameSync, 'op': 'renameSync' } ),
        copyFileSync: guardMoveSync( { 'fn': actual.copyFileSync, 'op': 'copyFileSync' } )
    }
}


jest.unstable_mockModule( 'node:fs/promises', async () => {
    const actual = await jest.requireActual( 'node:fs/promises' )
    const mocked = buildGuarded( { actual } )

    return {
        ...mocked,
        default: mocked
    }
} )


jest.unstable_mockModule( 'node:fs', async () => {
    const actual = await jest.requireActual( 'node:fs' )
    const guardedPromises = buildGuarded( { 'actual': actual.promises } )
    const mocked = {
        ...buildGuardedSync( { actual } ),
        promises: guardedPromises
    }

    return {
        ...mocked,
        default: mocked
    }
} )
