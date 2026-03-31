import * as k8s from "@kubernetes/client-node";
import {
  createConfiguration,
  ResponseContext,
  ServerConfiguration,
  wrapHttpLibrary,
} from "@kubernetes/client-node";

/**
 * Bun's fetch implementation does not honour the https.Agent passed by
 * @kubernetes/client-node, so the cluster CA from kubeconfig is never applied
 * to outgoing TLS connections. Bun does support a non-standard `tls` option on
 * fetch(), so we wrap the HTTP library to extract the cert/key/ca from the
 * agent built by @kubernetes/client-node and pass them through that way instead.
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

let _client: KubeClient | null = null;

export function getKubeClient(): KubeClient {
  if (_client) return _client;
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  _client = {
    appsV1: makeApiClient(kc, k8s.AppsV1Api),
    customObjects: makeApiClient(kc, k8s.CustomObjectsApi),
  };
  return _client;
}
