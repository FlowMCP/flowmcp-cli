import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { writeFile, mkdir, rm, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'

import { FlowMcpCli } from '../../src/task/FlowMcpCli.mjs'
import { VALID_LOCAL_CONFIG_WITH_PROMPTS, VALID_GLOBAL_CONFIG } from '../helpers/config.mjs'


const TEST_CWD = join( tmpdir(), 'flowmcp-cli-prompt-test' )
const LOCAL_CONFIG_DIR = join( TEST_CWD, '.flowmcp' )
const LOCAL_CONFIG_PATH = join( LOCAL_CONFIG_DIR, 'config.json' )
const PROMPTS_DIR = join( LOCAL_CONFIG_DIR, 'prompts' )

const GLOBAL_CONFIG_DIR = join( homedir(), '.flowmcp' )
const GLOBAL_CONFIG_PATH = join( GLOBAL_CONFIG_DIR, 'config.json' )
let globalConfigExistedBefore = false

const VALID_PROMPT_CONTENT = `# Standard Token Analysis

## Description
Full technical analysis report for a token.
Combines price data and indicators.

## Input
- \`tokenName\` (string, required): Name or ticker symbol

## Workflow
### Step 1: Symbol Resolution
Search for \`{tokenName}\` using \`searchSymbol\`.

### Step 2: Fetch Price Data
Call \`getOhlcv\` with the resolved symbol.

### Step 3: Compute Indicators
Compute \`getRelativeStrengthIndex\` with closings.

## Output
- Markdown document with indicator summary
`

const MINIMAL_PROMPT_CONTENT = `# Minimal Prompt

## Workflow
### Step 1: Do something
Call \`searchSymbol\` to find the asset.
`


beforeAll( async () => {
    try {
        await access( GLOBAL_CONFIG_PATH )
        globalConfigExistedBefore = true
    } catch {
        globalConfigExistedBefore = false
        await mkdir( GLOBAL_CONFIG_DIR, { recursive: true } )
        await writeFile( GLOBAL_CONFIG_PATH, JSON.stringify( VALID_GLOBAL_CONFIG, null, 4 ), 'utf-8' )
    }

    await mkdir( PROMPTS_DIR, { recursive: true } )
    await writeFile( LOCAL_CONFIG_PATH, JSON.stringify( VALID_LOCAL_CONFIG_WITH_PROMPTS, null, 4 ), 'utf-8' )
    await writeFile( join( PROMPTS_DIR, 'token-analysis.md' ), VALID_PROMPT_CONTENT, 'utf-8' )
    await writeFile( join( PROMPTS_DIR, 'quick-check.md' ), MINIMAL_PROMPT_CONTENT, 'utf-8' )
} )


afterAll( async () => {
    await rm( TEST_CWD, { recursive: true, force: true } )
} )


describe( 'FlowMcpCli.validationPromptAdd', () => {
    it( 'rejects missing group', () => {
        const { status, messages } = FlowMcpCli.validationPromptAdd( { group: undefined, name: 'test', file: 'test.md' } )

        expect( status ).toBe( false )
        expect( messages.length ).toBeGreaterThanOrEqual( 1 )
        expect( messages[ 0 ] ).toContain( 'group' )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'rejects non-string group', () => {
        const { status, messages } = FlowMcpCli.validationPromptAdd( { group: 42, name: 'test', file: 'test.md' } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( 'Must be a string' )
    } )


    it( 'rejects empty group', () => {
        const { status, messages } = FlowMcpCli.validationPromptAdd( { group: '   ', name: 'test', file: 'test.md' } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( 'Must not be empty' )
    } )


    it( 'rejects missing name', () => {
        const { status, messages } = FlowMcpCli.validationPromptAdd( { group: 'test', name: undefined, file: 'test.md' } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( 'name' )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'rejects missing file', () => {
        const { status, messages } = FlowMcpCli.validationPromptAdd( { group: 'test', name: 'test', file: undefined } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( 'file' )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'rejects non-.md file', () => {
        const { status, messages } = FlowMcpCli.validationPromptAdd( { group: 'test', name: 'test', file: 'test.txt' } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( '.md file' )
    } )


    it( 'collects multiple errors at once', () => {
        const { status, messages } = FlowMcpCli.validationPromptAdd( { group: undefined, name: undefined, file: undefined } )

        expect( status ).toBe( false )
        expect( messages.length ).toBe( 3 )
    } )


    it( 'accepts valid parameters', () => {
        const { status, messages } = FlowMcpCli.validationPromptAdd( { group: 'my-group', name: 'my-prompt', file: 'prompts/my-prompt.md' } )

        expect( status ).toBe( true )
        expect( messages.length ).toBe( 0 )
    } )
} )


describe( 'FlowMcpCli.validationPromptRemove', () => {
    it( 'rejects missing group', () => {
        const { status, messages } = FlowMcpCli.validationPromptRemove( { group: undefined, name: 'test' } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'rejects missing name', () => {
        const { status, messages } = FlowMcpCli.validationPromptRemove( { group: 'test', name: undefined } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'accepts valid parameters', () => {
        const { status, messages } = FlowMcpCli.validationPromptRemove( { group: 'test', name: 'my-prompt' } )

        expect( status ).toBe( true )
        expect( messages.length ).toBe( 0 )
    } )
} )


describe( 'FlowMcpCli.validationPromptShow', () => {
    it( 'rejects missing group', () => {
        const { status, messages } = FlowMcpCli.validationPromptShow( { group: undefined, name: 'test' } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'rejects missing name', () => {
        const { status, messages } = FlowMcpCli.validationPromptShow( { group: 'test', name: undefined } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'accepts valid parameters', () => {
        const { status, messages } = FlowMcpCli.validationPromptShow( { group: 'test', name: 'my-prompt' } )

        expect( status ).toBe( true )
        expect( messages.length ).toBe( 0 )
    } )
} )


describe( 'FlowMcpCli.validationPromptSearch', () => {
    it( 'rejects missing query', () => {
        const { status, messages } = FlowMcpCli.validationPromptSearch( { query: undefined } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( 'Missing value' )
    } )


    it( 'rejects empty query', () => {
        const { status, messages } = FlowMcpCli.validationPromptSearch( { query: '   ' } )

        expect( status ).toBe( false )
        expect( messages[ 0 ] ).toContain( 'Must not be empty' )
    } )


    it( 'accepts valid query', () => {
        const { status, messages } = FlowMcpCli.validationPromptSearch( { query: 'analysis' } )

        expect( status ).toBe( true )
        expect( messages.length ).toBe( 0 )
    } )
} )


describe( 'FlowMcpCli.promptList', () => {
    it( 'returns empty list when no config exists', async () => {
        const emptyCwd = join( tmpdir(), 'flowmcp-cli-prompt-empty' )
        await mkdir( emptyCwd, { recursive: true } )

        const { result } = await FlowMcpCli.promptList( { cwd: emptyCwd } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'prompts' ] ).toEqual( [] )

        await rm( emptyCwd, { recursive: true, force: true } )
    } )


    it( 'returns empty list when groups have no prompts', async () => {
        const noPromptsCwd = join( tmpdir(), 'flowmcp-cli-prompt-noprompts' )
        const noPromptsDir = join( noPromptsCwd, '.flowmcp' )
        await mkdir( noPromptsDir, { recursive: true } )

        const config = {
            'root': '~/.flowmcp',
            'groups': {
                'test': { 'description': 'No prompts here', 'tools': [ 'demo/ping.mjs' ] }
            }
        }
        await writeFile( join( noPromptsDir, 'config.json' ), JSON.stringify( config, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.promptList( { cwd: noPromptsCwd } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'prompts' ] ).toEqual( [] )

        await rm( noPromptsCwd, { recursive: true, force: true } )
    } )


    it( 'lists prompts from all groups', async () => {
        const { result } = await FlowMcpCli.promptList( { cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'prompts' ].length ).toBe( 2 )

        const names = result[ 'prompts' ]
            .map( ( p ) => {
                const name = p[ 'name' ]

                return name
            } )

        expect( names ).toContain( 'token-analysis' )
        expect( names ).toContain( 'quick-check' )
    } )


    it( 'includes group name, title, description, and toolCount', async () => {
        const { result } = await FlowMcpCli.promptList( { cwd: TEST_CWD } )
        const tokenPrompt = result[ 'prompts' ]
            .find( ( p ) => {
                const isToken = p[ 'name' ] === 'token-analysis'

                return isToken
            } )

        expect( tokenPrompt[ 'group' ] ).toBe( 'trading-analysis' )
        expect( tokenPrompt[ 'title' ] ).toBe( 'Standard Token Analysis' )
        expect( tokenPrompt[ 'description' ] ).toBe( 'Full technical analysis report for a token' )
        expect( tokenPrompt[ 'toolCount' ] ).toBe( 3 )
    } )
} )


describe( 'FlowMcpCli.promptSearch', () => {
    it( 'finds prompts by title', async () => {
        const { result } = await FlowMcpCli.promptSearch( { query: 'Token Analysis', cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'matches' ].length ).toBe( 1 )
        expect( result[ 'matches' ][ 0 ][ 'name' ] ).toBe( 'token-analysis' )
    } )


    it( 'finds prompts by description', async () => {
        const { result } = await FlowMcpCli.promptSearch( { query: 'indicators', cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'matches' ].length ).toBe( 1 )
        expect( result[ 'matches' ][ 0 ][ 'name' ] ).toBe( 'quick-check' )
    } )


    it( 'performs case-insensitive search', async () => {
        const { result } = await FlowMcpCli.promptSearch( { query: 'QUICK', cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'matches' ].length ).toBe( 1 )
        expect( result[ 'matches' ][ 0 ][ 'name' ] ).toBe( 'quick-check' )
    } )


    it( 'finds prompts by name', async () => {
        const { result } = await FlowMcpCli.promptSearch( { query: 'token-analysis', cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'matches' ].length ).toBe( 1 )
    } )


    it( 'returns empty matches for non-matching query', async () => {
        const { result } = await FlowMcpCli.promptSearch( { query: 'zzzznonexistent', cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'matches' ] ).toEqual( [] )
    } )


    it( 'returns empty matches when no config exists', async () => {
        const emptyCwd = join( tmpdir(), 'flowmcp-cli-prompt-search-empty' )
        await mkdir( emptyCwd, { recursive: true } )

        const { result } = await FlowMcpCli.promptSearch( { query: 'test', cwd: emptyCwd } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'matches' ] ).toEqual( [] )

        await rm( emptyCwd, { recursive: true, force: true } )
    } )
} )


describe( 'FlowMcpCli.promptShow', () => {
    it( 'returns prompt content', async () => {
        const { result } = await FlowMcpCli.promptShow( { group: 'trading-analysis', name: 'token-analysis', cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'group' ] ).toBe( 'trading-analysis' )
        expect( result[ 'name' ] ).toBe( 'token-analysis' )
        expect( result[ 'title' ] ).toBe( 'Standard Token Analysis' )
        expect( result[ 'file' ] ).toBe( '.flowmcp/prompts/token-analysis.md' )
        expect( result[ 'content' ] ).toContain( '# Standard Token Analysis' )
        expect( result[ 'content' ] ).toContain( '## Workflow' )
    } )


    it( 'returns error when group not found', async () => {
        const { result } = await FlowMcpCli.promptShow( { group: 'nonexistent', name: 'test', cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'not found' )
    } )


    it( 'returns error when prompt not found in group', async () => {
        const { result } = await FlowMcpCli.promptShow( { group: 'trading-analysis', name: 'nonexistent', cwd: TEST_CWD } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Prompt "nonexistent" not found' )
    } )


    it( 'returns error when prompt file is missing from disk', async () => {
        const missingCwd = join( tmpdir(), 'flowmcp-cli-prompt-show-missing' )
        const missingDir = join( missingCwd, '.flowmcp' )
        await mkdir( missingDir, { recursive: true } )

        const config = {
            'root': '~/.flowmcp',
            'groups': {
                'test': {
                    'description': 'Test',
                    'tools': [ 'demo/ping.mjs' ],
                    'prompts': {
                        'ghost': {
                            'title': 'Ghost Prompt',
                            'description': 'File does not exist',
                            'file': '.flowmcp/prompts/ghost.md'
                        }
                    }
                }
            }
        }
        await writeFile( join( missingDir, 'config.json' ), JSON.stringify( config, null, 4 ), 'utf-8' )

        const { result } = await FlowMcpCli.promptShow( { group: 'test', name: 'ghost', cwd: missingCwd } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Cannot read prompt file' )

        await rm( missingCwd, { recursive: true, force: true } )
    } )
} )


describe( 'FlowMcpCli.promptAdd', () => {
    const addCwd = join( tmpdir(), 'flowmcp-cli-prompt-add-test' )
    const addConfigDir = join( addCwd, '.flowmcp' )
    const addConfigPath = join( addConfigDir, 'config.json' )
    const addPromptsDir = join( addConfigDir, 'prompts' )


    beforeAll( async () => {
        await mkdir( addPromptsDir, { recursive: true } )

        const config = {
            'root': '~/.flowmcp',
            'defaultGroup': 'my-group',
            'groups': {
                'my-group': {
                    'description': 'Test group',
                    'tools': [
                        'yahoofinance/market.mjs::searchSymbol',
                        'yahoofinance/market.mjs::getOhlcv'
                    ]
                },
                'empty-tools': {
                    'description': 'No tools',
                    'tools': []
                }
            }
        }
        await writeFile( addConfigPath, JSON.stringify( config, null, 4 ), 'utf-8' )
        await writeFile( join( addPromptsDir, 'valid-prompt.md' ), VALID_PROMPT_CONTENT, 'utf-8' )
        await writeFile( join( addPromptsDir, 'no-title.md' ), `Not a heading\n\n## Workflow\n### Step 1\nDo stuff.\n`, 'utf-8' )
        await writeFile( join( addPromptsDir, 'no-workflow.md' ), `# Has Title\n\n## Description\nNo workflow here.\n`, 'utf-8' )
    } )


    afterAll( async () => {
        await rm( addCwd, { recursive: true, force: true } )
    } )


    it( 'adds a valid prompt to a group', async () => {
        const { result } = await FlowMcpCli.promptAdd( {
            group: 'my-group',
            name: 'valid-prompt',
            file: '.flowmcp/prompts/valid-prompt.md',
            cwd: addCwd
        } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'group' ] ).toBe( 'my-group' )
        expect( result[ 'name' ] ).toBe( 'valid-prompt' )
        expect( result[ 'title' ] ).toBe( 'Standard Token Analysis' )
        expect( result[ 'description' ] ).toContain( 'technical analysis' )
        expect( result[ 'file' ] ).toBe( '.flowmcp/prompts/valid-prompt.md' )
    } )


    it( 'resolves tool references from workflow', async () => {
        const { result } = await FlowMcpCli.promptAdd( {
            group: 'my-group',
            name: 'valid-prompt',
            file: '.flowmcp/prompts/valid-prompt.md',
            cwd: addCwd
        } )

        expect( result[ 'resolvedTools' ] ).toContain( 'searchSymbol' )
        expect( result[ 'resolvedTools' ] ).toContain( 'getOhlcv' )
    } )


    it( 'reports unresolved tool references as warnings', async () => {
        const { result } = await FlowMcpCli.promptAdd( {
            group: 'my-group',
            name: 'valid-prompt',
            file: '.flowmcp/prompts/valid-prompt.md',
            cwd: addCwd
        } )

        const unresolvedWarnings = result[ 'warnings' ]
            .filter( ( w ) => {
                const isUnresolved = w.includes( 'getRelativeStrengthIndex' )

                return isUnresolved
            } )

        expect( unresolvedWarnings.length ).toBe( 1 )
        expect( unresolvedWarnings[ 0 ] ).toContain( 'PRM005' )
    } )


    it( 'persists prompt entry to config.json', async () => {
        const configContent = await readFile( addConfigPath, 'utf-8' )
        const config = JSON.parse( configContent )
        const prompts = config[ 'groups' ][ 'my-group' ][ 'prompts' ]

        expect( prompts ).toBeDefined()
        expect( prompts[ 'valid-prompt' ] ).toBeDefined()
        expect( prompts[ 'valid-prompt' ][ 'title' ] ).toBe( 'Standard Token Analysis' )
        expect( prompts[ 'valid-prompt' ][ 'file' ] ).toBe( '.flowmcp/prompts/valid-prompt.md' )
    } )


    it( 'rejects PRM001 invalid name pattern', async () => {
        const { result } = await FlowMcpCli.promptAdd( {
            group: 'my-group',
            name: 'Bad Name!',
            file: '.flowmcp/prompts/Bad Name!.md',
            cwd: addCwd
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'PRM001' )
    } )


    it( 'rejects PRM002 file not found', async () => {
        const { result } = await FlowMcpCli.promptAdd( {
            group: 'my-group',
            name: 'nonexistent',
            file: '.flowmcp/prompts/nonexistent.md',
            cwd: addCwd
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'PRM002' )
    } )


    it( 'rejects PRM003 missing title', async () => {
        const { result } = await FlowMcpCli.promptAdd( {
            group: 'my-group',
            name: 'no-title',
            file: '.flowmcp/prompts/no-title.md',
            cwd: addCwd
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'PRM003' )
    } )


    it( 'rejects PRM004 missing workflow', async () => {
        const { result } = await FlowMcpCli.promptAdd( {
            group: 'my-group',
            name: 'no-workflow',
            file: '.flowmcp/prompts/no-workflow.md',
            cwd: addCwd
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'PRM004' )
    } )


    it( 'rejects PRM006 group with no tools', async () => {
        await writeFile( join( addPromptsDir, 'empty-test.md' ), MINIMAL_PROMPT_CONTENT, 'utf-8' )

        const { result } = await FlowMcpCli.promptAdd( {
            group: 'empty-tools',
            name: 'empty-test',
            file: '.flowmcp/prompts/empty-test.md',
            cwd: addCwd
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'PRM006' )
    } )


    it( 'rejects PRM008 filename mismatch', async () => {
        const { result } = await FlowMcpCli.promptAdd( {
            group: 'my-group',
            name: 'wrong-name',
            file: '.flowmcp/prompts/valid-prompt.md',
            cwd: addCwd
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'PRM008' )
    } )


    it( 'returns error when group does not exist', async () => {
        const { result } = await FlowMcpCli.promptAdd( {
            group: 'nonexistent',
            name: 'valid-prompt',
            file: '.flowmcp/prompts/valid-prompt.md',
            cwd: addCwd
        } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'not found' )
    } )
} )


describe( 'FlowMcpCli.promptRemove', () => {
    const removeCwd = join( tmpdir(), 'flowmcp-cli-prompt-remove-test' )
    const removeConfigDir = join( removeCwd, '.flowmcp' )
    const removeConfigPath = join( removeConfigDir, 'config.json' )
    const removePromptsDir = join( removeConfigDir, 'prompts' )


    beforeAll( async () => {
        await mkdir( removePromptsDir, { recursive: true } )

        const config = {
            'root': '~/.flowmcp',
            'groups': {
                'test-group': {
                    'description': 'Test',
                    'tools': [ 'demo/ping.mjs::ping' ],
                    'prompts': {
                        'to-remove': {
                            'title': 'Removable Prompt',
                            'description': 'Will be removed',
                            'file': '.flowmcp/prompts/to-remove.md'
                        },
                        'to-keep': {
                            'title': 'Keep This',
                            'description': 'Should survive',
                            'file': '.flowmcp/prompts/to-keep.md'
                        }
                    }
                }
            }
        }
        await writeFile( removeConfigPath, JSON.stringify( config, null, 4 ), 'utf-8' )
        await writeFile( join( removePromptsDir, 'to-remove.md' ), MINIMAL_PROMPT_CONTENT, 'utf-8' )
        await writeFile( join( removePromptsDir, 'to-keep.md' ), MINIMAL_PROMPT_CONTENT, 'utf-8' )
    } )


    afterAll( async () => {
        await rm( removeCwd, { recursive: true, force: true } )
    } )


    it( 'removes a prompt from the group', async () => {
        const { result } = await FlowMcpCli.promptRemove( { group: 'test-group', name: 'to-remove', cwd: removeCwd } )

        expect( result[ 'status' ] ).toBe( true )
        expect( result[ 'group' ] ).toBe( 'test-group' )
        expect( result[ 'name' ] ).toBe( 'to-remove' )
        expect( result[ 'removed' ] ).toBe( true )
        expect( result[ 'fileNotDeleted' ] ).toBe( '.flowmcp/prompts/to-remove.md' )
    } )


    it( 'does not delete the prompt file from disk', async () => {
        const filePath = join( removePromptsDir, 'to-remove.md' )
        let fileExists = true

        try {
            await access( filePath )
        } catch {
            fileExists = false
        }

        expect( fileExists ).toBe( true )
    } )


    it( 'persists removal to config.json', async () => {
        const configContent = await readFile( removeConfigPath, 'utf-8' )
        const config = JSON.parse( configContent )
        const prompts = config[ 'groups' ][ 'test-group' ][ 'prompts' ] || {}

        expect( prompts[ 'to-remove' ] ).toBeUndefined()
        expect( prompts[ 'to-keep' ] ).toBeDefined()
    } )


    it( 'returns error when group not found', async () => {
        const { result } = await FlowMcpCli.promptRemove( { group: 'nonexistent', name: 'test', cwd: removeCwd } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'not found' )
    } )


    it( 'returns error when prompt not found in group', async () => {
        const { result } = await FlowMcpCli.promptRemove( { group: 'test-group', name: 'nonexistent', cwd: removeCwd } )

        expect( result[ 'status' ] ).toBe( false )
        expect( result[ 'error' ] ).toContain( 'Prompt "nonexistent" not found' )
    } )


    it( 'cleans up prompts key when last prompt is removed', async () => {
        await FlowMcpCli.promptRemove( { group: 'test-group', name: 'to-keep', cwd: removeCwd } )

        const configContent = await readFile( removeConfigPath, 'utf-8' )
        const config = JSON.parse( configContent )

        expect( config[ 'groups' ][ 'test-group' ][ 'prompts' ] ).toBeUndefined()
    } )
} )
