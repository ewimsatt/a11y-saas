#!/bin/bash
set -euo pipefail

API_URL="http://localhost:3001"

echo "=== A11Y SaaS Smoke Test: First Scan Flow ==="
echo "Assumes: docker compose up, API+worker running, jq installed."

echo ""
echo "1. Creating project..."
PROJECT_ID=$(curl -s -X POST "${API_URL}/projects" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Smoke Test","baseUrl":"https://www.w3.org/WAI/demos/2019/color-contrast/"}' | jq -r '.id')

echo "Project ID: $PROJECT_ID"

echo ""
echo "2. Starting scan..."
SCAN_ID=$(curl -s -X POST "${API_URL}/scans/${PROJECT_ID}/run" \
  -H 'Content-Type: application/json' -d '{}' | jq -r '.scanId')

echo "Scan ID: $SCAN_ID"

echo ""
echo "3. Waiting for scan completion (poll issues, timeout 10min)..."
for i in {1..60}; do
  sleep 10
  ISSUES=$(curl -s "${API_URL}/scans/${SCAN_ID}/issues" | jq '.issues | length')
  if [ "$ISSUES" -gt 0 ]; then
    echo ""
    echo "✅ SUCCESS: Scan complete! Found ${ISSUES} issues."
    curl -s "${API_URL}/scans/${SCAN_ID}/issues" | jq '.issues[] | {id: .id, ruleId: .ruleId, severity: .severity}'
    exit 0
  fi
  echo "  Poll $i/60: waiting (issues: $ISSUES)..."
done

echo ""
echo "❌ TIMEOUT: No issues found after 10min. Check worker logs."
exit 1