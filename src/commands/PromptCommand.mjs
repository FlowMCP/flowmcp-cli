import { join, resolve, basename } from 'node:path'

import { appConfig } from '../data/config.mjs'
import { ConfigStore } from '../lib/ConfigStore.mjs'
import { FsUtils } from '../lib/FsUtils.mjs'
import { CliOutput } from '../lib/CliOutput.mjs'


// Memo 152 / PRD-019 (D-08) — the `flowmcp prompt list/search/show/add/remove`
// commands. Self-contained: depends only on lib modules (ConfigStore/FsUtils/
// CliOutput) + appConfig — no back-reference to FlowMcpCli. The validationPrompt*
// methods stay public here (tests call them directly via the FlowMcpCli facade,
// which delegates to these).
class PromptCommand {
    static async promptList( { cwd } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FsUtils.readJson( { filePath: localConfigPath } )

        if( !localConfig || !localConfig[ 'groups' ] ) {
            const result = {
                'status': true,
                'prompts': []
            }

            return { result }
        }

        const prompts = []

        Object.entries( localConfig[ 'groups' ] )
            .forEach( ( [ groupName, groupData ] ) => {
                const groupPrompts = groupData[ 'prompts' ] || {}
                const toolCount = ( groupData[ 'tools' ] || groupData[ 'schemas' ] || [] ).length

                Object.entries( groupPrompts )
                    .forEach( ( [ promptName, promptData ] ) => {
                        const { title, description } = promptData
                        prompts.push( {
                            'group': groupName,
                            'name': promptName,
                            title,
                            description,
                            toolCount
                        } )
                    } )
            } )

        const result = {
            'status': true,
            prompts
        }

        return { result }
    }


    static async promptSearch( { query, cwd } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { status: validStatus, messages } = PromptCommand.validationPromptSearch( { query } )
        if( !validStatus ) {
            const result = {
                'status': false,
                messages,
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} prompt search <query>`
            }

            return { result }
        }

        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FsUtils.readJson( { filePath: localConfigPath } )

        if( !localConfig || !localConfig[ 'groups' ] ) {
            const result = {
                'status': true,
                'matches': []
            }

            return { result }
        }

        const lowerQuery = query.toLowerCase()
        const matches = []

        Object.entries( localConfig[ 'groups' ] )
            .forEach( ( [ groupName, groupData ] ) => {
                const groupPrompts = groupData[ 'prompts' ] || {}

                Object.entries( groupPrompts )
                    .forEach( ( [ promptName, promptData ] ) => {
                        const { title, description } = promptData
                        const titleMatch = ( title || '' ).toLowerCase().includes( lowerQuery )
                        const descMatch = ( description || '' ).toLowerCase().includes( lowerQuery )
                        const nameMatch = promptName.toLowerCase().includes( lowerQuery )

                        if( titleMatch || descMatch || nameMatch ) {
                            matches.push( {
                                'group': groupName,
                                'name': promptName,
                                title,
                                description
                            } )
                        }
                    } )
            } )

        const result = {
            'status': true,
            matches
        }

        return { result }
    }


    static async promptShow( { group, name, cwd } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { status: validStatus, messages } = PromptCommand.validationPromptShow( { group, name } )
        if( !validStatus ) {
            const result = {
                'status': false,
                messages,
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} prompt show <group>/<name>`
            }

            return { result }
        }

        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FsUtils.readJson( { filePath: localConfigPath } )

        if( !localConfig || !localConfig[ 'groups' ] || !localConfig[ 'groups' ][ group ] ) {
            const result = CliOutput.error( {
                'error': `Group "${group}" not found.`,
                'fix': `Run ${appConfig[ 'cliCommand' ]} group list to see available groups.`
            } )

            return { result }
        }

        const groupData = localConfig[ 'groups' ][ group ]
        const groupPrompts = groupData[ 'prompts' ] || {}

