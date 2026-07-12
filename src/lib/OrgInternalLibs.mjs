// Memo 152 / PRD-027 (doctor gap b) — deterministic classification of a requiredLibrary as an
// org-internal FlowMCP library (published only on GitHub, NOT on the npm registry) vs. a normal
// npm package. The install hint for a missing org-internal lib must be `github:FlowMCP/<repo>` —
// a bare `npm install <name>` would 404, because these packages are never published to npm
// (Auto-Memory "No NPM Registry"). The repo name equals the package name for every entry below.
//
// This is an EXPLICIT, documented list (No-Silent-Defaults, no guessing): the sources are the
// FlowMCP-org add-on repos pinned in this CLI's own package.json as `github:FlowMCP/...` deps
// (geo-* toolkits) plus the two org-internal libs that appear as schema requiredLibraries but are
// user-installed-only and thus not CLI deps (time-csv-toolkit, rpc-benchmark; project CLAUDE.md +
// PRD-027 gap-b examples). Add a new org-internal add-on here when it starts shipping as a
// requiredLibrary; anything not listed is treated as a plain npm package.
class OrgInternalLibs {
    static #orgInternal = new Set( [
        'geo-gtfs-toolkit',
        'geo-geojson-toolkit',
        'geo-csv-tsv-toolkit',
        'geo-dzt-toolkit',
        'geo-zhv-toolkit',
        'geo-idbridge-toolkit',
        'geo-overpass-toolkit',
        'time-csv-toolkit',
        'rpc-benchmark',
        'flowmcp-grading',
        'flowmcp'
    ] )


    static isOrgInternal( { lib } ) {
        const orgInternal = OrgInternalLibs.#orgInternal.has( lib )

        return { orgInternal }
    }


    // The exact token that follows `npm install --prefix <base>` for THIS lib: a
    // `github:FlowMCP/<repo>` URL for org-internal libs, the bare package name otherwise.
    static installTargetFor( { lib } ) {
        const { orgInternal } = OrgInternalLibs.isOrgInternal( { lib } )
        const installTarget = orgInternal === true ? `github:FlowMCP/${lib}` : lib

        return { installTarget }
    }


    // A plain object map { lib -> installTarget } for handing to core LibraryLoader.resolveExternal
    // ({ installTargets }) so the runtime LIB-001 throw shows the right per-lib install command.
    static buildInstallTargets( { libs } ) {
        const effectiveLibs = Array.isArray( libs ) ? libs : []
        const installTargets = {}

        effectiveLibs
            .forEach( ( lib ) => {
                const { installTarget } = OrgInternalLibs.installTargetFor( { lib } )
                installTargets[ lib ] = installTarget
            } )

        return { installTargets }
    }
}


export { OrgInternalLibs }
