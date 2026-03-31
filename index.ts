import { loadConfig } from "./src/config";
import { Engine } from "./src/engine";
import { createServer } from "./src/server";

const cfg = await loadConfig();

const pollers = new Map<string, () => Promise<void>>();

for (const pipeline of cfg.pipelines) {
  const engine = new Engine(pipeline);
  pollers.set(pipeline.id, () => engine.poll());
  engine.start();
}

createServer(cfg, pollers);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
