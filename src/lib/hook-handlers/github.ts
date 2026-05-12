// GitHub webhook event → human-readable Telegram summary.
//
// We only care about a few event types — enough to know what's
// happening on the splitbill repo without drowning the chat:
//
//   - pull_request opened/closed/merged  — agent PRs, manual PRs
//   - push to main                       — direct main commits (rare)
//   - workflow_run completed             — CI green/red, gates auto-merge
//   - check_run completed                — finer-grained CI signal
//
// Anything else is silently ignored (return null). Telegram caps at
// 4096 chars so we keep summaries one line.

export interface GitHubEvent {
  // X-GitHub-Event header value: "pull_request", "push", "workflow_run", etc.
  event: string;
  // Parsed JSON body
  payload: Record<string, unknown>;
}

interface PullRequest {
  number: number;
  title: string;
  state: string;
  merged?: boolean;
  user?: { login: string };
  html_url?: string;
}

interface WorkflowRun {
  name: string;
  conclusion: string | null;
  status: string;
  head_branch?: string;
  html_url?: string;
}

interface Repository {
  full_name?: string;
  name?: string;
}

function repoName(payload: Record<string, unknown>): string {
  const repo = payload.repository as Repository | undefined;
  return repo?.full_name ?? repo?.name ?? "(unknown repo)";
}

function summarizePullRequest(payload: Record<string, unknown>): string | null {
  const action = payload.action as string | undefined;
  const pr = payload.pull_request as PullRequest | undefined;
  if (!pr || !action) return null;

  const repo = repoName(payload);
  const author = pr.user?.login ?? "unknown";
  const tag = `[${repo}]`;

  // We surface opened, closed-merged, closed-unmerged. Skip noise:
  // synchronize (push to PR branch), edited, labeled, reopened.
  switch (action) {
    case "opened":
      return `🟢 ${tag} PR #${pr.number} opened by ${author}\n${pr.title}\n${pr.html_url ?? ""}`;
    case "closed":
      if (pr.merged) {
        return `✅ ${tag} PR #${pr.number} merged\n${pr.title}\n${pr.html_url ?? ""}`;
      }
      return `🔒 ${tag} PR #${pr.number} closed without merge\n${pr.title}`;
    default:
      return null;
  }
}

function summarizePush(payload: Record<string, unknown>): string | null {
  const ref = payload.ref as string | undefined;
  // Only care about main branch pushes
  if (ref !== "refs/heads/main") return null;
  const repo = repoName(payload);
  const pusher = (payload.pusher as { name?: string } | undefined)?.name ?? "unknown";
  const headCommit = payload.head_commit as { message?: string } | undefined;
  const msg = headCommit?.message?.split("\n")[0] ?? "(no message)";
  return `📤 [${repo}] push to main by ${pusher}\n${msg}`;
}

function summarizeWorkflowRun(payload: Record<string, unknown>): string | null {
  const action = payload.action as string | undefined;
  if (action !== "completed") return null;
  const run = payload.workflow_run as WorkflowRun | undefined;
  if (!run) return null;
  // Only branch-level failures; success on every push would be too noisy.
  if (run.conclusion === "success") return null;
  const repo = repoName(payload);
  const icon = run.conclusion === "failure" ? "❌" : "⚠️";
  return `${icon} [${repo}] CI ${run.conclusion ?? "completed"} on ${run.head_branch ?? "?"} (${run.name})\n${run.html_url ?? ""}`;
}

/** Convert a GitHub webhook event into a Telegram-ready text, or null
 *  if we don't care about this event type. */
export function summarizeGithub(event: GitHubEvent): string | null {
  switch (event.event) {
    case "pull_request":
      return summarizePullRequest(event.payload);
    case "push":
      return summarizePush(event.payload);
    case "workflow_run":
      return summarizeWorkflowRun(event.payload);
    default:
      return null;
  }
}
