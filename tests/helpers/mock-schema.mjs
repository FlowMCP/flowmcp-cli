const validSchema = {
    'namespace': 'testApi',
    'name': 'Test API',
    'description': 'Test API for validation',
    'docs': [ 'https://test.example.com/docs' ],
    'tags': [ 'test' ],
    'flowMCP': '1.2.2',
    'root': 'https://test.example.com',
    'requiredServerParams': [],
    'headers': {
        'Accept': 'application/json'
    },
    'routes': {
        'getData': {
            'requestMethod': 'GET',
            'description': 'Get test data',
            'route': '/data',
            'parameters': [
                {
                    'position': {
                        'key': 'limit',
                        'value': '{{USER_PARAM}}',
                        'location': 'query'
                    },
                    'z': {
                        'primitive': 'number()',
                        'options': [ 'min(1)', 'max(100)', 'default(10)' ]
                    }
                }
            ],
            'tests': [
                { '_description': 'Get 10 items', 'limit': 10 }
            ],
            'modifiers': []
        }
    },
    'handlers': {}
}

const validSchemaWithServerParams = {
    'namespace': 'authApi',
    'name': 'Auth API',
    'description': 'API requiring server params',
    'docs': [ 'https://auth.example.com/docs' ],
    'tags': [ 'auth' ],
    'flowMCP': '1.2.2',
    'root': 'https://auth.example.com',
    'requiredServerParams': [ 'API_KEY', 'API_SECRET' ],
    'headers': {
        'Authorization': 'Bearer {{API_KEY}}',
        'Content-Type': 'application/json'
    },
    'routes': {
        'getUser': {
            'requestMethod': 'GET',
            'description': 'Get user data',
            'route': '/user/:id',
            'parameters': [
                {
                    'position': {
                        'key': 'id',
                        'value': '{{USER_PARAM}}',
                        'location': 'insert'
                    },
                    'z': {
                        'primitive': 'string()',
                        'options': []
                    }
                }
            ],
            'tests': [
                { '_description': 'Get user by ID', 'id': 'user123' }
            ],
            'modifiers': []
        }
    },
    'handlers': {}
}

const invalidSchema = {
    'namespace': '',
    'name': 'Invalid Schema'
}

const sampleEnvContent = [
    '# Sample .env file',
    'API_KEY=test-key-12345',
    'API_SECRET=test-secret-67890',
    'DATABASE_URL=postgresql://localhost:5432/test',
    '',
    '# Comment line',
    'NODE_ENV=development'
].join( '\n' )


export {
    validSchema,
    validSchemaWithServerParams,
    invalidSchema,
    sampleEnvContent
}
