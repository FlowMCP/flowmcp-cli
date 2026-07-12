import { createHash } from 'node:crypto'


// Memo 152 / PRD-023 (E-08, Zusage 4) — a geo.mjs/inkar.mjs analogue: a REGISTERED
// (trusted) schema that carries a REAL top-level import statement. geo.mjs:12-13 and
// inkar.mjs:1-2 import node:https/node:tls at the top level and therefore trip the
// SecurityScanner's forbidden "import" pattern (SEC001). Under F16=A the TRUSTED path
// (schemaFolders[] -> SchemaLoaderBridge -> core SchemaLoader.load) never scans, so this
// schema loads fine and shows up in list/search/serve. The SAME file handed to
// `private call` IS scanned and rejected (SEC001) — that asymmetry is exactly what the
// Zusage-4 test proves. The import is used (not dead) to mirror inkar/geo faithfully;
// executeRequest keeps the tool network-free so the suite stays deterministic.


const runFingerprint = async ( { struct, payload } ) => {
    const userParams = payload[ 'userParams' ] || {}
    const value = userParams[ 'value' ] !== undefined ? userParams[ 'value' ] : 'empty'
    const digest = createHash( 'sha256' ).update( value ).digest( 'hex' )

    struct[ 'status' ] = true
    struct[ 'data' ] = { value, digest }

    return { struct }
}


const handlers = ( { sharedLists, libraries } ) => {
    return {
        fingerprint: { executeRequest: runFingerprint }
    }
}


const main = {
    namespace: 'trustimp',
    name: 'Trusted Import Fixture API',
    description: 'A registered v4 schema with a real top-level import (geo/inkar analogue).',
    version: '4.0.0',
    docs: [ 'https://example.com/docs' ],
    tags: [ 'test', 'trusted' ],
    root: 'https://example.com',
    requiredServerParams: [],
    headers: {},
    tools: {
        fingerprint: {
            method: 'GET',
            description: 'Return a synthetic sha256 fingerprint without any network call.',
            path: '/fingerprint',
            parameters: [
                {
                    position: { key: 'value', value: '{{USER_PARAM}}', location: 'query' },
                    z: { primitive: 'string()', options: [ 'optional()' ] }
                }
            ],
            tests: [
                { _description: 'fingerprints a value', value: 'alpha' },
                { _description: 'fingerprints another value', value: 'beta' },
                { _description: 'fingerprints the default' }
            ],
            meta: {
                isReadOnly: true,
                isConcurrencySafe: true,
                isDestructive: false,
                searchHint: 'trusted import fingerprint',
                aliases: [],
                alwaysLoad: false
            }
        }
    }
}


export { main, handlers }
