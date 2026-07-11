import { join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'

import { ConfigStore } from '../lib/ConfigStore.mjs'
import { FsUtils } from '../lib/FsUtils.mjs'
import { CliOutput } from '../lib/CliOutput.mjs'


// Memo 152 / PRD-019 (D-08) — the `flowmcp allowlist` command plus the two Memo-150
// allowed-libraries helpers it shares with the handler-resolution and doctor paths.
// The helpers are public static so FlowMcpCli (#resolveHandlers, doctor) can call the
// SAME resolution chain the command uses. This module depends only on lib modules
// (ConfigStore/FsUtils/CliOutput) — no back-reference to FlowMcpCli.
class AllowlistCommand {
    // Memo 150 — the allowed-libraries base: the user-owned folder whose node_modules holds
    // external requiredLibraries (config "allowedLibrariesPath", default ~/.flowmcp/allowed-libraries,
    // ~/-expansion via ConfigStore.resolvePath). Absence-tolerant: a missing config key falls back to
    // the default (non-breaking, no forced config write). The folder need not exist yet — createRequire
    // anchors on a noop.cjs inside it (the file need not exist; only its directory is used to seed module
    // resolution). Folder presence IS the gate (F7=A): a lib only resolves here if it was deliberately
    // installed.
    static async resolveAllowedLibrariesBase() {
        const defaultBase = join( ConfigStore.globalConfigDir(), 'allowed-libraries' )
        const { data: globalConfig } = await FsUtils.readJson( { 'filePath': ConfigStore.globalConfigPath() } )
        const rawValue = globalConfig ? globalConfig[ 'allowedLibrariesPath' ] : null
        const configured = typeof rawValue === 'string' && rawValue.length > 0 ? rawValue : null
        const allowedLibrariesPathRaw = configured || defaultBase
        const { resolvedPath } = ConfigStore.resolvePath( { 'path': allowedLibrariesPathRaw } )

        return { 'allowedLibrariesBase': resolvedPath, allowedLibrariesPathRaw, 'configured': configured !== null }
    }


    // Memo 150 D3/F7 — enumerate the top-level packages installed in allowed-libraries/node_modules
    // (installed = allowed). Scoped packages (@scope/pkg) are expanded one level. Absent folder = [].
    static listInstalledLibraries( { allowedLibrariesBase } ) {
        const nodeModulesDir = join( allowedLibrariesBase, 'node_modules' )

        if( existsSync( nodeModulesDir ) === false ) {
            return { 'installed': [] }
        }

        let topEntries = []

        try {
            topEntries = readdirSync( nodeModulesDir, { 'withFileTypes': true } )
        } catch( err ) {
            CliOutput.emitCoded( { 'code': 'LIB-003', 'location': 'listInstalledLibraries: node_modules unreadable', err } )

            return { 'installed': [] }
        }

        const installed = topEntries
            .filter( ( entry ) => entry.isDirectory() === true || entry.isSymbolicLink() === true )
            .map( ( entry ) => entry[ 'name' ] )
            .filter( ( name ) => name.startsWith( '.' ) === false )
            .reduce( ( acc, name ) => {
                if( name.startsWith( '@' ) === false ) {
                    return [ ...acc, name ]
                }

                let scopedNames = []

                try {
                    scopedNames = readdirSync( join( nodeModulesDir, name ), { 'withFileTypes': true } )
                        .filter( ( entry ) => entry.isDirectory() === true || entry.isSymbolicLink() === true )
                        .map( ( entry ) => `${name}/${entry[ 'name' ]}` )
                } catch( err ) {
                    scopedNames = []
                }

                return [ ...acc, ...scopedNames ]
            }, [] )
            .sort()

        return { installed }
    }


    static async allowlist( { cwd, action, library } ) {
        const configPath = join( cwd, 'flowmcp.config.json' )
        const validActions = [ 'add', 'remove', 'list' ]

        if( !validActions.includes( action ) ) {
            const result = {
                'status': false,
                'error': `Invalid action "${action}".`,
                'fix': 'Use: add, remove, or list',
                configPath
            }

            return { result }
        }

        if( action !== 'list' ) {
            if( typeof library !== 'string' || library.trim() === '' ) {
                const result = {
                    'status': false,
                    'error': 'Library name must be a non-empty string.',
                    'fix': `Provide a valid npm package name, e.g. "talib" or "@scope/pkg"`,
                    configPath
                }

                return { result }
            }

            const validPattern = /^(@[a-z0-9-_]+\/)?[a-z0-9-_\.]+$/i
            const hasDangerousChars = /[<>|&;`$\\\/\.\.]/.test( library ) && library.includes( '..' )
            const isPathTraversal = library.includes( '..' ) || library.startsWith( '/' ) || library.startsWith( '.' )

            if( isPathTraversal || !validPattern.test( library ) ) {
                const result = {
                    'status': false,
                    'error': `Invalid library name "${library}". Only npm-style package names are allowed.`,
                    'fix': 'Use letters, digits, hyphens, underscores. Scoped names like @scope/pkg are allowed.',
                    configPath
                }

                return { result }
            }
        }

        // Memo 150 D3/F7 — the separate config allowlist is obsolete: folder presence in
        // allowed-libraries IS the permission gate. `list` shows what is actually installed there;
        // `add`/`remove` no longer mutate any config — they point at the manual install (F3=B: the
        // CLI never installs itself). This removes the dead getDefaultAllowlist key-mismatch (core
        // returns { allowlist }, the old CLI read { defaultAllowlist } -> the list was always empty).
        const { allowedLibrariesBase } = await AllowlistCommand.resolveAllowedLibrariesBase()

        if( action === 'add' || action === 'remove' ) {
            const command = action === 'add'
                ? `npm install --prefix ${allowedLibrariesBase} ${library}`
                : `npm uninstall --prefix ${allowedLibrariesBase} ${library}`

            const result = {
                'status': true,
                action,
                library,
                'deprecated': true,
                allowedLibrariesBase,
                'message': `"dev allowlist ${action}" is deprecated (Memo 150). Folder presence in allowed-libraries is the gate — the CLI never installs. Run this yourself:`,
                command,
                configPath
            }

            return { result }
        }

        // action === 'list' — the modules installed in allowed-libraries/node_modules (installed = allowed).
        const { installed } = AllowlistCommand.listInstalledLibraries( { allowedLibrariesBase } )

        const result = {
            'status': true,
            action,
            allowedLibrariesBase,
            installed,
            'count': installed.length,
            'note': `Folder presence is the gate (Memo 150 F7). Install with: npm install --prefix ${allowedLibrariesBase} <lib>`,
            configPath
        }

        return { result }
    }
}


export { AllowlistCommand }
