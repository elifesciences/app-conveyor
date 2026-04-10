# App Conveyor

A deployment pipeline tracker for GitOps workflows. It monitors commits from a source repository through each stage of delivery — CI build, container image push, Flux CD reconciliation, Kubernetes rollout — and surfaces the status of every commit in a web UI.

## Key concepts

- **Pipeline** — a named sequence of steps defined in `conveyor.yaml`
- **Package** — a tracked commit moving through a pipeline, identified by `{pipelineId}:{commitHash}`
- **Step** — a single stage in a pipeline (git, gha, ghcr, gh-pr, flux-image, flux-kustomize, k8s-deploy)
- **Upstream** — outputs from passed steps (commitHash, imageTag, imageDigest, etc.) propagated to downstream steps

## Architecture

| File | Purpose |
|---|---|
| `index.ts` | Entry point — loads config, starts engines, starts server |
| `src/engine.ts` | Polling loop — discovers commits, advances packages through steps |
| `src/db.ts` | SQLite persistence — packages, step states, step history |
| `src/migrations.ts` | Schema migration runner — runs pending migrations on startup |
| `src/server.ts` | HTTP server — UI routes and sync endpoints |
| `src/render.ts` | Server-side HTML rendering |
| `src/config.ts` | YAML config loading and Zod validation |
| `src/schemas.ts` | Zod schemas for pipeline config — single source of truth for types and CRD shape |
| `src/kube.ts` | Kubernetes client with Bun TLS workaround |
| `src/reconciler.ts` | CRD watcher — lists and watches Pipeline CRs, manages engine lifecycle |
| `src/modules/` | One file per step type |
| `scripts/gen-crds.ts` | Generates `crds/pipeline.yaml` from Zod schemas — run `bun run gen-crds` after schema changes |
| `crds/pipeline.yaml` | Committed CRD manifest — always regenerate and commit alongside schema changes |

The engine polls each pipeline on a configurable interval. Each poll discovers new commits (git step) and advances all in-progress packages by calling the appropriate module for each step in sequence. A step returning `pending` or `running` stops advancement for that package until the next poll.

## Database migrations

Schema changes go in `src/migrations.ts` as numbered entries in the `migrations` array. Rules:

- **Append only** — never edit or reorder existing entries; each version number must be stable
- `config_snapshot` in the `packages` table is **write-once** — set at package creation, intentionally excluded from the `ON CONFLICT DO UPDATE` in `upsertPackage`. Do not add it to the UPDATE clause.
- `advancePackage` uses `pkg.configSnapshot ?? this.cfg` so that in-flight packages continue with the config they were created under. The `?? this.cfg` fallback is intentional for packages that pre-date the snapshot column — do not remove it.
- **Additive where possible** — prefer `ALTER TABLE ... ADD COLUMN` with a default over destructive changes
- Migration 1 is the initial schema and uses `CREATE TABLE IF NOT EXISTS` so it is safe to run against databases that existed before the migration system was introduced; subsequent migrations should use plain `CREATE TABLE`

## Bun

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of jest or vitest
- Use `bun install` instead of npm/yarn/pnpm
- Use `bun run <script>` instead of npm/yarn/pnpm run
- Use `bunx <package>` instead of npx
- Bun automatically loads `.env` — don't use dotenv
- `Bun.serve()` for the HTTP server — don't use express
- `bun:sqlite` for SQLite — don't use better-sqlite3
- `Bun.file` instead of `node:fs` readFile/writeFile

## Testing

Run `bun run check` after any code change. This runs `biome check`, `tsc --noEmit`, and `bun test`. All three must pass before a task is considered complete.

```ts
import { test, expect } from "bun:test";

test("example", () => {
  expect(1).toBe(1);
});
```

## UI

The frontend is server-side rendered HTML only — plain string templates in `src/render.ts`. Do not add client-side JavaScript: no `<script>` tags, no inline event handlers, no `fetch()` from the browser. Use `<form method="POST">` for actions and HTTP 303 redirects from the server.

## Watch TLS

`k8s.Watch` in `@kubernetes/client-node` v1.x imports `node-fetch` directly (`import fetch from 'node-fetch'`), bypassing both `globalThis.fetch` and the `wrapHttpLibrary` mechanism used for API clients. In Bun, `node-fetch` does not forward the `https.Agent`'s TLS options, so the cluster CA is never applied — causing `unable to verify the first certificate` errors.

