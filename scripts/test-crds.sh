#!/usr/bin/env bash
# Integration test: applies crds/pipeline.yaml to a temporary KinD cluster and
# verifies that valid and invalid Pipeline resources are accepted/rejected.
#
# Usage:
#   bun run test:crds
#
# Requires: Docker running, kind (installed via mise)

set -euo pipefail

CLUSTER_NAME="conveyor-crd-test"
KUBECONFIG="/tmp/kubeconfig-${CLUSTER_NAME}"
CRD_NAME="pipelines.app-conveyor.elifesciences.org"
PASS=0
FAIL=0

KIND="$(mise which kind)"
KUBECTL="kubectl --kubeconfig ${KUBECONFIG}"

# ─── Helpers ──────────────────────────────────────────────────────────────────

ok() {
  echo "  ✓ $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "  ✗ $1"
  echo "    $2"
  FAIL=$((FAIL + 1))
}

assert_accepted() {
  local description="$1"
  local manifest="$2"
  if echo "$manifest" | $KUBECTL apply -f - &>/dev/null; then
    ok "$description"
  else
    fail "$description" "expected kubectl apply to succeed but it failed"
  fi
}

assert_rejected() {
  local description="$1"
  local manifest="$2"
  if echo "$manifest" | $KUBECTL apply -f - &>/dev/null; then
    fail "$description" "expected kubectl apply to fail but it succeeded"
  else
    ok "$description"
  fi
}

# ─── Cluster lifecycle ────────────────────────────────────────────────────────

echo "Creating KinD cluster \"${CLUSTER_NAME}\"..."
"$KIND" create cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG" 2>&1 | tail -1

cleanup() {
  echo "Deleting KinD cluster \"${CLUSTER_NAME}\"..."
  "$KIND" delete cluster --name "$CLUSTER_NAME" --kubeconfig "$KUBECONFIG" 2>/dev/null || true
  rm -f "$KUBECONFIG"
}
trap cleanup EXIT

# ─── Install CRD ─────────────────────────────────────────────────────────────

echo "Applying CRD..."
$KUBECTL apply -f crds/pipeline.yaml

echo "Waiting for CRD to be Established..."
$KUBECTL wait --for=condition=Established --timeout=30s "crd/${CRD_NAME}"

# ─── Tests ───────────────────────────────────────────────────────────────────

echo ""
echo "Running tests..."

# CRD is present
if $KUBECTL get crd "$CRD_NAME" &>/dev/null; then
  ok "CRD is present in cluster"
else
  fail "CRD is present in cluster" "kubectl get crd returned non-zero"
fi

# Valid Pipeline
assert_accepted "valid Pipeline resource is accepted" "
apiVersion: app-conveyor.elifesciences.org/v1alpha1
kind: Pipeline
metadata:
  name: valid-pipeline
  namespace: default
spec:
  name: Valid Pipeline
  steps:
    - id: src
      type: git
      repo: my-org/my-app
      branch: main
    - id: ci
      type: gha
      repo: my-org/my-app
      workflow: ci.yaml
"

# Unknown step type
assert_rejected "Pipeline with unknown step type is rejected" "
apiVersion: app-conveyor.elifesciences.org/v1alpha1
kind: Pipeline
metadata:
  name: bad-step-type
  namespace: default
spec:
  name: Bad Pipeline
  steps:
    - id: src
      type: not-a-real-type
"

# Missing required spec.name
assert_rejected "Pipeline missing required spec.name is rejected" "
apiVersion: app-conveyor.elifesciences.org/v1alpha1
kind: Pipeline
metadata:
  name: missing-name
  namespace: default
spec:
  steps:
    - id: src
      type: git
      repo: my-org/my-app
      branch: main
"

# Empty steps array
assert_rejected "Pipeline with empty steps array is rejected" "
apiVersion: app-conveyor.elifesciences.org/v1alpha1
kind: Pipeline
metadata:
  name: no-steps
  namespace: default
spec:
  name: Empty Pipeline
  steps: []
"

# Unknown spec field — Kubernetes uses strict decoding for CRDs with structural
# schemas, so unknown fields are rejected by the API server.
assert_rejected "Pipeline with unknown spec field is rejected" "
apiVersion: app-conveyor.elifesciences.org/v1alpha1
kind: Pipeline
metadata:
  name: extra-field
  namespace: default
spec:
  name: Extra Pipeline
  unknownField: should-fail
  steps:
    - id: src
      type: git
      repo: my-org/my-app
      branch: main
"

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
echo ""

[ "$FAIL" -eq 0 ]
