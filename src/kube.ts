import * as k8s from "@kubernetes/client-node";
import {
  createConfiguration,
  ResponseContext,
  ServerConfiguration,
  wrapHttpLibrary,
} from "@kubernetes/client-node";

type AgentOptions = {
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
  rejectUnauthorized?: boolean;
};

/**
 * Bun's fetch() ignores the https.Agent that @kubernetes/client-node attaches
 * to request options, so the cluster CA/cert/key are never applied to outgoing
 * TLS connections. This patch intercepts globalThis.fetch once at startup and,
 * when an agent with TLS options is present, forwards them via Bun's non-standard
 * `tls` fetch option instead.
 *
 * This covers both the API client path (via wrapHttpLibrary below) and the Watch
 * path, which calls globalThis.fetch() directly with an agent in RequestInit.
 */
function installBunFetchTLSPatch(): void {
  const original = globalThis.fetch.bind(globalThis);
  // biome-ignore lint/suspicious/noExplicitAny: Bun extends fetch with non-standard options; casting avoids the `preconnect` property gap in its type definition
  (globalThis as any).fetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const agent = (init as { agent?: { options?: AgentOptions } } | undefined)
      ?.agent;
    if (agent?.options) {
      return original(input, {
        ...init,
        tls: {
          ca: agent.options.ca,
          cert: agent.options.cert,
          key: agent.options.key,
          rejectUnauthorized: agent.options.rejectUnauthorized,
        },
      } as RequestInit);
    }
    return original(input, init);
  };
}

/**
 * Applies the same TLS extraction for the API client HTTP library wrapper,
 * which receives agent options via a different interface than raw fetch().
 */
function makeBunHttpLibrary() {
  return wrapHttpLibrary({
    async send(request) {
      const agent = request.getAgent() as
        | {
            options?: {
              ca?: Buffer;
              cert?: Buffer;
              key?: Buffer;
              rejectUnauthorized?: boolean;
            };
          }
        | undefined;

      const response = await fetch(request.getUrl(), {
        method: request.getHttpMethod(),
        headers: request.getHeaders(),
        body: request.getBody() as BodyInit | undefined,
        signal: request.getSignal() ?? undefined,
        tls: agent?.options
          ? {
              ca: agent.options.ca,
              cert: agent.options.cert,
              key: agent.options.key,
              rejectUnauthorized: agent.options.rejectUnauthorized,
            }
          : undefined,
      } as RequestInit);

      return new ResponseContext(
        response.status,
        Object.fromEntries(
          Array.from(response.headers as unknown as Iterable<[string, string]>),
        ),
        {
          text: () => response.text(),
          binary: async () => Buffer.from(await response.arrayBuffer()),
        },
      );
    },
  });
}

function makeApiClient<T extends k8s.ApiType>(
  kc: k8s.KubeConfig,
  apiClientType: k8s.ApiConstructor<T>,
): T {
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new Error("No active cluster!");
  const config = createConfiguration({
    baseServer: new ServerConfiguration(cluster.server, {}),
    httpApi: makeBunHttpLibrary(),
    authMethods: { default: kc },
  });
  return new apiClientType(config);
}

export interface KubeClient {
  appsV1: k8s.AppsV1Api;
  customObjects: k8s.CustomObjectsApi;
}

/**
 * Streams a Kubernetes watch using globalThis.fetch (which is already patched
 * by installBunFetchTLSPatch to forward the agent's TLS options to Bun).
 *
 * k8s.Watch imports node-fetch directly, bypassing the globalThis.fetch patch,
 * so we implement our own watch loop here using the standard ReadableStream API.
 */
export function startKubeWatch(
  path: string,
  onEvent: (type: string, obj: unknown) => void,
  onDone: (err?: unknown) => void,
): void {
  const kc = getKubeConfig();
  const cluster = kc.getCurrentCluster();
  if (!cluster) {
    onDone(new Error("No active cluster"));
    return;
  }

  const url = new URL(`${cluster.server}${path}`);
  url.searchParams.set("watch", "true");

  (async () => {
    // applyToFetchOptions adds auth headers and an https.Agent carrying the
    // cluster CA/cert/key. The globalThis.fetch patch detects the agent and
    // forwards its TLS options via Bun's non-standard `tls` fetch option.
    const init = await kc.applyToFetchOptions({});
    const response = await fetch(url.toString(), init as RequestInit);

    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          onDone();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line) as { type: string; object: unknown };
            onEvent(data.type, data.object);
          } catch {
            // ignore parse errors
          }
        }
      }
    } finally {
      reader.cancel();
    }
  })().catch(onDone);
}

let _kc: k8s.KubeConfig | null = null;
let _client: KubeClient | null = null;

export function getKubeConfig(): k8s.KubeConfig {
  if (_kc) return _kc;
  installBunFetchTLSPatch();
  _kc = new k8s.KubeConfig();
  _kc.loadFromDefault();
  return _kc;
}

export function getKubeClient(): KubeClient {
  if (_client) return _client;
  const kc = getKubeConfig();
  _client = {
    appsV1: makeApiClient(kc, k8s.AppsV1Api),
    customObjects: makeApiClient(kc, k8s.CustomObjectsApi),
  };
  return _client;
}
