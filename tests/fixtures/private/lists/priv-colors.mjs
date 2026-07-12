// Memo 152 / PRD-021 (E-05) — the shared list resolved via `--lists-dir`. The
// filename is the kebab-case of the ref ("privColors" -> "priv-colors.mjs").
// List files are NOT scanned by the SecurityScanner (only the schema file is).

export const list = {
    meta: {
        name: 'privColors',
        version: '1.0.0',
        description: 'A tiny private color list for the private-call lists-dir test.',
        fields: [
            { key: 'name', type: 'string', optional: false }
        ],
        dependsOn: []
    },
    entries: [
        { name: 'red' },
        { name: 'green' },
        { name: 'blue' }
    ]
}
