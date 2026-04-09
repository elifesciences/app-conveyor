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

export function createServer(
  pipelines: Map<string, PipelineConfig>,
  pollers: Map<string, () => Promise<void>>,
  packagePollers: Map<string, (commitPrefix: string) => Promise<void>>,
) {
  const port = Number(process.env.PORT ?? 3000);

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // GET / — landing page
      if (path === "/" || path === "") {
        const pipelineSummaries = [...pipelines.values()].map((pipeline) => {
          const latest = listPackages(pipeline.id, 1)[0] ?? null;
          return { pipeline, latest };
        });
        const html = renderLandingPage(pipelineSummaries, new Date());
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // POST /pipeline/:pipelineId/sync — trigger poll, redirect to dashboard or caller
      const syncMatch = path.match(/^\/pipeline\/([^/]+)\/sync$/);
      if (syncMatch?.[1] && req.method === "POST") {
        const pipelineId = syncMatch[1];
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
      }

      // POST /pipeline/:pipelineId/package/:commitId/sync — trigger single-package poll
      const packageSyncMatch = path.match(
        /^\/pipeline\/([^/]+)\/package\/([a-f0-9]{7,40})\/sync$/,
      );
      if (
        packageSyncMatch?.[1] &&
        packageSyncMatch[2] &&
        req.method === "POST"
      ) {
        const pipelineId = packageSyncMatch[1];
        const commitPrefix = packageSyncMatch[2];
        const trigger = packagePollers.get(pipelineId);
        if (!trigger)
          return new Response("Pipeline not found", { status: 404 });
        await trigger(commitPrefix);
        return new Response(null, {
          status: 303,
          headers: {
            Location: `/pipeline/${pipelineId}/package/${commitPrefix}`,
          },
        });
      }

      // POST /pipeline/:pipelineId/package/:commitId/retry — reset steps, keep snapshot
      // POST /pipeline/:pipelineId/package/:commitId/reset — reset steps, adopt current config
      const resetMatch = path.match(
        /^\/pipeline\/([^/]+)\/package\/([a-f0-9]{7,40})\/(retry|reset)$/,
      );
      if (
        resetMatch?.[1] &&
        resetMatch[2] &&
        resetMatch[3] &&
        req.method === "POST"
      ) {
        const pipelineId = resetMatch[1];
        const commitPrefix = resetMatch[2];
        const action = resetMatch[3] as "retry" | "reset";
        const pipeline = pipelines.get(pipelineId);
        if (!pipeline)
          return new Response("Pipeline not found", { status: 404 });
        const pkg = findPackageByCommitPrefix(pipelineId, commitPrefix);
        if (!pkg) return new Response("Package not found", { status: 404 });
        const effectiveCfg = pkg.configSnapshot ?? pipeline;
        const gitStepIds = effectiveCfg.steps
          .filter((s) => s.type === "git")
          .map((s) => s.id);
        resetPackage(
          pkg.id,
          gitStepIds,
          action === "reset" ? pipeline : undefined,
        );
        console.log(
          `[server] ${action} package ${pkg.commitHash.slice(0, 7)} in pipeline ${pipelineId}`,
        );
        const trigger = packagePollers.get(pipelineId);
        if (trigger) trigger(commitPrefix).catch(console.error);
        return new Response(null, {
          status: 303,
          headers: {
            Location: `/pipeline/${pipelineId}/package/${commitPrefix}`,
          },
        });
      }

      // GET /pipeline/:pipelineId — pipeline dashboard
      const dashMatch = path.match(/^\/pipeline\/([^/]+)$/);
      if (dashMatch?.[1] && req.method === "GET") {
        const pipelineId = dashMatch[1];
        const pipeline = pipelines.get(pipelineId);
        if (!pipeline)
          return new Response("Pipeline not found", { status: 404 });
        const packages = listPackages(pipelineId, 50);
        const html = renderDashboard(packages, pipeline, new Date());
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // GET /pipeline/:pipelineId/package/:commitId — package detail
      const detailMatch = path.match(
        /^\/pipeline\/([^/]+)\/package\/([a-f0-9]{7,40})$/,
      );
      if (detailMatch?.[1] && detailMatch[2] && req.method === "GET") {
        const pipelineId = detailMatch[1];
        const pipeline = pipelines.get(pipelineId);
        if (!pipeline)
          return new Response("Pipeline not found", { status: 404 });
        const pkg = findPackageByCommitPrefix(pipelineId, detailMatch[2]);
        if (!pkg) return new Response("Package not found", { status: 404 });
        const history: StepHistoryEntry[] = [];
        for (const step of pkg.steps) {
          history.push(...getStepHistory(pkg.id, step.stepId));
        }
        const html = renderPackageDetail(pkg, pipeline, history);
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // GET /api/packages?pipeline=... — JSON
      if (path === "/api/packages" && req.method === "GET") {
        const pipelineId = url.searchParams.get("pipeline");
        if (!pipelineId) {
          return Response.json(
            { error: "pipeline query param required" },
            { status: 400 },
          );
        }
        return Response.json(listPackages(pipelineId, 50));
      }

      // GET /healthz
      if (path === "/healthz") {
        return new Response("ok");
      }

      return new Response("Not found", { status: 404 });
    },
    error(err) {
      console.error("[server] unhandled error:", err);
      return new Response("Internal server error", { status: 500 });
    },
  });

  console.log(`[server] listening on http://localhost:${port}`);
  return server;
}
