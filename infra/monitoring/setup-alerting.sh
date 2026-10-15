#!/usr/bin/env bash
#
# Paralegix — breach-detection alerting setup for Google Cloud.
#
# Builds the chain:  backend logs (pino, structured JSON)
#                  → Cloud Logging (already automatic from Cloud Run)
#                  → log-based metrics (created here)
#                  → alert policies (created here)
#                  → a notification channel (email, created here).
#
# Each metric counts log entries whose `jsonPayload.event` matches one of the
# security events emitted by backend/src/shared/utils/securityLog.js. Keep the
# EVENT names below in sync with that taxonomy.
#
# COST: at a small-SaaS scale this is free. Alert policies + notifications are
# free. Log ingestion has a 50 GiB/project/month free tier and we only log
# failures + sensitive actions (low volume). Metrics are kept LABEL-FREE on
# purpose — we never promote `ip`/`actorUid` to a metric label (that would
# explode cardinality during an attack and could cost money). Identity lives in
# the log entry; when an alert fires you pivot to Logs Explorer to see who.
# Still: set a billing budget alert on the project as a backstop.
#
# USAGE:
#   1. Install + auth the gcloud CLI:  gcloud auth login
#   2. Edit the two variables below (PROJECT_ID, ALERT_EMAIL).
#   3. Run:  bash infra/monitoring/setup-alerting.sh
#
# Safe to re-run: metric creation is skipped if the metric already exists, and
# the script tells you which policies already exist rather than duplicating.

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# CONFIG — edit these.
# ─────────────────────────────────────────────────────────────────────────────
PROJECT_ID="${PROJECT_ID:-CHANGE_ME}"          # e.g. paralegix-prod
ALERT_EMAIL="${ALERT_EMAIL:-CHANGE_ME}"        # where alerts are delivered

# The Cloud Run service name (used to scope metrics to the backend only). If you
# leave this empty the metrics count matching events across the whole project.
CLOUD_RUN_SERVICE="${CLOUD_RUN_SERVICE:-}"

# ─────────────────────────────────────────────────────────────────────────────
if [[ "$PROJECT_ID" == "CHANGE_ME" || "$ALERT_EMAIL" == "CHANGE_ME" ]]; then
  echo "ERROR: edit PROJECT_ID and ALERT_EMAIL at the top of this script first." >&2
  exit 1
fi

echo "Using project: $PROJECT_ID"
gcloud config set project "$PROJECT_ID" >/dev/null

# Scope clause appended to every metric filter. Limits counting to backend logs.
RESOURCE_FILTER='resource.type="cloud_run_revision"'
if [[ -n "$CLOUD_RUN_SERVICE" ]]; then
  RESOURCE_FILTER="$RESOURCE_FILTER AND resource.labels.service_name=\"$CLOUD_RUN_SERVICE\""
fi

# ─────────────────────────────────────────────────────────────────────────────
# 1. Notification channel (email). Reused if one already exists for this address.
# ─────────────────────────────────────────────────────────────────────────────
echo "==> Ensuring email notification channel for $ALERT_EMAIL"
CHANNEL_ID="$(gcloud beta monitoring channels list \
  --filter="type=email AND labels.email_address=$ALERT_EMAIL" \
  --format="value(name)" | head -n1 || true)"

if [[ -z "$CHANNEL_ID" ]]; then
  CHANNEL_ID="$(gcloud beta monitoring channels create \
    --display-name="Paralegix security alerts" \
    --type=email \
    --channel-labels="email_address=$ALERT_EMAIL" \
    --format="value(name)")"
  echo "    created channel: $CHANNEL_ID"
else
  echo "    reusing channel: $CHANNEL_ID"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. Log-based counter metrics. One per security event. Label-free by design.
# ─────────────────────────────────────────────────────────────────────────────
create_metric () {
  local name="$1" event="$2" desc="$3"
  if gcloud logging metrics describe "$name" >/dev/null 2>&1; then
    echo "    metric exists: $name"
    return
  fi
  gcloud logging metrics create "$name" \
    --description="$desc" \
    --log-filter="$RESOURCE_FILTER AND jsonPayload.event=\"$event\"" >/dev/null
  echo "    created metric: $name"
}

