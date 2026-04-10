# App Conveyor

A deployment pipeline orchestrator that tracks commits from source code through to live Kubernetes deployment. It monitors each stage — GitHub Actions builds, container image pushes, Flux CD GitOps sync, and Kubernetes rollout — and gives a unified view of where every commit is in the pipeline.

## How it works

Each pipeline has a sequence of steps; App Conveyor polls each step and advances packages (identified by a commit hash) through the pipeline as each stage completes.

Pipelines come from two sources that can run simultaneously:

- **Kubernetes CRDs** — create `Pipeline` custom resources in your cluster; App Conveyor watches them and starts/stops engines dynamically as CRs are added, updated, or deleted. Enabled by setting `WATCH_NAMESPACE`.
- **YAML config file** — define pipelines in `conveyor.yaml` (or `CONFIG_PATH`). Loaded once at startup; requires a restart to pick up changes. Enabled automatically when the file is present.

Both sources contribute to the same live pipeline list. If the same pipeline ID appears in both, the YAML definition takes precedence and the CRD is ignored — useful for ops-team-owned pipelines that should not be overridden by cluster resources.

Supported step types:

- `git` — watches a GitHub branch for new commits
- `gha` — waits for a GitHub Actions workflow run to succeed
- `ghcr` — checks GitHub Container Registry for the built image
- `gh-pr` — tracks a Renovate PR that bumps the image tag, waits for it to merge
- `flux-image` — confirms Flux ImagePolicy has picked up the new tag
- `flux-kustomize` — verifies Flux Kustomization has reconciled the GitOps change
- `k8s-deploy` — checks the Kubernetes Deployment is fully rolled out with the right image

The web UI (port 3000 by default) shows all pipelines and packages with per-step status. A JSON API is also available at `/api/packages?pipeline=<id>`.

When a newer commit fully deploys, any older commits that are still in-flight are automatically marked as **superseded** ("Old") and removed from the active polling set — they will never deploy since the system has moved past them.

### Package actions

Each package detail page exposes actions depending on its state:

- **Sync now** — triggers an immediate poll without waiting for the next interval. Only shown for active (in-progress) packages.
- **Retry** — resets all non-git steps to pending and re-runs the package using the config it was originally created with. Useful when a transient failure needs another attempt.
- **Reset with current config** — like Retry, but adopts the current pipeline configuration. Use this after a pipeline config change to re-run an in-flight package under the new config.

Retry and Reset are only available on the newest non-superseded package. Resetting an older package would never succeed — its steps would observe the current world state (newer image tags, newer revisions) rather than what that commit originally tracked, and the engine would supersede it again on the next poll.

## Prerequisites

This project uses [mise](https://mise.jdx.dev) to manage tool versions. Install mise, then run:

```bash
mise install
```

This will install the correct version of Bun automatically.

## Setup

```bash
bun install
```

### Enable CRD watching

Apply the CRD, create `Pipeline` resources in your cluster, then set `WATCH_NAMESPACE`:

```bash
kubectl apply -f crds/pipeline.yaml
kubectl apply -f k8s/example-pipeline.yaml   # or your own Pipeline CR
WATCH_NAMESPACE=default bun run index.ts
```

Use `WATCH_NAMESPACE=*` to watch all namespaces (requires cluster-level RBAC — see [docs/deployment.md](docs/deployment.md)).

### Enable static YAML pipelines

Create a `conveyor.yaml` file alongside (or instead of) CRD watching. Example:

```yaml
pipelines:
  - id: my-app
    name: My App
    pollIntervalMs: 60000
    steps:
      - id: source
        type: git
        repo: my-org/my-app
        branch: main
      - id: build
        type: gha
        repo: my-org/my-app
        workflow: build.yml
      - id: image
        type: ghcr
        image: ghcr.io/my-org/my-app
      - id: deploy
        type: k8s-deploy
        namespace: my-namespace
        deployment: my-app
```

## Kubernetes context

Any pipeline using `flux-image`, `flux-kustomize`, or `k8s-deploy` steps requires a valid kubeconfig with a current context pointing at the target cluster. App Conveyor uses the default kubeconfig discovery (`~/.kube/config`, `KUBECONFIG` env var, or in-cluster service account).


## Environment variables

| Variable | Default | Description |
|---|---|---|
| `WATCH_NAMESPACE` | — | Comma-separated namespace(s) to watch for Pipeline CRDs, or `*` for all namespaces. Omit to disable CRD watching. |
| `CONFIG_PATH` | — | Path to a static pipeline config file. If unset, `conveyor.yaml` is used when present. |
| `DB_PATH` | `conveyor.db` | Path to the SQLite database |
| `PORT` | `3000` | HTTP server port |
| `GITHUB_TOKEN` | — | GitHub PAT for API access (required for private repos and GHCR) |

## Running

```bash
bun run index.ts
```

For development with auto-reload:

```bash
bun run dev
```

## Checks

```bash
bun run check
```

Runs Biome linting, TypeScript type checking, and tests. All three must pass.
