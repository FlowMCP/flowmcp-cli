#!/bin/bash
# Verifies that npm test does not contaminate ~/.flowmcp/.
# Memo 032 PRD-14 (Scenario A/B) + Memo 068 PRD-004 (Scenario C: content hash).
set -e

cd "$(dirname "$0")/.."

echo "=== Scenario A: snapshot ~/.flowmcp/ before/after npm test ==="
BEFORE=$(mktemp)
AFTER=$(mktemp)
ls -laR ~/.flowmcp > "$BEFORE" 2>/dev/null || echo "(not exists)" > "$BEFORE"

# Scenario C: content hash of the global config.json (catches in-place rewrites
# that an `ls` listing diff would miss — same size/mtime can still differ).
hash_config() {
    if [ -f ~/.flowmcp/config.json ]; then
        shasum -a 256 ~/.flowmcp/config.json | awk '{print $1}'
    else
        echo "(no config.json)"
    fi
}
CONFIG_HASH_BEFORE=$(hash_config)

echo "Running npm test..."
npm test --silent > /dev/null 2>&1 || true   # tolerate test exit code, we only care about isolation

ls -laR ~/.flowmcp > "$AFTER" 2>/dev/null || echo "(not exists)" > "$AFTER"
CONFIG_HASH_AFTER=$(hash_config)

if diff -q "$BEFORE" "$AFTER" > /dev/null; then
    echo "OK: ~/.flowmcp/ unchanged (listing)"
else
    echo "FAIL: ~/.flowmcp/ was modified by tests"
    diff "$BEFORE" "$AFTER" | head -20
    rm "$BEFORE" "$AFTER"
    exit 1
fi
rm "$BEFORE" "$AFTER"

echo ""
echo "=== Scenario C: config.json content hash before/after npm test ==="
if [ "$CONFIG_HASH_BEFORE" = "$CONFIG_HASH_AFTER" ]; then
    echo "OK: config.json hash unchanged ($CONFIG_HASH_BEFORE)"
else
    echo "FAIL: config.json content changed during npm test"
    echo "  before: $CONFIG_HASH_BEFORE"
    echo "  after:  $CONFIG_HASH_AFTER"
    exit 1
fi

echo ""
echo "=== Scenario B: .test-home cleanup ==="
if [ -d .test-home ]; then
    REMAINING=$(find .test-home -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')
    if [ "$REMAINING" = "0" ]; then
        echo "OK: .test-home empty after run"
    else
        echo "WARN: .test-home contains $REMAINING leftover directories"
        find .test-home -mindepth 1 -maxdepth 1
    fi
else
    echo "OK: .test-home does not exist (fully cleaned)"
fi
