import { dirname, resolve } from 'node:path'

import { FlowMCP, LibraryLoader } from 'flowmcp'

import { CliBase } from './CliBase.mjs'
import { CliOutput } from './CliOutput.mjs'
import { ListsCommand } from '../commands/ListsCommand.mjs'
import { AllowlistCommand } from '../commands/AllowlistCommand.mjs'


// Memo 152 / PRD-019 (D-09, "handler-libraries" cluster) — #resolveHandlers, extracted from
// FlowMcpCli into a shared lib because call/serve/resource/grading all need it and none may
// import the FlowMcpCli facade. Resolves a schema's shared lists + required external libraries
// (via core LibraryLoader.resolveExternal, Memo 152 PRD-018 D-06/F17=A) and builds the
// handler/resource-handler maps. No Silent Defaults (Memo 149 Strang B/C): a schema that
// DECLARES sharedLists/requiredLibraries but cannot resolve them fails loud with a coded
// error (LST-001 / HND-001 / LIB-001) rather than degrading to empty handlers -> content:[].
class HandlerResolver {
    static async resolve( { main, handlersFn, filePath } ) {
        let handlerMap = {}
        let resourceHandlerMap = {}

        if( !handlersFn ) {
            return { handlerMap, resourceHandlerMap }
        }

        try {
            const sharedListRefs = main[ 'sharedLists' ] || []
            let sharedLists = {}
            let libraries = {}

            if( sharedListRefs.length > 0 ) {
                const { listsDir } = ListsCommand.findListsDir( { filePath } )
                // Memo 149 Strang B/C — No Silent Defaults: a schema that DECLARES
                // sharedLists but whose _lists/ dir cannot be located, or whose refs
                // resolve to nothing, must fail loud with a code — never fall through to
                // an empty {} that surfaces downstream as a confusing content:[] (the
                // evmChains class of bug). The 30-lines-below requiredLibraries branch
                // already fails loud; the shared-list branch now matches that standard.
                if( !listsDir ) {
                    throw new Error( `LST-001 sharedLists: _lists directory not found for a schema declaring ${sharedListRefs.length} shared list(s) (filePath: ${filePath}). Ensure the schema resolves to its real repo path (schemaFolders[]).` )
                }

                const resolved = await FlowMCP.resolveSharedLists( { sharedListRefs, listsDir } )
                sharedLists = resolved[ 'sharedLists' ] || {}

                if( Object.keys( sharedLists ).length === 0 ) {
                    throw new Error( `HND-001 sharedLists: declared ${sharedListRefs.length} shared list(s) but none resolved from ${listsDir}. Check the ref name(s) and list version(s).` )
                }
            }

            const requiredLibraries = main[ 'requiredLibraries' ] || []
            if( requiredLibraries.length > 0 ) {
                // Memo 152 / PRD-018 (D-06, F17=A): the external-library resolution + classification
                // (LIB-001 not-installed / LIB-BINDING installed-but-unloadable / LIB-002 per-base miss)
                // is delegated to core LibraryLoader.resolveExternal — the CLI no longer re-orchestrates
                // library loading. The CLI keeps ownership of the allowlist gate (folder presence,
                // Memo 150 F7) by COMPUTING the ordered resolution bases and passing them to core:
                //   allowed-libraries FIRST (user-owned, config allowedLibrariesPath — where the 49
                //   external libs live and where `npm install --prefix` puts them), then the CLI base
                //   (ships ethers/better-sqlite3), then the schema dir (local dev). First hit wins.
                // core stays env-free (it reads no config; it receives the paths). LIB-001 stays coded
                // (re-thrown by the catch below); LIB-BINDING stays uncoded (logs+degrades — a broken
                // binding needs a rebuild, not an install). The LIB-002 emit is wired to CliOutput.
                const { allowedLibrariesBase } = await AllowlistCommand.resolveAllowedLibrariesBase()
                const { resolveBase } = CliBase.resolveBase()
                const schemaBase = dirname( resolve( filePath ) )
                const resolved = await LibraryLoader.resolveExternal( {
                    'requiredLibraries': requiredLibraries,
                    'resolveBases': [ allowedLibrariesBase, resolveBase, schemaBase ],
                    'installHintBase': allowedLibrariesBase,
                    'emit': ( { code, location, err } ) => CliOutput.emitCoded( { code, location, err } )
                } )
                libraries = resolved[ 'libraries' ]
            }

            const tempHandlers = handlersFn( { sharedLists, libraries } )
            const allRouteNames = Object.keys( tempHandlers || {} )
            const resources = main[ 'resources' ] || {}
            const created = FlowMCP.createHandlers( { handlersFn, sharedLists, libraries, 'routeNames': allRouteNames, resources } )
            handlerMap = created[ 'handlerMap' ] || {}
            resourceHandlerMap = created[ 'resourceHandlerMap' ] || {}
        } catch( resolveErr ) {
            // No Silent Defaults: a handler-resolution failure (e.g. an unresolvable required
            // library or shared-list ref) must be visible, not swallowed into empty handlers
            // that later surface as a confusing "No response received from server".
            // Memo 149 Strang B/C — a CODED failure (PREFIX-NNN, e.g. LST-001/HND-001) is a
            // declared-but-unresolvable contract violation and MUST surface (re-throw) rather
            // than degrade to empty handlers -> content:[]. Uncoded, unexpected errors still
            // degrade gracefully (empty maps returned) but are always logged.
            const isCoded = typeof resolveErr?.message === 'string' && /^[A-Z]{3,4}-\d{3}/.test( resolveErr.message )
            if( isCoded ) {
                throw resolveErr
            }

            console.error( `HND-001 [resolveHandlers] handler resolution failed: ${resolveErr.message}` )
            handlerMap = {}
            resourceHandlerMap = {}
        }

        return { handlerMap, resourceHandlerMap }
    }
}


export { HandlerResolver }
