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
  const lines = TELEGRAM_COMMAND_ROUTES.map(
    (r) => `/${r.command} <görev> — ${r.description}`,
  );
  return ["Komutlar:", ...lines, "", "/help — bu listeyi göster"].join("\n");
}
