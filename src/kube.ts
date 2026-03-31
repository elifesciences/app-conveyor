import { writeFileSync } from "node:fs";
import * as k8s from "@kubernetes/client-node";

let _kc: k8s.KubeConfig | null = null;

function getKubeConfig(): k8s.KubeConfig {
  if (_kc) return _kc;
  _kc = new k8s.KubeConfig();
  _kc.loadFromDefault();
  warnIfCaMissing(_kc);
  return _kc;
}

/**
 * Bun reads NODE_EXTRA_CA_CERTS only at process start, so setting it in-process
 * has no effect. If it isn't already set we write the CA to .kube-ca.pem so the
 * user can add it to .env once and have it picked up on next launch.
 */
function warnIfCaMissing(kc: k8s.KubeConfig): void {
  if (process.env.NODE_EXTRA_CA_CERTS) return;

  const cluster = kc.getCurrentCluster() as {
    caData?: string;
    caFile?: string;
  } | null;
  const caData: string | undefined = cluster?.caData;
  const caFile: string | undefined = cluster?.caFile;

  if (caFile) {
    console.warn(
      `[kube] NODE_EXTRA_CA_CERTS not set. Add to .env:\n  NODE_EXTRA_CA_CERTS=${caFile}`,
    );
    return;
  }

  if (caData) {
    const pem = Buffer.from(caData, "base64").toString("utf8");
    const outPath = ".kube-ca.pem";
    try {
      writeFileSync(outPath, pem, { mode: 0o600 });
      console.warn(
        `[kube] NODE_EXTRA_CA_CERTS not set — TLS will fail.\n` +
          `  CA cert written to ${outPath}. Add to .env:\n` +
          `  NODE_EXTRA_CA_CERTS=${outPath}`,
      );
    } catch {
      console.warn(
        `[kube] NODE_EXTRA_CA_CERTS not set and could not write CA to disk.`,
      );
    }
  }
}

export interface KubeClient {
  appsV1: k8s.AppsV1Api;
  customObjects: k8s.CustomObjectsApi;
}

let _client: KubeClient | null = null;

export function getKubeClient(): KubeClient {
  if (_client) return _client;
  const kc = getKubeConfig();
  _client = {
    appsV1: kc.makeApiClient(k8s.AppsV1Api),
    customObjects: kc.makeApiClient(k8s.CustomObjectsApi),
  };
  return _client;
}
