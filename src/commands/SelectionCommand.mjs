import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { SelectionValidator } from 'flowmcp'

import { ConfigStore } from '../lib/ConfigStore.mjs'
import { SchemaSource } from '../lib/SchemaSource.mjs'
import { CliOutput } from '../lib/CliOutput.mjs'


// Memo 152 / PRD-019 (D-08) — the `flowmcp selection list/show/validate` commands.
// Depends only on lib modules (ConfigStore/SchemaSource/CliOutput) + the v4
// SelectionValidator (from flowmcp) — no back-reference to FlowMcpCli.
class SelectionCommand {
    static async selectionList( { cwd: _cwd } ) {
        const schemasBaseDir = ConfigStore.schemasDir()
        const { sources } = await SchemaSource.listSources()

        const sourceDirs = sources
            .map( ( source ) => join( schemasBaseDir, source[ 'name' ] ) )

        const selections = []

        await sourceDirs
            .reduce( ( promise, sourceDir ) => promise.then( async () => {
                let entries = []

                try {
                    entries = await readdir( sourceDir, { recursive: true } )
                } catch( err ) {
                    CliOutput.emitCoded( { 'code': 'SEL-001', 'location': 'selectionList: source dir read failed', err } )
                    return
                }

                const selectionFiles = entries
                    .filter( ( entry ) => {
                        const isSelectionFile = entry.includes( 'selections' + '/' ) && ( entry.endsWith( '.mjs' ) || entry.endsWith( '.js' ) )

                        return isSelectionFile
                    } )
                    .map( ( entry ) => join( sourceDir, entry ) )

                await selectionFiles
                    .reduce( ( innerPromise, filePath ) => innerPromise.then( async () => {
                        try {
                            const fileUrl = pathToFileURL( filePath ).href
                            const mod = await import( fileUrl )
                            const selection = mod[ 'selection' ]

                            if( !selection ) {
                                return
                            }

                            const { namespace, name, whenToUse, tools, resources, prompts, skills } = selection
                            const allTools = Array.isArray( tools ) ? tools : []
                            const allResources = Array.isArray( resources ) ? resources : []
                            const allPrompts = Array.isArray( prompts ) ? prompts : []
                            const allSkills = Array.isArray( skills ) ? skills : []
                            const toolCount = allTools.length + allResources.length + allPrompts.length + allSkills.length
                            const sourceName = filePath.replace( schemasBaseDir + '/', '' ).split( '/' )[ 0 ]
                            const whenToUseSnippet = typeof whenToUse === 'string' ? whenToUse.slice( 0, 80 ) : ''

                            const entry = {
                                namespace,
                                name,
                                'file': filePath,
                                'source': sourceName,
                                toolCount,
                                'whenToUse': whenToUseSnippet
                            }

                            selections.push( entry )
                        } catch( err ) {
                            // skip unreadable files
                            CliOutput.emitCoded( { 'code': 'SEL-002', 'location': 'selectionList: selection file load failed', err } )
                        }
                    } ), Promise.resolve() )
            } ), Promise.resolve() )

        const result = {
            'status': true,
            'count': selections.length,
            selections
        }

        return { result }
    }


    static async selectionShow( { cwd: _cwd, name } ) {
        const { result: listResult } = await SelectionCommand.selectionList( { 'cwd': _cwd } )
        const { selections } = listResult

        const matched = selections
            .find( ( sel ) => {
                const fullId = `${sel[ 'namespace' ]}/selection/${sel[ 'name' ]}`
                const shortId = `${sel[ 'namespace' ]}/${sel[ 'name' ]}`
                const isMatch = fullId === name || shortId === name || sel[ 'name' ] === name

                return isMatch
            } )

        if( !matched ) {
            const result = {
                'status': false,
                'error': `Selection "${name}" not found.`,
                'fix': 'Use: flowmcp dev selection list to see available selections'
            }

            return { result }
        }

        let fullSelection = null

        try {
            const fileUrl = pathToFileURL( matched[ 'file' ] ).href
            const mod = await import( fileUrl )
            fullSelection = mod[ 'selection' ]
        } catch( error ) {
            const result = {
                'status': false,
                'error': `SEL-003 selectionShow: Failed to load selection file: ${error.message}`
            }

            return { result }
        }

        const result = {
            'status': true,
            'file': matched[ 'file' ],
            'source': matched[ 'source' ],
            'selection': fullSelection
        }

        return { result }
    }


    static async selectionValidate( { cwd, path: selectionPath } ) {
        const resolvedPath = resolve( cwd, selectionPath )
        let mod = null

        try {
            const fileUrl = pathToFileURL( resolvedPath ).href
            mod = await import( fileUrl )
        } catch( error ) {
            const result = {
                'status': false,
                'errors': [ { 'code': 'SEL000', 'message': `Cannot load file: ${error.message}` } ],
                'warnings': []
            }

            return { result }
        }

        const selection = mod[ 'selection' ]

        if( !selection ) {
            const result = {
                'status': false,
                'errors': [ { 'code': 'SEL000', 'message': `File does not export a "selection" constant` } ],
                'warnings': []
            }

            return { result }
        }

        // Memo 152 / PRD-012 (B-07) — v4 is a hard dependency: use the statically
        // imported v4 SelectionValidator directly. No dynamic import, no inline
        // fallback validator (the removed CLI-022/VAL-008 degradation class).
        const validatorResult = SelectionValidator.validate( { selection } )
        const rawErrors = validatorResult[ 'errors' ] || []
        const errors = rawErrors.map( ( e ) => {
            if( typeof e === 'string' ) {
                const match = e.match( /^([A-Z]+\d*):\s*(.*)$/ )
                if( match ) {
                    return { 'code': match[ 1 ], 'message': match[ 2 ] }
                }
                return { 'code': 'SEL000', 'message': e }
            }
            return e
        } )
        if( typeof selection[ 'namespace' ] === 'string' && selection[ 'namespace' ].includes( '/' ) ) {
            errors.push( { 'code': 'VAL110', 'message': `"namespace" must not contain slashes (got: "${selection[ 'namespace' ]}")` } )
        }
        if( typeof selection[ 'name' ] === 'string' && selection[ 'name' ].includes( '/' ) ) {
            errors.push( { 'code': 'VAL110', 'message': `"name" must not contain slashes (got: "${selection[ 'name' ]}")` } )
        }
        const status = errors.length === 0
        const warnings = validatorResult[ 'warnings' ] || []
        const result = { status, errors, warnings }

        return { result }
    }
}


export { SelectionCommand }
