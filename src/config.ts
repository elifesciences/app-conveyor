import { YAML } from "bun";
import { AppConfigSchema } from "./schemas";
import type { AppConfig } from "./types";

export async function loadConfig(): Promise<AppConfig> {
  const configPath = process.env.CONFIG_PATH ?? "conveyor.yaml";
  const file = Bun.file(configPath);

  if (!(await file.exists())) {
    console.error(`[config] Config file not found: ${configPath}`);
    console.error(`[config] Create conveyor.yaml or set CONFIG_PATH`);
    process.exit(1);
  }

  const raw = YAML.parse(await file.text());
  const result = AppConfigSchema.safeParse(raw);

  if (!result.success) {
    console.error(`[config] Invalid config in ${configPath}:`);
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  console.log(
    `[config] Loaded ${result.data.pipelines.length} pipeline(s) from ${configPath}`,
  );
  return result.data;
}
