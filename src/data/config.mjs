const appConfig = {
    'appName': 'FlowMCP',
    'cliCommand': 'flowmcp',
    'globalConfigDirName': '.flowmcp',
    'localConfigDirName': '.flowmcp',
    'defaultEnvFileName': '.env',
    'defaultRegistryUrl': 'https://raw.githubusercontent.com/FlowMCP/flowmcp-schemas/main/schemas/v1.2.0/flowmcp-registry-starter.json',
    'poweredBy': 'FlowMCP',
    'schemaSpec': '1.2.0'
}

const MODE_AGENT = 'agent'
const MODE_DEVELOPMENT = 'development'

const agentCommands = [
    'search',
    'add',
    'remove',
    'list',
    'call',
    'status',
    'mode'
]


export { appConfig, MODE_AGENT, MODE_DEVELOPMENT, agentCommands }
