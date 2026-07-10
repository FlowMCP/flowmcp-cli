// Memo 119 P1 / PRD-1.1 — perf-guard DECOY fixture (distinct namespace).
// If the resolver ever compiles this (regex narrowing regressed to O(N)), its
// module body fires and 'decoyone' lands in PERF_COMPILE_LOG -> the test fails.
import { appendFileSync } from 'node:fs'

if( process.env.PERF_COMPILE_LOG ) {
    appendFileSync( process.env.PERF_COMPILE_LOG, 'decoyone\n' )
}

const main = {
    namespace: 'decoyone',
    name: 'decoyone',
    description: 'Perf-guard decoy schema (Memo 119 P1).',
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
            output: { mimeType: 'application/json', schema: { type: 'object', description: 'A thing', properties: { ok: { type: 'string', description: 'ok flag' } } } }
        }
    }
}

const handlers = {}

export { main, handlers }
