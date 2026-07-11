/**
 * FlowMCP — MIT License
 *
 * CliOutput (Memo 152 PRD-017 / D-03) — the error-output leaf cluster extracted
 * from FlowMcpCli. Pure leaf: depends on nothing but Node's process.stderr and
 * the shared PREFIX-NNN error-code pattern. The CLI facade calls CliOutput.*
 * directly at every former #error / #emitCoded / #emitProgress / #splitErrorCode
 * / #extractErrorCode call-site.
 */

// Memo 149 Strang C — canonical PREFIX-NNN code shape (3-4 uppercase letters,
// 3-digit number). Every surfaced failure carries such a code; the doctor reads
// them back.
const ERROR_CODE_PATTERN = /^([A-Z]{3,4}-\d{3})/


class CliError extends Error {
    constructor( { code, severity = 'ERROR', source = null, message, originalError = null } ) {
        super( message )
        this.name = 'CliError'
        this.code = code
        this.severity = severity
        this.source = source
        this.originalError = originalError
    }
}


class CliOutput {
    static error( { error, fix, code = null, severity = null } ) {
        const result = { 'status': false, error }
        // Memo 149 Strang C — carry a machine-readable code (and optional severity) when
        // provided. If the caller passed no explicit code but the message already begins
        // with a PREFIX-NNN, surface that so coded messages self-describe.
        const derivedCode = code || CliOutput.extractErrorCode( { 'message': error } )
        if( derivedCode ) {
            result[ 'code' ] = derivedCode
        }
        if( severity ) {
            result[ 'severity' ] = severity
        }
        if( fix ) {
            result[ 'fix' ] = fix
        }

        return result
    }


    static extractErrorCode( { message } ) {
        if( typeof message !== 'string' ) {
            return null
        }

        const match = message.match( ERROR_CODE_PATTERN )

        return match ? match[ 1 ] : null
    }


    static emitCoded( { code, location, err } ) {
        const errCode = err && err.code
        const benignAbsence = errCode === 'ENOENT' || errCode === 'ENOTDIR'
        if( benignAbsence ) {
            return
        }

        const detail = err && err.message ? err.message : String( err )
        process.stderr.write( `${code} ${location}: ${detail}\n` )
    }


    static emitProgress( { quiet, message } ) {
        if( quiet === true ) { return }
        process.stderr.write( `[grading] ${message}\n` )
    }


    static splitErrorCode( { raw } ) {
        const match = raw.match( /^([A-Z]{2,}-\d{2,})(?::\s*)?(.*)$/ )
        if( match === null ) {
            return { 'code': null, 'message': raw.trim() }
        }

        return { 'code': match[ 1 ], 'message': match[ 2 ].trim() }
    }
}


export { CliOutput, CliError, ERROR_CODE_PATTERN }
