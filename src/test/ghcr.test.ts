import { expect, mock, test } from "bun:test";
import { tagContainsHash } from "../modules/ghcr";
import type { StepConfig } from "../types";

const cfg: StepConfig = {
  id: "reg",
  type: "ghcr",
  image: "ghcr.io/elifesciences/enhanced-preprints-client",
};
const sha = "d90e032abc1234567890123456789012345abcde";

function authResp() {
  return new Response(JSON.stringify({ token: "test-token" }));
}
function manifestResp(
  digest = "sha256:abcdef123456789012345678901234567890abcdef12345678",
) {
  return new Response("{}", { headers: { "Docker-Content-Digest": digest } });
}
function manifest404() {
  return new Response("not found", { status: 404 });
}
function githubVersionsResp(tags: string[][]) {
  const versions = tags.map((t, i) => ({
    id: i,
    name: `sha256:fake${i}`,
    metadata: { package_type: "container", container: { tags: t } },
  }));
  return new Response(JSON.stringify(versions), {
    headers: { "Content-Type": "application/json" },
  });
}

// ─── tagContainsHash ─────────────────────────────────────────────────────────

test("tagContainsHash: exact match", () => {
  expect(tagContainsHash("d90e032", "d90e032")).toBe(true);
});
test("tagContainsHash: segment match (8-char hash in tag)", () => {
  expect(tagContainsHash("master-d90e0323-20260316.0756", "d90e032")).toBe(
    true,
  );
});
test("tagContainsHash: prefix of full tag", () => {
  expect(tagContainsHash("d90e032abc", "d90e032")).toBe(true);
});
test("tagContainsHash: no match", () => {
  expect(tagContainsHash("master-abc1234-20260316.0756", "d90e032")).toBe(
    false,
  );
});
test("tagContainsHash: segment starts-with match", () => {
  expect(tagContainsHash("prod-d90e032x-20260316", "d90e032")).toBe(true);
});

// ─── syncGhcr ────────────────────────────────────────────────────────────────

test("passes on exact short-hash tag (fast path)", async () => {
  globalThis.fetch = mock(async (url: string) => {
    if (String(url).includes("/token")) return authResp();
    if (String(url).includes("/manifests/d90e032")) return manifestResp();
    throw new Error(`unexpected: ${url}`);
  }) as unknown as typeof globalThis.fetch;

  const { syncGhcr } = await import("../modules/ghcr");
  const state = await syncGhcr(cfg, sha);
  expect(state.status).toBe("passed");
  expect(state.imageTag).toBe("d90e032");
});

test("finds tag via GitHub Packages API (newest-first)", async () => {
  globalThis.fetch = mock(async (url: string) => {
    const u = String(url);
    if (u.includes("/token")) return authResp();
    if (u.includes("/manifests/d90e032") && !u.includes("master-"))
      return manifest404();
    if (u.includes("api.github.com") && u.includes("/packages/container/")) {
      return githubVersionsResp([
        ["master-d90e0323-20260316.0756"], // ← match
        ["master-abc1234-20260315.1200"],
      ]);
    }
    if (u.includes("/manifests/master-d90e0323")) return manifestResp();
    throw new Error(`unexpected: ${url}`);
  }) as unknown as typeof globalThis.fetch;

  const mod = await import("../modules/ghcr");
  const state = await mod.syncGhcr(cfg, sha);
  expect(state.status).toBe("passed");
  expect(state.imageTag).toBe("master-d90e0323-20260316.0756");
});

test("falls back to OCI tags/list if GitHub API has no match", async () => {
  globalThis.fetch = mock(async (url: string) => {
    const u = String(url);
    if (u.includes("/token")) return authResp();
    if (u.includes("/manifests/d90e032") && !u.includes("master-"))
      return manifest404();
    if (u.includes("api.github.com"))
      return new Response(JSON.stringify([]), {
        headers: { "Content-Type": "application/json" },
      });
    if (u.includes("/tags/list")) {
      return new Response(
        JSON.stringify({ tags: ["master-d90e0323-20260316.0756"] }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.includes("/manifests/master-d90e0323")) return manifestResp();
    throw new Error(`unexpected: ${url}`);
  }) as unknown as typeof globalThis.fetch;

  const mod = await import("../modules/ghcr");
  const state = await mod.syncGhcr(cfg, sha);
  expect(state.status).toBe("passed");
  expect(state.imageTag).toBe("master-d90e0323-20260316.0756");
});

test("returns pending when no tag found anywhere", async () => {
  globalThis.fetch = mock(async (url: string) => {
    const u = String(url);
    if (u.includes("/token")) return authResp();
    if (u.includes("/manifests/")) return manifest404();
    if (u.includes("api.github.com"))
      return new Response(JSON.stringify([]), {
        headers: { "Content-Type": "application/json" },
      });
    if (u.includes("/tags/list"))
      return new Response(
        JSON.stringify({ tags: ["master-abc1234-20260315"] }),
        { headers: { "Content-Type": "application/json" } },
      );
    throw new Error(`unexpected: ${url}`);
  }) as unknown as typeof globalThis.fetch;

  const mod = await import("../modules/ghcr");
  const state = await mod.syncGhcr(cfg, sha);
  expect(state.status).toBe("pending");
  expect(state.detail).toContain("d90e032");
});

test("OCI fallback follows relative Link header", async () => {
  let page = 0;
  globalThis.fetch = mock(async (url: string) => {
    const u = String(url);
    if (u.includes("/token")) return authResp();
    if (u.includes("/manifests/d90e032") && !u.includes("master-"))
      return manifest404();
    if (u.includes("api.github.com"))
      return new Response(JSON.stringify([]), {
        headers: { "Content-Type": "application/json" },
      });
    if (u.includes("/tags/list") && page === 0) {
      page++;
      return new Response(
        JSON.stringify({ tags: ["master-abc0001-20260101"] }),
        {
          headers: {
            "Content-Type": "application/json",
            Link: '</v2/elifesciences/enhanced-preprints-client/tags/list?last=master-abc0001&n=100>; rel="next"',
          },
        },
      );
    }
    if (u.includes("/tags/list") && page === 1) {
      return new Response(
        JSON.stringify({ tags: ["master-d90e0323-20260316.0756"] }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.includes("/manifests/master-d90e0323")) return manifestResp();
    throw new Error(`unexpected: ${url}`);
  }) as unknown as typeof globalThis.fetch;

  const mod = await import("../modules/ghcr");
  const state = await mod.syncGhcr(cfg, sha);
  expect(state.status).toBe("passed");
  expect(state.imageTag).toBe("master-d90e0323-20260316.0756");
});
