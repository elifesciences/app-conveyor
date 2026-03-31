/**
 * Image Tracker — checks GHCR for an image tagged with (or containing) the commit_hash.
 *
 * Tag matching strategy (in order):
 *   1. Exact manifest probe on the 7-char short hash (fast path)
 *   2. GitHub Packages API — returns versions newest-first, each with their tags.
 *      Efficient for timestamp-based tag formats like {branch}-{hash}-{timestamp}.
 *   3. OCI /tags/list fallback (lexicographic order, slower for large registries)
 */

import { ghFetch } from "../github";
import type { StepConfig, StepState } from "../types";
import { errorMessage, now } from "../util";

interface GhcrVersion {
  metadata?: {
    container?: {
      tags?: string[];
    };
  };
}

interface GhcrTokenResponse {
  token?: string;
  access_token?: string;
}

export async function syncGhcr(
  cfg: StepConfig,
  commitHash: string,
): Promise<StepState> {
  const base: Omit<StepState, "status" | "label" | "detail"> = {
    stepId: cfg.id,
    updatedAt: now(),
    commitHash,
  };

  if (!cfg.image) {
    return {
      ...base,
      status: "skipped",
      label: "–",
      detail: "image not configured",
    };
  }

  const withoutRegistry = cfg.image.replace(/^ghcr\.io\//, "");
  const shortHash = commitHash.slice(0, 7);

  try {
    const bearerToken = await getGhcrToken(withoutRegistry);

    // ── 1. Fast path: probe exact tag ──────────────────────────────────────
    const exactResult = await probeManifest(
      withoutRegistry,
      shortHash,
      bearerToken,
    );
    if (exactResult.ok) {
      return buildPassed(base, cfg.image, shortHash, exactResult.digest);
    }
    if (exactResult.status !== 404) {
      return {
        ...base,
        status: "failed",
        label: "err",
        detail: `registry ${exactResult.status}`,
      };
    }

    // ── 2. GitHub Packages API (newest-first, efficient) ───────────────────
    const ghTag = await findTagViaGithubApi(withoutRegistry, shortHash);
    if (ghTag) {
      const result = await probeManifest(withoutRegistry, ghTag, bearerToken);
      if (!result.ok) {
        return {
          ...base,
          status: "failed",
          label: "err",
          detail: `registry ${result.status} for ${ghTag}`,
        };
      }
      return buildPassed(base, cfg.image, ghTag, result.digest);
    }

    // ── 3. OCI tags/list fallback ──────────────────────────────────────────
    const ociTag = await findTagViaOci(withoutRegistry, shortHash, bearerToken);
    if (ociTag) {
      const result = await probeManifest(withoutRegistry, ociTag, bearerToken);
      if (!result.ok) {
        return {
          ...base,
          status: "failed",
          label: "err",
          detail: `registry ${result.status} for ${ociTag}`,
        };
      }
      return buildPassed(base, cfg.image, ociTag, result.digest);
    }

    return {
      ...base,
      status: "pending",
      label: "waiting",
      detail: `no tag containing ${shortHash}`,
    };
  } catch (e: unknown) {
    return {
      ...base,
      status: "failed",
      label: "err",
      detail: errorMessage(e),
    };
  }
}

// ─── GitHub Packages API ──────────────────────────────────────────────────────

/**
 * Uses the GitHub REST API to list package versions (newest first) and find
 * one whose tags contain the short hash. Works for both org and user packages.
 */
async function findTagViaGithubApi(
  repo: string, // e.g. "elifesciences/enhanced-preprints-client"
  shortHash: string,
): Promise<string | null> {
  const slashIdx = repo.indexOf("/");
  if (slashIdx === -1) return null;

  const owner = repo.slice(0, slashIdx);
  // Package names with slashes are URL-encoded
  const packageName = encodeURIComponent(repo.slice(slashIdx + 1));

  // Try org packages first, then user packages
  const endpoints = [
    `/orgs/${owner}/packages/container/${packageName}/versions?per_page=100`,
    `/users/${owner}/packages/container/${packageName}/versions?per_page=100`,
  ];

  for (const endpoint of endpoints) {
    try {
      const versions = (await ghFetch(endpoint)) as GhcrVersion[];
      if (!Array.isArray(versions)) continue;

      console.log(
        `[ghcr] GitHub Packages API returned ${versions.length} versions for ${repo}`,
      );

      for (const version of versions) {
        const tags: string[] = version?.metadata?.container?.tags ?? [];
        const match = tags.find((t) => tagContainsHash(t, shortHash));
        if (match) return match;
      }

      // Got a valid response but no match in first 100 versions — stop here
      return null;
    } catch (e: unknown) {
      console.warn(
        `[ghcr] GitHub Packages API failed for ${endpoint}: ${errorMessage(e)}`,
      );
    }
  }

  return null;
}

// ─── OCI registry fallback ────────────────────────────────────────────────────

async function findTagViaOci(
  repo: string,
  shortHash: string,
  bearerToken: string,
  maxTags = 1000,
): Promise<string | null> {
  let url: string | null = `https://ghcr.io/v2/${repo}/tags/list?n=100`;

  while (url && maxTags > 0) {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    if (!resp.ok) {
      console.warn(`[ghcr] OCI tags/list ${resp.status} for ${repo}`);
      break;
    }

    const json = (await resp.json()) as { tags?: string[] };
    const tags = json.tags ?? [];

    const match = tags.find((t) => tagContainsHash(t, shortHash));
    if (match) return match;

    maxTags -= tags.length;
    url = parseNextLink(resp.headers.get("Link"));
  }

  return null;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Returns a bearer token for ghcr.io OCI v2 API calls.
 *
 * GHCR's OCI endpoint does not accept raw GitHub PATs as Bearer tokens.
 * The PAT must be presented as Basic auth credentials on the token-exchange
 * endpoint to obtain a proper OCI registry token.
 * Without a PAT the exchange is anonymous (pull-only, no list scope).
 */
async function getGhcrToken(repo: string): Promise<string> {
  const pat = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {};
  if (pat) {
    // username can be anything; password is the PAT
    headers.Authorization = `Basic ${btoa(`x-token:${pat}`)}`;
  }
  const resp = await fetch(
    `https://ghcr.io/token?scope=repository:${repo}:pull,list&service=ghcr.io`,
    { headers },
  );
  const json = (await resp.json()) as GhcrTokenResponse;
  return json.token ?? json.access_token ?? "";
}

async function probeManifest(
  repo: string,
  tag: string,
  bearerToken: string,
): Promise<{ ok: boolean; status: number; digest: string }> {
  const resp = await fetch(`https://ghcr.io/v2/${repo}/manifests/${tag}`, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      Accept:
        "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json",
    },
  });
  return {
    ok: resp.ok,
    status: resp.status,
    digest: resp.headers.get("Docker-Content-Digest") ?? "",
  };
}

/**
 * Returns true if any dash-delimited segment of `tag` starts with `hash`.
 * "master-d90e0323-20260316.0756" + "d90e032" → true
 */
export function tagContainsHash(tag: string, hash: string): boolean {
  if (tag === hash) return true;
  return tag.split("-").some((part) => part.startsWith(hash));
}

function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  const m = link.match(/<([^>]+)>;\s*rel="next"/);
  const raw = m?.[1];
  if (!raw) return null;
  try {
    return new URL(raw, "https://ghcr.io").toString();
  } catch {
    return null;
  }
}

function buildPassed(
  base: Omit<StepState, "status" | "label" | "detail">,
  image: string,
  tag: string,
  digest: string,
): StepState {
  const shortDigest = digest.startsWith("sha256:")
    ? digest.slice(7, 19)
    : digest.slice(0, 12);
  return {
    ...base,
    status: "passed",
    label: shortDigest,
    detail: `${image}:${tag} → ${digest}`,
    imageDigest: digest,
    imageTag: tag,
  };
}
