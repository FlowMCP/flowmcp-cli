#!/bin/bash
# Verifies that npm test does not contaminate ~/.flowmcp/.
# Memo 032 PRD-14.
set -e

cd "$(dirname "$0")/.."

echo "=== Scenario A: snapshot ~/.flowmcp/ before/after npm test ==="
BEFORE=$(mktemp)
AFTER=$(mktemp)
ls -laR ~/.flowmcp > "$BEFORE" 2>/dev/null || echo "(not exists)" > "$BEFORE"

echo "Running npm test..."
npm test --silent > /dev/null 2>&1 || true   # tolerate test exit code, we only care about isolation

ls -laR ~/.flowmcp > "$AFTER" 2>/dev/null || echo "(not exists)" > "$AFTER"

if diff -q "$BEFORE" "$AFTER" > /dev/null; then
    echo "OK: ~/.flowmcp/ unchanged"
else
    echo "FAIL: ~/.flowmcp/ was modified by tests"
    diff "$BEFORE" "$AFTER" | head -20
    rm "$BEFORE" "$AFTER"
    exit 1
fi
rm "$BEFORE" "$AFTER"

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
