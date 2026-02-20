[![Test](https://img.shields.io/github/actions/workflow/status/FlowMCP/flowmcp-cli/test-on-push.yml)]() ![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)

# FlowMCP CLI

Command-line tool for developing, validating, and managing FlowMCP schemas.

## Description

FlowMCP CLI is a developer tool for working with FlowMCP schemas — structured API definitions that enable AI agents to interact with external services. The CLI provides schema validation, live API testing, repository imports, delta-based updates, and an MCP server mode for integration with AI agent frameworks like Claude Code.

## Architecture

```mermaid
flowchart LR
    A[Global: ~/.flowmcp/] --> B[Config + .env + Schemas]
    B --> C[flowmcp init]
    C --> D[Local: project/.flowmcp/]
    D --> E[Groups with Selected Tools]
    E --> F[flowmcp call / run]
```

| Level | Path | Content |
|-------|------|---------|
| **Global** | `~/.flowmcp/` | Config, .env with API keys, all imported schemas |
| **Local** | `{project}/.flowmcp/` | Project config, groups with selected tools |

## Quickstart

```bash
git clone https://github.com/FlowMCP/flowmcp-cli.git
cd flowmcp-cli
npm i
npx flowmcp init
```

## Commands

### Setup

| Command | Description |
|---------|-------------|
| `flowmcp init` | Interactive setup — creates global and local config |

### Tool Discovery

| Command | Description |
|---------|-------------|
| `flowmcp search <query>` | Find available tools by keyword |
| `flowmcp add <tool-name>` | Activate a tool for this project |
| `flowmcp remove <tool-name>` | Deactivate a tool |
| `flowmcp list` | Show active tools |

### Schema Management

| Command | Description |
|---------|-------------|
| `flowmcp schemas` | List all available schemas and their tools |
| `flowmcp import <url> [--branch name]` | Import schemas from a GitHub repository |
| `flowmcp import-registry <url>` | Import schemas from a registry URL |
| `flowmcp update [source-name]` | Update schemas from remote registries (hash-based delta) |
| `flowmcp status` | Show config, sources, groups, and health info |

### Group Management

| Command | Description |
|---------|-------------|
| `flowmcp group list` | List all groups and their tool counts |
| `flowmcp group append <name> --tools "refs"` | Add tools to a group (creates group if new) |
| `flowmcp group remove <name> --tools "refs"` | Remove tools from a group |
| `flowmcp group set-default <name>` | Set the default group |

### Validation & Testing

| Command | Description |
|---------|-------------|
| `flowmcp validate [path] [--group name]` | Validate schema structure against spec 2.0.0 |
| `flowmcp test project [--route name] [--group name]` | Test default group with live API calls |
| `flowmcp test user [--route name]` | Test all user schemas with live API calls |
| `flowmcp test single <path> [--route name]` | Test a single schema file |

### Execution

| Command | Description |
|---------|-------------|
| `flowmcp call list-tools [--group name]` | List available tools in default/specified group |
| `flowmcp call <tool-name> [json] [--group name]` | Call a tool with optional JSON input |
| `flowmcp run [--group name]` | Start MCP server (stdio transport) |

## Tool Reference Format

```
source/file.mjs              # All tools from a schema
source/file.mjs::routeName   # Single tool from a schema
```

## Workflow Example

```bash
# 1. Setup (quick install imports schemas and creates default group)
flowmcp init

# 2. Or: Manual import and group creation
flowmcp import https://github.com/flowmcp/flowmcp-schemas
flowmcp group append crypto --tools "flowmcp-schemas/coingecko/simplePrice.mjs,flowmcp-schemas/etherscan/getBalance.mjs"
flowmcp group set-default crypto

# 3. Validate and test
flowmcp validate
flowmcp test project

# 4. Use tools
flowmcp call list-tools
flowmcp call coingecko_simplePrice '{"ids":"bitcoin","vs_currencies":"usd"}'

# 5. Update schemas from remote
flowmcp update

# 6. Run as MCP server
flowmcp run
```

## Documentation

Full documentation at [docs.flowmcp.org](https://docs.flowmcp.org). See the [CLI Reference](https://docs.flowmcp.org/guides/cli-reference) for detailed command documentation.

## License

MIT
