// Memo 152 / PRD-021 (E-05) — a standalone private fixture that DECLARES a
// sharedLists reference. Without a lists directory the pipeline (strict) fails
// loud with LST-001; with `--lists-dir <dir>` pointing at ./lists it resolves the
// `privColors` list and the tool runs. Scanner-neutral (no forbidden substrings).


const runPickColor = async ( { struct, payload } ) => {
    const userParams = payload[ 'userParams' ] || {}
    const color = userParams[ 'color' ] !== undefined ? userParams[ 'color' ] : 'unset'

    struct[ 'status' ] = true
    struct[ 'data' ] = { picked: color }

    return { struct }
}


const handlers = ( { sharedLists, libraries } ) => {
    return {
        pickColor: { executeRequest: runPickColor }
    }
}


const main = {
    namespace: 'privlist',
    name: 'Private SharedList Fixture',
    description: 'A private fixture that references a shared list.',
    version: '4.0.0',
    docs: [ 'https://example.com/docs' ],
    tags: [ 'test' ],
    root: 'https://example.com',
    requiredServerParams: [],
    headers: {},
    sharedLists: [
        { ref: 'privColors', version: '1.0.0' }
    ],
    tools: {
        pickColor: {
            method: 'GET',
            description: 'Return the picked color without any network call.',
            path: '/pick',
            parameters: [
                {
                    position: { key: 'color', value: '{{USER_PARAM}}', location: 'query' },
                    z: { primitive: 'enum()', enum: [ '{{privColors:name}}' ] }
                }
            ],
            tests: [
                { _description: 'red', color: 'red' },
                { _description: 'green', color: 'green' },
                { _description: 'blue', color: 'blue' }
            ],
            meta: {
                isReadOnly: true,
                isConcurrencySafe: true,
                isDestructive: false,
                searchHint: 'private sharedlist fixture',
                aliases: [],
                alwaysLoad: false
            }
        }
    }
}


export { main, handlers }
