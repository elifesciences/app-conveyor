import { YAML } from "bun";
import { AppConfigSchema } from "./schemas";
import type { AppConfig } from "./types";

export async function loadConfig(): Promise<AppConfig | null> {
  const explicitPath = process.env.CONFIG_PATH;
  const configPath = explicitPath ?? "conveyor.yaml";
  const file = Bun.file(configPath);

  if (!(await file.exists())) {
    if (explicitPath) {
      console.error(`[config] Config file not found: ${configPath}`);
      process.exit(1);
    }
    return null; // conveyor.yaml absent — YAML source simply inactive
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
    `[config] Loaded ${result.data.pipelines.length} static pipeline(s) from ${configPath}`,
  );
  return result.data;
}
