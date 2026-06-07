// Memo 119 P1 / PRD-1.1 — perf-guard fixture.
// Records its own module evaluation (= an actual #loadSchema compile) into the
// side-channel file named by PERF_COMPILE_LOG. The resolver must compile THIS
// file (it declares the target namespace) and nothing else.
import { appendFileSync } from 'node:fs'

if( process.env.PERF_COMPILE_LOG ) {
    appendFileSync( process.env.PERF_COMPILE_LOG, 'perfprobe\n' )
}

const main = {
    namespace: 'perfprobe',
    name: 'perfprobe',
    description: 'Perf-guard target schema (Memo 119 P1).',
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
