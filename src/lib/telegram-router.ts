// Maps Telegram chat commands → panel workflow names.
//
// The polling worker sees a message like "/se add a login button",
// extracts the command "se" and the args "add a login button", then
// triggers the workflow named here with the args as the first-step
// input override. The workflow's last step is expected to deliver the
// agent's output back to the same Telegram chat.

export interface CommandRoute {
  command: string;
  workflowName: string;
  description: string;
}

export const TELEGRAM_COMMAND_ROUTES: CommandRoute[] = [
  { command: "se", workflowName: "tg-cmd-se", description: "cc:software-engineer" },
  { command: "debug", workflowName: "tg-cmd-debug", description: "cc:debug" },
  { command: "pa", workflowName: "tg-cmd-pa", description: "cc:personal-assistant" },
];

// Maps direct-route commands to the underlying agent name. Used by the
// poller to apply agent-specific response-style guardrails before
// dispatching, so /se /debug /pa get the same enforcement as plain-text
// orchestrator dispatches.
export const COMMAND_TO_AGENT: Record<string, string> = {
  se: "cc:software-engineer",
  debug: "cc:debug",
  pa: "cc:personal-assistant",
};

export function parseCommand(text: string): { command: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  // Strip leading slash and any "@bot" suffix that Telegram adds in groups.
  const rest = trimmed.slice(1);
  const space = rest.indexOf(" ");
  let head: string;
  let args: string;
  if (space === -1) {
    head = rest;
    args = "";
  } else {
    head = rest.slice(0, space);
    args = rest.slice(space + 1).trim();
  }
  // "/se@mybot foo" → command "se"
  const at = head.indexOf("@");
  const command = (at === -1 ? head : head.slice(0, at)).toLowerCase();
  return { command, args };
}

export function findRoute(command: string): CommandRoute | undefined {
  return TELEGRAM_COMMAND_ROUTES.find((r) => r.command === command);
}

export function buildHelp(): string {
  const agents = TELEGRAM_COMMAND_ROUTES.map(
    (r) => `/${r.command} <görev> — ${r.description}`,
  );
  return [
    "Agent komutları:",
    ...agents,
    "",
    "Kontrol komutları (her zaman çalışır, worker meşgul olsa bile):",
    "/ping — panel hayatta mı?",
    "/agents — kayıtlı agent listesi",
    "/auto on|off — auto-merge toggle",
    "/cap [status|set <usd>] — günlük maliyet limiti",
    "/kill [<task-id>] — çalışan task'ı durdur",
    "/deploy [status|retry] — Vercel deploy bilgisi",
    "/revert <pr-number> — merge edilmiş PR için revert linki",
    "/undo [confirm] — son agent commit'ini develop'tan revert eder",
    "/backup [status|now] — B2'deki backup durumu / manuel backup",
    "/sync — Mac'in develop branch'ini GitHub'tan günceller",
    "/help — bu listeyi göster",
  ].join("\n");
}

/** Commands handled directly by the poller (not routed to a workflow). */
export const SYSTEM_COMMANDS: ReadonlySet<string> = new Set([
  "sync",
  "ping",
  "auto",
  "cap",
  "kill",
  "deploy",
  "revert",
  "agents",
  "undo",
  "backup",
]);

// Patterns that strongly suggest the user is asking the agent to do
// something destructive in shell-command form. These are mostly catastrophic
// (deletes data, force-pushes, drops tables) and are easy for an agent to
// misinterpret if buried in a long task description. We refuse such requests
// unless the user appends a confirmation token, e.g. "/se ... [confirm]".
//
// Each pattern is matched case-insensitively against the args text.
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-rf?\b/i, reason: "rm -rf" },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: "git reset --hard" },
  { pattern: /\bgit\s+push\s+(--force|-f)\b/i, reason: "git push --force" },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*[fd][a-zA-Z]*\b/i, reason: "git clean -fd" },
  { pattern: /\bdrop\s+table\b/i, reason: "DROP TABLE" },
  { pattern: /\btruncate\s+table\b/i, reason: "TRUNCATE TABLE" },
  { pattern: /\bdelete\s+from\b/i, reason: "DELETE FROM" },
  { pattern: /\b--no-verify\b/i, reason: "--no-verify (skip git hooks)" },
  { pattern: /\bsudo\s+rm\b/i, reason: "sudo rm" },
  { pattern: /\bchmod\s+777\b/i, reason: "chmod 777" },
];

/** Phrase the user can append to opt out of the safety check for a single command. */
const CONFIRM_TOKEN = /\[confirm\]/i;

export interface DangerousCheck {
  isDangerous: boolean;
  matched?: string[];
  hasConfirm: boolean;
}

export function checkDangerous(text: string): DangerousCheck {
  const matched: string[] = [];
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(text)) matched.push(reason);
  }
  return {
    isDangerous: matched.length > 0,
    matched: matched.length ? matched : undefined,
    hasConfirm: CONFIRM_TOKEN.test(text),
  };
}
