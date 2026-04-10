import { Engine } from "./engine";
import { getKubeClient, startKubeWatch } from "./kube";
import type { PipelineConfig } from "./types";

const GROUP = "app-conveyor.elifesciences.org";
const VERSION = "v1alpha1";
const PLURAL = "pipelines";

interface PipelineCR {
  metadata: { name: string; namespace: string };
  spec: Omit<PipelineConfig, "id">;
}

// Minimal interface for the engine lifecycle operations the reconciler needs.
// Satisfied by Engine in production and by test fakes in tests.
export interface EngineHandle {
  start(): void;
  stop(): void;
  poll(): Promise<void>;
  pollPackage(commitPrefix: string): Promise<void>;
}

// Abstraction over the Kubernetes list and watch operations needed by the
// reconciler. Inject a fake in tests to avoid needing a real cluster.
export interface ReconcilerK8s {
  listNamespaced(namespace: string): Promise<unknown[]>;
  listAll(): Promise<unknown[]>;
  startWatch(
    path: string,
    onEvent: (type: string, obj: unknown) => void,
    onDone: (err?: unknown) => void,
  ): void;
}

function makeDefaultK8s(): ReconcilerK8s {
  return {
    async listNamespaced(namespace) {
      const list =
        await getKubeClient().customObjects.listNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace,
          plural: PLURAL,
        });
      return (list as { items?: unknown[] }).items ?? [];
    },
    async listAll() {
      const list = await getKubeClient().customObjects.listClusterCustomObject({
        group: GROUP,
        version: VERSION,
        plural: PLURAL,
      });
      return (list as { items?: unknown[] }).items ?? [];
    },
    startWatch(path, onEvent, onDone) {
      startKubeWatch(path, onEvent, onDone);
    },
  };
}

interface SharedMaps {
  pipelines?: Map<string, PipelineConfig>;
  pollers?: Map<string, () => Promise<void>>;
  packagePollers?: Map<string, (commitPrefix: string) => Promise<void>>;
  // IDs owned by a higher-priority source (e.g. static YAML config).
  // ADDED/MODIFIED/DELETED events for reserved IDs are ignored.
  reservedIds?: Set<string>;
}

export class Reconciler {
  private engines = new Map<string, EngineHandle>(); // key: "namespace/name"
  readonly pipelines: Map<string, PipelineConfig>;
  readonly pollers: Map<string, () => Promise<void>>;
  readonly packagePollers: Map<string, (commitPrefix: string) => Promise<void>>;
  private namespaces: string[];
  private stopped = false;
  private readonly k8s: ReconcilerK8s;
  private readonly createEngine: (cfg: PipelineConfig) => EngineHandle;
  private readonly reservedIds: Set<string>;

  constructor(
    namespaces: string[],
    k8s?: ReconcilerK8s,
    createEngine?: (cfg: PipelineConfig) => EngineHandle,
    shared?: SharedMaps,
  ) {
    this.namespaces = namespaces;
    this.k8s = k8s ?? makeDefaultK8s();
    this.createEngine = createEngine ?? ((cfg) => new Engine(cfg));
    this.pipelines = shared?.pipelines ?? new Map();
    this.pollers = shared?.pollers ?? new Map();
    this.packagePollers = shared?.packagePollers ?? new Map();
    this.reservedIds = shared?.reservedIds ?? new Set();
  }

  async start(): Promise<void> {
    if (this.namespaces.includes("*")) {
      const items = await this.k8s.listAll();
      for (const item of items) this.upsertEngine(item as PipelineCR);
      this.k8s.startWatch(
        `/apis/${GROUP}/${VERSION}/${PLURAL}`,
        this.onEvent,
        this.onWatchDone("all namespaces"),
      );
      console.log("[reconciler] watching all namespaces");
    } else {
      for (const namespace of this.namespaces) {
        const items = await this.k8s.listNamespaced(namespace);
        for (const item of items) this.upsertEngine(item as PipelineCR);
        this.k8s.startWatch(
          `/apis/${GROUP}/${VERSION}/namespaces/${namespace}/${PLURAL}`,
          this.onEvent,
          this.onWatchDone(namespace),
        );
      }
      console.log(
        `[reconciler] watching namespaces: ${this.namespaces.join(", ")}`,
      );
    }
  }

  stop(): void {
    this.stopped = true;
    for (const engine of this.engines.values()) engine.stop();
    this.engines.clear();
    this.pipelines.clear();
    this.pollers.clear();
    this.packagePollers.clear();
  }

  private onEvent = (type: string, obj: unknown): void => {
    const cr = obj as PipelineCR;
    if (type === "ADDED" || type === "MODIFIED") {
      this.upsertEngine(cr);
    } else if (type === "DELETED") {
      this.removeEngine(`${cr.metadata.namespace}/${cr.metadata.name}`);
    }
  };

  private onWatchDone(label: string): (err?: unknown) => void {
    return (err) => {
      if (this.stopped) return;
      if (err) {
        console.error(
          `[reconciler] watch ended with error in ${label}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
      setTimeout(() => this.start(), 5000);
    };
  }

  private upsertEngine(cr: PipelineCR): void {
    const key = `${cr.metadata.namespace}/${cr.metadata.name}`;
    if (this.reservedIds.has(cr.metadata.name)) {
      console.log(`[reconciler] skipping ${key} — owned by static config`);
      return;
    }
    const cfg: PipelineConfig = { id: cr.metadata.name, ...cr.spec };

    const existing = this.engines.get(key);
    if (existing) {
      existing.stop();
      console.log(`[reconciler] restarting engine for ${key}`);
    } else {
      console.log(`[reconciler] starting engine for ${key}`);
    }

    const engine = this.createEngine(cfg);
    this.engines.set(key, engine);
    this.pipelines.set(cr.metadata.name, cfg);
    this.pollers.set(cr.metadata.name, () => engine.poll());
    this.packagePollers.set(cr.metadata.name, (prefix) =>
      engine.pollPackage(prefix),
    );
    engine.start();
  }

  private removeEngine(key: string): void {
    const name = key.split("/")[1] ?? key;
    if (this.reservedIds.has(name)) {
      console.log(
        `[reconciler] ignoring delete for ${key} — owned by static config`,
      );
      return;
    }
    const engine = this.engines.get(key);
    if (engine) {
      engine.stop();
      this.engines.delete(key);
    }
    this.pipelines.delete(name);
    this.pollers.delete(name);
    this.packagePollers.delete(name);
    console.log(`[reconciler] removed engine for ${key}`);
  }
}
