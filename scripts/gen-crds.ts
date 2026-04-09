/**
 * Generates crds/pipeline.yaml from the Zod schemas in src/schemas.ts.
 *
 * Run with: bun run gen-crds
 *
 * The output is committed to the repository. If schemas change, re-run this
 * script and commit the updated CRD alongside the schema change.
 */

import { YAML } from "bun";
import { PipelineConfigSchema } from "../src/schemas";

// In a Pipeline CRD the pipeline ID is carried by metadata.name, not the spec
const PipelineSpecSchema = PipelineConfigSchema.omit({ id: true });

const specSchema = PipelineSpecSchema.toJSONSchema() as Record<string, unknown>;

// $schema is not valid inside a K8s CRD openAPIV3Schema block
delete specSchema.$schema;

// Kubernetes structural schemas forbid additionalProperties alongside properties.
// Unknown fields are silently pruned by the API server — no explicit false needed.
function stripAdditionalProperties(schema: unknown): void {
  if (typeof schema !== "object" || schema === null) return;
  const obj = schema as Record<string, unknown>;
  delete obj.additionalProperties;
  for (const value of Object.values(obj)) {
    stripAdditionalProperties(value);
  }
}
stripAdditionalProperties(specSchema);

const crd = {
  apiVersion: "apiextensions.k8s.io/v1",
  kind: "CustomResourceDefinition",
  metadata: {
    name: "pipelines.app-conveyor.elifesciences.org",
  },
  spec: {
    group: "app-conveyor.elifesciences.org",
    names: {
      kind: "Pipeline",
      plural: "pipelines",
      singular: "pipeline",
      shortNames: ["pl"],
    },
    scope: "Namespaced",
    versions: [
      {
        name: "v1alpha1",
        served: true,
        storage: true,
        schema: {
          openAPIV3Schema: {
            type: "object",
            required: ["spec"],
            properties: {
              spec: specSchema,
            },
          },
        },
      },
    ],
  },
};

await Bun.write("crds/pipeline.yaml", YAML.stringify(crd));
console.log("Generated crds/pipeline.yaml");
