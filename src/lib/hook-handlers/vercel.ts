// Vercel webhook event → human-readable Telegram summary.
//
// We care about deployments — when one starts, succeeds, fails. The
// other events Vercel sends (project.created, integration.* etc.) are
// noise for our purpose and silently dropped.
//
// Note: Vercel signs the raw request body with HMAC SHA1 using your
// integration "Client Secret" (NOT the typical "secret token" pattern
// most providers use). We handle that in the route, this file only
// turns parsed bodies into text.

export interface VercelEvent {
  // Vercel's body has a top-level "type" field, e.g. "deployment.succeeded"
  type: string;
  payload: Record<string, unknown>;
}

interface DeploymentPayload {
  deployment?: {
    name?: string;
    url?: string;
    inspectorUrl?: string;
    meta?: { githubCommitMessage?: string; githubCommitRef?: string };
  };
  project?: { name?: string };
  team?: { id?: string };
  target?: string | null;
}

function deploymentLine(p: Record<string, unknown>, icon: string, verb: string): string {
  const dp = p as DeploymentPayload;
  const project = dp.project?.name ?? dp.deployment?.name ?? "(unknown)";
  const branch = dp.deployment?.meta?.githubCommitRef ?? "?";
  const target = dp.target ?? "preview";
  const url = dp.deployment?.url ? `https://${dp.deployment.url}` : (dp.deployment?.inspectorUrl ?? "");
  const commitMsg = dp.deployment?.meta?.githubCommitMessage?.split("\n")[0] ?? "";
  const second = commitMsg ? `\n${commitMsg}` : "";
  return `${icon} [vercel/${project}] ${verb} on ${branch} (${target})${second}\n${url}`;
}

/** Convert a Vercel webhook event into Telegram text, or null if we
 *  don't care. */
export function summarizeVercel(event: VercelEvent): string | null {
  switch (event.type) {
    case "deployment.created":
      // Skipping this — too noisy. We'll know it succeeded or failed.
      return null;
    case "deployment.succeeded":
    case "deployment.ready":
      return deploymentLine(event.payload, "🚀", "deployment succeeded");
    case "deployment.error":
    case "deployment.canceled":
      return deploymentLine(event.payload, "❌", `deployment ${event.type.split(".")[1]}`);
    default:
      return null;
  }
}
