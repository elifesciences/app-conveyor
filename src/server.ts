import {
  findPackageByCommitPrefix,
  getStepHistory,
  listPackages,
  resetPackage,
} from "./db";
import {
  renderDashboard,
  renderLandingPage,
  renderPackageDetail,
} from "./render";
import type { PipelineConfig, StepHistoryEntry } from "./types";

const htmlHeaders = { "Content-Type": "text/html; charset=utf-8" };

export function createServer(
  pipelines: Map<string, PipelineConfig>,
  pollers: Map<string, () => Promise<void>>,
  packagePollers: Map<string, (commitPrefix: string) => Promise<void>>,
) {
  const port = Number(process.env.PORT ?? 3000);

  async function handleReset(
    pipelineId: string,
    commitId: string,
    action: "retry" | "reset",
  ): Promise<Response> {
    const pipeline = pipelines.get(pipelineId);
    if (!pipeline) return new Response("Pipeline not found", { status: 404 });
    const pkg = findPackageByCommitPrefix(pipelineId, commitId);
    if (!pkg) return new Response("Package not found", { status: 404 });
    const effectiveCfg = pkg.configSnapshot ?? pipeline;
    const gitStepIds = effectiveCfg.steps
      .filter((s) => s.type === "git")
      .map((s) => s.id);
    resetPackage(pkg.id, gitStepIds, action === "reset" ? pipeline : undefined);
    console.log(
      `[server] ${action} package ${pkg.commitHash.slice(0, 7)} in pipeline ${pipelineId}`,
    );
    const trigger = packagePollers.get(pipelineId);
    if (trigger) trigger(commitId).catch(console.error);
    return new Response(null, {
      status: 303,
      headers: { Location: `/pipeline/${pipelineId}/package/${commitId}` },
    });
  }

  const server = Bun.serve({
    port,
    routes: {
      // GET / — landing page
      "/": () => {
        const pipelineSummaries = [...pipelines.values()].map((pipeline) => {
          const latest = listPackages(pipeline.id, 1)[0] ?? null;
          return { pipeline, latest };
        });
        return new Response(renderLandingPage(pipelineSummaries, new Date()), {
          headers: htmlHeaders,
        });
      },

      // GET /healthz
      "/healthz": new Response("ok"),

      // GET /api/packages?pipeline=...
      "/api/packages": (req) => {
        const pipelineId = new URL(req.url).searchParams.get("pipeline");
        if (!pipelineId) {
          return Response.json(
            { error: "pipeline query param required" },
            { status: 400 },
          );
        }
        return Response.json(listPackages(pipelineId, 50));
      },

      // GET /pipeline/:pipelineId — pipeline dashboard
      "/pipeline/:pipelineId": (req) => {
        const { pipelineId } = req.params;
        const pipeline = pipelines.get(pipelineId);
        if (!pipeline)
          return new Response("Pipeline not found", { status: 404 });
        const packages = listPackages(pipelineId, 50);
        return new Response(renderDashboard(packages, pipeline, new Date()), {
          headers: htmlHeaders,
        });
      },

      // POST /pipeline/:pipelineId/sync — trigger poll, redirect to dashboard or caller
      "/pipeline/:pipelineId/sync": async (req) => {
        if (req.method !== "POST")
          return new Response("Method Not Allowed", { status: 405 });
        const { pipelineId } = req.params;
        const trigger = pollers.get(pipelineId);
        if (!trigger)
          return new Response("Pipeline not found", { status: 404 });
        await trigger();
        const formData = await req.formData().catch(() => null);
        const redirect =
          formData?.get("redirect")?.toString() ?? `/pipeline/${pipelineId}`;
        return new Response(null, {
          status: 303,
          headers: { Location: redirect },
        });
      },

      // GET /pipeline/:pipelineId/package/:commitId — package detail
      "/pipeline/:pipelineId/package/:commitId": (req) => {
        const { pipelineId, commitId } = req.params;
        const pipeline = pipelines.get(pipelineId);
        if (!pipeline)
          return new Response("Pipeline not found", { status: 404 });
        const pkg = findPackageByCommitPrefix(pipelineId, commitId);
        if (!pkg) return new Response("Package not found", { status: 404 });
        const history: StepHistoryEntry[] = [];
        for (const step of pkg.steps) {
          history.push(...getStepHistory(pkg.id, step.stepId));
        }
        return new Response(renderPackageDetail(pkg, pipeline, history), {
          headers: htmlHeaders,
        });
      },

      // POST /pipeline/:pipelineId/package/:commitId/sync — trigger single-package poll
      "/pipeline/:pipelineId/package/:commitId/sync": async (req) => {
        if (req.method !== "POST")
          return new Response("Method Not Allowed", { status: 405 });
        const { pipelineId, commitId } = req.params;
        const trigger = packagePollers.get(pipelineId);
        if (!trigger)
          return new Response("Pipeline not found", { status: 404 });
        await trigger(commitId);
        return new Response(null, {
          status: 303,
          headers: { Location: `/pipeline/${pipelineId}/package/${commitId}` },
        });
      },

      // POST /pipeline/:pipelineId/package/:commitId/retry — reset steps, keep snapshot
      "/pipeline/:pipelineId/package/:commitId/retry": (req) => {
        if (req.method !== "POST")
          return new Response("Method Not Allowed", { status: 405 });
        return handleReset(req.params.pipelineId, req.params.commitId, "retry");
      },

      // POST /pipeline/:pipelineId/package/:commitId/reset — reset steps, adopt current config
      "/pipeline/:pipelineId/package/:commitId/reset": (req) => {
        if (req.method !== "POST")
          return new Response("Method Not Allowed", { status: 405 });
        return handleReset(req.params.pipelineId, req.params.commitId, "reset");
      },
    },
    error(err) {
      console.error("[server] unhandled error:", err);
      return new Response("Internal server error", { status: 500 });
    },
  });

  console.log(`[server] listening on http://localhost:${port}`);
  return server;
}
