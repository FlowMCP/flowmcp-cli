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
    'defaultRegistryUrl': 'https://raw.githubusercontent.com/FlowMCP/flowmcp-schemas/main/schemas/v1.2.0/flowmcp-registry-starter.json',
    'registryFileName': 'flowmcp-registry.json',
    'poweredBy': 'FlowMCP',
    'schemaSpec': '1.2.0'
}


export { appConfig }
