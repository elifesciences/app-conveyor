import { expect, test } from "bun:test";
import {
  type EngineHandle,
  Reconciler,
  type ReconcilerK8s,
} from "../reconciler";
import type { PipelineConfig } from "../types";

// ─── Fakes ────────────────────────────────────────────────────────────────────

class FakeK8s implements ReconcilerK8s {
  readonly watchedPaths: string[] = [];
  private eventHandlers: Array<(type: string, obj: unknown) => void> = [];

  constructor(private readonly items: unknown[] = []) {}

  async listNamespaced(_ns: string): Promise<unknown[]> {
    return this.items;
  }

  async listAll(): Promise<unknown[]> {
    return this.items;
  }

  startWatch(
    path: string,
    onEvent: (type: string, obj: unknown) => void,
    _onDone: (err?: unknown) => void,
  ): void {
    this.watchedPaths.push(path);
    this.eventHandlers.push(onEvent);
  }

  fire(type: string, obj: unknown): void {
    for (const h of this.eventHandlers) h(type, obj);
  }
}

class FakeEngine implements EngineHandle {
  started = false;
  stopped = false;
  readonly cfg: PipelineConfig;

  constructor(cfg: PipelineConfig) {
    this.cfg = cfg;
  }

  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  async poll() {}
  async pollPackage(_: string) {}
}

function makeEngineFactory() {
  const created: FakeEngine[] = [];
  const factory = (cfg: PipelineConfig): FakeEngine => {
    const e = new FakeEngine(cfg);
    created.push(e);
    return e;
  };
  return { created, factory };
}

