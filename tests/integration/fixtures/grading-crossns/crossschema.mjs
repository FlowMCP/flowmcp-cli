// Fixture for the O(N^2) resolver fix: this schema's declared namespace
// (crossfolderns) intentionally differs from the folder it is seeded into, so the
// resolver must find it by its declared namespace (content probe), not by folder.
const main = {
    namespace: 'crossfolderns',
    name: 'crossschema',
    description: 'Schema whose declared namespace differs from its provider folder.',
    version: '4.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://example.com',
    requiredServerParams: [],
    headers: {},
    tools: {
        getThing: {
            method: 'GET',
            path: '/thing',
            description: 'Get a thing',
            parameters: [],
            tests: [ { _description: 't1' }, { _description: 't2' } ],
            output: {
                mimeType: 'application/json',
                schema: {
                    type: 'object',
                    description: 'A thing',
                    properties: {
                        ok: { type: 'string', description: 'ok flag' }
                    }
                }
            }
        }
    }
}

const handlers = {}

export { main, handlers }
