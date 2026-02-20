export const main = {
    namespace: 'testminimal',
    name: 'Minimal Test API',
    description: 'Minimal v2 schema for unit testing',
    version: '2.0.0',
    docs: [ 'https://test.example.com/docs' ],
    tags: [ 'test' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {
        'Accept': 'application/json'
    },
    routes: {
        ping: {
            method: 'GET',
            description: 'Simple ping endpoint',
            path: '/get',
            parameters: [],
            tests: [
                { _description: 'Basic ping test' }
            ]
        },
        getData: {
            method: 'GET',
            description: 'Get data with params',
            path: '/get',
            parameters: [
                { position: { key: 'limit', value: '{{USER_PARAM}}', location: 'query' }, z: { primitive: 'number()', options: [ 'min(1)', 'max(100)', 'default(10)' ] } },
                { position: { key: 'search', value: '{{USER_PARAM}}', location: 'query' }, z: { primitive: 'string()', options: [ 'optional()' ] } }
            ],
            tests: [
                { _description: 'Get with limit', limit: 5 },
                { _description: 'Get with search', search: 'test', limit: 10 }
            ]
        }
    }
}
