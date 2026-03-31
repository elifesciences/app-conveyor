# App Conveyor

A deployment pipeline orchestrator that tracks commits from source code through to live Kubernetes deployment. It monitors each stage — GitHub Actions builds, container image pushes, Flux CD GitOps sync, and Kubernetes rollout — and gives a unified view of where every commit is in the pipeline.

## How it works

Pipelines are defined in a YAML config file. Each pipeline has a sequence of steps; App Conveyor polls each step and advances packages (identified by a commit hash) through the pipeline as each stage completes.

Supported step types:

- `git` — watches a GitHub branch for new commits
- `gha` — waits for a GitHub Actions workflow run to succeed
- `ghcr` — checks GitHub Container Registry for the built image
- `gh-pr` — tracks a Renovate PR that bumps the image tag, waits for it to merge
- `flux-image` — confirms Flux ImagePolicy has picked up the new tag
- `flux-kustomize` — verifies Flux Kustomization has reconciled the GitOps change
- `k8s-deploy` — checks the Kubernetes Deployment is fully rolled out with the right image

The web UI (port 3000 by default) shows all pipelines and packages with per-step status. A JSON API is also available at `/api/packages?pipeline=<id>`.

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

Create a `conveyor.yaml` config file. Example:

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

If the cluster uses a custom CA, set `NODE_EXTRA_CA_CERTS` to the certificate path, or App Conveyor will attempt to write the CA to `.kube-ca.pem` automatically.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `CONFIG_PATH` | `conveyor.yaml` | Path to the pipeline config file |
| `DB_PATH` | `conveyor.db` | Path to the SQLite database |
| `PORT` | `3000` | HTTP server port |
| `GITHUB_TOKEN` | — | GitHub PAT for API access (required for private repos and GHCR) |
| `NODE_EXTRA_CA_CERTS` | — | Path to custom CA certificate for Kubernetes TLS |

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