echo "==> Creating log-based metrics"
create_metric paralegix_auth_failed   "auth.failed"   "Failed token verifications (credential stuffing / brute force signal)"
create_metric paralegix_authz_denied  "authz.denied"  "403 permission denials (authz-probing / IDOR-hunting signal)"
create_metric paralegix_server_error  "server.error"  "Unhandled server errors (5xx)"
create_metric paralegix_data_export   "data.export"   "Personal-data / billing exports"
create_metric paralegix_data_erasure  "data.erasure"  "Account / client data erasures"
create_metric paralegix_admin_action  "admin.action"  "Privileged admin mutations"

# ─────────────────────────────────────────────────────────────────────────────
# 3. Alert policies. Thresholds are STARTING POINTS — tune after a week of real
#    traffic (see the tuning notes at the bottom). Each policy sums the metric
#    over a 5-minute window and fires when the sum exceeds the threshold.
# ─────────────────────────────────────────────────────────────────────────────
create_policy () {
  local display="$1" metric="$2" threshold="$3" aligner="$4"
  if gcloud alpha monitoring policies list \
       --filter="displayName=\"$display\"" --format="value(name)" | grep -q .; then
    echo "    policy exists: $display"
    return
  fi
  local tmp; tmp="$(mktemp)"
  cat > "$tmp" <<JSON
{
  "displayName": "$display",
  "combiner": "OR",
  "conditions": [{
    "displayName": "$display condition",
    "conditionThreshold": {
      "filter": "metric.type=\"logging.googleapis.com/user/$metric\" AND resource.type=\"cloud_run_revision\"",
      "aggregations": [{
        "alignmentPeriod": "300s",
        "perSeriesAligner": "$aligner",
        "crossSeriesReducer": "REDUCE_SUM"
      }],
      "comparison": "COMPARISON_GT",
      "thresholdValue": $threshold,
      "duration": "0s",
      "trigger": { "count": 1 }
    }
  }],
  "notificationChannels": ["$CHANNEL_ID"],
  "documentation": {
    "content": "Paralegix security alert: $display. Open Logs Explorer and filter jsonPayload.event to see the offending actor/IP, then follow SECURITY_INCIDENT_RESPONSE.md.",
    "mimeType": "text/markdown"
  }
}
JSON
  gcloud alpha monitoring policies create --policy-from-file="$tmp" >/dev/null
  rm -f "$tmp"
  echo "    created policy: $display"
}

echo "==> Creating alert policies"
# ALIGN_DELTA sums counter increments within the alignment period.
create_policy "Paralegix: auth failure spike"       paralegix_auth_failed  20  ALIGN_DELTA
create_policy "Paralegix: permission-denied spike"   paralegix_authz_denied 30  ALIGN_DELTA
create_policy "Paralegix: server error spike"        paralegix_server_error 25  ALIGN_DELTA
create_policy "Paralegix: data export activity"      paralegix_data_export  10  ALIGN_DELTA
create_policy "Paralegix: data erasure"              paralegix_data_erasure 0   ALIGN_DELTA
create_policy "Paralegix: admin action"              paralegix_admin_action 0   ALIGN_DELTA

echo
echo "Done. Verify in the console:"
echo "  Monitoring → Alerting   (policies)"
echo "  Logging → Logs-based metrics   (metrics)"
echo
echo "TUNING NOTES"
echo "  - Thresholds above are per 5-minute window. Watch the first week and"
echo "    raise any policy that pages on normal traffic."
echo "  - 'data erasure' and 'admin action' fire on ANY occurrence (threshold 0)"
echo "    because they are rare and individually worth a look. If admin actions"
echo "    become routine, raise that threshold or narrow the metric filter."
echo "  - To see WHO triggered an alert, open Logs Explorer and query e.g.:"
echo "      jsonPayload.event=\"authz.denied\""
echo "    then read jsonPayload.actorUid / jsonPayload.ip on the entries."
echo "  - This covers the BACKEND only. Vercel (frontend) logs do not reach GCP."
echo "  - Backstop: set a billing budget alert on the project (Billing → Budgets)."
