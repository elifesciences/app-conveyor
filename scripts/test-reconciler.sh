#!/usr/bin/env bash
# Smoke test: verifies the reconciler picks up Pipeline CRs from a real KinD cluster.
#
# Usage:
#   GITHUB_TOKEN=<token> bun run test:reconciler
#
# Requires: Docker running, kind (installed via mise), GITHUB_TOKEN

set -euo pipefail

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "GITHUB_TOKEN not set — skipping reconciler smoke test"
  exit 0
fi

CLUSTER_NAME="conveyor-reconciler-test"
KUBECONFIG="/tmp/kubeconfig-${CLUSTER_NAME}"
LOG_FILE="/tmp/conveyor-reconciler-test.log"
APP_PID=""

KIND="$(mise which kind)"
KUBECTL="kubectl --kubeconfig ${KUBECONFIG}"

# ─── Helpers ──────────────────────────────────────────────────────────────────

ok() {
  echo "  ✓ $1"
}

fail() {
  echo "  ✗ $1"
  echo "    $2"
}

# ─── Cluster lifecycle ────────────────────────────────────────────────────────

echo "Creating KinD cluster \"${CLUSTER_NAME}\"..."
"$KIND" create cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG" 2>&1 | tail -1

cleanup() {
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  echo "Deleting KinD cluster \"${CLUSTER_NAME}\"..."
  "$KIND" delete cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG" 2>/dev/null || true
  rm -f "$KUBECONFIG" "$LOG_FILE" "/tmp/conveyor-kind-ca.crt"
}
trap cleanup EXIT

# ─── Install CRD + example Pipeline CR ───────────────────────────────────────

echo "Applying CRD..."
$KUBECTL apply -f crds/pipeline.yaml
$KUBECTL wait --for=condition=Established --timeout=30s \
  "crd/pipelines.app-conveyor.elifesciences.org"

echo "Applying example Pipeline CR..."
$KUBECTL apply -f k8s/example-pipeline.yaml

# ─── Start app in reconciler mode ─────────────────────────────────────────────

echo "Starting app-conveyor in reconciler mode..."

# k8s.Watch uses Node.js https.request directly, which doesn't pick up the CA
# from the kubeconfig agent the same way Bun's fetch() does. Extract the KinD
# CA cert and pass it via NODE_EXTRA_CA_CERTS so the Watch can verify TLS.
CA_CERT_FILE="/tmp/conveyor-kind-ca.crt"
$KUBECTL config view --raw \
  -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' \
  | base64 -d > "$CA_CERT_FILE"

KUBECONFIG="$KUBECONFIG" WATCH_NAMESPACE="default" NODE_EXTRA_CA_CERTS="$CA_CERT_FILE" \
  bun run index.ts >"$LOG_FILE" 2>&1 &
APP_PID=$!

# ─── Tests ───────────────────────────────────────────────────────────────────

echo ""
echo "Running tests..."

PASS=0
FAIL=0

# Wait for the reconciler to process the Pipeline CR. Accept either outcome:
#   "starting engine"  — when no static config reserves the ID
#   "skipping"         — when a conveyor.yaml reserves the same pipeline ID
TIMEOUT=30
FOUND=false
for i in $(seq 1 "$TIMEOUT"); do
  if grep -qE "\[reconciler\] (starting engine for|skipping) default/app-conveyor" \
      "$LOG_FILE" 2>/dev/null; then
    FOUND=true
    break
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    break
  fi
  sleep 1
done

if $FOUND; then
  ok "reconciler picked up Pipeline CR (started or reserved by static config)"
  PASS=$((PASS + 1))
else
  fail "reconciler did not process Pipeline CR within ${TIMEOUT}s" "check log: ${LOG_FILE}"
  FAIL=$((FAIL + 1))
  echo ""
  echo "Log output:"
  cat "$LOG_FILE" 2>/dev/null || true
fi

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
echo ""

[ "$FAIL" -eq 0 ]
