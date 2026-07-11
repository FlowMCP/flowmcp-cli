/**
 * FlowMCP — MIT License
 *
 * ModuleRegistry (Memo 152 PRD-017 / D-02) — the single injection seam for the
 * v4 core surface and the grading module. Extracted from FlowMcpCli so every
 * later split module shares ONE place to inject/reset the cross-module state
 * (the former #v4Override / #gradingOverride statics). The CLI facade keeps
 * #v4Module / #loadGradingModule / __testInjectV4 / __testInjectGrading as thin
 * delegations onto this registry (facade stability, F12=A).
 */

import { MainValidator, MetaGenerator, SkillValidator, SelectionValidator } from 'flowmcp'


class ModuleRegistry {
    static #v4Override = null
    static #gradingOverride = null


    // The v4 core surface the validate path consumes. #v4Override wins when a
    // test injected one (via inject); otherwise the statically-imported surface.
    static getV4() {
        if( ModuleRegistry.#v4Override ) {
            return ModuleRegistry.#v4Override
        }

        return { MainValidator, MetaGenerator, SkillValidator, SelectionValidator }
    }


    // The grading module's public surface. #gradingOverride wins when injected;
    // otherwise a dynamic import of flowmcp-grading (may throw — the CLI facade
    // wraps this in the GRD-001 try/catch to preserve the null-on-failure shape).
    static async getGrading() {
        if( ModuleRegistry.#gradingOverride ) {
            return ModuleRegistry.#gradingOverride
        }

        return await import( 'flowmcp-grading' )
    }


    // Explicit injection API. A present key overwrites (including an explicit
    // null — tests reset the grading override with { grading: null }).
    static inject( payload ) {
        if( Object.hasOwn( payload, 'v4' ) ) {
            ModuleRegistry.#v4Override = payload[ 'v4' ]
        }

        if( Object.hasOwn( payload, 'grading' ) ) {
            ModuleRegistry.#gradingOverride = payload[ 'grading' ]
        }
    }


    static reset() {
        ModuleRegistry.#v4Override = null
        ModuleRegistry.#gradingOverride = null
    }
}


export { ModuleRegistry }
