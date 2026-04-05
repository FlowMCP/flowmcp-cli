/**
 * Central configuration for the CLI.
 * Fork-friendly: change these values to rebrand the entire CLI.
 *
 * @property {string} appName            - Display name shown in headers and logs
 * @property {string} cliCommand         - The CLI binary name (used in help texts and error messages)
 * @property {string} globalConfigDirName - Directory name for global config (in user home)
 * @property {string} localConfigDirName  - Directory name for per-project config
 * @property {string} defaultEnvFileName  - Default .env file name
 * @property {string} defaultRegistryUrl  - Default registry URL for schema imports
 * @property {string} registryFileName    - Expected registry file name in repositories
 * @property {string} poweredBy           - Attribution string
 * @property {string} schemaSpec          - Schema specification version
 */
const appConfig = {
    'appName': 'FlowMCP',
    'cliCommand': 'flowmcp',
    'globalConfigDirName': '.flowmcp',
    'localConfigDirName': '.flowmcp',
    'defaultEnvFileName': '.env',
    'defaultRegistryUrl': 'https://raw.githubusercontent.com/FlowMCP/flowmcp-schemas/main/schemas/v2.0.0/flowmcp-registry-starter.json',
    'registryFileName': 'flowmcp-registry.json',
    'poweredBy': 'FlowMCP',
    'schemaSpec': '3.0.0',
    'cacheDirName': 'cache'
}

const catalogCategories = [
    {
        'name': 'Blockchain EVM',
        'match': [ 'etherscan', 'moralis', 'alchemy', 'infura', 'bscscan', 'blocknative', 'goldrush', 'ethers', 'ethscriptions', 'beaconchain', 'tenderly', 'sourcify', 'avalanche', 'chainlink', 'chainlist', 'wormholescan', 'bicscan' ]
    },
    {
        'name': 'Blockchain Solana',
        'match': [ 'solanatracker', 'solscan', 'solsniffer', 'jupiter', 'rugcheck', 'blockberry' ]
    },
    {
        'name': 'DeFi',
        'match': [ 'aave', 'uniswap', 'defillama', 'dexscreener', 'bridgerates', 'llama', 'debank', 'dexpaprika', 'oneinch', 'coinbase', 'safeglobal' ]
    },
    {
        'name': 'NFT & Identity',
        'match': [ 'lukso', 'ens', 'poap', 'spaceid', 'profilejump', 'passport', 'goldsky', 'nina' ]
    },
    {
        'name': 'Crypto Data',
        'match': [ 'coingecko', 'coincap', 'coinmarketcap', 'cryptodata', 'cryptopanic', 'cryptorank', 'cryptowizards', 'cryptoorderbook', 'ohlcv', 'taapi', 'indicator', 'honeypot', 'bitget', 'simdune' ]
    },
    {
        'name': 'Analytics',
        'match': [ 'dune', 'santiment', 'chartimg', 'polymarket', 'thegraph' ]
    },
    {
        'name': 'Government DE',
        'match': [ 'arbeitsagentur', 'autobahn', 'dashboard', 'digital', 'feiertage', 'govdata', 'klinikatlas', 'mudab', 'oeffentliche', 'itausschreibung', 'pegelonline', 'pflanzenschutz', 'reisewarnungen', 'smard', 'strahlenschutz', 'stolpersteine', 'umweltbundesamt', 'zvg', 'berlin', 'vag', 'ecovisio' ]
    },
    {
        'name': 'Government EU',
        'match': [ 'epo', 'ted' ]
    },
    {
        'name': 'Weather & Geo',
        'match': [ 'dwd', 'geoapify', 'overpass' ]
    },
    {
        'name': 'Web3 Social',
        'match': [ 'snapshot', 'tally', 'talent', 'memorylol', 'twitter', 'reddit', 'medium', 'cointelegraph' ]
    },
    {
        'name': 'News & Media',
        'match': [ 'newsapi', 'newsdata', 'tagesschau', 'hnrss' ]
    },
    {
        'name': 'Dev Tools & Utilities',
        'match': [ 'swaggerhub', 'mcpregistry', 'pinata', 'context', 'webcareer', 'xpayment', 'dip', 'blockchaininfo', 'mina', 'chainlinkmulticall' ]
    }
]


export { appConfig, catalogCategories }
