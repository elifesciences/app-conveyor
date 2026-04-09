import { loadConfig } from "./src/config";
import { Engine } from "./src/engine";
import { Reconciler } from "./src/reconciler";
import { createServer } from "./src/server";
import type { PipelineConfig } from "./src/types";

const watchNamespace = process.env.WATCH_NAMESPACE;

// Shared maps — populated by static config first, then by the CRD reconciler.
// Passing these by reference means the server always sees the live union.
const pipelines = new Map<string, PipelineConfig>();
const pollers = new Map<string, () => Promise<void>>();
const packagePollers = new Map<
  string,
  (commitPrefix: string) => Promise<void>
>();
const reservedIds = new Set<string>();

// ── Static config (YAML) ──────────────────────────────────────────────────────
// Loaded first so that reserved IDs are registered before the reconciler starts.
// Returns null when conveyor.yaml is absent and CONFIG_PATH is not set.
const cfg = await loadConfig();
if (cfg) {
  for (const pipeline of cfg.pipelines) {
    const engine = new Engine(pipeline);
    reservedIds.add(pipeline.id);
    pipelines.set(pipeline.id, pipeline);
    pollers.set(pipeline.id, () => engine.poll());
    packagePollers.set(pipeline.id, (commitPrefix) =>
      engine.pollPackage(commitPrefix),
    );
    engine.start();
  }
}

// ── CRD reconciler ────────────────────────────────────────────────────────────
// Active when WATCH_NAMESPACE is set. Appends to the shared maps; skips any
// pipeline ID already reserved by static config.
let reconciler: Reconciler | null = null;
if (watchNamespace) {
  const namespaces = watchNamespace
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  reconciler = new Reconciler(namespaces, undefined, undefined, {
    pipelines,
    pollers,
    packagePollers,
    reservedIds,
  });
  await reconciler.start();
}

if (!cfg && !watchNamespace) {
  console.error(
    "[startup] No config source active. Provide conveyor.yaml, set CONFIG_PATH, or set WATCH_NAMESPACE.",
  );
  process.exit(1);
}

// ── Server ────────────────────────────────────────────────────────────────────
createServer(pipelines, pollers, packagePollers);

const shutdown = () => {
  reconciler?.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
