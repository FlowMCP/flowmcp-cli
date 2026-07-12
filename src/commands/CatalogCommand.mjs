import { readFile, stat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { appConfig, catalogCategories } from '../data/config.mjs'
import { ConfigStore } from '../lib/ConfigStore.mjs'
import { CliOutput } from '../lib/CliOutput.mjs'
import { FsUtils } from '../lib/FsUtils.mjs'
import { SchemaLoaderBridge } from '../lib/SchemaLoaderBridge.mjs'
import { SearchCommand } from './SearchCommand.mjs'


// Memo 152 / PRD-019 (D-08 cluster "catalog-skill", partial) — the two self-contained catalog
// read/validate commands extracted from FlowMcpCli: `catalog sources` (lists the linked local
// sources) and `validate-catalog` (structural registry.json check, CAT001..CAT007). The larger
// generateSkill / generateCatalog members of this cluster, plus catalog link/unlink, stay in
// FlowMcpCli untouched (link/unlink deletion is PRD-020 G-12). FlowMcpCli.catalogSources /
// validateCatalog stay as public delegations (index.mjs + the catalog test call them). No
// back-reference to FlowMcpCli — lib deps only.
class CatalogCommand {
    static async catalogSources() {
        const { localSources } = await ConfigStore.readLocalSources()

        const linked = Object.entries( localSources )
            .map( ( [ name, entry ] ) => {
                const sourceInfo = { name, 'path': entry[ 'path' ] }

                return sourceInfo
            } )

        const result = {
            'status': true,
            'count': linked.length,
            'sources': linked
        }

        return { result }
    }


    static async validateCatalog( { catalogDir, cwd } ) {
        if( !catalogDir ) {
            return { result: CliOutput.error( { error: 'Missing catalog directory', fix: 'flowmcp validate-catalog <catalog-directory>' } ) }
        }

        const registryPath = join( catalogDir, 'registry.json' )
        let registryData = null

        try {
            const content = await readFile( registryPath, 'utf-8' )
            registryData = JSON.parse( content )
        } catch( err ) {
            return { result: { status: false, errors: [ `CAT001: registry.json must exist in catalog root — ${err.message}` ], warnings: [] } }
        }

        const errors = []
        const warnings = []

        const dirName = catalogDir.split( '/' ).pop()

        if( registryData[ 'name' ] !== dirName ) {
            errors.push( `CAT002: name "${registryData[ 'name' ]}" must match directory name "${dirName}"` )
        }

        const shared = registryData[ 'shared' ] || []

        await Promise.allSettled(
            shared
                .map( async ( entry ) => {
                    const filePath = join( catalogDir, entry[ 'file' ] )

                    try {
                        await stat( filePath )
                    } catch( err ) {
                        errors.push( `CAT003: shared file not found — ${entry[ 'file' ]}` )
                    }
                } )
        )

        const schemas = registryData[ 'schemas' ] || []

        await Promise.allSettled(
            schemas
                .map( async ( entry ) => {
                    const filePath = join( catalogDir, entry[ 'file' ] )

                    try {
                        await stat( filePath )
                    } catch( err ) {
                        errors.push( `CAT004: schema file not found — ${entry[ 'file' ]}` )
                    }
                } )
        )

        const agents = registryData[ 'agents' ] || []

        await Promise.allSettled(
            agents
                .map( async ( entry ) => {
                    const filePath = join( catalogDir, entry[ 'manifest' ] )

                    try {
                        await stat( filePath )
                    } catch( err ) {
                        errors.push( `CAT005: agent manifest not found — ${entry[ 'manifest' ]}` )
                    }
                } )
        )

        const specVersion = registryData[ 'schemaSpec' ] || ''
        const validVersions = [ '2.0.0', '3.0.0' ]

        if( !validVersions.includes( specVersion ) ) {
            errors.push( `CAT007: schemaSpec "${specVersion}" is not a valid FlowMCP specification version` )
        }

        const result = {
            status: errors.length === 0,
            catalog: registryData[ 'name' ] || dirName,
            schemaSpec: specVersion,
            counts: {
                shared: shared.length,
                schemas: schemas.length,
                agents: agents.length
            },
            errors,
            warnings
        }

        return { result }
    }

    // Memo 152 / PRD-019 (D-08 cluster "catalog-skill") — generateCatalog + generateSkill moved
    // here from FlowMcpCli (they reuse the SearchCommand discovery helpers). catalog link/unlink
    // stay in FlowMcpCli (deletion is PRD-020 G-12).
    static async generateCatalog( { cwd } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { tools: allTools } = await SearchCommand.listAvailableTools()
        const schemasBaseDir = ConfigStore.schemasDir()

        const tagsByNamespace = {}

        await allTools
            .reduce( ( promise, tool ) => promise.then( async () => {
                const { schemaRef, namespace } = tool

                if( tagsByNamespace[ namespace ] ) { return }

                const filePath = join( schemasBaseDir, schemaRef )

                try {
                    const { main } = await SchemaLoaderBridge.loadSchema( { filePath } )

                    if( main && main[ 'tags' ] ) {
                        tagsByNamespace[ namespace ] = main[ 'tags' ]
                    } else {
                        tagsByNamespace[ namespace ] = []
                    }
                } catch( err ) {
                    process.stderr.write( `CLI-012 generateCatalog: schema tags load failed: ${err.message}\n` )
                    tagsByNamespace[ namespace ] = []
                }
            } ), Promise.resolve() )

        const categoryStats = catalogCategories
            .map( ( category ) => {
                const { name, match } = category
                const matchingTools = allTools
                    .filter( ( tool ) => {
                        const ns = tool[ 'namespace' ].toLowerCase()
                        const matched = match
                            .some( ( m ) => ns.startsWith( m ) )

                        return matched
                    } )

                const tagCounts = {}
                matchingTools
                    .forEach( ( tool ) => {
                        const nsTags = tagsByNamespace[ tool[ 'namespace' ] ] || []
                        nsTags
                            .filter( ( t ) => !t.startsWith( 'cacheTtl' ) )
                            .forEach( ( tag ) => {
                                tagCounts[ tag ] = ( tagCounts[ tag ] || 0 ) + 1
                            } )
                    } )

                const topTags = Object.entries( tagCounts )
                    .sort( ( a, b ) => b[ 1 ] - a[ 1 ] )
                    .slice( 0, 7 )
                    .map( ( [ tag ] ) => tag )

                const namespaceCounts = {}
                matchingTools
                    .forEach( ( tool ) => {
                        const ns = tool[ 'namespace' ]
                        namespaceCounts[ ns ] = ( namespaceCounts[ ns ] || 0 ) + 1
                    } )

                const topProviders = Object.entries( namespaceCounts )
                    .sort( ( a, b ) => b[ 1 ] - a[ 1 ] )
                    .slice( 0, 3 )
                    .map( ( [ ns ] ) => `${ns}-*` )

                return {
                    name,
                    'toolCount': matchingTools.length,
                    topTags,
                    topProviders
                }
            } )
            .filter( ( c ) => c[ 'toolCount' ] > 0 )

        const uncategorizedTools = allTools
            .filter( ( tool ) => {
                const ns = tool[ 'namespace' ].toLowerCase()
                const isInCategory = catalogCategories
                    .some( ( cat ) => {
                        const matched = cat[ 'match' ]
                            .some( ( m ) => ns.startsWith( m ) )

                        return matched
                    } )

                return !isInCategory
            } )

        if( uncategorizedTools.length > 0 ) {
            const uncategorizedNamespaces = {}
            uncategorizedTools
                .forEach( ( tool ) => {
                    uncategorizedNamespaces[ tool[ 'namespace' ] ] = true
                } )

            categoryStats.push( {
                'name': 'Other',
                'toolCount': uncategorizedTools.length,
                'topTags': [],
                'topProviders': Object.keys( uncategorizedNamespaces ).slice( 0, 3 )
                    .map( ( ns ) => `${ns}-*` )
            } )
        }

        const totalTools = allTools.length
        const categoryCount = categoryStats.length

        const rows = categoryStats
            .map( ( cat ) => {
                const tags = cat[ 'topTags' ].join( ', ' ) || '—'
                const providers = cat[ 'topProviders' ].join( ', ' ) || '—'

                return `| ${cat[ 'name' ]} | ${cat[ 'toolCount' ]} | ${tags} | ${providers} |`
            } )
            .join( '\n' )

        const markdown = [
            `# FlowMCP Meta-Katalog (${totalTools} Tools, ${categoryCount} Kategorien)`,
            `# Suche: flowmcp search <query>`,
            '',
            '| Kategorie | Tools | Top-Tags | Top-Providers |',
            '|-----------|:-----:|----------|---------------|',
            rows,
            ''
        ].join( '\n' )

        const outputDir = join( cwd, '.claude', 'rules' )
        const outputPath = join( outputDir, 'flowmcp-catalog.md' )

        await mkdir( outputDir, { 'recursive': true } )
        await FsUtils.writeGuarded( { 'path': outputPath, 'content': markdown, 'onExists': 'overwrite' } )

        const tokenEstimate = Math.ceil( markdown.length / 4 )

        const result = {
            'status': true,
            'path': outputPath,
            'categories': categoryCount,
            totalTools,
            tokenEstimate,
            'content': markdown
        }

        return { result }
    }


    static async generateSkill( { toolId } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        if( !toolId || typeof toolId !== 'string' || toolId.trim().length === 0 ) {
            const result = CliOutput.error( {
                'error': 'Missing tool ID.',
                'fix': `Provide: ${appConfig[ 'cliCommand' ]} skill generate <tool-name>`
            } )

            return { result }
        }

        const { tools: allTools } = await SearchCommand.listAvailableTools()
        const matchedTool = allTools
            .find( ( t ) => t[ 'toolName' ] === toolId )

        if( !matchedTool ) {
            const result = CliOutput.error( {
                'error': `Tool "${toolId}" not found.`,
                'fix': `Use: ${appConfig[ 'cliCommand' ]} search <keyword> to find tool names`
            } )

            return { result }
        }

        const schemasBaseDir = ConfigStore.schemasDir()
        const filePath = join( schemasBaseDir, matchedTool[ 'schemaRef' ] )
        const { main } = await SchemaLoaderBridge.loadSchema( { filePath } )

        if( !main ) {
            const result = CliOutput.error( {
                'error': `Could not load schema for "${toolId}".`,
                'fix': 'Schema file may be corrupted or missing.'
            } )

            return { result }
        }

        const { routeName } = matchedTool
        const tools = main[ 'tools' ] || main[ 'routes' ] || {}
        const route = tools[ routeName ] || {}

        const { meta } = SearchCommand.extractMetaFlags( { main, routeName } )
        const { requiredParams, optionalParams } = SearchCommand.extractParameterDetails( { main, routeName } )
        const { example } = SearchCommand.generateCallExample( { 'toolName': toolId, requiredParams } )

        const allParams = [ ...requiredParams, ...optionalParams ]
        const paramRows = allParams
            .map( ( param ) => {
                const { key, type, isEnum, enumExamples, listRef } = param
                const isRequired = requiredParams
                    .some( ( rp ) => rp[ 'key' ] === key )
                const required = isRequired ? 'Yes' : 'No'
                const typeDisplay = isEnum && listRef
                    ? `enum (${listRef})`
                    : type

                return `| ${key} | ${typeDisplay} | ${required} | — |`
            } )
            .join( '\n' )

        const enumSections = allParams
            .filter( ( p ) => p[ 'isEnum' ] && ( p[ 'listRef' ] || p[ 'enumExamples' ].length > 0 ) )
            .map( ( p ) => {
                if( p[ 'listRef' ] ) {
                    return `### ${p[ 'key' ]} (${p[ 'listRef' ]})\nExamples: see \`flowmcp lists ${p[ 'listRef' ]}\``
                }

                return `### ${p[ 'key' ]}\nValues: ${p[ 'enumExamples' ].join( ', ' )}`
            } )
            .join( '\n\n' )

        const description = route[ 'description' ] || main[ 'description' ] || ''

        const sections = [
            `# Skill: ${toolId}`,
            '',
            `> ${description}`,
            '',
            '## Meta',
            `- ${meta}`,
            '',
            '## Parameters',
            '',
            '| Parameter | Type | Required | Default |',
            '|-----------|------|----------|---------|',
            paramRows,
            ''
        ]

        if( enumSections.length > 0 ) {
            sections.push( '## Enum Values', '', enumSections, '' )
        }

        sections.push(
            '## Call',
            '',
            '```bash',
            example,
            '```',
            ''
        )

        const content = sections
            .flat()
            .join( '\n' )

        const result = {
            'status': true,
            toolId,
            'content': content
        }

        return { result }
    }
}


export { CatalogCommand }
