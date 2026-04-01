import { loadConfig } from "./src/config";
import { Engine } from "./src/engine";
import { createServer } from "./src/server";

const cfg = await loadConfig();

const pollers = new Map<string, () => Promise<void>>();
const packagePollers = new Map<
  string,
  (commitPrefix: string) => Promise<void>
>();

for (const pipeline of cfg.pipelines) {
  const engine = new Engine(pipeline);
  pollers.set(pipeline.id, () => engine.poll());
  packagePollers.set(pipeline.id, (commitPrefix) =>
    engine.pollPackage(commitPrefix),
  );
  engine.start();
}

createServer(cfg, pollers, packagePollers);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
