export const main = {
    namespace: 'testhandlers',
    name: 'Handler Test API',
    description: 'v2 schema with handlers for unit testing',
    version: '2.0.0',
    docs: [],
    tags: [ 'test', 'handlers' ],
    root: 'https://httpbin.org',
    requiredServerParams: [],
    headers: {
        'Accept': 'application/json'
    },
    routes: {
        getTransformed: {
            method: 'GET',
            description: 'Endpoint with post handler',
            path: '/get',
            parameters: [
                { position: { key: 'query', value: '{{USER_PARAM}}', location: 'query' }, z: { primitive: 'string()', options: [ 'optional()' ] } }
            ],
            tests: [
                { _description: 'Transform response', query: 'hello' }
            ]
        }
    }
}


export const handlers = () => {
    return {
        getTransformed: {
            postRequest: async ( { response, struct, payload } ) => {
                struct[ 'data' ] = { 'transformed': true, 'original': struct[ 'data' ] }

                return { response }
            }
        }
    }
}
