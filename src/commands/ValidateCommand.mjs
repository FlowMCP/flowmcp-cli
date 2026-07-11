import { ADDON_REGISTRY } from '../data/addons.mjs'
import { ConfigStore } from '../lib/ConfigStore.mjs'
import { CliOutput } from '../lib/CliOutput.mjs'
import { SchemaSource } from '../lib/SchemaSource.mjs'
import { SchemaLoaderBridge } from '../lib/SchemaLoaderBridge.mjs'
import { ModuleRegistry } from '../lib/ModuleRegistry.mjs'
import { SqliteGtfsResourceValidator } from '../validators/SqliteGtfsResourceValidator.mjs'
import { ServeCommand } from './ServeCommand.mjs'


// Memo 152 / PRD-019 (D-08 cluster "validate-migrate") — `flowmcp validate` (aka schema-check)
// + `flowmcp schemas`, extracted from FlowMcpCli. v4-only validation (Memo 152 PRD-012 B-06):
// a schema that does not declare a 4.x version is rejected fail-loud (convert via `flowmcp
// migrate`). validateSingleSchema is PUBLIC static because the grading-deterministic path reuses
// it (shared validate-single family). The v4 core surface is read via ModuleRegistry.getV4()
// (the old #v4Module was a thin delegation to it). Default-group resolution is delegated to
// ServeCommand (F18=A move). FlowMcpCli.validate / schemas / validationValidate stay public
// delegations (index.mjs + tests call them). No back-reference to FlowMcpCli.
class ValidateCommand {
    static async schemas() {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const { sources } = await SchemaSource.listSources()

        const result = {
            'status': true,
            sources
        }

        return { result }
    }


    static async validate( { schemaPath, cwd } ) {
        const { initialized, error: initError, fix: initFix } = await ConfigStore.requireInit()
        if( !initialized ) {
            const result = CliOutput.error( { 'error': initError, 'fix': initFix } )

            return { result }
        }

        const v4 = ModuleRegistry.getV4()

        if( !schemaPath && cwd ) {
            const { schemas: groupSchemas, error: groupError } = await ServeCommand.resolveDefaultGroupSchemas( { cwd } )
            if( groupError ) {
                const result = CliOutput.error( { error: groupError } )

                return { result }
            }

            const results = groupSchemas
                .map( ( { main, file } ) => ValidateCommand.validateSingleSchema( { main, file, v4 } ) )

            const passed = results
                .filter( ( { status } ) => {
                    const isPassed = status === true

                    return isPassed
                } )
                .length

            const failed = results.length - passed

            const result = {
                'status': failed === 0,
                'total': results.length,
                passed,
                failed,
                results
            }

            return { result }
        }

        const { status: validStatus, messages: validMessages } = ValidateCommand.validationValidate( { schemaPath } )
        if( !validStatus ) {
            const result = { 'status': false, 'messages': validMessages }

            return { result }
        }

        const { schemas, error: loadError } = await SchemaLoaderBridge.loadSchemasFromPath( { schemaPath } )
        if( !schemas ) {
            const result = CliOutput.error( { error: loadError } )

            return { result }
        }

        const results = schemas
            .map( ( { main, file } ) => ValidateCommand.validateSingleSchema( { main, file, v4 } ) )

        const passed = results
            .filter( ( { status } ) => {
                const isPassed = status === true

                return isPassed
            } )
            .length

        const failed = results.length - passed

        const result = {
            'status': failed === 0,
            'total': results.length,
            passed,
            failed,
            results
        }

        return { result }
    }


    static validationValidate( { schemaPath } ) {
        const struct = { 'status': false, 'messages': [] }

        if( schemaPath === undefined || schemaPath === null ) {
            struct[ 'messages' ].push( 'schemaPath: Missing value. Provide a path to a schema file or directory.' )
        } else if( typeof schemaPath !== 'string' ) {
            struct[ 'messages' ].push( 'schemaPath: Must be a string.' )
        }

        if( struct[ 'messages' ].length > 0 ) {
            return struct
        }

        struct[ 'status' ] = true

        return struct
    }


    static #enrichV4WithRuntimeMeta( { main, MetaGenerator } ) {
        const tools = main && main[ 'tools' ] ? main[ 'tools' ] : null
        if( !tools || typeof tools !== 'object' ) { return main }

        const enrichedEntries = Object
            .entries( tools )
            .map( ( [ name, tool ] ) => {
                if( tool && tool[ 'meta' ] ) { return [ name, tool ] }
                const { meta } = MetaGenerator.generate( { tool, 'toolName': name } )
                return [ name, { ...tool, meta } ]
            } )

