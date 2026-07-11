/**
 * FlowMCP — MIT License
 *
 * FsUtils (Memo 152 PRD-017 / D-03) — the filesystem read/write leaf cluster
 * extracted from FlowMcpCli. Depends only on Node's fs plus CliOutput for the
 * one coded emit in readJson. The CLI facade calls FsUtils.* directly at every
 * former #readJson / #readText / #readJsonFile / #writeAtomic / #writeGuarded
 * call-site; __testWriteGuarded remains a facade hook (removed in PRD-020/D-11).
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { existsSync } from 'node:fs'

import { CliOutput } from './CliOutput.mjs'


class FsUtils {
    static async readJson( { filePath } ) {
        try {
            const content = await readFile( filePath, 'utf-8' )
            const data = JSON.parse( content )

            return { data }
        } catch( err ) {
            CliOutput.emitCoded( { 'code': 'CFG-003', 'location': 'readJson: json read/parse failed', err } )
            return { 'data': null }
        }
    }


    static async readText( { filePath } ) {
        try {
            const data = await readFile( filePath, 'utf-8' )

            return { data, 'error': null }
        } catch {
            return { 'data': null, 'error': `CLI-015 readText: Cannot read file: ${filePath}` }
        }
    }


    static async readJsonFile( { filePath } ) {
        const { data } = await FsUtils.readJson( { filePath } )

        return data
    }


    static async writeAtomic( { path, content, onConflict } ) {
        const absolutePath = resolve( path )
        // NO SILENT DEFAULT: the conflict policy must be one of the three known
        // values. An unknown value is a hard error, never a silent fall-through.
        const validConflicts = [ 'abort', 'skip', 'overwrite' ]
        if( validConflicts.includes( onConflict ) === false ) {
            throw new Error( `#writeAtomic: invalid onConflict '${onConflict}' (expected one of ${validConflicts.join( ', ' )})` )
        }
        if( existsSync( absolutePath ) ) {
            if( onConflict === 'abort' ) {
                throw new Error( `NO-OVERWRITE conflict: ${absolutePath} already exists` )
            }
            // 'skip' keeps the existing file; 'overwrite' falls through to the atomic
            // write below (the tmp+rename replaces the existing file). The previous
            // code returned skipped for BOTH, so --on-conflict=overwrite never
            // overwrote — a stale prompts.json was kept indefinitely.
            if( onConflict === 'skip' ) {
                return { 'skipped': true, absolutePath }
            }
        }
        const tmp = `${absolutePath}.tmp`
        await writeFile( tmp, content, 'utf-8' )
        await rename( tmp, absolutePath )
        return { 'skipped': false, absolutePath }
    }


    // Memo 068 R2 — the single guarded writer for persistent artifacts.
    // There is NO silent overwrite path: every overwrite must be a deliberate,
    // named choice by the caller via onExists. The safe default (onExists
    // omitted or undefined) refuses to overwrite and reports an error object.
    //   onExists: 'error'     -> existing file => { written:false, error }
    //   onExists: 'skip'      -> existing file => { written:false, skipped:true }
    //   onExists: 'overwrite' -> deliberate, named overwrite (atomic)
    // Object-return, no throw, no silent default.
    static async writeGuarded( { path, content, onExists } ) {
        const absolutePath = resolve( path )
        const effective = onExists === undefined ? 'error' : onExists
        const exists = existsSync( absolutePath )

        if( exists === true && effective === 'error' ) {
            return { 'written': false, 'skipped': false, 'error': `NO-OVERWRITE: refusing to overwrite existing file: ${absolutePath}` }
        }

        if( exists === true && effective === 'skip' ) {
            return { 'written': false, 'skipped': true, 'error': null }
        }

        await mkdir( dirname( absolutePath ), { recursive: true } )
        const tmp = `${absolutePath}.tmp`
        await writeFile( tmp, content, 'utf-8' )
        await rename( tmp, absolutePath )

        return { 'written': true, 'skipped': false, 'error': null }
    }
}


export { FsUtils }
