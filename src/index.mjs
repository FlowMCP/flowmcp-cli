#!/usr/bin/env node
import { parseArgs } from 'node:util'

import { FlowMcpCli } from './task/FlowMcpCli.mjs'


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

const main = async () => {
    if( values[ 'help' ] || !command ) {
        await FlowMcpCli.help( { cwd } )

        return
    }

    if( command === 'init' ) {
        await FlowMcpCli.init( { cwd } )

        return
    }

    if( command === 'import' ) {
        const url = positionals[ 1 ]
        const branch = values[ 'branch' ] || 'main'
        const { result } = await FlowMcpCli.import( { url, branch } )
        output( { result } )

        return
    }

    if( command === 'import-registry' ) {
        const registryUrl = positionals[ 1 ]
        const { result } = await FlowMcpCli.importRegistry( { registryUrl } )
        output( { result } )

        return
    }

    if( command === 'schemas' ) {
        const { result } = await FlowMcpCli.schemas()
        output( { result } )

        return
    }

    if( command === 'group' ) {
        const subCommand = positionals[ 1 ]
        const groupName = positionals[ 2 ]

        if( subCommand === 'append' ) {
            const tools = values[ 'tools' ]
            const { result } = await FlowMcpCli.groupAppend( { 'name': groupName, tools, cwd } )
            output( { result } )

            return
        }

        if( subCommand === 'remove' ) {
            const tools = values[ 'tools' ]
            const { result } = await FlowMcpCli.groupRemove( { 'name': groupName, tools, cwd } )
            output( { result } )

            return
        }

        if( subCommand === 'list' ) {
            const { result } = await FlowMcpCli.groupList( { cwd } )
            output( { result } )

            return
        }

        if( subCommand === 'set-default' ) {
            const { result } = await FlowMcpCli.groupSetDefault( { 'name': groupName, cwd } )
            output( { result } )

            return
        }

        await FlowMcpCli.help( { cwd } )

        return
    }

    if( command === 'validate' ) {
        const group = values[ 'group' ]
        const { result } = await FlowMcpCli.validate( { schemaPath, cwd, group } )
        output( { result } )

        return
    }

    if( command === 'test' ) {
        const subCommand = positionals[ 1 ]
        const route = values[ 'route' ]
        const group = values[ 'group' ]

        if( subCommand === 'project' ) {
            const { result } = await FlowMcpCli.test( { 'schemaPath': undefined, route, cwd, group, 'all': false } )
            output( { result } )

            return
        }

        if( subCommand === 'user' ) {
            const { result } = await FlowMcpCli.test( { 'schemaPath': undefined, route, cwd, group, 'all': true } )
            output( { result } )

            return
        }

        if( subCommand === 'single' ) {
            const filePath = positionals[ 2 ]
            const { result } = await FlowMcpCli.test( { 'schemaPath': filePath, route, cwd, group, 'all': false } )
            output( { result } )

            return
        }

        await FlowMcpCli.help( { cwd } )

        return
    }

    if( command === 'run' ) {
        const group = values[ 'group' ]
        const { result } = await FlowMcpCli.run( { group, cwd } )

        if( !result[ 'status' ] ) {
            output( { result } )
            process.exit( 1 )
        }

        return
    }

    if( command === 'call' ) {
        const subCommand = positionals[ 1 ]

        if( subCommand === 'list-tools' ) {
            const group = values[ 'group' ]
            const { result } = await FlowMcpCli.callListTools( { group, cwd } )
            output( { result } )

            return
        }

        const toolName = subCommand
        const jsonArgs = positionals[ 2 ] || null
        const group = values[ 'group' ]
        const { result } = await FlowMcpCli.callTool( { toolName, jsonArgs, group, cwd } )
        output( { result } )

        return
    }

    if( command === 'status' ) {
        const { result } = await FlowMcpCli.status( { cwd } )
        output( { result } )

        return
    }

    await FlowMcpCli.help( { cwd } )
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
