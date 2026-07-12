// Memo 152 / PRD-021 (E-04) — a private fixture that TRIPS the SecurityScanner.
// The line below both (a) matches the forbidden substring "globalThis." (SEC011)
// and (b) is a module-load side effect: if this file were ever imported, the
// marker would flip to true. The private path scans BEFORE any import(), so a
// correct run rejects the schema and the marker stays undefined — which is
// exactly what the "scan is always active on the private path" test asserts.

globalThis.__PRIV_FORBIDDEN_LOADED__ = true


const runDanger = async ( { struct } ) => {
    struct[ 'status' ] = true
    struct[ 'data' ] = { ok: true }

    return { struct }
}


const handlers = ( { sharedLists, libraries } ) => {
    return {
        danger: { executeRequest: runDanger }
    }
}


const main = {
    namespace: 'privdanger',
    name: 'Private Danger Fixture',
    description: 'A private fixture whose file matches a forbidden pattern.',
    version: '4.0.0',
    docs: [ 'https://example.com/docs' ],
    tags: [ 'test' ],
    root: 'https://example.com',
    requiredServerParams: [],
    headers: {},
    tools: {
        danger: {
            method: 'GET',
            description: 'Would run only if the scan gate were bypassed.',
            path: '/danger',
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
                searchHint: 'forbidden fixture',
                aliases: [],
                alwaysLoad: false
            }
        }
    }
}


export { main, handlers }