The fix is to bypass `k8s.Watch` entirely. `kube.ts` exports `startKubeWatch()`, which implements the same streaming watch loop using `globalThis.fetch` (which is patched by `installBunFetchTLSPatch()` to forward agent TLS options via Bun's `tls` fetch option). It calls `kc.applyToFetchOptions()` to obtain the auth headers and agent, then reads the response body as a `ReadableStream`, splitting on newlines and JSON-parsing each event.

`reconciler.ts` uses `startKubeWatch` instead of `new k8s.Watch(...)`.

The test script `scripts/test-reconciler.sh` passes `KUBECONFIG` to the app process; the patch picks up the CA from the kubeconfig agent automatically, so no `NODE_EXTRA_CA_CERTS` workaround is needed.

## Kubernetes TLS

Bun's `fetch()` ignores `https.Agent`, so the standard Node.js mechanism for injecting CA certs does not work. This is already solved in `src/kube.ts` using `wrapHttpLibrary` from `@kubernetes/client-node`, which extracts the CA/cert/key from the agent and passes them via Bun's non-standard `tls` fetch option. Do not reach for `NODE_EXTRA_CA_CERTS` or process re-exec as a solution to Kubernetes TLS issues.

## GitHub API

Fine-grained PATs cannot access organisation-owned packages via the GitHub Packages API — this is a GitHub platform limitation. A classic PAT with `read:packages` and `repo` scopes is required for any pipeline that uses the `ghcr` step against org-owned images.

## Reconciler and config modes

Both config sources can be active simultaneously. `index.ts` starts each source independently:

- **Static config** (`conveyor.yaml` or `CONFIG_PATH`) — loaded first at startup via `loadConfig()`, which returns `null` if the file is absent (not an error). Engines are created once and never change at runtime. Their IDs are registered as `reservedIds`.
- **CRD watch** (`WATCH_NAMESPACE` set) — `Reconciler` lists existing Pipeline CRs then watches for changes, starting/stopping/restarting engines dynamically. Reserved IDs are passed to the reconciler; ADDED/MODIFIED/DELETED events for those IDs are silently ignored so static config always wins.

Both sources write into the same shared `pipelines`, `pollers`, and `packagePollers` maps, which are passed by reference to `createServer` so it always sees the live union. At least one source must be active; the process exits with an error if neither is configured.

`WATCH_NAMESPACE` accepts comma-separated namespaces (e.g. `default,staging`) or `*` for all namespaces. `*` uses the cluster-scoped watch path (`/apis/{group}/{version}/{plural}`) and requires a `ClusterRoleBinding`; named namespaces can use per-namespace `RoleBinding`s.

## CRD schema generation

When changing `src/schemas.ts`, the full workflow is:
1. `bun run gen-crds` — regenerate `crds/pipeline.yaml`
2. `bun run test:crds` — verify the CRD against a real KinD cluster (requires Docker)
3. `bun run check` — unit tests and type check
4. Commit the schema change and the updated `crds/pipeline.yaml` together

`scripts/gen-crds.ts` derives the CRD `openAPIV3Schema` from the Zod schemas via `.toJSONSchema()`. Two K8s compatibility gotchas to be aware of:

- **`exclusiveMinimum`** — Zod v4's `.toJSONSchema()` emits JSON Schema 2020-12 (`exclusiveMinimum: <number>`), but K8s CRDs require OpenAPI 3.0 (`exclusiveMinimum: true` + `minimum: <number>`). Avoid `.positive()` and `.gt(n)` on integer fields; use `.min(n+1)` instead, which generates a plain `minimum` constraint that K8s accepts.
- **`additionalProperties` + `properties`** — K8s structural schemas forbid both at the same level. `gen-crds.ts` strips all `additionalProperties` after generation. Unknown fields are still rejected — K8s uses strict decoding for CRDs, so unknown fields cause a `BadRequest` error rather than being silently pruned.

## Known gotcha: image tag hash matching

Image tags often embed the commit hash with a `g` prefix (trunkver format: `{timestamp}-g{hash}-{runId}`). A segment-based `startsWith(hash)` check will never match. Use `includes(shortHash)` where `shortHash = imageTag.slice(0, 7)`. This affects ghcr tag matching, flux-image comparison, and k8s-deploy image confirmation — all already handled, but watch for it in any new tag comparison code.
