// Memo 153 / Rest-Item 1 (F23, F2=B) — the NAMED financial-clarity Resource-schema proof.
//
// research-03 established that "financial-clarity" is an EXTERNAL project's *Resource* schema
// dir, loaded at runtime purely via a schemaFolders[] path entry — so the generic private-call
// mechanism was proven (clean/lib/sharedlist/markdown fixtures), but no committed, NAMED in-repo
// test showed a private *Resource* schema passing through the private v4 runtime (Pipeline.load,
// SECURITY SCAN ACTIVE). This fixture is that named proof: a minimal private schema that declares
// a v4 (markdown, inline) RESOURCE — the financial-clarity shape — alongside one network-free
// executeRequest tool, so the whole `private call` path is exercised while the resource is asserted
// to survive the load gate. Origin 'inline' means no external .md / .db artifact is needed at load
// time, and every line stays free of the SecurityScanner's forbidden substrings.


const runReading = async ( { struct, payload } ) => {
    const userParams = payload[ 'userParams' ] || {}
    const metric = userParams[ 'metric' ] !== undefined ? userParams[ 'metric' ] : 'runway'

    struct[ 'status' ] = true
    struct[ 'data' ] = { metric, note: `financial-clarity reading for ${metric}` }

    return { struct }
}


const handlers = ( { sharedLists, libraries } ) => {
    return {
        reading: { executeRequest: runReading }
    }
}


const main = {
    namespace: 'finclarity',
    name: 'Financial Clarity Resource Fixture',
    description: 'A private fixture declaring a v4 resource — the named financial-clarity proof (Memo 153, F23).',
    version: '4.0.0',
    docs: [ 'https://example.com/docs' ],
    tags: [ 'test', 'private', 'resource' ],
    root: 'https://example.com',
    requiredServerParams: [],
    headers: {},
    resources: {
        clarityGuide: {
            source: 'markdown',
            origin: 'inline',
            name: 'financial-clarity.md',
            description: 'An inline markdown resource bundled with the private financial-clarity schema.'
        }
    },
    tools: {
        reading: {
            method: 'GET',
            description: 'Return a synthetic financial-clarity reading without any network call.',
            path: '/reading',
            parameters: [
                {
                    position: { key: 'metric', value: '{{USER_PARAM}}', location: 'query' },
                    z: { primitive: 'string()', options: [ 'optional()' ] }
                }
            ],
            tests: [
                { _description: 'reading default' },
                { _description: 'reading runway', metric: 'runway' },
                { _description: 'reading burn', metric: 'burn' }
            ],
            meta: {
                isReadOnly: true,
                isConcurrencySafe: true,
                isDestructive: false,
                searchHint: 'financial clarity reading',
                aliases: [],
                alwaysLoad: false
            }
        }
    }
}


export { main, handlers }
