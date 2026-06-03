/**
 * POC schema for Memo 051 (sqlite-gtfs source-type integration).
 *
 * The `path` field uses the ${FLOWMCP_RESOURCES} variable which is
 * resolved at runtime by the CLI. For E2E tests, the suite sets
 * `process.env.FLOWMCP_RESOURCES` to a test-controlled directory and
 * places the synthetic-fixture DB there as `gtfs-de.db`. For live
 * usage, the user places a converted GTFS-DE SQLite under
 * `~/.flowmcp/resources/gtfs-de.db`.
 *
 * Memo 051 REV-04 — Kap. 3.2, Kap. 7.5, Kap. 9.1.
 */
export const schema = {
    namespace: 'gtfsde',
    name: 'gtfsde-transit-v2',
    version: '2.0.0',
    main: {
        resources: [
            {
                source: 'sqlite-gtfs',
                mode: 'file-based',
                path: '${FLOWMCP_RESOURCES}/gtfs-de.db',
                addon: 'geo-gtfs-toolkit',
                addonSource: 'github:FlowMCP/gtfs-sqlite-toolkit'
            }
        ]
    }
}
