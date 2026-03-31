export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function isK8sNotFound(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as {
    statusCode?: unknown;
    response?: { statusCode?: unknown };
  };
  return err.statusCode === 404 || err.response?.statusCode === 404;
}

export function now(): string {
  return new Date().toISOString();
}

export function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
