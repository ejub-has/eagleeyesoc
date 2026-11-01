# Alert source integrations

Both sources push alerts to the generic webhook endpoint. Fixed values (the sources and mapping below) are Eagle Eye conventions; the payload keys are chosen by you in each source's body template. The samples in `docs/samples/` are illustrative, not captured from a live system.

## Common setup

1. In Eagle Eye, create an API token in the target tenant with the `alerts:write` scope (Settings, API tokens).
2. Choose the case template key that new alerts should use (for example `ransomware`, `bec`, `phishing`).
3. Endpoint (replace the host with the Azure-provided hostname):

```
POST https://<host>/api/tenants/<tenant>/webhooks/<source>?template=<key>&title_field=title&id_field=<id key>&group_field=<group key>
Authorization: Bearer <token>
Content-Type: application/json
```

- `title_field`, `id_field`, and `group_field` name top-level keys in the JSON body.
- Alerts with the same source and id are de-duplicated (HTTP 200, `duplicate: true`); alerts sharing a group key join the same open case.
- The whole body is stored as the raw alert payload.

## CrowdStrike Falcon Fusion SOAR (US-2)

Source name: `crowdstrike`. Create a Fusion workflow triggered by the detections you want, and add an HTTP request action:

- Method POST, URL as above with `source` = `crowdstrike`, `id_field=detection_id`, `group_field=host`.
- Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`.
- Body: a JSON object using the keys in `docs/samples/crowdstrike-fusion.json`, filling each value with the matching workflow variable from the action's variable picker. Confirm the exact variable names in your console.

Grouping by `host` puts all alerts for one host into one open case; use `detection_id` for the group instead if you want one case per detection.

## Elastic (Kibana, self-managed Enterprise)

Source name: `elastic`. In Kibana, create a Webhook connector, then attach it to each detection or alerting rule as an action:

- Method POST, URL as above with `source` = `elastic`, `id_field=alert_id`, `group_field=rule_id`.
- Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`. Kibana must be able to reach the intake hostname over HTTPS.
- Body: a Mustache template producing the keys in `docs/samples/elastic-kibana.json`, for example `{"title": "{{rule.name}}", "alert_id": "{{alert.id}}", "rule_id": "{{rule.id}}", "severity": "{{context.rule.severity}}", "reason": "{{context.reason}}", "rule_url": "{{rule.url}}"}`. Variable availability differs between rule types; check them in the action's variable list.

## Testing a source without the real system

```sh
curl -X POST "https://<host>/api/tenants/<tenant>/webhooks/crowdstrike?template=ransomware&title_field=title&id_field=detection_id&group_field=host" \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d @docs/samples/crowdstrike-fusion.json
```

Use synthetic data only in the proof of value.
