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
 *
 * Local development may use `file:../<addon>` in package.json. Production
 * pinning happens via `github:FlowMCP/<addon>#<version>` (see PRD-16 loader).
 */
const ADDON_REGISTRY = {
    'sqlite-gtfs': {
        'name': 'gtfs-sqlite-toolkit',
        'source': 'github:FlowMCP/gtfs-sqlite-toolkit',
        'defaultVersion': 'main'
    }
}


export { ADDON_REGISTRY }
