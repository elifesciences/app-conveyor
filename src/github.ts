const GITHUB_API = "https://api.github.com";

export async function ghFetch(path: string): Promise<unknown> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const resp = await fetch(`${GITHUB_API}${path}`, { headers });
  if (!resp.ok) {
    throw new Error(`GitHub API ${resp.status} for ${path}`);
  }
  return resp.json();
}
