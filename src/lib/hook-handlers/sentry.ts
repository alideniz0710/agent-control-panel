// Sentry webhook event → human-readable Telegram summary.
//
// Sentry has many event types (issue, comment, metric_alert,
// installation, etc.); we only surface issues being created or
// resolved. Anything else is dropped silently.
//
// Sentry signs the raw body with HMAC SHA256 using the integration's
// Client Secret. The Sentry-Hook-Signature header carries the digest
// in hex (no "sha256=" prefix unlike GitHub). Route handles the
// verification, this file only summarizes.

export interface SentryEvent {
  // Header X-Sentry-Hook-Resource indicates the resource ("issue", "event_alert", ...)
  resource: string;
  // X-Sentry-Hook-Type is the action verb ("created", "resolved", ...)
  action?: string;
  payload: Record<string, unknown>;
}

interface SentryIssue {
  title?: string;
  level?: string;
  permalink?: string;
  shortId?: string;
  project?: { name?: string };
  culprit?: string;
}

interface SentryActor {
  name?: string;
}

function summarizeIssue(event: SentryEvent): string | null {
  const data = event.payload.data as { issue?: SentryIssue } | undefined;
  const issue = data?.issue ?? (event.payload as { issue?: SentryIssue }).issue;
  if (!issue) return null;
  const project = issue.project?.name ?? "(unknown)";
  const level = (issue.level ?? "error").toUpperCase();
  const icon = event.action === "resolved" ? "✅" : "🚨";
  const verb = event.action === "resolved" ? "resolved" : "created";
  const id = issue.shortId ?? "?";
  const title = issue.title ?? "(no title)";
  const link = issue.permalink ?? "";
  const culprit = issue.culprit ? `\nin: ${issue.culprit}` : "";
  return `${icon} [sentry/${project}] ${level} ${verb}: ${id}\n${title}${culprit}\n${link}`;
}

/** Convert a Sentry webhook event into Telegram text, or null if we
 *  don't care. */
export function summarizeSentry(event: SentryEvent): string | null {
  if (event.resource !== "issue") return null;
  // Only the actions we care about
  if (event.action !== "created" && event.action !== "resolved") return null;
  return summarizeIssue(event);
}
