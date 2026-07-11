import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { FlowMCP } from 'flowmcp'

import { appConfig } from '../data/config.mjs'
import { ConfigStore } from '../lib/ConfigStore.mjs'
import { CliOutput } from '../lib/CliOutput.mjs'
import { FsUtils } from '../lib/FsUtils.mjs'
import { SchemaSource } from '../lib/SchemaSource.mjs'
import { SchemaLoaderBridge } from '../lib/SchemaLoaderBridge.mjs'
import { EnvResolver } from '../lib/EnvResolver.mjs'


// Memo 152 / PRD-019 (D-09 cluster "search-list") — `flowmcp search`, extracted from FlowMcpCli
// together with the schema-discovery/enrichment helpers it shares with call + list + catalog.
// listAvailableTools / extractMetaFlags / extractParameterDetails / generateCallExample /
// extractParameters are PUBLIC static because CallCommand, ListCommand and the catalog-skill
// generators all consume them (none may import the FlowMcpCli facade). loadSharedAliases /
// scoreToolMatch are private (search-only). FlowMcpCli.search stays a public delegation
// (index.mjs + tests call it). No back-reference to FlowMcpCli — lib/core deps only.
class SearchCommand {
    static async search( { query } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        if( !query || typeof query !== 'string' || query.trim().length === 0 ) {
            const result = CliOutput.error( {
                'error': 'Missing search query.',
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} search <query>`
            } )

            return { result }
        }

        const { tools: allTools } = await SearchCommand.listAvailableTools()
        const queryTokens = query.toLowerCase().trim().split( /\s+/ )

        // Memo 099 Kap 6 — read env so search can flag key-gated (disabled) tools
        const { config: searchConfig } = await ConfigStore.readConfig( { cwd: process.cwd() } )
        const searchEnvPath = searchConfig ? searchConfig[ 'envPath' ] : null
        const { data: searchEnvContent } = searchEnvPath
            ? await FsUtils.readText( { filePath: searchEnvPath } )
            : { data: null }
        const searchEnvObject = searchEnvContent
            ? EnvResolver.parseEnvFile( { envContent: searchEnvContent } ).envObject
            : {}

        const { aliasIndex } = await SearchCommand.#loadSharedAliases()
        const sharedMatchRefs = new Set()
        aliasIndex
            .forEach( ( { searchTerms, schemaRefs } ) => {
                const hasMatch = queryTokens
                    .some( ( token ) => {
                        const found = searchTerms
                            .some( ( term ) => term.includes( token ) )

                        return found
                    } )

                if( hasMatch ) {
                    schemaRefs
                        .forEach( ( ref ) => { sharedMatchRefs.add( ref ) } )
                }
            } )

        const scoredTools = allTools
            .map( ( tool ) => {
                const { score } = SearchCommand.#scoreToolMatch( { tool, queryTokens, sharedMatchRefs } )
                const { toolName, description, namespace, tags, schemaRef, routeName } = tool
                const entry = {
                    'name': toolName,
                    description,
                    namespace,
                    tags,
                    score,
                    'type': tool[ 'type' ] || 'tool',
                    'call': `${appConfig[ 'cliCommand' ]} call ${toolName}`,
                    schemaRef,
                    routeName
                }

                return entry
            } )
            .filter( ( tool ) => {
                const { score } = tool

                return score > 0
            } )
            .sort( ( a, b ) => {
                const result = b[ 'score' ] - a[ 'score' ]

                return result
            } )

        const maxResults = 10
        const matchCount = scoredTools.length
        const showing = Math.min( matchCount, maxResults )
        const limitedTools = scoredTools.slice( 0, maxResults )
        const isDetailView = matchCount === 1

        const enrichedTools = await limitedTools
            .reduce( ( promise, tool ) => promise.then( async ( acc ) => {
                const { schemaRef, routeName, name: toolName } = tool
                const { filePath } = await SchemaSource.resolveSchemaPath( { schemaRef } )

                try {
                    const { main } = await SchemaLoaderBridge.loadSchema( { filePath } )

                    if( main ) {
                        // Memo 099 Kap 6 — flag tools whose required keys are missing
                        const requiredKeys = main[ 'requiredServerParams' ] || []
                        const missingKeys = requiredKeys
                            .filter( ( key ) => {
                                const present = searchEnvObject[ key ] !== undefined && String( searchEnvObject[ key ] ).length > 0

                                return present === false
                            } )
                        if( missingKeys.length > 0 ) {
                            tool[ 'disabled' ] = true
                            tool[ 'disabledReason' ] = `missing ${missingKeys.join( ', ' )}`
                        }

                        const { meta } = SearchCommand.extractMetaFlags( { main, routeName } )
                        const { requiredParams, optionalParams } = SearchCommand.extractParameterDetails( { main, routeName } )
                        const { example } = SearchCommand.generateCallExample( { toolName, requiredParams } )

                        tool[ 'meta' ] = meta
                        tool[ 'requiredParams' ] = requiredParams
                            .map( ( { key, type, isEnum, enumExamples, listRef } ) => {
                                const entry = { key, type }
                                if( isEnum && enumExamples.length > 0 ) {
                                    entry[ 'examples' ] = enumExamples
                                }
                                if( isEnum && listRef ) {
                                    entry[ 'list' ] = listRef
                                }

                                return entry
                            } )
                        tool[ 'example' ] = example

                        if( isDetailView ) {
                            tool[ 'optionalParams' ] = optionalParams
                                .map( ( { key, type, isEnum, enumExamples, listRef } ) => {
                                    const entry = { key, type }
                                    if( isEnum && listRef ) {
                                        entry[ 'list' ] = listRef
                                    }
                                    if( isEnum && enumExamples.length > 0 ) {
                                        entry[ 'examples' ] = enumExamples
                                    }

                                    return entry
                                } )
                        }
                    }
                } catch( err ) {
                    // Schema could not be loaded — return without enrichment
                    process.stderr.write( `CLI-005 search: schema enrichment skipped: ${err.message}\n` )
                }

                const toolType = tool[ 'type' ] || 'tool'
                if( tool[ 'namespace' ] && tool[ 'routeName' ] ) {
                    tool[ 'specId' ] = `${tool[ 'namespace' ]}/${toolType}/${tool[ 'routeName' ]}`
                }

                delete tool[ 'schemaRef' ]
                delete tool[ 'routeName' ]
                acc.push( tool )

                return acc
            } ), Promise.resolve( [] ) )

        let hint = ''
        if( matchCount === 0 ) {
            hint = 'No matches. Try broader terms or single keywords.'
        } else if( matchCount > maxResults ) {
            hint = `${matchCount} matches found, showing top ${maxResults} by relevance. Refine with: ${appConfig[ 'cliCommand' ]} search "more specific query"`
        }

        const result = {
            'status': true,
            query,
            matchCount,
            showing,
            'tools': enrichedTools
        }

        if( hint.length > 0 ) { result[ 'hint' ] = hint }

        return { result }
    }


    static async listAvailableTools() {
        const { sources } = await SchemaSource.listSources()
        const tools = []

        await sources
            .reduce( ( promise, source ) => promise.then( async () => {
                const { name: sourceName, schemas: sourceSchemas } = source

                await sourceSchemas
                    .reduce( ( schemaPromise, schemaEntry ) => schemaPromise.then( async () => {
                        const { file, namespace } = schemaEntry
                        const schemaRef = `${sourceName}/${file}`
                        const { filePath } = await SchemaSource.resolveSchemaPath( { schemaRef } )
                        const { main } = await SchemaLoaderBridge.loadSchema( { filePath } )

                        const effectiveNamespace = main && main[ 'namespace' ] ? main[ 'namespace' ] : namespace

                        const toolEntries = main ? ( main[ 'tools' ] || main[ 'routes' ] ) : null
                        if( main && toolEntries ) {
                            Object.entries( toolEntries )
                                .forEach( ( [ routeName, routeConfig ] ) => {
                                    const routeDescription = routeConfig[ 'description' ] || ''
                                    const toolRef = `${schemaRef}::${routeName}`
                                    const { toolName } = FlowMCP.buildToolName( {
                                        routeName,
                                        'namespace': effectiveNamespace
                                    } )

                                    tools.push( {
                                        toolRef,
                                        toolName,
                                        schemaRef,
                                        routeName,
                                        'namespace': effectiveNamespace,
                                        'description': routeDescription,
                                        'tags': main[ 'tags' ] || [],
                                        'schemaName': main[ 'name' ] || '',
                                        'type': 'tool'
                                    } )
                                } )
                        }

                        if( main && main[ 'resources' ] ) {
                            Object.entries( main[ 'resources' ] )
                                .forEach( ( [ resourceName, resourceConfig ] ) => {
                                    const resourceDescription = resourceConfig[ 'description' ] || ''
                                    const toolRef = `${schemaRef}::resource::${resourceName}`
                                    const toolName = `${resourceName}_${effectiveNamespace}`

                                    tools.push( {
                                        toolRef,
                                        toolName,
                                        schemaRef,
                                        'routeName': resourceName,
                                        'namespace': effectiveNamespace,
                                        'description': resourceDescription,
                                        'tags': main[ 'tags' ] || [],
                                        'schemaName': main[ 'name' ] || '',
                                        'type': 'resource'
                                    } )
                                } )
                        }

                        if( main && main[ 'skills' ] ) {
                            main[ 'skills' ]
                                .forEach( ( skillDef ) => {
                                    const skillName = skillDef[ 'name' ] || 'unknown'
                                    const skillDescription = skillDef[ 'description' ] || ''
                                    const toolRef = `${schemaRef}::skill::${skillName}`
                                    const toolName = `${skillName}_${effectiveNamespace}`

                                    tools.push( {
                                        toolRef,
                                        toolName,
                                        schemaRef,
                                        'routeName': skillName,
                                        'namespace': effectiveNamespace,
                                        'description': skillDescription,
                                        'tags': main[ 'tags' ] || [],
                                        'schemaName': main[ 'name' ] || '',
                                        'type': 'skill'
                                    } )
                                } )
                        }
                    } ), Promise.resolve() )
            } ), Promise.resolve() )

        return { tools }
    }


    static async #loadSharedAliases() {
        const { sources } = await SchemaSource.listSources()
        const schemasBaseDir = ConfigStore.schemasDir()
        const aliasIndex = []

        await sources
            .reduce( ( promise, source ) => promise.then( async () => {
                const { name: sourceName } = source
                const registryPath = join( schemasBaseDir, sourceName, '_registry.json' )
                const { data: registry } = await FsUtils.readJson( { filePath: registryPath } )

                if( !registry || !Array.isArray( registry[ 'shared' ] ) ) { return }

                await registry[ 'shared' ]
                    .reduce( ( p, sharedEntry ) => p.then( async () => {
                        const { file: sharedFile } = sharedEntry
                        const filePath = join( schemasBaseDir, sourceName, sharedFile )

                        try {
                            const mod = await import( pathToFileURL( filePath ).href )
                            let exportedArray = Object.values( mod )
                                .find( ( v ) => Array.isArray( v ) )

                            if( !exportedArray ) {
                                const listObj = Object.values( mod )
                                    .find( ( v ) => v && typeof v === 'object' && Array.isArray( v[ 'entries' ] ) )
                                exportedArray = listObj ? listObj[ 'entries' ] : null
                            }

                            if( !exportedArray ) { return }

                            const searchTerms = exportedArray
                                .reduce( ( acc, obj ) => {
                                    const alias = obj[ 'alias' ] || obj[ 'code' ] || obj[ 'alpha2' ] || ''
                                    const name = obj[ 'name' ] || ''

                                    if( alias ) { acc.push( alias.toLowerCase() ) }
                                    if( name ) { acc.push( name.toLowerCase() ) }

                                    return acc
                                }, [] )

                            const matchingSchemaRefs = ( registry[ 'schemas' ] || [] )
                                .filter( ( s ) => {
                                    const schemaShared = s[ 'shared' ] || []
                                    const matches = schemaShared.includes( sharedFile )

                                    return matches
                                } )
                                .map( ( s ) => {
                                    const ref = `${sourceName}/${s[ 'file' ]}`

                                    return ref
                                } )

                            aliasIndex.push( {
                                'sharedFile': sharedFile,
                                searchTerms,
                                'schemaRefs': matchingSchemaRefs
                            } )
                        } catch( err ) {
                            // _shared file could not be loaded — skip
                            CliOutput.emitCoded( { 'code': 'SCH-002', 'location': 'loadSharedAliases: shared file load failed', err } )
                        }
                    } ), Promise.resolve() )
            } ), Promise.resolve() )

        return { aliasIndex }
    }


    static #scoreToolMatch( { tool, queryTokens, sharedMatchRefs } ) {
        const { toolName, namespace, description, tags, schemaName } = tool
        const lowerName = toolName.toLowerCase()
        const lowerNamespace = namespace.toLowerCase()
        const lowerDesc = description.toLowerCase()
        const lowerSchemaName = schemaName.toLowerCase()
        const lowerTags = tags
            .map( ( tag ) => {
                const lower = tag.toLowerCase()

                return lower
            } )
        const nameSegments = lowerName.split( '_' )

        if( queryTokens.length === 1 && lowerName === queryTokens[ 0 ] ) {
            return { 'score': 100 }
        }

        let totalScore = 0

        const allTokensMatch = queryTokens
            .every( ( token ) => {
                let tokenScore = 0
                const wordBoundary = new RegExp( `\\b${token}\\b` )

                if( lowerNamespace === token ) { tokenScore += 20 }
                if( nameSegments.includes( token ) ) { tokenScore += 15 }
                if( lowerTags.includes( token ) ) { tokenScore += 12 }
                if( wordBoundary.test( lowerSchemaName ) ) { tokenScore += 8 }
                if( wordBoundary.test( lowerDesc ) ) { tokenScore += 5 }

                if( tokenScore === 0 ) {
                    const segmentContains = nameSegments
                        .some( ( seg ) => seg.includes( token ) )
                    if( segmentContains ) { tokenScore += 8 }
                }

                if( tokenScore === 0 ) {
                    const descContains = lowerDesc.includes( token )
                    if( descContains ) { tokenScore += 3 }
                }

                totalScore += tokenScore

                return tokenScore > 0
            } )

        if( !allTokensMatch && !( sharedMatchRefs && sharedMatchRefs.has( tool[ 'schemaRef' ] ) ) ) {
            return { 'score': 0 }
        }

        if( sharedMatchRefs && sharedMatchRefs.has( tool[ 'schemaRef' ] ) ) {
            totalScore += 10
        }

        return { 'score': totalScore }
    }


    static extractMetaFlags( { main, routeName } ) {
        const tools = main[ 'tools' ] || main[ 'routes' ] || {}
        const route = tools[ routeName ] || {}
        const method = ( route[ 'method' ] || 'GET' ).toUpperCase()
        const tags = main[ 'tags' ] || []
        const serverParams = main[ 'requiredServerParams' ] || []

        const flags = []

        if( method === 'GET' ) {
            flags.push( 'Read-only' )
        } else {
            flags.push( `${method}` )
        }

        if( serverParams.length > 0 ) {
            flags.push( 'API-Key required' )
        } else {
            flags.push( 'No API-Key' )
        }

        const hasCacheTtl = tags
            .some( ( tag ) => tag.startsWith( 'cacheTtl' ) )
        if( hasCacheTtl ) {
            flags.push( 'Cached' )
        }

        const meta = flags.join( ' | ' )

        return { meta }
    }


    static extractParameterDetails( { main, routeName } ) {
        const tools = main[ 'tools' ] || main[ 'routes' ] || {}
        const route = tools[ routeName ] || {}
        const parameters = route[ 'parameters' ] || []

        const requiredParams = []
        const optionalParams = []

        parameters
            .forEach( ( param ) => {
                const key = param?.[ 'position' ]?.[ 'key' ] || 'unknown'
                const primitive = param?.[ 'z' ]?.[ 'primitive' ] || 'string()'
                const options = param?.[ 'z' ]?.[ 'options' ] || []
                const isOptional = options
                    .some( ( opt ) => opt.startsWith( 'optional' ) )

                const typeMatch = primitive.match( /^(\w+)\(/ )
                const type = typeMatch ? typeMatch[ 1 ] : 'string'

                const isEnum = primitive.startsWith( 'enum(' )
                let enumExamples = []
                let listRef = null

                if( isEnum ) {
                    const enumContent = primitive.slice( 5, -1 )
                    const templateMatch = enumContent.match( /\{\{(\w+):(\w+)\}\}/ )

                    if( templateMatch ) {
                        const listName = templateMatch[ 1 ]
                        listRef = listName
                            .replace( /([a-z0-9])([A-Z])/g, '$1-$2' )
                            .toLowerCase()
                    } else {
                        enumExamples = enumContent
                            .split( ',' )
                            .map( ( v ) => v.trim().replace( /^'|'$/g, '' ) )
                            .slice( 0, 5 )
                    }
                }

                const entry = { key, type, isEnum, enumExamples, listRef }

                if( isOptional ) {
                    optionalParams.push( entry )
                } else {
                    requiredParams.push( entry )
                }
            } )

        return { requiredParams, optionalParams }
    }


    static generateCallExample( { toolName, requiredParams } ) {
        const paramParts = requiredParams
            .map( ( param ) => {
                const { key, type, enumExamples } = param

                if( type === 'number' ) {
                    return `"${key}":1`
                }

                if( type === 'boolean' ) {
                    return `"${key}":true`
                }

                if( enumExamples && enumExamples.length > 0 ) {
                    return `"${key}":"${enumExamples[ 0 ]}"`
                }

                return `"${key}":"<${key}>"`
            } )

        let example = ''

        if( paramParts.length > 0 ) {
            example = `flowmcp call ${toolName} '{${paramParts.join( ',' )}}'`
        } else {
            example = `flowmcp call ${toolName}`
        }

        return { example }
    }


    static extractParameters( { routeParameters, sharedLists } ) {
        const parameters = {}

        const userParameters = routeParameters
            .filter( ( param ) => {
                const { position } = param
                const isUserParam = position[ 'value' ] === '{{USER_PARAM}}'

                return isUserParam
            } )

        userParameters
            .forEach( ( param ) => {
                const { position, z } = param
                const { key } = position

                if( !z ) {
                    parameters[ key ] = { 'type': 'string', 'required': true }

                    return
                }

                const { primitive, options } = z

                const entry = {}

                if( primitive.startsWith( 'enum(' ) ) {
                    entry[ 'type' ] = 'enum'
                    let enumContent = primitive
                    if( enumContent.includes( '{{' ) && sharedLists ) {
                        const { result } = FlowMCP.interpolateEnum( { 'template': enumContent, sharedLists } )
                        enumContent = result
                    }
                    const inner = enumContent.slice( 5, -1 )
                    entry[ 'values' ] = inner.split( ',' )
                        .map( ( v ) => {
                            const trimmed = v.trim()

                            return trimmed
                        } )
                        .filter( ( v ) => v.length > 0 )
                } else if( primitive.startsWith( 'number(' ) ) {
                    entry[ 'type' ] = 'number'
                } else if( primitive.startsWith( 'array(' ) ) {
                    entry[ 'type' ] = 'array'
                } else {
                    entry[ 'type' ] = 'string'
                }

                const optionsList = options || []
                const hasOptional = optionsList
                    .find( ( opt ) => {
                        const isOptional = opt === 'optional()'

                        return isOptional
                    } )

                const defaultOption = optionsList
                    .find( ( opt ) => {
                        const isDefault = opt.startsWith( 'default(' )

                        return isDefault
                    } )

                if( hasOptional || defaultOption ) {
                    entry[ 'required' ] = false
                } else {
                    entry[ 'required' ] = true
                }

                if( defaultOption ) {
                    const inner = defaultOption.slice( 8, -1 )
                    const parsed = Number( inner )
                    entry[ 'default' ] = Number.isNaN( parsed ) ? inner : parsed
                }

                parameters[ key ] = entry
            } )

        return { parameters }
    }
}


export { SearchCommand }
