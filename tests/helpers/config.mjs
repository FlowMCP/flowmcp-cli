import { join } from 'node:path'
import { tmpdir } from 'node:os'


const TEST_TMP_DIR = join( tmpdir(), 'flowmcp-cli-test' )
const TEST_GLOBAL_CONFIG_DIR = join( TEST_TMP_DIR, '.flowmcp' )
const TEST_LOCAL_CONFIG_DIR = join( TEST_TMP_DIR, 'project', '.flowmcp' )
const TEST_SCHEMAS_DIR = join( TEST_TMP_DIR, 'schemas' )

const VALID_GLOBAL_CONFIG = {
    'envPath': '/tmp/test.env',
    'flowmcpCore': {
        'version': '1.4.2',
        'commit': '91ccaf8dc7b61b5df3cfa780699cbf4973cd3cbd',
        'schemaSpec': '1.2.0'
    },
    'initialized': '2026-01-31T12:00:00.000Z'
}

const VALID_GLOBAL_CONFIG_WITH_SOURCES = {
    'envPath': '/tmp/test.env',
    'flowmcpCore': {
        'version': '1.4.2',
        'commit': '91ccaf8dc7b61b5df3cfa780699cbf4973cd3cbd',
        'schemaSpec': '1.2.0'
    },
    'initialized': '2026-01-31T12:00:00.000Z',
    'sources': {
        'demo': {
            'type': 'builtin',
            'schemaCount': 1
        },
        'flowmcp-community': {
            'type': 'github',
            'repository': 'https://github.com/flowmcp/flowMCP-schemas',
            'branch': 'main',
            'registryUrl': 'https://raw.githubusercontent.com/flowmcp/flowMCP-schemas/main/flowmcp-registry.json',
            'schemaCount': 3,
            'importedAt': '2026-01-31T14:00:00.000Z'
        }
    }
}

const VALID_LOCAL_CONFIG = {
    'root': '~/.flowmcp',
    'schemasDir': './schemas'
}

const VALID_LOCAL_CONFIG_WITH_GROUPS = {
    'root': '~/.flowmcp',
    'defaultGroup': 'my-defi',
    'groups': {
        'my-defi': {
            'description': 'DeFi API schemas',
            'schemas': [
                'demo/ping.mjs',
                'flowmcp-community/coincap/assets.mjs'
            ]
        },
        'market-data': {
            'description': 'Market data schemas',
            'schemas': [
                'flowmcp-community/coingecko-com/prices.mjs'
            ]
        }
    }
}

const VALID_GITHUB_URL = 'https://github.com/flowmcp/flowMCP-schemas'

const VALID_REGISTRY = {
    'name': 'flowmcp-community',
    'version': '1.0.0',
    'description': 'Official FlowMCP community schemas',
    'schemaSpec': '1.2.0',
    'baseDir': 'schemas/v1.2.0',
    'schemas': [
        {
            'namespace': 'coincap',
            'file': 'coincap/assets.mjs',
            'name': 'CoinCap Assets API',
            'requiredServerParams': [ 'COINCAP_API_KEY' ]
        },
        {
            'namespace': 'coingecko',
            'file': 'coingecko-com/prices.mjs',
            'name': 'CoinGecko Prices',
            'requiredServerParams': []
        }
    ]
}


export {
    TEST_TMP_DIR,
    TEST_GLOBAL_CONFIG_DIR,
    TEST_LOCAL_CONFIG_DIR,
    TEST_SCHEMAS_DIR,
    VALID_GLOBAL_CONFIG,
    VALID_GLOBAL_CONFIG_WITH_SOURCES,
    VALID_LOCAL_CONFIG,
    VALID_LOCAL_CONFIG_WITH_GROUPS,
    VALID_GITHUB_URL,
    VALID_REGISTRY
}
