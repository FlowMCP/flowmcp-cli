// Memo 157 / Phase 3 (PRD-07) — a registered SQLite RESOURCE-query schema fixture.
//
// Declares one sqlite resource with two queries and one markdown `about` resource. It is the
// live proof that the v4 resource-query wiring works end to end: `${queryName}_${namespace}`
// is what search advertises, what `call` (and `private call`) resolves, and what `serve`
// registers (search == call == serve). The `about` markdown resource carries NO queries and
// must therefore NOT be advertised as a callable tool. The database resolves from `~/` into the
// per-suite mocked test home, so no real ~/.flowmcp is ever touched.


const main = {
    namespace: 'privres',
    name: 'Private Resource Query Fixture',
    description: 'A sqlite resource-query schema used to prove the v4 resource wiring (Memo 157 P3).',
    version: '4.0.0',
    docs: [ 'https://example.com/docs' ],
    tags: [ 'test', 'resource', 'sqlite' ],
    root: '',
    requiredServerParams: [],
    resources: {
        guide: {
            source: 'markdown',
            origin: 'inline',
            name: 'privres-guide.md',
            description: 'An inline about-doc that must never appear as a callable tool.'
        },
        itemsDb: {
            source: 'sqlite',
            mode: 'in-memory',
            database: '~/.flowmcp/data/priv157.db',
            description: 'A tiny read-only items table for the resource-query proof.',
            queries: {
                listItems: {
                    sql: 'SELECT id, label FROM items ORDER BY id LIMIT ?',
                    description: 'List items ordered by id.',
                    parameters: [
                        {
                            position: { key: 'limit', value: '{{USER_PARAM}}' },
                            z: { primitive: 'number()', options: [ 'min(1)', 'max(100)', 'default(10)' ] }
                        }
                    ],
                    output: {
                        mimeType: 'application/json',
                        schema: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'number', description: 'Row id' },
                                    label: { type: 'string', description: 'Row label' }
                                }
                            }
                        }
                    }
                },
                itemById: {
                    sql: 'SELECT id, label FROM items WHERE id = ?',
                    description: 'Fetch a single item by id.',
                    parameters: [
                        {
                            position: { key: 'id', value: '{{USER_PARAM}}' },
                            z: { primitive: 'number()', options: [ 'min(1)' ] }
                        }
                    ],
                    output: {
                        mimeType: 'application/json',
                        schema: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    id: { type: 'number', description: 'Row id' },
                                    label: { type: 'string', description: 'Row label' }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}


export { main }