        if( !groupPrompts[ name ] ) {
            const result = CliOutput.error( {
                'error': `Prompt "${name}" not found in group "${group}".`,
                'fix': `Run ${appConfig[ 'cliCommand' ]} prompt list to see available prompts.`
            } )

            return { result }
        }

        const { file, title, description } = groupPrompts[ name ]
        const filePath = resolve( cwd, file )
        const { data: content, error: readError } = await FsUtils.readText( { filePath } )

        if( !content ) {
            const result = CliOutput.error( {
                'error': `Cannot read prompt file: ${readError}`,
                'fix': `Check that the file exists at ${file}`
            } )

            return { result }
        }

        const result = {
            'status': true,
            'group': group,
            'name': name,
            title,
            description,
            file,
            content
        }

        return { result }
    }


    static async promptAdd( { group, name, file, cwd } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { status: validStatus, messages } = PromptCommand.validationPromptAdd( { group, name, file } )
        if( !validStatus ) {
            const result = {
                'status': false,
                messages,
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} prompt add <group> <name> --file <path>`
            }

            return { result }
        }

        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FsUtils.readJson( { filePath: localConfigPath } )

        if( !localConfig || !localConfig[ 'groups' ] || !localConfig[ 'groups' ][ group ] ) {
            const result = CliOutput.error( {
                'error': `Group "${group}" not found.`,
                'fix': `Run ${appConfig[ 'cliCommand' ]} group list to see available groups. Create one with: ${appConfig[ 'cliCommand' ]} group append <name> --tools <list>`
            } )

            return { result }
        }

        const groupData = localConfig[ 'groups' ][ group ]
        const toolRefs = groupData[ 'tools' ] || groupData[ 'schemas' ] || []

        if( toolRefs.length === 0 ) {
            const result = CliOutput.error( {
                'error': `PRM006 "${group}": Group must have at least one tool to have prompts.`,
                'fix': `Add tools first: ${appConfig[ 'cliCommand' ]} group append ${group} --tools <list>`
            } )

            return { result }
        }

        const namePattern = /^[a-z][a-z0-9-]*$/
        if( !namePattern.test( name ) ) {
            const result = CliOutput.error( {
                'error': `PRM001 "${name}": Name must match ^[a-z][a-z0-9-]*$`,
                'fix': `Use lowercase letters, numbers, and hyphens. Must start with a letter.`
            } )

            return { result }
        }

        const expectedFilename = `${name}.md`
        const actualFilename = basename( file )
        if( actualFilename !== expectedFilename ) {
            const result = CliOutput.error( {
                'error': `PRM008 "${name}": File must be named ${expectedFilename}, got ${actualFilename}`,
                'fix': `Rename the file to ${expectedFilename} or use a matching prompt name.`
            } )

            return { result }
        }

        const filePath = resolve( cwd, file )
        const { data: content, error: readError } = await FsUtils.readText( { filePath } )

        if( !content ) {
            const result = CliOutput.error( {
                'error': `PRM002 "${name}": File not found at ${file}`,
                'fix': `Create the prompt file first, then add it.`
            } )

            return { result }
        }

        const lines = content.split( '\n' )
        const firstLine = lines[ 0 ] || ''

        if( !firstLine.startsWith( '# ' ) ) {
            const result = CliOutput.error( {
                'error': `PRM003 "${name}": Missing required section # Title (first line)`,
                'fix': `The first line of the prompt file must be a level-1 heading: # Your Title`
            } )

            return { result }
        }

        const title = firstLine.slice( 2 ).trim()

        const hasWorkflow = lines
            .some( ( line ) => {
                const isWorkflow = line.trim().startsWith( '## Workflow' )

                return isWorkflow
            } )

        if( !hasWorkflow ) {
            const result = CliOutput.error( {
                'error': `PRM004 "${name}": Missing required section ## Workflow`,
                'fix': `Add a ## Workflow section to the prompt file.`
            } )

            return { result }
        }

        const description = PromptCommand.#extractPromptDescription( { lines } )

        const { resolved, unresolved } = PromptCommand.#detectToolReferences( { lines, toolRefs } )

        const warnings = unresolved
            .map( ( ref ) => {
                const warning = `PRM005 "${name}": Tool "${ref}" not found in group "${group}"`

                return warning
            } )

        if( !groupData[ 'prompts' ] ) {
            groupData[ 'prompts' ] = {}
        }

        groupData[ 'prompts' ][ name ] = {
            title,
            description,
            'file': file
        }

        await FsUtils.writeGuarded( { 'path': localConfigPath, 'content': JSON.stringify( localConfig, null, 4 ), 'onExists': 'overwrite' } )

        const result = {
            'status': true,
            'group': group,
            'name': name,
            title,
            description,
            'file': file,
            'resolvedTools': resolved,
            warnings
        }

        return { result }
    }


    static async promptRemove( { group, name, cwd } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { status: validStatus, messages } = PromptCommand.validationPromptRemove( { group, name } )
        if( !validStatus ) {
            const result = {
                'status': false,
                messages,
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} prompt remove <group> <name>`
            }

            return { result }
        }

        const localConfigPath = join( cwd, appConfig[ 'localConfigDirName' ], 'config.json' )
        const { data: localConfig } = await FsUtils.readJson( { filePath: localConfigPath } )

        if( !localConfig || !localConfig[ 'groups' ] || !localConfig[ 'groups' ][ group ] ) {
            const result = CliOutput.error( {
                'error': `Group "${group}" not found.`,
                'fix': `Run ${appConfig[ 'cliCommand' ]} group list to see available groups.`
            } )

            return { result }
        }

        const groupData = localConfig[ 'groups' ][ group ]
        const groupPrompts = groupData[ 'prompts' ] || {}

        if( !groupPrompts[ name ] ) {
            const result = CliOutput.error( {
                'error': `Prompt "${name}" not found in group "${group}".`,
                'fix': `Run ${appConfig[ 'cliCommand' ]} prompt list to see available prompts.`
            } )

            return { result }
        }

        const { file } = groupPrompts[ name ]
        delete groupPrompts[ name ]

        if( Object.keys( groupPrompts ).length === 0 ) {
            delete groupData[ 'prompts' ]
        }

        await FsUtils.writeGuarded( { 'path': localConfigPath, 'content': JSON.stringify( localConfig, null, 4 ), 'onExists': 'overwrite' } )

        const result = {
            'status': true,
            'group': group,
            'name': name,
            'removed': true,
            'fileNotDeleted': file
        }

        return { result }
    }


    static validationPromptAdd( { group, name, file } ) {
        const struct = { 'status': false, 'messages': [] }

        if( group === undefined || group === null ) {
            struct[ 'messages' ].push( 'group: Missing value. Provide a group name.' )
        } else if( typeof group !== 'string' ) {
            struct[ 'messages' ].push( 'group: Must be a string.' )
        } else if( group.trim().length === 0 ) {
            struct[ 'messages' ].push( 'group: Must not be empty.' )
        }

        if( name === undefined || name === null ) {
            struct[ 'messages' ].push( 'name: Missing value. Provide a prompt name.' )
        } else if( typeof name !== 'string' ) {
            struct[ 'messages' ].push( 'name: Must be a string.' )
        } else if( name.trim().length === 0 ) {
            struct[ 'messages' ].push( 'name: Must not be empty.' )
        }

        if( file === undefined || file === null ) {
            struct[ 'messages' ].push( 'file: Missing value. Provide --file <path> to a .md file.' )
        } else if( typeof file !== 'string' ) {
            struct[ 'messages' ].push( 'file: Must be a string.' )
        } else if( file.trim().length === 0 ) {
            struct[ 'messages' ].push( 'file: Must not be empty.' )
        } else if( !file.endsWith( '.md' ) ) {
            struct[ 'messages' ].push( 'file: Must be a .md file.' )
        }

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    static validationPromptRemove( { group, name } ) {
        const struct = { 'status': false, 'messages': [] }

        if( group === undefined || group === null ) {
            struct[ 'messages' ].push( 'group: Missing value. Provide a group name.' )
        } else if( typeof group !== 'string' ) {
            struct[ 'messages' ].push( 'group: Must be a string.' )
        } else if( group.trim().length === 0 ) {
            struct[ 'messages' ].push( 'group: Must not be empty.' )
        }

        if( name === undefined || name === null ) {
            struct[ 'messages' ].push( 'name: Missing value. Provide a prompt name.' )
        } else if( typeof name !== 'string' ) {
            struct[ 'messages' ].push( 'name: Must be a string.' )
        } else if( name.trim().length === 0 ) {
            struct[ 'messages' ].push( 'name: Must not be empty.' )
        }

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    static validationPromptShow( { group, name } ) {
        const struct = { 'status': false, 'messages': [] }

        if( group === undefined || group === null ) {
            struct[ 'messages' ].push( 'group: Missing value. Provide a group name.' )
        } else if( typeof group !== 'string' ) {
            struct[ 'messages' ].push( 'group: Must be a string.' )
        } else if( group.trim().length === 0 ) {
            struct[ 'messages' ].push( 'group: Must not be empty.' )
        }

        if( name === undefined || name === null ) {
            struct[ 'messages' ].push( 'name: Missing value. Provide a prompt name.' )
        } else if( typeof name !== 'string' ) {
            struct[ 'messages' ].push( 'name: Must be a string.' )
        } else if( name.trim().length === 0 ) {
            struct[ 'messages' ].push( 'name: Must not be empty.' )
        }

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    static validationPromptSearch( { query } ) {
        const struct = { 'status': false, 'messages': [] }

        if( query === undefined || query === null ) {
            struct[ 'messages' ].push( 'query: Missing value. Provide a search query.' )
        } else if( typeof query !== 'string' ) {
            struct[ 'messages' ].push( 'query: Must be a string.' )
        } else if( query.trim().length === 0 ) {
            struct[ 'messages' ].push( 'query: Must not be empty.' )
        }

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    static #extractPromptDescription( { lines } ) {
        let inDescription = false
        const descLines = []

        lines
            .forEach( ( line ) => {
                if( line.trim() === '## Description' ) {
                    inDescription = true

                    return
                }

                if( inDescription && line.startsWith( '## ' ) ) {
                    inDescription = false

                    return
                }

                if( inDescription ) {
                    descLines.push( line )
                }
            } )

        const description = descLines
            .join( ' ' )
            .trim()
            .replace( /\s+/g, ' ' )

        return description
    }


    static #detectToolReferences( { lines, toolRefs } ) {
        let inWorkflow = false
        const backtickPattern = /`([a-zA-Z][a-zA-Z0-9]*)`/g

        const routeNames = toolRefs
            .map( ( ref ) => {
                const parts = ref.split( '::' )
                const routeName = parts.length > 1 ? parts[ 1 ] : null

                return routeName
            } )
            .filter( ( r ) => {
                const exists = r !== null

                return exists
            } )

        const detectedRefs = new Set()

        lines
            .forEach( ( line ) => {
                if( line.trim() === '## Workflow' ) {
                    inWorkflow = true

                    return
                }

                if( inWorkflow && line.startsWith( '## ' ) && !line.startsWith( '### ' ) ) {
                    inWorkflow = false

                    return
                }

                if( inWorkflow ) {
                    let match = backtickPattern.exec( line )
                    const matches = []
                    while( match !== null ) {
                        matches.push( match[ 1 ] )
                        match = backtickPattern.exec( line )
                    }

                    matches
                        .forEach( ( m ) => {
                            detectedRefs.add( m )
                        } )
                }
            } )

        const resolved = []
        const unresolved = []

        Array.from( detectedRefs )
            .forEach( ( ref ) => {
                const found = routeNames.includes( ref )

                if( found ) {
                    resolved.push( ref )
                } else {
                    unresolved.push( ref )
                }
            } )

        return { resolved, unresolved }
    }
}


export { PromptCommand }
