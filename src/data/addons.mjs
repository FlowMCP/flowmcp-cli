/**
 * FlowMCP — MIT License
 *
 * DISCLAIMER: This code orchestrates calls to third-party APIs. Each API has
 * its own Terms of Services. FlowMCP makes no representation about TOS
 * compliance, data licensing, or fitness for any purpose. Users are solely
 * responsible for reviewing and adhering to each API provider's terms.
 *
 * For more information, see LICENSE.md and DISCLAIMER.md in the repo root.
 */

/**
 * ADDON_REGISTRY — hardcoded V1 lookup map for FlowMCP resource add-ons.
 *
 * Maps a `source` value (e.g. `sqlite-gtfs`) to the implementing add-on package.
 *
 * Memo 051 REV-04 — Kap. 5.4 (hardcoded lookup, `github:` pattern, NO NPM),
 * Kap. 7.4 (add-on import is NOT npm).
 *
 * Entry format:
 *   key:               Source value as it appears in `main.resources[].source`
 *   value.name:        Add-on package name (matches package.json dependency key)
 *   value.source:      GitHub source path (NO npm) — `github:Owner/Repo`
 *   value.defaultVersion: Default version / branch reference for `github:` URLs
 *   value.urlMode:     Whether the source supports `mode: 'url'` (Memo 096 —
 *                      fetch a complete GeoJSON/CSV in one request, hold it in
 *                      memory). `sqlite-gtfs` is file-based only (urlMode false).
 *
 * Local development may use `file:../<addon>` in package.json. Production
 * pinning happens via `github:FlowMCP/<addon>#<version>` (see PRD-16 loader).
 */
const ADDON_REGISTRY = {
    'sqlite-gtfs': {
        // `name` = the package's own name (geo-gtfs-toolkit); the loader imports
        // by `name`. The GitHub repo keeps its original name (not renamed).
        'name': 'geo-gtfs-toolkit',
        'source': 'github:FlowMCP/gtfs-sqlite-toolkit',
        'defaultVersion': 'main',
        'urlMode': false
    },
    'geo-geojson': {
        'name': 'geo-geojson-toolkit',
        'source': 'github:FlowMCP/geojson-sqlite-toolkit',
        'defaultVersion': 'main',
        'urlMode': true
    },
    'geo-csv': {
        'name': 'geo-csv-tsv-toolkit',
        'source': 'github:FlowMCP/csv-tsv-sqlite-toolkit',
        'defaultVersion': 'main',
        'urlMode': true
    },
    'geo-overpass': {
        // Live-Query add-on (Memo 100). New repo, already named to the geo-*
        // standard, so `name` matches the published package directly (no held
        // legacy name). Live HTTP source — not url/file based, urlMode false.
        'name': 'geo-overpass-toolkit',
        'source': 'github:FlowMCP/geo-overpass-toolkit',
        'defaultVersion': 'main',
        'urlMode': false
    }
}


export { ADDON_REGISTRY }
