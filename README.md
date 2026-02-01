[![Test](https://img.shields.io/github/actions/workflow/status/FlowMCP/flowmcp-cli/test-on-push.yml)]() ![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)

# FlowMCP CLI

Command-line tool for developing, validating, and managing FlowMCP schemas.

## Description

FlowMCP CLI is a developer tool for working with FlowMCP schemas — structured API definitions that enable AI agents to interact with external services. The CLI provides schema validation, live API testing, repository imports, and an MCP server mode for integration with AI agent frameworks like Claude Code.

All commands output JSON for programmatic consumption by AI agents and scripts.

## Architecture

The CLI operates on two configuration levels:

```mermaid
flowchart LR
    A[Global: ~/.flowmcp/] --> B[Config + .env + Sources]
    B --> C[flowmcp init]
    C --> D[Local: {project}/.flowmcp/]
    D --> E[Groups with Selected Tools]
    E --> F[flowmcp call / run]
```

| Level | Path | Content |
|-------|------|---------|
| **Global** | `~/.flowmcp/` | Config, .env with API keys, all imported schemas |
| **Local** | `{project}/.flowmcp/` | Project config, groups with selected tools |

## Quickstart

Get started with FlowMCP CLI in three steps.

**Clone the repository**

```bash
git clone https://github.com/FlowMCP/flowmcp-cli.git
cd flowmcp-cli
```

**Install dependencies**

```bash
npm i
```

**Initialize FlowMCP**

```bash
npx flowmcp init
```

This creates global configuration at `~/.flowmcp/` and optionally sets up a local project configuration. Follow the interactive prompts to specify your `.env` file location for API keys.

## Features

- Schema validation against FlowMCP spec 1.2.0
- Live API testing with real HTTP calls
- GitHub repository import with registry support
- Tool groups for project-specific schema selection
- MCP server mode for AI agent integration
- JSON output for all commands (AI-friendly)
- Interactive setup with health checks
- Supports multiple schema sources (builtin, GitHub, registry)

## Table of Contents

- [Installation](#installation)
- [Global vs Local Configuration](#global-vs-local-configuration)
- [Methods](#methods)
  - [.init()](#init)
  - [.import()](#import)
  - [.importRegistry()](#importregistry)
  - [.schemas()](#schemas)
  - [.status()](#status)
  - [.validate()](#validate)
  - [.test()](#test)
  - [.groupList()](#grouplist)
  - [.groupAppend()](#groupappend)
  - [.groupRemove()](#groupremove)
  - [.groupSetDefault()](#groupsetdefault)
  - [.callListTools()](#calllisttools)
  - [.callTool()](#calltool)
  - [.run()](#run)
  - [.help()](#help)
- [Tool Reference Format](#tool-reference-format)
- [Workflow Examples](#workflow-examples)
- [Contributing](#contributing)
- [License](#license)

## Installation

FlowMCP CLI requires Node.js 22 or higher.

**Global installation**

```bash
npm install -g flowmcp-cli
```

**Local development**

```bash
git clone https://github.com/FlowMCP/flowmcp-cli.git
cd flowmcp-cli
npm i
npm link
```

## Global vs Local Configuration

FlowMCP operates on two configuration levels.

**Global Configuration** (`~/.flowmcp/`)

- Stores all imported schemas
- Contains `.env` file with API keys
- Maintains schema sources (builtin, GitHub, registry)
- Created once with `flowmcp init`

**Local Configuration** (`{project}/.flowmcp/`)

- Project-specific tool groups
- Default group selection
- Created per project with `flowmcp init` in project directory

This separation allows you to import schemas once globally and selectively activate them per project via groups.

## Methods

All methods output JSON to stdout for programmatic consumption.

### init()

Interactive setup that creates global and local configuration.

**Method**

```
flowmcp init
```

**Parameters**

None. Interactive prompts guide you through setup.

**Example**

```bash
flowmcp init
```

**Returns**

Interactive console output with health checks and configuration status. No JSON output.

**What it does**

1. Displays health status of global and local configuration
2. Prompts for `.env` file path if not configured
3. Creates `~/.flowmcp/config.json` with FlowMCP core info
4. Optionally creates `.flowmcp/config.json` in current project
5. Initializes default group if needed


### import()

Import schemas from a GitHub repository.

**Method**

```
flowmcp import <url>
```

**Parameters**

| Key | Type | Description | Required |
|-----|------|-------------|----------|
| url | string | GitHub repository URL (e.g., `https://github.com/org/repo`) | Yes |
| --branch | string | Branch to import from (default: `main`) | No |

**Example**

```bash
flowmcp import https://github.com/flowmcp/flowmcp-schemas
flowmcp import https://github.com/flowmcp/flowmcp-schemas --branch develop
```

**Returns**

```javascript
{
    status: true,
    message: 'Schemas imported from flowmcp/flowmcp-schemas',
    schemaCount: 42,
    source: 'flowmcp-schemas'
}
```

| Key | Type | Description |
|-----|------|-------------|
| status | boolean | Success indicator |
| message | string | Human-readable result message |
| schemaCount | number | Number of schemas imported |
| source | string | Source identifier added to global config |


### importRegistry()

Import schemas from a registry URL.

**Method**

```
flowmcp import-registry <url>
```

**Parameters**

| Key | Type | Description | Required |
|-----|------|-------------|----------|
| url | string | Registry URL pointing to a JSON registry file | Yes |

**Example**

```bash
flowmcp import-registry https://registry.flowmcp.com/schemas.json
```

**Returns**

```javascript
{
    status: true,
    message: 'Schemas imported from registry',
    schemaCount: 15,
    sources: [ 'registry-source-1', 'registry-source-2' ]
}
```

| Key | Type | Description |
|-----|------|-------------|
| status | boolean | Success indicator |
| message | string | Human-readable result message |
| schemaCount | number | Total number of schemas imported |
| sources | array of strings | Source identifiers added to global config |


### schemas()

List all available schemas and their tools.

**Method**

```
flowmcp schemas
```

**Parameters**

None.

**Example**

```bash
flowmcp schemas
```

**Returns**

```javascript
{
    status: true,
    schemas: [
        {
            source: 'flowmcp-schemas',
            file: 'coingecko/simplePrice.mjs',
            routes: [ 'simplePrice', 'simpleSupportedVsCurrencies' ],
            toolCount: 2
        }
    ],
    totalSchemas: 42,
    totalTools: 128
}
```

| Key | Type | Description |
|-----|------|-------------|
| status | boolean | Success indicator |
| schemas | array of objects | List of all available schemas with their routes |
| totalSchemas | number | Total number of schema files |
| totalTools | number | Total number of tools (routes) across all schemas |


### status()

Show configuration, sources, groups, and health information.

**Method**

```
flowmcp status
```

**Parameters**

None.

**Example**

```bash
flowmcp status
```

**Returns**

```javascript
{
    status: true,
    global: {
        configPath: '/Users/user/.flowmcp/config.json',
        envPath: '/Users/user/.env',
        sources: {
            demo: { type: 'builtin', schemaCount: 1 },
            'flowmcp-schemas': { type: 'github', schemaCount: 42 }
        }
    },
    local: {
        configPath: '/path/to/project/.flowmcp/config.json',
        defaultGroup: 'crypto',
        groups: {
            crypto: { toolCount: 5 },
            defi: { toolCount: 8 }
        }
    },
    health: {
        healthy: true,
        checks: [
            { name: 'globalConfig', ok: true },
            { name: 'envFile', ok: true },
            { name: 'schemas', ok: true, detail: '43 schemas' }
        ]
    }
}
```

| Key | Type | Description |
|-----|------|-------------|
| status | boolean | Success indicator |
| global | object | Global configuration details |
| local | object | Local configuration details (if in project) |
| health | object | Health check results |


### validate()

Validate schema structure against FlowMCP spec 1.2.0.

**Method**

```
flowmcp validate [path]
```

**Parameters**

| Key | Type | Description | Required |
|-----|------|-------------|----------|
| path | string | Path to schema file or directory | No |
| --group | string | Validate schemas in a specific group instead of default | No |

**Example**

```bash
# Validate single schema file
flowmcp validate ~/.flowmcp/schemas/demo/coingecko.mjs

# Validate default group
flowmcp validate

# Validate specific group
flowmcp validate --group crypto
```

**Returns**

```javascript
{
    status: true,
    validated: 5,
    errors: [],
    warnings: []
}
```

Or with validation errors:

```javascript
{
    status: false,
    validated: 3,
    errors: [
        {
            file: 'schemas/broken/invalid.mjs',
            route: 'brokenRoute',
            error: 'Missing required field: schemaSpec'
        }
    ],
    warnings: [
        {
            file: 'schemas/demo/example.mjs',
            route: 'exampleRoute',
            warning: 'Deprecated field: oldParam'
        }
    ]
}
```

| Key | Type | Description |
|-----|------|-------------|
| status | boolean | All schemas valid |
| validated | number | Number of schemas validated |
| errors | array of objects | Validation errors (if any) |
| warnings | array of objects | Validation warnings (if any) |


### test()

Test schemas with live API calls.

**Method**

```
flowmcp test <scope>
```

**Parameters**

| Key | Type | Description | Required |
|-----|------|-------------|----------|
| scope | string | One of: `project`, `user`, `single` | Yes |
| --route | string | Filter by route name (optional) | No |
| --group | string | Use specific group instead of default | No |

For `single` scope, provide file path as second argument:

```
flowmcp test single <path>
```

**Example**

```bash
# Test default group (project scope)
flowmcp test project

# Test all user schemas
flowmcp test user

# Test single schema file
flowmcp test single ~/.flowmcp/schemas/demo/coingecko.mjs

# Test specific route
flowmcp test project --route simplePrice

# Test specific group
flowmcp test project --group crypto
```

**Returns**

```javascript
{
    status: true,
    tested: 5,
    passed: 4,
    failed: 1,
    results: [
        {
            file: 'coingecko/simplePrice.mjs',
            route: 'simplePrice',
            status: 'passed',
            duration: 234
        },
        {
            file: 'etherscan/getBalance.mjs',
            route: 'getBalance',
            status: 'failed',
            error: 'API key not found in .env',
            duration: 12
        }
    ]
}
```

| Key | Type | Description |
|-----|------|-------------|
| status | boolean | All tests passed |
| tested | number | Number of tools tested |
| passed | number | Number of passed tests |
| failed | number | Number of failed tests |
| results | array of objects | Detailed test results per tool |


### groupList()

List all groups and their tool counts.

**Method**

```
flowmcp group list
```

**Parameters**

None.

**Example**

```bash
flowmcp group list
```

**Returns**

```javascript
{
    status: true,
    defaultGroup: 'crypto',
    groups: {
        crypto: {
            toolCount: 5,
            tools: [
                'flowmcp-schemas/coingecko/simplePrice.mjs::simplePrice',
                'flowmcp-schemas/etherscan/getBalance.mjs'
            ]
        },
        defi: {
            toolCount: 8,
            tools: [ '...' ]
        }
    }
}
```

| Key | Type | Description |
|-----|------|-------------|
| status | boolean | Success indicator |
| defaultGroup | string | Name of the default group |
| groups | object | Map of group names to their configurations |


### groupAppend()

Add tools to a group.

**Method**

```
flowmcp group append <name> --tools "refs"
```

**Parameters**

| Key | Type | Description | Required |
|-----|------|-------------|----------|
| name | string | Group name | Yes |
| --tools | string | Comma-separated tool references | Yes |

**Example**

```bash
flowmcp group append crypto --tools "flowmcp-schemas/coingecko/simplePrice.mjs,flowmcp-schemas/etherscan/getBalance.mjs::getBalance"
```

**Returns**

```javascript
{
    status: true,
    group: 'crypto',
    toolCount: 7,
    added: 2
}
```

| Key | Type | Description |
|-----|------|-------------|
| status | boolean | Success indicator |
| group | string | Group name |
| toolCount | number | Total tools in group after append |
| added | number | Number of tools added |


### groupRemove()

Remove tools from a group.

**Method**

```
flowmcp group remove <name> --tools "refs"
```

**Parameters**

| Key | Type | Description | Required |
|-----|------|-------------|----------|
| name | string | Group name | Yes |
| --tools | string | Comma-separated tool references | Yes |

**Example**

```bash
flowmcp group remove crypto --tools "flowmcp-schemas/coingecko/simplePrice.mjs::simplePrice"
```

**Returns**

```javascript
{
    status: true,
    group: 'crypto',
    toolCount: 6,
    removed: 1
}
```

| Key | Type | Description |
|-----|------|-------------|
| status | boolean | Success indicator |
| group | string | Group name |
| toolCount | number | Total tools in group after removal |
| removed | number | Number of tools removed |


### groupSetDefault()

Set the default group for the current project.

**Method**

```
flowmcp group set-default <name>
```

**Parameters**

| Key | Type | Description | Required |
|-----|------|-------------|----------|
| name | string | Group name | Yes |

**Example**

```bash
flowmcp group set-default crypto
```

**Returns**

```javascript
{
    status: true,
    defaultGroup: 'crypto'
}
```

| Key | Type | Description |
|-----|------|-------------|
| status | boolean | Success indicator |
| defaultGroup | string | Name of the newly set default group |


### callListTools()

List available tools in the default group (or specified group).

**Method**

```
flowmcp call list-tools
```

**Parameters**

| Key | Type | Description | Required |
|-----|------|-------------|----------|
| --group | string | Use specific group instead of default | No |

**Example**

```bash
# List tools in default group
flowmcp call list-tools

# List tools in specific group
flowmcp call list-tools --group crypto
```

**Returns**

```javascript
{
    status: true,
    group: 'crypto',
    tools: [
        {
            name: 'coingecko_simplePrice',
            description: 'Get cryptocurrency prices in various currencies',
            source: 'flowmcp-schemas/coingecko/simplePrice.mjs',
            route: 'simplePrice'
        }
    ],
    toolCount: 5
}
```

| Key | Type | Description |
|-----|------|-------------|
| status | boolean | Success indicator |
| group | string | Group name |
| tools | array of objects | List of available tools with metadata |
| toolCount | number | Total number of tools |


### callTool()

Call a tool with optional JSON input.

**Method**

```
flowmcp call <tool-name> [json]
```

**Parameters**

| Key | Type | Description | Required |
|-----|------|-------------|----------|
| tool-name | string | Tool name from list-tools | Yes |
| json | string | JSON string with tool arguments | No |
| --group | string | Use specific group instead of default | No |

**Example**

```bash
# Call without arguments
flowmcp call coingecko_simpleSupportedVsCurrencies

# Call with JSON arguments
flowmcp call coingecko_simplePrice '{"ids":"bitcoin,ethereum","vs_currencies":"usd,eur"}'

# Call tool in specific group
flowmcp call my_tool --group defi
```

**Returns**

The tool's actual API response wrapped in a result object:

```javascript
{
    status: true,
    tool: 'coingecko_simplePrice',
    result: {
        bitcoin: { usd: 45000, eur: 38000 },
        ethereum: { usd: 3000, eur: 2500 }
    },
    duration: 456
}
```

| Key | Type | Description |
|-----|------|-------------|
| status | boolean | Tool call succeeded |
| tool | string | Tool name that was called |
| result | any | The tool's actual response data |
| duration | number | Execution time in milliseconds |


### run()

Start MCP server for the default group.

**Method**

```
flowmcp run
```

**Parameters**

| Key | Type | Description | Required |
|-----|------|-------------|----------|
| --group | string | Use specific group instead of default | No |

**Example**

```bash
# Run MCP server with default group
flowmcp run

# Run MCP server with specific group
flowmcp run --group crypto
```

**Returns**

Starts an MCP server process (stdio transport). No JSON output. The server runs until interrupted (Ctrl+C).

On error before server start:

```javascript
{
    status: false,
    error: 'No default group configured'
}
```


### help()

Show help information about available commands.

**Method**

```
flowmcp help
```

or

```
flowmcp --help
```

or

```
flowmcp -h
```

**Parameters**

None.

**Example**

```bash
flowmcp help
```

**Returns**

Console output with command usage information. No JSON output.

## Tool Reference Format

When specifying tools in groups, use one of these formats:

```
source/file.mjs              # All tools from a schema
source/file.mjs::routeName   # Single tool from a schema
```

**Examples**

```bash
# Add all tools from a schema
flowmcp group append crypto --tools "flowmcp-schemas/coingecko/simplePrice.mjs"

# Add specific tool
flowmcp group append crypto --tools "flowmcp-schemas/etherscan/getBalance.mjs::getBalance"

# Add multiple (comma-separated)
flowmcp group append crypto --tools "flowmcp-schemas/coingecko/simplePrice.mjs,flowmcp-schemas/etherscan/getBalance.mjs::getBalance"
```

## Workflow Examples

**Initial Setup**

```bash
# Initialize FlowMCP
flowmcp init

# Import schema repository
flowmcp import https://github.com/flowmcp/flowmcp-schemas

# Check status
flowmcp status

# List available schemas
flowmcp schemas
```

**Create a Project Group**

```bash
# Create group for crypto tools
flowmcp group append crypto --tools "flowmcp-schemas/coingecko/simplePrice.mjs,flowmcp-schemas/etherscan/getBalance.mjs"

# Set as default
flowmcp group set-default crypto

# List groups
flowmcp group list

# List tools in current group
flowmcp call list-tools
```

**Validate and Test**

```bash
# Validate schemas
flowmcp validate

# Test all tools in default group
flowmcp test project

# Test specific route
flowmcp test project --route simplePrice

# Test single schema file
flowmcp test single ~/.flowmcp/schemas/demo/coingecko.mjs
```

**Use Tools**

```bash
# Call tool without arguments
flowmcp call coingecko_simpleSupportedVsCurrencies

# Call tool with arguments
flowmcp call coingecko_simplePrice '{"ids":"bitcoin","vs_currencies":"usd"}'

# Run MCP server for AI agent integration
flowmcp run
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT
