import { mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import chalk from 'chalk'
import inquirer from 'inquirer'

import { appConfig } from '../data/config.mjs'
import { ConfigStore } from '../lib/ConfigStore.mjs'
import { CliOutput } from '../lib/CliOutput.mjs'
import { FsUtils } from '../lib/FsUtils.mjs'
import { SchemaLoaderBridge } from '../lib/SchemaLoaderBridge.mjs'
import { NamespaceIndex } from '../lib/NamespaceIndex.mjs'
import { EnvResolver } from '../lib/EnvResolver.mjs'


// Memo 152 / PRD-019 (D-08 cluster "env-tools") — the `flowmcp dev env doctor|acquire|backup|
// restore|diff` commands, extracted from FlowMcpCli. Pure move — behaviour is UNCHANGED, in
// particular the Memo 032 rules stand: backup/restore/diff never delete an .env, restore only
// overwrites after an explicit inquirer confirm, and diff reports key NAMES only (never values).
// FlowMcpCli.devEnv* stay as public delegations (index.mjs + the dev-env tests call them). The
// shared env parsing/resolution lives in lib/EnvResolver; no back-reference to FlowMcpCli.
class EnvCommand {
    static async #collectAllRequiredServerParams( { cwd, schemaFilter = null } ) {
        const { index } = await NamespaceIndex.get( { cwd } )
        const tools = index[ 'tools' ] || {}
        const schemasBaseDir = ConfigStore.schemasDir()
        const keyToSchemas = new Map()
        const loadedFiles = new Set()

        const entries = Object.entries( tools )
        await entries
            .reduce( ( promise, [ specId, entry ] ) => promise.then( async () => {
                const { file, source } = entry
                const namespace = specId.split( '/' )[ 0 ]

                if( schemaFilter && namespace !== schemaFilter ) {
                    return
                }

                const fileKey = `${source}/${file}`
                if( loadedFiles.has( fileKey ) ) {
                    return
                }
                loadedFiles.add( fileKey )

                const filePath = join( schemasBaseDir, source, file )
                const { main } = await SchemaLoaderBridge.loadSchema( { filePath } )

                if( !main ) {
                    return
                }

                const requiredServerParams = main[ 'requiredServerParams' ] || []
                requiredServerParams
                    .forEach( ( paramKey ) => {
                        if( !keyToSchemas.has( paramKey ) ) {
                            keyToSchemas.set( paramKey, [] )
                        }

                        const existing = keyToSchemas.get( paramKey )
                        const schemaId = `${main[ 'namespace' ] || namespace}/${file}`
                        const alreadyTracked = existing
                            .find( ( s ) => {
                                const isSame = s === schemaId

                                return isSame
                            } )

                        if( !alreadyTracked ) {
                            existing.push( schemaId )
                        }
                    } )
            } ), Promise.resolve() )

        const keys = Array.from( keyToSchemas.keys() ).sort()

        return { keys, keyToSchemas }
    }


    /**
     * `flowmcp dev env doctor` (Memo 032 PRD-09).
     *
     * Reports which required keys are filled / missing / unused.
     * Supports JSON output, --fix-template, --print-signups, --strict and --schema filter.
     */
    static async doctor( { schema = null, strict = false, fixTemplate = false, json = false, printSignups = false, cwd } ) {
        const { envObject, sources } = await EnvResolver.resolveEnv( { cwd } )
        const { keys: required } = await EnvCommand.#collectAllRequiredServerParams( { cwd, 'schemaFilter': schema } )

        const filled = []
        const missing = []

        required
            .forEach( ( key ) => {
                const value = envObject[ key ]
                const isFilled = EnvResolver.isKeyFilled( { value } )

                if( isFilled ) {
                    filled.push( key )
                } else {
                    missing.push( key )
                }
            } )

        const requiredSet = new Set( required )
        const unused = Object.keys( envObject )
            .filter( ( key ) => {
                const isInRequired = requiredSet.has( key )

                return !isInRequired
            } )
            .sort()

        if( json ) {
            const result = {
                'status': true,
                sources,
                filled,
                missing,
                unused,
                required
            }

            if( strict && missing.length > 0 ) {
                process.exitCode = 1
                result[ 'status' ] = false
            }

            return { result }
        }

        if( fixTemplate ) {
            const template = missing
                .map( ( key ) => {
                    const line = `${key}=`

                    return line
                } )
                .join( '\n' )

            return { result: { 'status': true, template } }
        }

        if( printSignups ) {
            const guidePath = join( dirname( fileURLToPath( import.meta.url ) ), '..', 'data', 'acquisition-guide.json' )
            const { data: guide } = await FsUtils.readJson( { filePath: guidePath } )
            const guideKeys = ( guide && guide[ 'keys' ] ) || {}

            const lines = missing
                .map( ( key ) => {
                    const entry = guideKeys[ key ]
                    const url = entry ? entry[ 'signupUrl' ] : 'no signup URL'
                    const line = `${key}: ${url}`

                    return line
                } )

            return { result: { 'status': true, 'signups': lines.join( '\n' ) } }
        }

        const globalLabel = sources[ 'global' ] || '(none)'
        const localLabel = sources[ 'local' ] || '(none)'

        console.log( '' )
        console.log( chalk.cyan( '  Env Doctor' ) )
        console.log( `  ${chalk.gray( 'Global:' )} ${globalLabel}` )
        console.log( `  ${chalk.gray( 'Local: ' )} ${localLabel}` )
        console.log( '' )
        console.log( `  ${chalk.green( '✓' )} Filled:  ${filled.length}` )
        console.log( `  ${chalk.yellow( '⚠' )} Missing: ${missing.length}` )
        console.log( `  ${chalk.gray( '·' )} Unused:  ${unused.length}` )
        console.log( '' )

        if( missing.length > 0 ) {
            console.log( chalk.yellow( '  Missing keys:' ) )
            missing
                .forEach( ( key ) => {
                    console.log( `    - ${key}` )
                } )
            console.log( '' )
        }

        const summary = `Filled ${filled.length}, Missing ${missing.length}, Unused ${unused.length}`

        if( strict && missing.length > 0 ) {
            process.exitCode = 1

            return { result: { 'status': false, summary, missing } }
        }

        return { result: { 'status': true, summary } }
    }


    /**
     * `flowmcp dev env backup` (Memo 032 PRD-11).
     * Snapshots the resolved env to ~/.flowmcp/.env-backups/{ISO}.env.
     */
    static async backup( { cwd } ) {
        const { sources } = await EnvResolver.resolveEnv( { cwd } )
        const source = sources[ 'global' ] || sources[ 'local' ]

        if( !source ) {
            const result = CliOutput.error( {
                'error': 'No env file found to back up.',
                'fix': `Create one at ~/${appConfig[ 'globalConfigDirName' ]}/${appConfig[ 'defaultEnvFileName' ]} first.`
            } )

            return { result }
        }

        const { data: content } = await FsUtils.readText( { filePath: source } )
        if( content === null ) {
            const result = CliOutput.error( {
                'error': `Cannot read env file: ${source}`,
                'fix': 'Check filesystem permissions.'
            } )

            return { result }
        }

        const backupDir = join( ConfigStore.globalConfigDir(), '.env-backups' )
        await mkdir( backupDir, { recursive: true } )

        const iso = new Date().toISOString().replace( /:/g, '-' )
        const backup = join( backupDir, `${iso}.env` )
        await FsUtils.writeGuarded( { 'path': backup, 'content': content, 'onExists': 'overwrite' } )

        const result = { 'status': true, source, backup }

        return { result }
    }


    /**
     * `flowmcp dev env restore <file>` (Memo 032 PRD-11).
     * Restores a previous backup to the global env path. Prompts for confirmation.
     */
    static async restore( { file, cwd: _cwd } ) {
        if( !file || typeof file !== 'string' ) {
            const result = CliOutput.error( {
                'error': 'Missing backup file path.',
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} dev env restore <file>`
            } )

            return { result }
        }

        const { data: content } = await FsUtils.readText( { filePath: file } )
        if( content === null ) {
            const result = CliOutput.error( {
                'error': `Backup file not found: ${file}`,
                'fix': `Use: ${appConfig[ 'cliCommand' ]} dev env backup to create a snapshot first.`
            } )

            return { result }
        }

        const targetPath = join( ConfigStore.globalConfigDir(), appConfig[ 'defaultEnvFileName' ] )

        const { confirmed } = await inquirer.prompt( [
            {
                'type': 'confirm',
                'name': 'confirmed',
                'message': `Restore ${file} to ${targetPath}? Existing keys will be overwritten.`,
                'default': false
            }
        ] )

        if( !confirmed ) {
            const result = { 'status': false, 'error': 'Restore cancelled by user.' }

            return { result }
        }

        await mkdir( dirname( targetPath ), { recursive: true } )
        await FsUtils.writeGuarded( { 'path': targetPath, 'content': content, 'onExists': 'overwrite' } )

        const result = { 'status': true, 'restored': targetPath }

        return { result }
    }


    /**
     * `flowmcp dev env diff <file>` (Memo 032 PRD-11).
     * Diff current resolved env against a backup file. Returns key NAMES only — never values.
     */
    static async diff( { file, cwd } ) {
        if( !file || typeof file !== 'string' ) {
            const result = CliOutput.error( {
                'error': 'Missing backup file path.',
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} dev env diff <file>`
            } )

            return { result }
        }

        const { data: backupContent } = await FsUtils.readText( { filePath: file } )
        if( backupContent === null ) {
            const result = CliOutput.error( {
                'error': `Backup file not found: ${file}`,
                'fix': `Use: ${appConfig[ 'cliCommand' ]} dev env backup to create a snapshot first.`
            } )

            return { result }
        }

        const { envObject: current } = await EnvResolver.resolveEnv( { cwd } )
        const { envObject: backup } = EnvResolver.parseEnvFile( { 'envContent': backupContent } )

        const currentKeys = new Set( Object.keys( current ) )
        const backupKeys = new Set( Object.keys( backup ) )

        const onlyInCurrent = Array.from( currentKeys )
            .filter( ( key ) => {
                const inBackup = backupKeys.has( key )

                return !inBackup
            } )
            .sort()

        const onlyInBackup = Array.from( backupKeys )
            .filter( ( key ) => {
                const inCurrent = currentKeys.has( key )

                return !inCurrent
            } )
            .sort()

        const valueDiffKeys = Array.from( currentKeys )
            .filter( ( key ) => {
                const inBoth = backupKeys.has( key )
                if( !inBoth ) {
                    return false
                }

                const differs = current[ key ] !== backup[ key ]

                return differs
            } )
            .sort()

        const result = {
            'status': true,
            onlyInCurrent,
            onlyInBackup,
            valueDiffKeys
        }

        return { result }
    }


    /**
     * `flowmcp dev env acquire` (Memo 032 PRD-08).
     * Lists/filters acquisition guidance for missing keys.
     */
    static async acquire( { key = null, mode = null, printGuide = false, json = false, cwd } ) {
        const guidePath = join( dirname( fileURLToPath( import.meta.url ) ), '..', 'data', 'acquisition-guide.json' )
        const { data: guide } = await FsUtils.readJson( { filePath: guidePath } )

        if( !guide || !guide[ 'keys' ] ) {
            const result = CliOutput.error( {
                'error': 'Acquisition guide not found.',
                'fix': 'Reinstall flowmcp-cli or check src/data/acquisition-guide.json'
            } )

            return { result }
        }

        const { result: doctorResult } = await EnvCommand.doctor( { 'json': true, cwd } )
        const missing = doctorResult[ 'missing' ] || []

        let candidates = missing
            .map( ( missingKey ) => {
                const entry = guide[ 'keys' ][ missingKey ]
                const wrapped = entry ? { 'key': missingKey, ...entry } : null

                return wrapped
            } )
            .filter( ( entry ) => {
                const isKnown = entry !== null

                return isKnown
            } )

        if( key ) {
            candidates = candidates
                .filter( ( entry ) => {
                    const matches = entry[ 'key' ] === key

                    return matches
                } )
        }

        if( mode ) {
            candidates = candidates
                .filter( ( entry ) => {
                    const matches = entry[ 'authMode' ] === mode

                    return matches
                } )
        }

        if( json ) {
            const result = { 'status': true, 'count': candidates.length, 'entries': candidates }

            return { result }
        }

        if( printGuide ) {
            const lines = []
            lines.push( '# FlowMCP — API Key Acquisition Guide' )
            lines.push( '' )
            lines.push( `Generated: ${new Date().toISOString()}` )
            lines.push( '' )

            candidates
                .forEach( ( entry ) => {
                    lines.push( `## ${entry[ 'key' ]}` )
                    lines.push( '' )
                    lines.push( `- Provider: ${entry[ 'provider' ]}` )
                    lines.push( `- Signup URL: ${entry[ 'signupUrl' ]}` )
                    lines.push( `- Auth mode: ${entry[ 'authMode' ]}` )
                    lines.push( `- Free tier: ${entry[ 'freeTier' ]}` )

                    if( entry[ 'notes' ] && entry[ 'notes' ].length > 0 ) {
                        lines.push( `- Notes: ${entry[ 'notes' ]}` )
                    }

                    lines.push( '' )
                    lines.push( 'Steps:' )
                    const steps = entry[ 'steps' ] || []
                    steps
                        .forEach( ( step, index ) => {
                            lines.push( `${index + 1}. ${step}` )
                        } )
                    lines.push( '' )
                } )

            const markdown = lines.join( '\n' )

            return { result: { 'status': true, 'markdown': markdown } }
        }

        console.log( '' )
        console.log( chalk.cyan( '  Env Acquire' ) )
        console.log( `  ${chalk.gray( 'Missing keys with guidance:' )} ${candidates.length}` )
        console.log( '' )

        candidates
            .forEach( ( entry ) => {
                console.log( `  ${chalk.yellow( entry[ 'key' ] )} (${entry[ 'authMode' ]})` )
                console.log( `    Provider: ${entry[ 'provider' ]}` )
                console.log( `    Signup:   ${entry[ 'signupUrl' ]}` )
                console.log( '' )
            } )

        const result = { 'status': true, 'count': candidates.length }

        return { result }
    }
}


export { EnvCommand }
