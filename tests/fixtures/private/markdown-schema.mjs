// Memo 152 / PRD-023 (E-08, H-12 building block) — a scanner-neutral private fixture
// that declares a v4 markdown resource. Before f1fafff (cherry-picked in Phase 1) the v4
// MainValidator rejected schemas whose resources were markdown; this fixture proves a
// private schema WITH a markdown resource now passes the load gate (MainValidator, Pipeline
// Schritt 4) and runs via `private call`. The resource origin is "inline" so no external
// .md file is required at load time. Every line stays free of the SecurityScanner's
// forbidden substrings.


const runInfo = async ( { struct, payload } ) => {
    const userParams = payload[ 'userParams' ] || {}
    const topic = userParams[ 'topic' ] !== undefined ? userParams[ 'topic' ] : 'general'

    struct[ 'status' ] = true
    struct[ 'data' ] = { topic, note: `info about ${topic}` }

    return { struct }
}


const handlers = ( { sharedLists, libraries } ) => {
    return {
        info: { executeRequest: runInfo }
    }
}


const main = {
    namespace: 'privmd',
    name: 'Private Markdown Fixture API',
    description: 'A private fixture declaring a markdown resource (H-12 / f1fafff).',
    version: '4.0.0',
    docs: [ 'https://example.com/docs' ],
    tags: [ 'test', 'private' ],
    root: 'https://example.com',
    requiredServerParams: [],
    headers: {},
    resources: {
        guide: {
            source: 'markdown',
            origin: 'inline',
            name: 'guide.md',
            description: 'An inline markdown guide bundled with the private schema.'
        }
    },
    tools: {
        info: {
            method: 'GET',
            description: 'Return synthetic info without any network call.',
            path: '/info',
            parameters: [
                {
                    position: { key: 'topic', value: '{{USER_PARAM}}', location: 'query' },
                    z: { primitive: 'string()', options: [ 'optional()' ] }
                }
            ],
            tests: [
                { _description: 'info general' },
                { _description: 'info topic a', topic: 'a' },
                { _description: 'info topic b', topic: 'b' }
            ],
            meta: {
                isReadOnly: true,
                isConcurrencySafe: true,
                isDestructive: false,
                searchHint: 'private markdown info',
                aliases: [],
                alwaysLoad: false
            }
        }
    }
}


export { main, handlers }
