#!/usr/bin/env node
import { parseArgs } from 'node:util'

import { FlowMcpCli } from './task/FlowMcpCli.mjs'
import { agentCommands, MODE_AGENT, MODE_DEVELOPMENT } from './data/config.mjs'


const args = parseArgs( {
    args: process.argv.slice( 2 ),
    allowPositionals: true,
    strict: false,
    options: {
        'route': { type: 'string' },
        'branch': { type: 'string' },
        'group': { type: 'string' },
        'tools': { type: 'string' },
        'help': { type: 'boolean', short: 'h' }
    }
} )

const { positionals, values } = args
const command = positionals[ 0 ]
const schemaPath = positionals[ 1 ]
const cwd = process.cwd()

const output = ( { result } ) => {
    process.stdout.write( JSON.stringify( result, null, 4 ) + '\n' )
}

const runAgentCommands = async () => {
    if( command === 'search' ) {
        const query = positionals[ 1 ]
        const { result } = await FlowMcpCli.search( { query } )
        output( { result } )

        return true
    }

    if( command === 'add' ) {
        const toolName = positionals[ 1 ]
        const { result } = await FlowMcpCli.add( { toolName, cwd } )
        output( { result } )

        return true
    }

    if( command === 'remove' ) {
        const toolName = positionals[ 1 ]
        const { result } = await FlowMcpCli.remove( { toolName, cwd } )
        output( { result } )

        return true
    }

    if( command === 'list' ) {
        const { result } = await FlowMcpCli.list( { cwd } )
        output( { result } )

        return true
    }

    if( command === 'call' ) {
        const subCommand = positionals[ 1 ]

        if( subCommand === 'list-tools' ) {
            const group = values[ 'group' ]
            const { result } = await FlowMcpCli.callListTools( { group, cwd } )
            output( { result } )

            return true
        }

        const toolName = subCommand
        const jsonArgs = positionals[ 2 ] || null
        const group = values[ 'group' ]
        const { result } = await FlowMcpCli.callTool( { toolName, jsonArgs, group, cwd } )
        output( { result } )

        return true
    }

    if( command === 'status' ) {
        const { result } = await FlowMcpCli.status( { cwd } )
        output( { result } )

        return true
    }

    if( command === 'run' ) {
        const group = values[ 'group' ]
        const { result } = await FlowMcpCli.run( { group, cwd } )

        if( !result[ 'status' ] ) {
            output( { result } )
            process.exit( 1 )
        }

        return true
    }

    if( command === 'mode' ) {
        const modeArg = positionals[ 1 ]

        if( !modeArg ) {
            const { result } = await FlowMcpCli.getMode( { cwd } )
            output( { result } )

            return true
        }

        const resolvedMode = modeArg === 'dev' ? MODE_DEVELOPMENT : modeArg
        const { result } = await FlowMcpCli.setMode( { 'mode': resolvedMode, cwd } )
        output( { result } )

        return true
    }

    return false
}

const runDevCommands = async () => {
    if( command === 'init' ) {
        await FlowMcpCli.init( { cwd } )

        return true
    }

    if( command === 'import' ) {
        const url = positionals[ 1 ]
        const branch = values[ 'branch' ] || 'main'
        const { result } = await FlowMcpCli.import( { url, branch } )
        output( { result } )

        return true
    }

    if( command === 'import-registry' ) {
        const registryUrl = positionals[ 1 ]
        const { result } = await FlowMcpCli.importRegistry( { registryUrl } )
        output( { result } )

        return true
    }

    if( command === 'schemas' ) {
        const { result } = await FlowMcpCli.schemas()
        output( { result } )

        return true
    }

    if( command === 'group' ) {
        const subCommand = positionals[ 1 ]
        const groupName = positionals[ 2 ]

        if( subCommand === 'append' ) {
            const tools = values[ 'tools' ]
            const { result } = await FlowMcpCli.groupAppend( { 'name': groupName, tools, cwd } )
            output( { result } )

            return true
        }

        if( subCommand === 'remove' ) {
            const tools = values[ 'tools' ]
            const { result } = await FlowMcpCli.groupRemove( { 'name': groupName, tools, cwd } )
            output( { result } )

            return true
        }

        if( subCommand === 'list' ) {
            const { result } = await FlowMcpCli.groupList( { cwd } )
            output( { result } )

            return true
        }

        if( subCommand === 'set-default' ) {
            const { result } = await FlowMcpCli.groupSetDefault( { 'name': groupName, cwd } )
            output( { result } )

            return true
        }

        await FlowMcpCli.help( { cwd } )

        return true
    }

    if( command === 'validate' ) {
        const group = values[ 'group' ]
        const { result } = await FlowMcpCli.validate( { schemaPath, cwd, group } )
        output( { result } )

        return true
    }

    if( command === 'test' ) {
        const subCommand = positionals[ 1 ]
        const route = values[ 'route' ]
        const group = values[ 'group' ]

        if( subCommand === 'project' ) {
            const { result } = await FlowMcpCli.test( { 'schemaPath': undefined, route, cwd, group, 'all': false } )
            output( { result } )

            return true
        }

        if( subCommand === 'user' ) {
            const { result } = await FlowMcpCli.test( { 'schemaPath': undefined, route, cwd, group, 'all': true } )
            output( { result } )

            return true
        }

        if( subCommand === 'single' ) {
            const filePath = positionals[ 2 ]
            const { result } = await FlowMcpCli.test( { 'schemaPath': filePath, route, cwd, group, 'all': false } )
            output( { result } )

            return true
        }

        await FlowMcpCli.help( { cwd } )

        return true
    }

    return false
}

const main = async () => {
    if( values[ 'help' ] || !command ) {
        const { result: { mode } } = await FlowMcpCli.getMode( { cwd } )
        if( mode === MODE_DEVELOPMENT ) {
            await FlowMcpCli.help( { cwd } )
        } else {
            await FlowMcpCli.helpAgent()
        }

        return
    }

    const { result: { mode } } = await FlowMcpCli.getMode( { cwd } )

    const agentHandled = await runAgentCommands()
    if( agentHandled ) {
        return
    }

    if( mode === MODE_DEVELOPMENT ) {
        const devHandled = await runDevCommands()
        if( devHandled ) {
            return
        }

        await FlowMcpCli.help( { cwd } )

        return
    }

    const result = {
        'status': false,
        'error': `Unknown command "${command}".`,
        'available': [ 'search', 'add', 'remove', 'list', 'call', 'status', 'mode' ],
        'fix': `Run: flowmcp --help`
    }

    output( { result } )
}

main()
    .catch( ( error ) => {
        if( error.name === 'ExitPromptError' ) {
            process.exit( 0 )
        }

        const result = { 'status': false, 'error': error.message }
        process.stdout.write( JSON.stringify( result, null, 4 ) + '\n' )
        process.exit( 1 )
    } )
