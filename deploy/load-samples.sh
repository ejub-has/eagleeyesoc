#!/usr/bin/env bash
# Send the sample CrowdStrike and Elastic alerts to the local stack so the screens have data.
# Usage: deploy/load-samples.sh <API token with alerts:write> [tenant]
set -euo pipefail
cd "$(dirname "$0")/.."
token=${1:?usage: deploy/load-samples.sh <API token> [tenant]}
base="http://localhost:8000/api/tenants/${2:-detect-respond}/webhooks"
send() {
  curl -fsS -X POST "$base/$1" -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" --data @"$2"
  echo
}
# Opens a case; its tactic and technique fill the case's ATT&CK mapping.
send "crowdstrike?template=ransomware&id_field=detection_id&group_field=host" docs/samples/crowdstrike-fusion.json
# Waits in the Triage tab.
send "elastic?template=phishing&id_field=alert_id&triage=true" docs/samples/elastic-kibana.json