        return { ...main, 'tools': Object.fromEntries( enrichedEntries ) }
    }


    static #v4ConsistencyErrors( { main, toolCount } ) {
        const errors = []
        const routeKeys = main && main[ 'routes' ] ? Object.keys( main[ 'routes' ] ) : []
        if( routeKeys.length > 0 ) {
            errors.push( 'VERSION-001: a 4.x schema must not declare populated "routes" (use "tools")' )
        }
        const skills = main && Array.isArray( main[ 'skills' ] ) ? main[ 'skills' ] : []
        if( skills.length > 0 ) {
            errors.push( 'VERSION-002: a 4.x schema must not declare "skills"' )
        }
        if( toolCount > 8 ) {
            errors.push( `VERSION-003: a 4.x schema declares ${toolCount} tools; the per-file cap is 8 (split the namespace)` )
        }

        return errors
    }


    // Public: the grading-deterministic path reuses this (shared validate-single family).
    static validateSingleSchema( { main, file, v4 } ) {
        const namespace = main && main[ 'namespace' ] ? main[ 'namespace' ] : 'unknown'
        const toolCount = Object.keys( ( main && ( main[ 'tools' ] || main[ 'routes' ] ) ) || {} ).length
        const resourceCount = Object.keys( ( main && main[ 'resources' ] ) || {} ).length
        const skillCount = ( ( main && main[ 'skills' ] ) || [] ).length
        const version = main && main[ 'version' ] ? String( main[ 'version' ] ) : ''
        const isV4 = version.startsWith( '4.' )

        const sqliteGtfsErrors = ValidateCommand.#runSqliteGtfsResourceChecks( { main } )

        // Memo 152 / PRD-012 (B-06) — v4-only: a schema that does not declare a 4.x
        // version is rejected fail-loud (no silent normalization, no v2 validateMain
        // fallback). Convert a legacy schema explicitly with `flowmcp migrate`.
        if( !isV4 ) {
            const combinedMessages = [ `VAL-009: schema version "${version || 'missing'}" is not v4 — this CLI validates v4-only schemas (version 4.x). Convert a legacy schema with \`flowmcp migrate\`.`, ...sqliteGtfsErrors.map( ( e ) => `${e.code}: ${e.message} (${e.path})` ) ]
            return { file, namespace, 'status': false, 'messages': combinedMessages, 'tools': toolCount, 'resources': resourceCount, 'skills': skillCount }
        }

        try {
            // Memo 119 Kap 3 — version-consistency gate. A schema declaring a 4.x
            // version must be SHAPED like v4: no populated v2 `routes`, no populated
            // v3 `skills`, and at most 8 tools per file. Because v4 reuses the v2
            // transport, a mis-declared schema otherwise only fails at runtime.
            const consistencyErrors = ValidateCommand.#v4ConsistencyErrors( { main, toolCount } )
            const enriched = v4[ 'MetaGenerator' ]
                ? ValidateCommand.#enrichV4WithRuntimeMeta( { main, 'MetaGenerator': v4[ 'MetaGenerator' ] } )
                : main
            const { status, messages, warnings } = v4[ 'MainValidator' ].validate( { 'main': enriched } )
            const combinedMessages = [ ...consistencyErrors, ...( messages || [] ), ...sqliteGtfsErrors.map( ( e ) => `${e.code}: ${e.message} (${e.path})` ) ]
            const combinedStatus = status && sqliteGtfsErrors.length === 0 && consistencyErrors.length === 0
            return { file, namespace, 'status': combinedStatus, 'messages': combinedMessages, warnings, 'tools': toolCount, 'resources': resourceCount, 'skills': skillCount }
        } catch( err ) {
            const combinedMessages = [ `SKL-003 validateSingleSchema: ${err.message}`, ...sqliteGtfsErrors.map( ( e ) => `${e.code}: ${e.message} (${e.path})` ) ]
            return {
                file, namespace,
                'status': false,
                'messages': combinedMessages,
                'tools': toolCount, 'resources': resourceCount, 'skills': skillCount
            }
        }
    }


    static #runSqliteGtfsResourceChecks( { main } ) {
        // RES030/RES031/RES035 — structural sqlite-gtfs checks (Memo 051 PRD-17).
        // RES032, RES033, RES034 are pipeline-only — see `flowmcp add` (PRD-18).
        const rawResources = main && main[ 'resources' ]
        if( !rawResources ) { return [] }

        const resourcesArray = Array.isArray( rawResources )
            ? rawResources
            : Object.values( rawResources )

        const hasAnySqliteGtfs = resourcesArray
            .some( ( r ) => {
                const isMatch = r && ADDON_REGISTRY[ r.source ] !== undefined

                return isMatch
            } )

        if( !hasAnySqliteGtfs ) { return [] }

        const { errors } = SqliteGtfsResourceValidator.validateResources( { 'resources': resourcesArray } )

        return errors
    }
}


export { ValidateCommand }
