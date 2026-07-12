// Memo 152 / PRD-022 (E-07) — a standalone private fixture that DECLARES an allowlisted
// required library (zlib, a Node builtin on the core #defaultAllowlist). The handler is
// defined inside the factory so it closes over the injected `libraries` and can PROVE the
// library reached the handler. Scanner-neutral: no import/require/process./fs./setTimeout.


const handlers = ( { sharedLists, libraries } ) => {
    const runCheckLib = async ( { struct } ) => {
        const lib = libraries[ 'zlib' ]
        const libLoaded = lib !== undefined && lib !== null
        const hasGzip = libLoaded && typeof lib[ 'gzipSync' ] === 'function'

        struct[ 'status' ] = true
        struct[ 'data' ] = { libLoaded, hasGzip }

        return { struct }
    }

    return {
        checkLib: { executeRequest: runCheckLib }
    }
}


const main = {
    namespace: 'privlib',
    name: 'Private Library Fixture',
    description: 'Standalone private fixture requiring an allowlisted library.',
    version: '4.0.0',
    docs: [ 'https://example.com/docs' ],
    tags: [ 'test', 'private' ],
    root: 'https://example.com',
    requiredServerParams: [],
    requiredLibraries: [ 'zlib' ],
    headers: {},
    tools: {
        checkLib: {
            method: 'GET',
            description: 'Confirm the allowlisted zlib library was injected into the handler.',
            path: '/check-lib',
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
                searchHint: 'private library fixture',
                aliases: [],
                alwaysLoad: false
            }
        }
    }
}


export { main, handlers }
