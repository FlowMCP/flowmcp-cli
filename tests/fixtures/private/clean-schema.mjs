// Memo 152 / PRD-021 (E-04) — a standalone, scanner-neutral v4 private fixture.
// It is NEVER placed in any schemaFolders[] source, so it is only reachable via
// `flowmcp private call <this-path> <tool> '{json}'`. The single tool is
// executeRequest-only (network-free), so the happy-path test is deterministic
// and never touches the wire. Every line is free of the SecurityScanner's
// forbidden substrings (no import/require/eval/process./fs./setTimeout/...).


const runPing = async ( { struct, payload } ) => {
    const userParams = payload[ 'userParams' ] || {}
    const name = userParams[ 'name' ] !== undefined ? userParams[ 'name' ] : 'anonymous'

    struct[ 'status' ] = true
    struct[ 'data' ] = { greeting: `hello ${name}`, echoed: userParams }

    return { struct }
}


const handlers = ( { sharedLists, libraries } ) => {
    return {
        ping: { executeRequest: runPing }
    }
}


const main = {
    namespace: 'privfix',
    name: 'Private Fixture API',
    description: 'Standalone private fixture schema for the private call leaf.',
    version: '4.0.0',
    docs: [ 'https://example.com/docs' ],
    tags: [ 'test', 'private' ],
    root: 'https://example.com',
    requiredServerParams: [],
    headers: {},
    tools: {
        ping: {
            method: 'GET',
            description: 'Return a synthetic greeting without any network call.',
            path: '/ping',
            parameters: [
                {
                    position: { key: 'name', value: '{{USER_PARAM}}', location: 'query' },
                    z: { primitive: 'string()', options: [ 'optional()' ] }
                }
            ],
            tests: [
                { _description: 'greets world', name: 'world' },
                { _description: 'greets alice', name: 'alice' },
                { _description: 'greets nobody' }
            ],
            meta: {
                isReadOnly: true,
                isConcurrencySafe: true,
                isDestructive: false,
                searchHint: 'private fixture ping',
                aliases: [],
                alwaysLoad: false
            }
        }
    }
}


export { main, handlers }
