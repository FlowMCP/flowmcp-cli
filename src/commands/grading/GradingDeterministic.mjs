/**
 * FlowMCP — MIT License
 *
 * Memo 152 / PRD-019 (D-10) — grading-bridge module split. Extracted VERBATIM
 * from FlowMcpCli.mjs; bodies are byte-identical, cross-module references route
 * through the sibling grading modules / core (public statics). FlowMcpCli keeps
 * thin delegation facades for the routed entry points (F12=A).
 */

import { readFile, writeFile, mkdir, readdir, stat, access, unlink, rename } from 'node:fs/promises'
import { join, resolve, basename, extname, dirname, relative, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'

import chalk from 'chalk'
import { FlowMCP, SkillValidator, SelectionValidator, CatalogIndex, IdResolver } from 'flowmcp'

import { appConfig } from '../../data/config.mjs'
import { PathVariableResolver } from '../../path/resolvePathVariables.mjs'
import { SqliteGtfsRuntime } from '../../addons/SqliteGtfsRuntime.mjs'
import { ModuleRegistry } from '../../lib/ModuleRegistry.mjs'
import { CliOutput, CliError } from '../../lib/CliOutput.mjs'
import { FsUtils } from '../../lib/FsUtils.mjs'
import { ConfigStore } from '../../lib/ConfigStore.mjs'
import { SchemaSource } from '../../lib/SchemaSource.mjs'
import { EnvResolver } from '../../lib/EnvResolver.mjs'
import { NamespaceIndex } from '../../lib/NamespaceIndex.mjs'
import { HandlerResolver } from '../../lib/HandlerResolver.mjs'
import { SchemaLoaderBridge } from '../../lib/SchemaLoaderBridge.mjs'
import { ValidateCommand } from '../ValidateCommand.mjs'
import { ListsCommand } from '../ListsCommand.mjs'
import { GradingTarget } from './GradingTarget.mjs'
import { GradingConsume } from './GradingConsume.mjs'
import { GradingEmit } from './GradingEmit.mjs'
import { GradingStatus } from './GradingStatus.mjs'


class GradingDeterministic {
    // Memo 152 / PRD-019 (D-08) — #quickInstall moved to src/commands/InitCommand.mjs.


    // Memo 152 / PRD-019 (D-08) — #manualInstall moved to src/commands/InitCommand.mjs.


    // Memo 152 / PRD-019 (D-08) — #promptEnvPath moved to src/commands/InitCommand.mjs.




    // Memo 152 / PRD-019 (D-08) — #detectCoreInfo moved to src/commands/InitCommand.mjs.


    static getAllTestsTyped( { main } ) {
        const schemaRef = main[ 'namespace' ] || 'unknown'
        const tests = []

        // (1) Tools (also accepts legacy v1.x `routes`)
        const tools = main[ 'tools' ] || main[ 'routes' ] || {}
        Object.entries( tools )
            .forEach( ( [ toolName, toolConfig ] ) => {
                const toolTests = toolConfig[ 'tests' ] || []

                toolTests
                    .forEach( ( testCase ) => {
                        const { _description, ...userParams } = testCase

                        tests.push( {
                            'primitive': 'tool',
                            schemaRef,
                            'name': toolName,
                            'test': { '_description': _description || '', userParams },
                            'context': { 'routeName': toolName }
                        } )
                    } )
            } )

        // (2) Resources — main.resources is an object of resources, each with queries, each with tests
        const resources = main[ 'resources' ] || {}
        Object.entries( resources )
            .forEach( ( [ resourceName, resourceConfig ] ) => {
                const queries = resourceConfig[ 'queries' ] || {}

                Object.entries( queries )
                    .forEach( ( [ queryName, queryConfig ] ) => {
                        const queryTests = queryConfig[ 'tests' ] || []

                        queryTests
                            .forEach( ( testCase ) => {
                                const { _description, ...userParams } = testCase

                                tests.push( {
                                    'primitive': 'resource',
                                    schemaRef,
                                    'name': `${resourceName}.${queryName}`,
                                    'test': { '_description': _description || '', userParams },
                                    'context': { resourceName, queryName }
                                } )
                            } )
                    } )
            } )

        // (3) Skills — Structural-Tests; implizites Structural-Test-Set falls keine tests
        const skills = main[ 'skills' ] || []
        skills
            .forEach( ( skill ) => {
                const skillName = skill[ 'name' ]
                const explicitTests = skill[ 'tests' ] || []

                const skillTests = explicitTests.length > 0
                    ? explicitTests
                    : [ { '_description': `Structural: ${skillName}` } ]

                skillTests
                    .forEach( ( testCase ) => {
                        const { _description, ...userParams } = testCase

                        tests.push( {
                            'primitive': 'skill',
                            schemaRef,
                            'name': skillName,
                            'test': { '_description': _description || '', userParams },
                            'context': { skill, 'kind': 'structural' }
                        } )
                    } )
            } )

        // (4) Prompts
        const prompts = main[ 'prompts' ] || []
        prompts
            .forEach( ( prompt ) => {
                const promptName = prompt[ 'name' ]
                const promptTests = prompt[ 'tests' ] || []

                promptTests
                    .forEach( ( testCase ) => {
                        const { _description, ...userParams } = testCase

                        tests.push( {
                            'primitive': 'prompt',
                            schemaRef,
                            'name': promptName,
                            'test': { '_description': _description || '', userParams },
                            'context': { prompt }
                        } )
                    } )
            } )

        // (5) Selection — transitive Member-Liste + Inline-Skills
        const selection = main[ 'selection' ] || null
        if( selection ) {
            const memberLists = [
                { 'type': 'tool',     'ids': selection[ 'tools' ] || [] },
                { 'type': 'resource', 'ids': selection[ 'resources' ] || [] },
                { 'type': 'prompt',   'ids': selection[ 'prompts' ] || [] }
            ]

            memberLists
                .forEach( ( { type, ids } ) => {
                    ids
                        .forEach( ( memberId ) => {
                            tests.push( {
                                'primitive': 'selection-member',
                                schemaRef,
                                'name': memberId,
                                'test': { '_description': `Selection member: ${memberId}`, 'userParams': {} },
                                'context': { memberId, 'memberType': type }
                            } )
                        } )
                } )

            const inlineSkills = selection[ 'skills' ] || []

            inlineSkills
                .forEach( ( skill ) => {
                    const skillName = skill[ 'name' ]
                    const skillTests = skill[ 'tests' ] || [ { '_description': `Selection-skill (structural): ${skillName}` } ]

                    skillTests
                        .forEach( ( testCase ) => {
                            const { _description, ...userParams } = testCase

                            tests.push( {
                                'primitive': 'skill',
                                schemaRef,
                                'name': skillName,
                                'test': { '_description': _description || '', userParams },
                                'context': { skill, 'kind': 'selection-inline' }
                            } )
                        } )
                } )
        }

        return tests
    }


    // Output capture: full string in JSON mode (fullOutput), 200-char preview otherwise.
    // The human/terminal renderer never prints this field, so the preview cap only ever
    // affected the JSON payload that machine analysis consumes — full output is required there.
    static limitOutput( { dataAsString, fullOutput } ) {
        const previewLimit = 200

        if( !dataAsString ) {
            return null
        }

        return fullOutput === true ? dataAsString : dataAsString.slice( 0, previewLimit )
    }


    // PRD-005: Primitive-aware test dispatcher (v4-ready)
    // Routes per typedTest.primitive: tool, resource, skill, prompt, selection-member
    // Always returns { status, error, output, durationMs, primitive } — never throws
    static async executeTest( { typedTest, schemaMain, schemaSource = null, handlerMap = {}, resourceHandlerMap = {}, serverParams = {}, sharedLists = {}, fullOutput = false } ) {
        const startedAt = Date.now()
        const primitive = typedTest[ 'primitive' ]

        try {
            if( primitive === 'tool' ) {
                const { routeName } = typedTest[ 'context' ]
                const { userParams } = typedTest[ 'test' ]

                const fetchResult = await FlowMCP.fetch( {
                    'main': schemaMain,
                    handlerMap,
                    userParams,
                    serverParams,
                    routeName
                } )

                const { status, messages, dataAsString } = fetchResult
                const output = GradingDeterministic.limitOutput( { dataAsString, fullOutput } )
                const error = status ? null : ( ( messages || [] )[ 0 ] || 'unknown error' )

                return {
                    status,
                    error,
                    output,
                    'durationMs': Date.now() - startedAt,
                    primitive
                }
            }

            if( primitive === 'resource' ) {
                const { resourceName, queryName } = typedTest[ 'context' ]
                const { userParams } = typedTest[ 'test' ]
                const resources = schemaMain[ 'resources' ] || {}
                const resourceDefinition = resources[ resourceName ]
                const schemaRef = typedTest[ 'schemaRef' ] || schemaMain[ 'namespace' ] || 'unknown'

                if( !resourceDefinition ) {
                    return {
                        'status': false,
                        'error': `resource "${resourceName}" not found in schema`,
                        'output': null,
                        'durationMs': Date.now() - startedAt,
                        primitive
                    }
                }

                const execResult = await FlowMCP.executeResource( {
                    resourceDefinition,
                    resourceName,
                    queryName,
                    userParams,
                    'handlerMap': resourceHandlerMap,
                    schemaRef
                } )

                const struct = execResult && execResult[ 'struct' ] ? execResult[ 'struct' ] : execResult || {}
                const ok = struct[ 'status' ] === true
                const dataString = struct[ 'dataAsString' ]
                    ? struct[ 'dataAsString' ]
                    : ( struct[ 'data' ] ? JSON.stringify( struct[ 'data' ] ) : null )
                const output = GradingDeterministic.limitOutput( { 'dataAsString': dataString, fullOutput } )
                const error = ok ? null : ( ( struct[ 'messages' ] || [] )[ 0 ] || 'resource execution failed' )

                return {
                    'status': ok,
                    error,
                    output,
                    'durationMs': Date.now() - startedAt,
                    primitive
                }
            }

            // skill / prompt / selection-member carry no downloadable data. They are
            // validated STRUCTURALLY against the real v4 modules (no longer stub-passed):
            // SkillValidator / SelectionValidator / a prompt field check. A structurally
            // invalid primitive returns status:false.
            if( primitive === 'skill' ) {
                const tools = schemaMain[ 'tools' ] || {}
                const resources = schemaMain[ 'resources' ] || {}
                const skill = typedTest[ 'context' ][ 'skill' ]
                const skillName = typedTest[ 'name' ]
                const { status, messages } = SkillValidator.validate( {
                    'skills': { [ skillName ]: skill },
                    tools,
                    resources
                } )
                return {
                    status,
                    'error': status ? null : ( ( messages || [] )[ 0 ] || 'skill structurally invalid' ),
                    'output': `skill-structural:${skillName}`,
                    'durationMs': Date.now() - startedAt,
                    primitive
                }
            }

            if( primitive === 'prompt' ) {
                // No dedicated v4 PromptValidator export — the honest structural check is
                // field-level: a prompt must carry a non-empty string name.
                const prompt = typedTest[ 'context' ][ 'prompt' ]
                const status = prompt !== undefined && prompt !== null && typeof prompt[ 'name' ] === 'string' && prompt[ 'name' ].length > 0
                return {
                    status,
                    'error': status ? null : 'prompt structurally invalid: missing string name',
                    'output': `prompt-structural:${typedTest[ 'name' ]}`,
                    'durationMs': Date.now() - startedAt,
                    primitive
                }
            }

            if( primitive === 'selection-member' ) {
                // Single-schema structural validation of the selection block via the real
                // v4 module. Catalog-resolvability (SEL003) needs cross-schema registry
                // data not available here, so it is omitted.
                const selection = schemaMain[ 'selection' ] || null
                const { valid, errors } = selection === null
                    ? { 'valid': false, 'errors': [ 'selection block missing on schema' ] }
                    : SelectionValidator.validate( { selection, 'catalog': null } )
                return {
                    'status': valid,
                    'error': valid ? null : ( ( errors || [] )[ 0 ] || 'selection structurally invalid' ),
                    'output': `selection-member:${typedTest[ 'name' ]}`,
                    'durationMs': Date.now() - startedAt,
                    primitive
                }
            }

            return {
                'status': false,
                'error': `unknown primitive: ${primitive}`,
                'output': null,
                'durationMs': Date.now() - startedAt,
                primitive
            }
        } catch( err ) {
            return {
                'status': false,
                'error': `CLI-021 executeTest: ${err && err.message ? err.message : String( err )}`,
                'output': null,
                'durationMs': Date.now() - startedAt,
                primitive
            }
        }
    }


    // PRD-005: Iterate typed tests + dispatch + aggregate per-primitive summary
    // Returns { results, summary: { byPrimitive: {...}, overall: 'PASS' | 'FAIL' } }
    static async runTypedTests( { main, schemaSource = null, handlerMap = {}, resourceHandlerMap = {}, serverParams = {}, sharedLists = {}, fullOutput = false } ) {
        const typedTests = GradingDeterministic.getAllTestsTyped( { main } )

        const results = await typedTests
            .reduce( ( promise, typedTest ) => promise.then( async ( acc ) => {
                const result = await GradingDeterministic.executeTest( {
                    typedTest,
                    'schemaMain': main,
                    schemaSource,
                    handlerMap,
                    resourceHandlerMap,
                    serverParams,
                    sharedLists,
                    fullOutput
                } )

                acc.push( {
                    'primitive': typedTest[ 'primitive' ],
                    'name': typedTest[ 'name' ],
                    'schemaRef': typedTest[ 'schemaRef' ],
                    ...result
                } )

                return acc
            } ), Promise.resolve( [] ) )

        const byPrimitive = results
            .reduce( ( acc, r ) => {
                const key = r[ 'primitive' ] || 'unknown'

                if( !acc[ key ] ) {
                    acc[ key ] = { 'pass': 0, 'fail': 0 }
                }

                if( r[ 'status' ] === true ) {
                    acc[ key ][ 'pass' ] = acc[ key ][ 'pass' ] + 1
                } else {
                    acc[ key ][ 'fail' ] = acc[ key ][ 'fail' ] + 1
                }

                return acc
            }, {} )

        const totalFail = Object
            .values( byPrimitive )
            .reduce( ( sum, v ) => sum + v[ 'fail' ], 0 )

        const overall = totalFail === 0 ? 'PASS' : 'FAIL'

        return {
            results,
            'summary': { byPrimitive, overall }
        }
    }


    // PRD-006: validate --only=<csv> filter, map plural CLI values -> internal singular discriminators
    static validateOnlyFilter( { only } ) {
        if( only === undefined || only === null || only === '' ) {
            return { 'filter': null, 'error': null }
        }

        const allowed = [ 'tools', 'resources', 'skills', 'prompts', 'selections' ]
        const requested = only
            .split( ',' )
            .map( ( s ) => s.trim() )
            .filter( ( s ) => s.length > 0 )

        const invalid = requested
            .filter( ( r ) => {
                const isInvalid = !allowed.includes( r )

                return isInvalid
            } )

        if( invalid.length > 0 ) {
            return {
                'filter': null,
                'error': `Invalid --only values: ${invalid.join( ', ' )}. Allowed: ${allowed.join( ', ' )}`
            }
        }

        const primitiveMap = {
            'tools': 'tool',
            'resources': 'resource',
            'skills': 'skill',
            'prompts': 'prompt',
            'selections': 'selection-member'
        }

        const filter = requested
            .map( ( r ) => {
                return primitiveMap[ r ]
            } )

        return { filter, 'error': null }
    }


    // PRD-006: compute "declared" map per primitive from a schema main
    static computeDeclared( { main } ) {
        const safeMain = main || {}
        const tools = safeMain[ 'tools' ] || safeMain[ 'routes' ]
        const resources = safeMain[ 'resources' ]
        const skills = safeMain[ 'skills' ]
        const prompts = safeMain[ 'prompts' ]
        const selection = safeMain[ 'selection' ]

        const declared = {
            'tool':              tools !== undefined && tools !== null,
            'resource':          resources !== undefined && resources !== null,
            'skill':             skills !== undefined && skills !== null,
            'prompt':            prompts !== undefined && prompts !== null,
            'selection-member':  selection !== undefined && selection !== null
        }

        return { declared }
    }


    // PRD-006: aggregate per-primitive summary { passed, total, declared, filtered }
    static aggregateByPrimitive( { results, declared, filter } ) {
        const primitives = [ 'tool', 'resource', 'skill', 'prompt', 'selection-member' ]
        const safeResults = results || []
        const safeDeclared = declared || {}
        const filteredSet = filter ? new Set( filter ) : null

        const summary = primitives
            .reduce( ( acc, p ) => {
                const own = safeResults
                    .filter( ( r ) => {
                        const matches = r[ 'primitive' ] === p

                        return matches
                    } )

                const passed = own
                    .filter( ( r ) => {
                        const isPass = r[ 'status' ] === true

                        return isPass
                    } )
                    .length

                const total = own.length
                const isFiltered = filteredSet ? !filteredSet.has( p ) : false
                const isDeclared = safeDeclared[ p ] === true

                acc[ p ] = {
                    passed,
                    total,
                    'declared': isDeclared,
                    'filtered': isFiltered
                }

                return acc
            }, {} )

        return { summary }
    }


    // PRD-4.2 — concise human summary for a deterministic result, to STDERR.
    // JSON-shape audit conclusion: NO machine key is dropped/renamed (rollup +
    // Provider-Proof consumers depend on them); this summary is ADDITIVE and lives
    // on stderr so a piped stdout stays pure JSON. Suppressed by --quiet and by
    // --json (pure machine mode). Handles both the single-schema and namespace shapes.
    static printDeterministicSummary( { result, quiet, json } ) {
        if( quiet === true || json === true || result === null || result === undefined ) { return }
        if( result[ 'status' ] === false && result[ 'mode' ] === undefined ) {
            process.stderr.write( `[grading] error: ${result[ 'error' ]}\n` )
            return
        }

        const lines = []
        const verdict = result[ 'status' ] === true ? 'PASS' : 'FAIL'
        lines.push( `[grading] ${result[ 'target' ]} — ${verdict}` )

        if( Array.isArray( result[ 'schemas' ] ) === true ) {
            const passed = result[ 'schemas' ].filter( ( s ) => s[ 'status' ] === true ).length
            lines.push( `[grading]   schemas: ${passed}/${result[ 'schemaCount' ]} green` )
        } else if( result[ 'pretest' ] !== undefined && result[ 'pretest' ] !== null ) {
            const pretest = result[ 'pretest' ]
            const validateOk = result[ 'validate' ] !== undefined && result[ 'validate' ] !== null ? result[ 'validate' ][ 'status' ] === true : null
            lines.push( `[grading]   validate: ${validateOk === null ? 'n/a' : ( validateOk ? 'ok' : 'fail' )}  pretest: ${pretest[ 'ok' ] === true ? 'ok' : ( pretest[ 'keyGated' ] === true ? 'key-gated' : 'fail' )}` )
            const stamp = pretest[ 'fromCache' ] === true ? `cached (data ${pretest[ 'dataAt' ]})` : `fresh (data ${pretest[ 'dataAt' ]})`
            lines.push( `[grading]   data: ${stamp}` )
            const below = Array.isArray( pretest[ 'toolsBelowThreshold' ] ) ? pretest[ 'toolsBelowThreshold' ] : []
            if( below.length > 0 ) { lines.push( `[grading]   below bar: ${below.join( ', ' )}` ) }
        }

        if( result[ 'rollupGrade' ] !== undefined ) {
            lines.push( `[grading]   grade: ${result[ 'rollupGrade' ]} (${result[ 'rollupStatus' ]})` )
        }
        if( result[ 'rollupError' ] !== undefined ) {
            lines.push( `[grading]   rollup error: ${result[ 'rollupError' ]}` )
        }

        process.stderr.write( lines.join( '\n' ) + '\n' )
    }


    // Memo 102 Phase 1 / PRD-001 — deterministic single-schema/-tool validation:
    // structural validation PLUS the DataPretest data-pretest (HTTP 200 + non-empty
    // data), WITHOUT prompt-emit and WITHOUT the non-deterministic LLM scoring.
    // The answer to "is this schema valid?" as one structured result.
    //
    // Target grammar (PRD-001 scope, full 3-level addressing is Phase 3):
    //   namespace/schema-name        (1 slash) -> all tools of one schema
    //   namespace/tool/<name>        (2 slash) -> just the one addressed tool
    //
    // PRD-002 — the --only flag carries the v4-primitive view that used to live in
    // `dev test`: tool/resource run through the DataPretest path; skill/prompt/
    // selection-member run through the existing structural primitive check
    // (#runTypedTests + #aggregateByPrimitive). The same #validateOnlyFilter
    // allowlist applies (no duplication).
    static async gradingDeterministic( { cwd, target, gradingDataDir, gradingExportDir = null, withKeys, only, dryRun = false, force = false, quiet = false, json, skipRollup = false, throttleMs = 0 } ) {
        const grading = await GradingTarget.loadGrading()
        if( grading === null || grading[ 'DataPretest' ] === undefined ) {
            return { 'result': CliOutput.error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }

        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': CliOutput.error( { 'error': 'Missing grading target.', 'fix': 'Usage: flowmcp grading deterministic <namespace> | <namespace>/<schema> | <namespace>/tool/<name>' } ) }
        }

        // PRD-002 — validate the --only filter once (shared with `dev test`'s old
        // path). An unknown value is a HARD error (no silent skip).
        const { filter: onlyFilter, error: onlyError } = GradingDeterministic.validateOnlyFilter( { only } )
        if( onlyError !== null ) {
            return { 'result': CliOutput.error( { 'error': onlyError } ) }
        }

        // Parse the Spec-ID. PRD-001 only accepts a schema-ID (1 slash) or a
        // tool-ID (2 slashes, type === 'tool'). Resource/prompt/skill/selection
        // Spec-IDs are out of scope here (no silent acceptance).
        const parsed = IdResolver.parseSpecId( { 'specId': target } )
        if( parsed.valid !== true ) {
            return { 'result': CliOutput.error( { 'error': parsed.error, 'fix': 'Use a namespace "<namespace>", a schema-ID "<namespace>/<schema>", or a tool-ID "<namespace>/tool/<name>".' } ) }
        }
        // Memo 107 PRD-004 — bare namespace runs the deterministic grade over every
        // schema of the namespace ("one command per namespace") and produces ONE
        // namespace rollup (index.json) + Provider-Proof (grade.json). Delegated so
        // the single-schema path below stays unchanged.
        if( parsed.type === 'namespace' ) {
            return GradingDeterministic.gradingDeterministicNamespace( { cwd, 'namespace': parsed.namespace, gradingDataDir, gradingExportDir, withKeys, only, dryRun, force, quiet, json, throttleMs } )
        }
        if( parsed.type !== 'schema' && parsed.type !== 'tool' && parsed.type !== 'test' ) {
            return { 'result': CliOutput.error( { 'error': `Spec-ID type "${parsed.type}" is not supported by grading deterministic (only namespace, schema-ID, tool-ID or per-test).`, 'fix': 'Use "<namespace>", "<namespace>/<schema>", "<namespace>/tool/<name>" or "<namespace>/tool/<name>/tests/<N>".' } ) }
        }

        const namespace = parsed.namespace
        // A tool-ID and a per-test selector both scope the deterministic grade to one
        // tool (the `_gradings/` granularity is per-tool; a per-test selector addresses
        // a single recorded test of that tool for validation/inspection).
        const toolFilter = parsed.type === 'tool' || parsed.type === 'test' ? parsed.name : null
        const testIndex = parsed.type === 'test' ? parsed.testIndex : null

        // PRD-003 (B2): the deterministic single-mode reads the schema LIVE from
        // schemaFolders[], not from the island import snapshot. The island root is
        // still the OUTPUT store (DataPretest.#persist writes the summary there).
        const gradingDataRoot = await GradingTarget.gradingDataRoot( { cwd, gradingDataDir } )

        // Resolve the schemas for this namespace live. A namespace absent from every
        // schemaFolders[] source is a coded hard error (SRC-001) — never silent.
        const resolvedSchemas = await GradingTarget.resolveSchemasForTarget( { namespace } )
        if( resolvedSchemas.status === false ) {
            return { 'result': CliOutput.error( { 'error': resolvedSchemas.error, 'fix': resolvedSchemas.fix } ) }
        }
        const liveSchemas = resolvedSchemas.schemas

        // Determine the addressed schema. A schema-ID names the folder directly; a
        // tool-ID needs a Tool->Schema lookup. No silent first-wins: an ambiguous
        // tool match is surfaced with a visible note.
        const resolved = GradingDeterministic.resolveDeterministicSchemaLive( { liveSchemas, parsed, namespace } )
        if( resolved.status === false ) {
            return { 'result': CliOutput.error( { 'error': resolved.error, 'fix': resolved.fix } ) }
        }
        const schemaName = resolved.schemaName
        const sourcePath = resolved.sourcePath
        const main = resolved.main
        const handlersFn = resolved.handlersFn

        // PA-5: key-injection opt-in (default OFF) — same gate as emit-prompts.
        const { useKeys } = await GradingTarget.gradingUseKeys( { withKeys } )

        // Step 1 — structural validation (Memo REV-08 Kap. 1: structural validate
        // FIRST, then the deterministic data-pretest = "the validation").
        const v4 = ModuleRegistry.getV4()
        const validate = ValidateCommand.validateSingleSchema( { main, 'file': basename( sourcePath ), v4 } )

        // Step 2 — the deterministic data-pretest (status === true AND #hasData),
        // a strict superset of `dev test`. Same Phase-0/1 wiring as emit-prompts:
        // resolveEnv -> buildServerParams -> resolveSharedLists -> DataPretest.run,
        // but WITHOUT the prompt/goal emit afterwards.
        const requiredServerParams = Array.isArray( main[ 'requiredServerParams' ] ) ? main[ 'requiredServerParams' ] : []
        const serverParams = useKeys === true
            ? EnvResolver.buildServerParams( { 'envObject': ( await EnvResolver.resolveEnv( { cwd } ) ).envObject, requiredServerParams } ).serverParams
            : {}
        const { sharedLists } = await ListsCommand.resolveSharedListsForSchema( { main, 'filePath': sourcePath } )

        // PRD-012 — --no-save (dryRun) runs the pretest in full but persists NOTHING
        // to the island (no summary.json / test-N.json). The deterministic path has
        // no Stage-3 writes, so dryRun here only gates the DataPretest persist.
        // PRD-4.1 — tick the slow part (live/cached pretest) to stderr.
        CliOutput.emitProgress( { quiet, 'message': `${target}: structural validate + data pretest${force === true ? ' (--force re-fetch)' : ''}...` } )

        // PRD-2.2 — force threads the cache bypass into the pretest. Without it the
        // pretest reuses the persisted test-N.json (read-cache, PRD-2.1); with it the
        // data is re-fetched. A re-fetch that flips `deterministic-green` flows
        // straight into the _gradings rewrite + rollup below, so the affected
        // deterministic areas are re-evaluated (the grade itself still hangs on the
        // schemaHash — data reuse never silently invalidates it).
        const pretestRaw = await grading[ 'DataPretest' ].run( {
            namespace,
            'toolName': schemaName,
            main,
            handlersFn,
            'schemaSnapshotPath': sourcePath,
            serverParams,
            sharedLists,
            'gradingDataDir': gradingDataRoot,
            dryRun,
            force,
            throttleMs
        } )

        // Tool-ID: restrict the pretest view to the one addressed tool. The gate is
        // recomputed over the filtered results so `ok` reflects only that tool.
        const { pretest } = GradingDeterministic.scopeDeterministicPretest( { pretestRaw, toolFilter } )

        // Per-test selector: validate the 1-based test index is in range for the tool
        // and surface the addressed test (no silent default — an out-of-range index is
        // a hard error, never clamped). The `_gradings/` write stays tool-scoped.
        let testScope = null
        if( testIndex !== null ) {
            const toolResults = ( Array.isArray( pretest.results ) ? pretest.results : [] )
                .filter( ( entry ) => entry[ 'name' ] === toolFilter )
            if( testIndex > toolResults.length ) {
                return { 'result': CliOutput.error( { 'error': `Test index ${testIndex} is out of range for tool "${toolFilter}" (${toolResults.length} recorded test(s)).`, 'fix': `Address a test between 1 and ${toolResults.length}, or run the whole tool "${namespace}/tool/${toolFilter}".` } ) }
            }
            const addressed = toolResults[ testIndex - 1 ]
            testScope = {
                'tool': toolFilter,
                'testIndex': testIndex,
                'working': addressed[ 'working' ],
                'status': addressed[ 'status' ],
                'responseBytes': addressed[ 'responseBytes' ] === undefined ? null : addressed[ 'responseBytes' ],
                'large': addressed[ 'large' ] === true,
                'extreme': addressed[ 'extreme' ] === true
            }
        }

        // PRD-002 — optional v4-primitive view (the migrated `dev test --only`
        // capability). tool/resource come from the DataPretest results; skill/
        // prompt/selection-member from the structural #runTypedTests path.
        let primitives = null
        if( onlyFilter !== null ) {
            const { view } = await GradingDeterministic.deterministicPrimitiveView( { main, handlersFn, 'schemaSource': sourcePath, serverParams, sharedLists, onlyFilter, toolFilter, pretest } )
            primitives = view
        }

        // Hints derived from the DataPretest errors[]. Phase 5 surfaces the new
        // classes: DPT-006 (parameterless, Bar=1), DPT-007 (key-gated — not evaluable
        // without key, NOT a FAIL), DPT-008 (duplicate test). The pretest object
        // carries keyGated/perTool/stopReason so callers can tell "not evaluable"
        // from a genuine FAIL.
        const { hints } = GradingDeterministic.deterministicHints( { 'validate': validate, pretest } )
        const status = validate[ 'status' ] === true && pretest.ok === true

        // PRD-4.1 — done-tick with the data stamp (cache reuse vs re-fetch).
        const stamp = pretest.fromCache === true ? `cached, data ${pretest.dataAt}` : `fresh, data ${pretest.dataAt}`
        CliOutput.emitProgress( { quiet, 'message': `${target}: ${status === true ? 'PASS' : 'FAIL'} (${stamp})` } )

        const result = {
            status,
            'mode': 'deterministic',
            target,
            'saved': dryRun !== true,
            'validate': validate,
            pretest,
            hints
        }
        if( resolved.note !== null && resolved.note !== undefined ) {
            result[ 'note' ] = resolved.note
        }
        if( primitives !== null ) {
            result[ 'primitives' ] = primitives
        }
        if( testScope !== null ) {
            result[ 'testScope' ] = testScope
        }

        // Memo 107 PRD-006 — the deterministic Area grading + full-structure wiring.
        // After the pretest, write the deterministic `_gradings/` entries for this
        // schema (Answer-Mapper -> AreaScorer.writeEntry, NO-OVERWRITE/additive), then
        // — unless this is a namespace sub-call (skipRollup) — rebuild the namespace
        // index.json (RebuildIndex) and the Provider-Proof grade.json (ProviderProof).
        // dryRun (--no-save) skips ALL island writes (PRD-012 / guard 6). This is the
        // gap that turned `grading deterministic` from a summary-only sweep into the
        // real deterministic grading (Memo 107 Kap. 4).
        if( dryRun !== true ) {
            const written = await GradingDeterministic.deterministicWriteGradings( { grading, gradingDataRoot, namespace, schemaName, main, validate, pretest, toolFilter } )
            result[ 'gradingsWritten' ] = written.written
            if( written.skipped.length > 0 ) { result[ 'gradingsSkipped' ] = written.skipped }
            if( written.errors.length > 0 ) { result[ 'gradingErrors' ] = written.errors }

            if( skipRollup !== true ) {
                const rollup = await GradingDeterministic.deterministicRollup( { cwd, grading, gradingDataRoot, gradingExportDir, namespace } )
                if( rollup.status !== true ) {
                    // The deterministic GRADE already ran; a rollup/persistence failure is
                    // surfaced (never silent) but does NOT flip the grade `status`.
                    result[ 'rollupError' ] = rollup.error
                } else {
                    result[ 'indexPath' ] = rollup.indexPath
                    result[ 'proofPath' ] = rollup.proofPath
                    result[ 'rollupStatus' ] = rollup.rollupStatus
                    result[ 'rollupGrade' ] = rollup.rollupGrade
                }
            }
        }

        return { result }
    }


    // Memo 107 PRD-005/006 — write the deterministic Area `_gradings/` entries for one
    // schema. The DeterministicAreaMapper turns the structural validation + DataPretest
    // result into spec-conformant deterministic entries (single-test per tool,
    // tools-aggregate-schema), and AreaScorer.writeEntry persists each one timestamped-
    // additive (ASC-010 NO-OVERWRITE — a same-second collision is benign idempotency,
    // not an error). Guard 1 (Kap. 0a.5): `_gradings/` only ever via AreaScorer.writeEntry.
    static async deterministicWriteGradings( { grading, gradingDataRoot, namespace, schemaName, main, validate, pretest, toolFilter = null } ) {
        const Mapper = grading[ 'DeterministicAreaMapper' ]
        const AreaScorer = grading[ 'AreaScorer' ]
        if( Mapper === undefined || AreaScorer === undefined ) {
            return { 'written': 0, 'skipped': [], 'errors': [ 'flowmcp-grading too old: DeterministicAreaMapper / AreaScorer not exported.' ] }
        }

        const recordedAt = new Date().toISOString().replace( /\.\d{3}Z$/, 'Z' ).replace( /:/g, '-' )
        // Memo 112 P6.2 — persist the schemaHash with the deterministic gradings so a
        // later `grading plan` can detect staleness (live hash != stored hash). The
        // Mapper already writes entry.schemaHash when given one (DeterministicAreaMapper);
        // it was simply never fed. A null hash (uncanonicalizable schema) is omitted.
        const HashGenerator = grading[ 'HashGenerator' ]
        const computedHash = HashGenerator !== undefined && HashGenerator !== null
            ? HashGenerator.computeSchemaHash( { 'schema': main } ).hash
            : null
        const schemaHash = typeof computedHash === 'string' && computedHash.length > 0 ? computedHash : undefined
        const mapped = Mapper.mapSchema( { namespace, 'schemaId': schemaName, main, validate, pretest, recordedAt, schemaHash } )
        const providersRoot = join( gradingDataRoot, 'providers' )
        const errors = [ ...mapped.errors ]
        const writeCounter = { count: 0 }

        // Memo 107 PRD-007 (E-4) — a tool-addressed grade (`<ns>/tool/<name>`) writes
        // ONLY that tool's single-test entry; sibling tools' `_gradings/` stay
        // untouched. The schema-level summary.json is unaffected (DataPretest always
        // computes it over the full declared tool set, so it is never blind-replaced).
        const entriesToWrite = toolFilter === null
            ? mapped.entries
            : mapped.entries.filter( ( item ) => item.area === 'single-test' && item.tool === toolFilter )

        await entriesToWrite
            .reduce( ( promise, item ) => promise.then( async () => {
                const { dir, errors: dirErrors } = AreaScorer.resolveGradingsDir( {
                    providersRoot, 'ns': namespace, 'schemaId': schemaName, 'tool': item.tool === null ? undefined : item.tool, 'area': item.area
                } )
                if( dir === null ) { errors.push( ...dirErrors ); return }
                const res = await AreaScorer.writeEntry( { 'entry': item.entry, 'gradingsDir': dir, 'area': item.area, 'timestamp': recordedAt } )
                if( res.written === true ) {
                    writeCounter.count += 1
                    return
                }
                const benign = res.errors.some( ( error ) => error.includes( 'ASC-010' ) === true )
                if( benign === false ) { errors.push( ...res.errors ) }
            } ), Promise.resolve() )

        return { 'written': writeCounter.count, 'skipped': mapped.skipped, errors }
    }


    // Memo 107 PRD-006 — rebuild the namespace rollup (index.json) from the on-disk
    // `_gradings/` and project the committable Provider-Proof (grade.json). Guards 2+3
    // (Kap. 0a.5): index.json only via RebuildIndex.rebuildNamespaceIndex, grade.json
    // only via ProviderProof.write. Reuses the exact wiring proven on consume-scores.
    static async deterministicRollup( { cwd, grading, gradingDataRoot, gradingExportDir, namespace } ) {
        const RebuildIndex = grading[ 'RebuildIndex' ]
        const ProviderProof = grading[ 'ProviderProof' ]
        if( RebuildIndex === undefined || RebuildIndex === null || ProviderProof === undefined || ProviderProof === null ) {
            return { 'status': false, 'error': 'flowmcp-grading too old: RebuildIndex / ProviderProof not available; the namespace index.json / grade.json were not built.', 'fix': 'Update the flowmcp-grading dependency.' }
        }

        const namespaceDir = join( gradingDataRoot, 'providers', namespace )
        let rebuilt
        try {
            rebuilt = await RebuildIndex.rebuildNamespaceIndex( { namespaceDir } )
        } catch( rebuildError ) {
            return { 'status': false, 'error': `CLI-025 deterministicRollup: Index rebuild threw: ${rebuildError.message}`, 'fix': 'Resolve the island state above and re-run.' }
        }
        if( rebuilt.status !== true ) {
            return { 'status': false, 'error': `Index rebuild failed: ${( rebuilt.errors || [] ).join( '; ' )}`, 'fix': 'Resolve the index errors above and re-run.' }
        }

        const proof = await GradingConsume.writeProviderProof( {
            cwd, grading, gradingDataRoot, gradingExportDir, 'target': namespace, 'namespaceIndex': rebuilt.index
        } )
        if( proof.status !== true ) {
            return { 'status': false, 'error': proof.error, 'fix': proof.fix }
        }

        return {
            'status': true,
            'indexPath': GradingTarget.toRepoRelativePath( { cwd, 'path': rebuilt.indexPath } ),
            'proofPath': GradingTarget.toRepoRelativePath( { cwd, 'path': proof.proofPath } ),
            'rollupStatus': rebuilt.index[ 'status' ],
            'rollupGrade': rebuilt.index[ 'grade' ]
        }
    }


    // Memo 107 PRD-004 — bare-namespace deterministic grade: run every schema of the
    // namespace (skipRollup, so each writes its own `_gradings/` but defers the rollup),
    // then build the namespace index.json + Provider-Proof grade.json EXACTLY ONCE.
    static async gradingDeterministicNamespace( { cwd, namespace, gradingDataDir, gradingExportDir, withKeys, only, dryRun, force = false, quiet = false, json, throttleMs = 0 } ) {
        const resolved = await GradingTarget.resolveSchemasForTarget( { namespace } )
        if( resolved.status === false ) {
            return { 'result': CliOutput.error( { 'error': resolved.error, 'fix': resolved.fix } ) }
        }

        const total = resolved.schemas.length
        CliOutput.emitProgress( { quiet, 'message': `namespace ${namespace}: ${total} schema(s) to grade deterministically` } )

        const perSchema = []
        await resolved.schemas
            .reduce( ( promise, schema, index ) => promise.then( async () => {
                CliOutput.emitProgress( { quiet, 'message': `[${index + 1}/${total}] ${schema.schemaName}` } )
                const sub = await GradingDeterministic.gradingDeterministic( {
                    cwd, 'target': `${namespace}/${schema.schemaName}`, gradingDataDir, gradingExportDir, withKeys, only, dryRun, force, 'quiet': true, json, 'skipRollup': true, throttleMs
                } )
                const subResult = sub.result
                perSchema.push( {
                    'schema': schema.schemaName,
                    'status': subResult.status === true,
                    'pretestOk': subResult.pretest === undefined || subResult.pretest === null ? null : subResult.pretest.ok,
                    'gradingsWritten': subResult.gradingsWritten === undefined ? 0 : subResult.gradingsWritten
                } )
            } ), Promise.resolve() )

        const out = {
            'status': perSchema.length > 0 && perSchema.every( ( entry ) => entry.status === true ),
            'mode': 'deterministic',
            'target': namespace,
            'saved': dryRun !== true,
            'schemaCount': perSchema.length,
            'schemas': perSchema
        }

        if( dryRun !== true ) {
            const grading = await GradingTarget.loadGrading()
            const gradingDataRoot = await GradingTarget.gradingDataRoot( { cwd, gradingDataDir } )
            const rollup = await GradingDeterministic.deterministicRollup( { cwd, grading, gradingDataRoot, gradingExportDir, namespace } )
            if( rollup.status !== true ) {
                out[ 'rollupError' ] = rollup.error
            } else {
                out[ 'indexPath' ] = rollup.indexPath
                out[ 'proofPath' ] = rollup.proofPath
                out[ 'rollupStatus' ] = rollup.rollupStatus
                out[ 'rollupGrade' ] = rollup.rollupGrade
            }
        }

        return { 'result': out }
    }


    // PRD-2.3 — `grading reload <ns|ns/schema>`: re-fetch + rewrite the persisted
    // test-N.json (force semantics), DECOUPLED from grading. It runs the data
    // pretest with force:true so the read-cache (PRD-2.1) is bypassed and the
    // island test data is refreshed, but it writes NO `_gradings/` entries and NO
    // grade.json/index.json — a pure data reload. Reports the per-schema rewritten
    // test counts + the new data stamp (dataAt). NO SILENT DEFAULTS.
    static async gradingReload( { cwd, target, gradingDataDir, withKeys, quiet = false, json } ) {
        const grading = await GradingTarget.loadGrading()
        if( grading === null || grading[ 'DataPretest' ] === undefined ) {
            return { 'result': CliOutput.error( { 'error': 'grading module unavailable', 'fix': 'npm install / update the flowmcp-grading dependency' } ) }
        }
        if( typeof target !== 'string' || target.length === 0 ) {
            return { 'result': CliOutput.error( { 'error': 'Missing reload target.', 'fix': 'Usage: flowmcp grading reload <namespace> | <namespace>/<schema>' } ) }
        }

        const parsed = IdResolver.parseSpecId( { 'specId': target } )
        if( parsed.valid !== true || ( parsed.type !== 'namespace' && parsed.type !== 'schema' ) ) {
            return { 'result': CliOutput.error( { 'error': `grading reload accepts a namespace or a schema-ID, got "${target}".`, 'fix': 'Use "<namespace>" or "<namespace>/<schema>".' } ) }
        }

        const namespace = parsed.namespace
        const gradingDataRoot = await GradingTarget.gradingDataRoot( { cwd, gradingDataDir } )
        const resolvedSchemas = await GradingTarget.resolveSchemasForTarget( { namespace } )
        if( resolvedSchemas.status === false ) {
            return { 'result': CliOutput.error( { 'error': resolvedSchemas.error, 'fix': resolvedSchemas.fix } ) }
        }

        const targetSchemas = parsed.type === 'schema'
            ? resolvedSchemas.schemas.filter( ( s ) => s.schemaName === parsed.name )
            : resolvedSchemas.schemas
        if( targetSchemas.length === 0 ) {
            return { 'result': CliOutput.error( { 'error': `Schema "${target}" not found in schemaFolders[].`, 'fix': 'Address an existing schema or namespace.' } ) }
        }

        const { useKeys } = await GradingTarget.gradingUseKeys( { withKeys } )
        const envObject = useKeys === true ? ( await EnvResolver.resolveEnv( { cwd } ) ).envObject : {}

        const perSchema = []
        const reloadTotal = targetSchemas.length
        CliOutput.emitProgress( { quiet, 'message': `reload ${target}: re-fetch ${reloadTotal} schema(s)...` } )
        await targetSchemas
            .reduce( ( promise, schema, index ) => promise.then( async () => {
                CliOutput.emitProgress( { quiet, 'message': `[${index + 1}/${reloadTotal}] reload ${schema.schemaName}` } )
                const requiredServerParams = Array.isArray( schema.main[ 'requiredServerParams' ] ) ? schema.main[ 'requiredServerParams' ] : []
                const serverParams = useKeys === true
                    ? EnvResolver.buildServerParams( { envObject, requiredServerParams } ).serverParams
                    : {}
                const { sharedLists } = await ListsCommand.resolveSharedListsForSchema( { 'main': schema.main, 'filePath': schema.sourcePath } )
                const pretest = await grading[ 'DataPretest' ].run( {
                    namespace,
                    'toolName': schema.schemaName,
                    'main': schema.main,
                    'handlersFn': schema.handlersFn,
                    'schemaSnapshotPath': schema.sourcePath,
                    serverParams,
                    sharedLists,
                    'gradingDataDir': gradingDataRoot,
                    'force': true
                } )
                const testsWritten = ( Array.isArray( pretest.results ) ? pretest.results : [] )
                    .filter( ( r ) => r[ 'primitive' ] === 'tool' || r[ 'primitive' ] === 'resource' )
                    .length
                perSchema.push( {
                    'schema': schema.schemaName,
                    'reloaded': pretest.fromCache === false,
                    'testsWritten': testsWritten,
                    'ok': pretest.ok === true,
                    'keyGated': pretest.keyGated === true,
                    'dataAt': pretest.dataAt === undefined ? null : pretest.dataAt
                } )
            } ), Promise.resolve() )

        return {
            'result': {
                'status': true,
                'mode': 'reload',
                'target': target,
                'schemaCount': perSchema.length,
                'schemas': perSchema
            }
        }
    }


    // PRD-001 + PRD-003 (B2) — resolve the addressed schema from the LIVE
    // schemaFolders[] read (liveSchemas = { schemaName, main, handlersFn,
    // sourcePath }[]). A schema-ID names the folder directly (must exist). A
    // tool-ID needs a Tool->Schema lookup over the live main exports; a tool
    // present in several schema files is reported (visible note), never silently
    // first-won. No silent default.
    static resolveDeterministicSchemaLive( { liveSchemas, parsed, namespace } ) {
        const schemaNames = liveSchemas.map( ( s ) => s.schemaName )

        if( parsed.type === 'schema' ) {
            const hit = liveSchemas
                .find( ( s ) => s.schemaName === parsed.name )
            if( hit === undefined ) {
                return { 'status': false, 'error': `Schema "${namespace}/${parsed.name}" not found in schemaFolders[] (schemas: ${schemaNames.join( ', ' ) || 'none'}).`, 'fix': 'Register the provider in schemaFolders[], or address an existing schema.' }
            }

            return { 'status': true, 'schemaName': hit.schemaName, 'sourcePath': hit.sourcePath, 'main': hit.main, 'handlersFn': hit.handlersFn, 'note': null }
        }

        // Tool-ID — find which live schema declares this tool by scanning its
        // tools/routes.
        const matches = liveSchemas
            .filter( ( s ) => {
                const tools = s.main[ 'tools' ] || s.main[ 'routes' ] || {}
                return Object.keys( tools ).includes( parsed.name ) === true
            } )

        if( matches.length === 0 ) {
            return { 'status': false, 'error': `Tool "${namespace}/tool/${parsed.name}" not found in any schema (schemas: ${schemaNames.join( ', ' ) || 'none'}).`, 'fix': 'Register the provider in schemaFolders[], or address an existing tool.' }
        }

        const note = matches.length > 1
            ? `Tool "${parsed.name}" found in ${matches.length} schemas (${matches.map( ( m ) => m.schemaName ).join( ', ' )}); using "${matches[ 0 ].schemaName}" (first match — multi-folder collision handling is Phase 3).`
            : null

        return { 'status': true, 'schemaName': matches[ 0 ].schemaName, 'sourcePath': matches[ 0 ].sourcePath, 'main': matches[ 0 ].main, 'handlersFn': matches[ 0 ].handlersFn, note }
    }


    // PRD-001 — project the raw DataPretest result onto an optional single-tool
    // filter. When a tool-ID is given, results[] is narrowed to that tool and the
    // pass-gate (ok/passedDownloadable) is recomputed over the filtered set so the
    // answer reflects only the addressed tool. No silent default: an empty filtered
    // set turns into ok:false with an explicit DPT-style error string.
    static scopeDeterministicPretest( { pretestRaw, toolFilter } ) {
        const baseResults = Array.isArray( pretestRaw.results ) ? pretestRaw.results : []
        if( toolFilter === null ) {
            // Phase 5 surfacing: carry the deterministic SURFACING classes through to
            // the CLI output so they are visible (never silent) — keyGated (PRD-014),
            // the per-tool classes incl. parameterless/needs-tests (PRD-013), the FAIL
            // set and the explicit stopReason. No silent default: absent fields stay
            // absent rather than being fabricated.
            const pretest = {
                'ok': pretestRaw.ok,
                'keyGated': pretestRaw.keyGated === true,
                'passedDownloadable': pretestRaw.passedDownloadable,
                'required': pretestRaw.required,
                'toolsBelowThreshold': Array.isArray( pretestRaw.toolsBelowThreshold ) ? pretestRaw.toolsBelowThreshold : [],
                'perTool': pretestRaw.perTool === undefined || pretestRaw.perTool === null ? {} : pretestRaw.perTool,
                'stopReason': pretestRaw.stopReason === undefined ? null : pretestRaw.stopReason,
                'fromCache': pretestRaw.fromCache === true,
                'dataAt': pretestRaw.dataAt === undefined ? null : pretestRaw.dataAt,
                'results': baseResults,
                'errors': Array.isArray( pretestRaw.errors ) ? pretestRaw.errors : []
            }

            return { pretest }
        }

        const downloadablePrimitives = [ 'tool', 'resource' ]
        const filtered = baseResults
            .filter( ( r ) => r[ 'name' ] === toolFilter )
        const passedDownloadable = filtered
            .filter( ( r ) => r[ 'working' ] === true )
            .length
        const required = pretestRaw.required
        const downloadableInTool = filtered
            .filter( ( r ) => downloadablePrimitives.includes( r[ 'primitive' ] ) )
            .length

        // Phase 5 surfacing: take the authoritative per-tool class from the raw
        // pretest (DataPretest computed it against the per-tool EFFECTIVE bar, incl.
        // parameterless Bar=1 / key-gated). A key-gated schema is NOT a FAIL for the
        // single tool either. No silent default — an absent per-tool node degrades
        // to the legacy global-bar gate.
        const rawPerTool = pretestRaw.perTool === undefined || pretestRaw.perTool === null ? {} : pretestRaw.perTool
        const toolNode = rawPerTool[ toolFilter ] === undefined ? null : rawPerTool[ toolFilter ]
        const keyGated = pretestRaw.keyGated === true
        const toolBar = toolNode !== null && typeof toolNode.bar === 'number' ? toolNode.bar : required

        // Re-derive the gate for the single tool: not key-gated AND downloadable AND
        // meeting its own effective bar.
        const ok = keyGated === false && downloadableInTool > 0 && passedDownloadable >= toolBar
        const errors = []
        if( keyGated === false && filtered.length === 0 && ( toolNode === null || toolNode.total !== 0 ) ) {
            errors.push( `DPT-004: Tool "${toolFilter}" produced no test results in the pretest.` )
        }
        if( keyGated === false && ok === false && filtered.length > 0 ) {
            errors.push( `DPT-003: Tool "${toolFilter}" below ${toolBar} working downloadable tests (${passedDownloadable}/${toolBar}).` )
        }
        // Preserve the per-tool DPT-004/006/007/008 detail lines that mention this tool.
        const carried = ( Array.isArray( pretestRaw.errors ) ? pretestRaw.errors : [] )
            .filter( ( e ) => typeof e === 'string' && ( e.includes( `${toolFilter}:` ) || ( keyGated && e.includes( 'DPT-007' ) ) ) )

        const pretest = {
            ok,
            keyGated,
            passedDownloadable,
            required,
            'toolsBelowThreshold': ok === false && keyGated === false && toolNode !== null
                ? [ `${toolFilter} (${passedDownloadable}/${toolBar})` ]
                : [],
            'perTool': toolNode === null ? {} : { [ toolFilter ]: toolNode },
            'stopReason': pretestRaw.stopReason === undefined ? null : pretestRaw.stopReason,
            'fromCache': pretestRaw.fromCache === true,
            'dataAt': pretestRaw.dataAt === undefined ? null : pretestRaw.dataAt,
            'results': filtered,
            'errors': [ ...errors, ...carried ]
        }

        return { pretest }
    }


    // PRD-002 — the migrated v4-primitive view (`dev test --only`). tool/resource
    // are sourced from the DataPretest results (PRD-001); skill/prompt/
    // selection-member from the structural #runTypedTests path. Aggregated per
    // primitive via #aggregateByPrimitive (the exact shape `dev test` produced).
    static async deterministicPrimitiveView( { main, handlersFn, schemaSource, serverParams, sharedLists, onlyFilter, toolFilter, pretest } ) {
        const { handlerMap, resourceHandlerMap } = await HandlerResolver.resolve( { main, handlersFn, 'filePath': schemaSource } )

        let typedResults = []
        try {
            const typedRun = await GradingDeterministic.runTypedTests( {
                main,
                schemaSource,
                handlerMap,
                'resourceHandlerMap': resourceHandlerMap || {},
                serverParams,
                sharedLists,
                'fullOutput': false
            } )
            typedResults = typedRun[ 'results' ] || []
        } catch( err ) {
            typedResults = [ { 'primitive': 'tool', 'name': '*', 'status': false, 'error': `CLI-026 deterministicPrimitiveView: ${err.message}` } ]
        }

        // Restrict to the requested primitives, and to the addressed tool when a
        // tool-ID was given.
        const scoped = typedResults
            .filter( ( r ) => onlyFilter.includes( r[ 'primitive' ] ) )
            .filter( ( r ) => toolFilter === null || r[ 'primitive' ] !== 'tool' || r[ 'name' ] === toolFilter )

        const { declared } = GradingDeterministic.computeDeclared( { main } )
        const { summary } = GradingDeterministic.aggregateByPrimitive( { 'results': scoped, declared, 'filter': onlyFilter } )

        const view = {
            'tools': summary[ 'tool' ],
            'resources': summary[ 'resource' ],
            'skills': summary[ 'skill' ],
            'prompts': summary[ 'prompt' ],
            'selections': summary[ 'selection-member' ]
        }

        return { view }
    }


    // PRD-001 — derive actionable hints ONLY from the existing structural-validate
    // messages and the DataPretest errors[] (no new error classes here). A green
    // result yields an empty hint list.
    static deterministicHints( { validate, pretest } ) {
        const hints = []
        if( validate[ 'status' ] !== true ) {
            ( validate[ 'messages' ] || [] )
                .forEach( ( m ) => { hints.push( `structural: ${m}` ) } )
        }
        if( pretest.ok !== true ) {
            ( pretest.errors || [] )
                .forEach( ( e ) => { hints.push( `pretest: ${e}` ) } )
        }

        return { hints }
    }
}


export { GradingDeterministic }
