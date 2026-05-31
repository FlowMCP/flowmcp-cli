const main = {
    namespace: 'demoapi',
    name: 'demoapi',
    description: 'Demo provider schema used by grading integration tests.',
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
            tests: [ { _description: 't1' }, { _description: 't2' }, { _description: 't3' } ],
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
