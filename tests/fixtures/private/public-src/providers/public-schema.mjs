// Memo 152 / PRD-021 (E-04) — a normal, registered v4 schema used by the
// invisibility test. It IS placed under a schemaFolders[] source so `list` /
// `search` can see it — the private fixtures (privfix/privlist/privdanger) must
// NEVER appear in that same output, proving the private path never registers.


const runEcho = async ( { struct, payload } ) => {
    const userParams = payload[ 'userParams' ] || {}

    struct[ 'status' ] = true
    struct[ 'data' ] = { echoed: userParams }

    return { struct }
}


const handlers = ( { sharedLists, libraries } ) => {
    return {
        echo: { executeRequest: runEcho }
    }
}


const main = {
    namespace: 'pubfix',
    name: 'Public Fixture API',
    description: 'A normal registered v4 schema for the invisibility test.',
    version: '4.0.0',
    docs: [ 'https://example.com/docs' ],
    tags: [ 'test' ],
    root: 'https://example.com',
    requiredServerParams: [],
    headers: {},
    tools: {
        echo: {
            method: 'GET',
            description: 'Echo the given params without any network call.',
            path: '/echo',
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
                searchHint: 'public fixture echo',
                aliases: [],
                alwaysLoad: false
            }
        }
    }
}


export { main, handlers }
