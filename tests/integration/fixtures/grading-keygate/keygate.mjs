// Memo 119 P3 / PRD-3.2 — fixture: a schema gated behind SOME_KEY. With an empty
// SOME_KEY in .env the grading deterministic run must treat it as MISSING (key-
// gated, DPT-007), not fire a live request that 401s into a false FAIL.
const main = {
    namespace: 'keygate',
    name: 'keygate',
    description: 'Key-gated provider fixture (Memo 119 P3).',
    version: '4.0.0',
    docs: [],
    tags: [ 'test' ],
    root: 'https://example.com',
    requiredServerParams: [ 'SOME_KEY' ],
    headers: { 'Authorization': 'Bearer {{SOME_KEY}}' },
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
                    properties: { ok: { type: 'string', description: 'ok flag' } }
                }
            }
        }
    }
}

const handlers = () => ( {} )

export { main, handlers }