function makeCR(name: string, namespace = "default") {
  return {
    metadata: { name, namespace },
    spec: {
      name: `Pipeline ${name}`,
      steps: [
        { id: "src", type: "git" as const, repo: "org/repo", branch: "main" },
      ],
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("start() with named namespaces uses per-namespace watch paths", async () => {
  const k8s = new FakeK8s();
  const reconciler = new Reconciler(["default", "staging"], k8s);
  await reconciler.start();

  expect(k8s.watchedPaths).toEqual([
    "/apis/app-conveyor.elifesciences.org/v1alpha1/namespaces/default/pipelines",
    "/apis/app-conveyor.elifesciences.org/v1alpha1/namespaces/staging/pipelines",
  ]);
});

test("start() with * uses cluster-wide watch path", async () => {
  const k8s = new FakeK8s();
  const reconciler = new Reconciler(["*"], k8s);
  await reconciler.start();

  expect(k8s.watchedPaths).toEqual([
    "/apis/app-conveyor.elifesciences.org/v1alpha1/pipelines",
  ]);
});

test("pre-existing CRs start engines on startup", async () => {
  const k8s = new FakeK8s([makeCR("my-app")]);
  const { created, factory } = makeEngineFactory();
  const reconciler = new Reconciler(["default"], k8s, factory);
  await reconciler.start();

  const engine = created[0];
  if (!engine) throw new Error("expected engine to be created");

  expect(engine.started).toBe(true);
  expect(engine.cfg.id).toBe("my-app");
  expect(reconciler.pipelines.get("my-app")?.name).toBe("Pipeline my-app");
  expect(reconciler.pollers.has("my-app")).toBe(true);
  expect(reconciler.packagePollers.has("my-app")).toBe(true);
});

test("ADDED event starts a new engine and populates maps", async () => {
  const k8s = new FakeK8s();
  const { created, factory } = makeEngineFactory();
  const reconciler = new Reconciler(["default"], k8s, factory);
  await reconciler.start();

  k8s.fire("ADDED", makeCR("my-app"));

  const engine = created[0];
  if (!engine) throw new Error("expected engine to be created");

  expect(engine.started).toBe(true);
  expect(reconciler.pipelines.has("my-app")).toBe(true);
});

test("MODIFIED event with changed config stops old engine and starts a new one", async () => {
  const k8s = new FakeK8s([makeCR("my-app")]);
  const { created, factory } = makeEngineFactory();
  const reconciler = new Reconciler(["default"], k8s, factory);
  await reconciler.start();

  const first = created[0];
  if (!first) throw new Error("expected first engine");

  // Fire MODIFIED with a different spec (e.g. different pipeline name).
  const modified = {
    metadata: { name: "my-app", namespace: "default" },
    spec: {
      name: "Pipeline my-app v2",
      steps: [
        { id: "src", type: "git" as const, repo: "org/repo", branch: "main" },
      ],
    },
  };
  k8s.fire("MODIFIED", modified);

  const second = created[1];
  if (!second) throw new Error("expected second engine");

  expect(first.stopped).toBe(true);
  expect(second.started).toBe(true);
  expect(reconciler.pipelines.has("my-app")).toBe(true);
});

test("MODIFIED event with unchanged config does not restart engine", async () => {
  const k8s = new FakeK8s([makeCR("my-app")]);
  const { created, factory } = makeEngineFactory();
  const reconciler = new Reconciler(["default"], k8s, factory);
  await reconciler.start();

  const first = created[0];
  if (!first) throw new Error("expected first engine");

  k8s.fire("MODIFIED", makeCR("my-app"));

  expect(created.length).toBe(1); // no new engine created
  expect(first.stopped).toBe(false); // existing engine untouched
});

test("DELETED event stops engine and removes it from maps", async () => {
  const k8s = new FakeK8s([makeCR("my-app")]);
  const { created, factory } = makeEngineFactory();
  const reconciler = new Reconciler(["default"], k8s, factory);
  await reconciler.start();

  k8s.fire("DELETED", makeCR("my-app"));

  const engine = created[0];
  if (!engine) throw new Error("expected engine to have been created");

  expect(engine.stopped).toBe(true);
  expect(reconciler.pipelines.has("my-app")).toBe(false);
  expect(reconciler.pollers.has("my-app")).toBe(false);
  expect(reconciler.packagePollers.has("my-app")).toBe(false);
});

test("stop() stops all engines and clears all maps", async () => {
  const k8s = new FakeK8s([makeCR("app-a"), makeCR("app-b")]);
  const { created, factory } = makeEngineFactory();
  const reconciler = new Reconciler(["default"], k8s, factory);
  await reconciler.start();

  reconciler.stop();

  expect(created.every((e) => e.stopped)).toBe(true);
  expect(reconciler.pipelines.size).toBe(0);
  expect(reconciler.pollers.size).toBe(0);
  expect(reconciler.packagePollers.size).toBe(0);
});

test("ADDED event is ignored for reserved IDs", async () => {
  const k8s = new FakeK8s();
  const { created, factory } = makeEngineFactory();
  const reservedIds = new Set(["my-app"]);
  const reconciler = new Reconciler(["default"], k8s, factory, { reservedIds });
  await reconciler.start();

  k8s.fire("ADDED", makeCR("my-app"));

  expect(created).toHaveLength(0);
  expect(reconciler.pipelines.has("my-app")).toBe(false);
});

test("DELETED event is ignored for reserved IDs", async () => {
  // Simulate a pre-populated pipeline owned by static config
  const staticPipeline: PipelineConfig = {
    id: "my-app",
    name: "My App",
    steps: [{ id: "src", type: "git", repo: "org/repo", branch: "main" }],
  };
  const staticPipelines = new Map([["my-app", staticPipeline]]);
  const reservedIds = new Set(["my-app"]);

  const k8s = new FakeK8s();
  const { created, factory } = makeEngineFactory();
  const reconciler = new Reconciler(["default"], k8s, factory, {
    pipelines: staticPipelines,
    reservedIds,
  });
  await reconciler.start();

  k8s.fire("DELETED", makeCR("my-app"));

  // Static pipeline must remain in the map untouched
  expect(created).toHaveLength(0);
  expect(reconciler.pipelines.has("my-app")).toBe(true);
});

test("pollers and packagePollers delegate to the correct engine", async () => {
  const k8s = new FakeK8s();
  const { created, factory } = makeEngineFactory();
  const reconciler = new Reconciler(["default"], k8s, factory);
  await reconciler.start();

  k8s.fire("ADDED", makeCR("my-app"));

  const engine = created[0];
  if (!engine) throw new Error("expected engine to be created");

  let pollCalled = false;
  let pollPackageCalled = false;
  engine.poll = async () => {
    pollCalled = true;
  };
  engine.pollPackage = async (_: string) => {
    pollPackageCalled = true;
  };

  await reconciler.pollers.get("my-app")?.();
  await reconciler.packagePollers.get("my-app")?.("abc1234");

  expect(pollCalled).toBe(true);
  expect(pollPackageCalled).toBe(true);
});
