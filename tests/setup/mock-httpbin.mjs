/**
 * mock-httpbin.mjs — deterministic offline stand-in for https://httpbin.org
 *
 * Memo 096 / flowmcp-cli#65: many unit tests use `root: 'https://httpbin.org'`.
 * Hitting the live public service makes CI non-deterministic — when GitHub
 * Actions cannot reach httpbin fast enough, the tool calls exceed the 15s
 * timeout and the workflow goes red (it is NOT random — it is an external
 * dependency in a unit test). This setup intercepts global.fetch for any
 * httpbin.org URL and answers locally, so tests never touch the internet.
 *
 * Behaviour mirrors the httpbin endpoints the fixtures actually use:
 *   - /status/<code>  -> responds with exactly that HTTP status (error-path tests)
 *   - everything else -> 200 with an httpbin-style echo JSON body
 *
 * Non-httpbin URLs are delegated to the original fetch unchanged.
 */

const originalFetch = globalThis.fetch


const buildEchoBody = ( { url, method } ) => {
    let parsed = null
    try {
        parsed = new URL( url )
    } catch( e ) {
        parsed = null
    }

    const args = {}
    if( parsed ) {
        parsed.searchParams
            .forEach( ( value, key ) => {
                args[ key ] = value
            } )
    }

    const body = {
        args,
        headers: { 'Accept': 'application/json', 'Host': 'httpbin.org' },
        origin: '127.0.0.1',
        url,
        method
    }

    return body
}


const mockHttpbinFetch = async ( input, init = {} ) => {
    const url = typeof input === 'string' ? input : ( input && input.url ) || String( input )
    const isHttpbin = url.includes( 'httpbin.org' )

    if( !isHttpbin ) {
        return originalFetch( input, init )
    }

    const method = ( init && init.method ) || ( input && input.method ) || 'GET'

    const statusMatch = url.match( /\/status\/(\d{3})/ )
    if( statusMatch ) {
        const code = Number( statusMatch[ 1 ] )
        const text = JSON.stringify( { status: code, url } )

        return new Response( text, {
            status: code,
            headers: { 'content-type': 'application/json' }
        } )
    }

    const body = buildEchoBody( { url, method } )

    return new Response( JSON.stringify( body ), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    } )
}


globalThis.fetch = mockHttpbinFetch
