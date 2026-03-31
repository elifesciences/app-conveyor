import { YAML } from "bun";
import type { AppConfig } from "./types";

export async function loadConfig(): Promise<AppConfig> {
  const configPath = process.env.CONFIG_PATH ?? "conveyor.yaml";
  const file = Bun.file(configPath);

  if (!(await file.exists())) {
    console.error(`[config] Config file not found: ${configPath}`);
    console.error(`[config] Create conveyor.yaml or set CONFIG_PATH`);
    process.exit(1);
  }

  const text = await file.text();
  const cfg = YAML.parse(text) as AppConfig;

  if (!Array.isArray(cfg?.pipelines) || cfg.pipelines.length === 0) {
    console.error(`[config] No pipelines defined in ${configPath}`);
    process.exit(1);
  }

  for (const pipeline of cfg.pipelines) {
    if (!pipeline.id || !pipeline.name) {
      console.error(`[config] Each pipeline must have an id and name`);
      process.exit(1);
    }
    if (!Array.isArray(pipeline.steps) || pipeline.steps.length === 0) {
      console.error(`[config] Pipeline "${pipeline.id}" has no steps`);
      process.exit(1);
    }
  }

  console.log(
    `[config] Loaded ${cfg.pipelines.length} pipeline(s) from ${configPath}`,
  );
  return cfg;
}
