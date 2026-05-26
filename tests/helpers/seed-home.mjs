import { homedir } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'


// Memo 068 PRD-003 — test migration helper.
// Many CLI commands (validate, test, status, ...) call #requireInit() first
// and refuse to run without an initialized global config. Before isolation,
// these tests silently relied on the real (contaminated) ~/.flowmcp being
// initialized. Under the isolated home they must seed that precondition
// explicitly. homedir() resolves into <repo>/.test-home via the global mock.


async function seedInitializedGlobalConfig() {
    const globalConfigDir = join( homedir(), '.flowmcp' )
    await mkdir( globalConfigDir, { recursive: true } )

    const config = {
        'envPath': join( globalConfigDir, '.env' ),
        'flowmcpCore': {
            'version': '1.4.2',
            'commit': 'test-seed',
            'schemaSpec': '1.2.0'
        },
        'initialized': '2026-01-31T12:00:00.000Z'
    }

    await writeFile( join( globalConfigDir, 'config.json' ), JSON.stringify( config, null, 4 ), 'utf-8' )

    return { globalConfigDir, config }
}


export { seedInitializedGlobalConfig }
