// Thin wrapper around the GitHub REST API for the panel's auto-merge
// and /revert flows. Uses GITHUB_TOKEN env (fine-scoped PAT).
//
// All functions throw on HTTP errors with a clear message. Caller is
// expected to catch and surface to the user (Telegram or logs).

const DEFAULT_REPO = "alideniz0710/splitbill";

interface FetchOpts {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
}

async function githubFetch<T>(path: string, opts: FetchOpts = {}): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN not configured");
  const res = await fetch(`https://api.github.com${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.body ? { "content-type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`github ${opts.method ?? "GET"} ${path} → ${res.status}: ${txt.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export interface PullRequest {
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  merge_commit_sha: string | null;
  draft: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
  user: { login: string };
  changed_files?: number;
  additions?: number;
  deletions?: number;
}

export interface PullRequestFile {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed";
  additions: number;
  deletions: number;
  changes: number;
}

export interface CheckRunsResponse {
  total_count: number;
  check_runs: Array<{
    name: string;
    status: "queued" | "in_progress" | "completed";
    conclusion: "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "action_required" | "skipped" | null;
  }>;
}

export function getRepo(): string {
  return process.env.GITHUB_REPO ?? DEFAULT_REPO;
}

export async function listOpenPRs(): Promise<PullRequest[]> {
  return githubFetch<PullRequest[]>(`/repos/${getRepo()}/pulls?state=open&per_page=20`);
}

export async function getPR(number: number): Promise<PullRequest> {
  return githubFetch<PullRequest>(`/repos/${getRepo()}/pulls/${number}`);
}

export async function listPRFiles(number: number): Promise<PullRequestFile[]> {
  return githubFetch<PullRequestFile[]>(`/repos/${getRepo()}/pulls/${number}/files?per_page=100`);
}

export async function getPRCheckRuns(prSha: string): Promise<CheckRunsResponse> {
  return githubFetch<CheckRunsResponse>(`/repos/${getRepo()}/commits/${prSha}/check-runs?per_page=50`);
}

export async function squashMergePR(number: number): Promise<{ sha: string; merged: boolean; message: string }> {
  return githubFetch(`/repos/${getRepo()}/pulls/${number}/merge`, {
    method: "PUT",
    body: { merge_method: "squash" },
  });
}
