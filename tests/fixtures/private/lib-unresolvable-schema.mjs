// Memo 152 / PRD-022 (E-07) — a standalone private fixture that DECLARES a required library
// which cannot be resolved (not on the allowlist, not installed in any resolution base). The
// private path must FAIL LOUD with LIB-001 rather than silently degrade to empty libraries
// (No-Silent-Defaults, F17=A). Scanner-neutral: no import/require/process./fs./setTimeout.


const handlers = ( { sharedLists, libraries } ) => {
    const runNever = async ( { struct } ) => {
        struct[ 'status' ] = true
        struct[ 'data' ] = { ok: true }

        return { struct }
    }

    return {
        never: { executeRequest: runNever }
    }
}


const main = {
    namespace: 'privnolib',
    name: 'Private Unresolvable-Library Fixture',
    description: 'Standalone private fixture requiring a library that never resolves.',
    version: '4.0.0',
    docs: [ 'https://example.com/docs' ],
    tags: [ 'test', 'private' ],
    root: 'https://example.com',
    requiredServerParams: [],
    requiredLibraries: [ 'flowmcp-not-a-real-lib-xyzzy' ],
    headers: {},
    tools: {
        never: {
            method: 'GET',
            description: 'Would only run if the missing library had silently been skipped.',
            path: '/never',
            parameters: [],
            tests: [
                { _description: 'a' },
                { _description: 'b' },
                { _description: 'c' }
            ],
            meta: {
                isReadOnly: true,
                isConcurrencySafe: true,
                isDestructive: false,
                searchHint: 'unresolvable library fixture',
                aliases: [],
                alwaysLoad: false
            }
        }
    }
}


export { main, handlers }
