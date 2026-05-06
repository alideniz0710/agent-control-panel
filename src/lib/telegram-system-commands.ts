// Direct-action Telegram commands that don't go through workflows.
//
// /sync → git pull origin develop on the Mac panel host. Use after
//         merging a PR on GitHub (e.g. from iPad) so the agent's
//         next /se starts from up-to-date code instead of stale
//         local develop.

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const DEFAULT_REPO_PATH = "/Users/alidenizaslan/splitbill";
const DEFAULT_BRANCH = "develop";

interface SendFn {
  (chatId: number | string, text: string): Promise<void>;
}

export async function handleSyncCommand(
  chatId: number | string,
  send: SendFn,
): Promise<void> {
  const repoPath = process.env.SPLITBILL_REPO_PATH ?? DEFAULT_REPO_PATH;
  const branch = process.env.SPLITBILL_BRANCH ?? DEFAULT_BRANCH;

  await send(chatId, `⏳ ${repoPath} → git pull origin ${branch}`);

  try {
    const { stdout, stderr } = await execAsync(
      `cd "${repoPath}" && git fetch origin --prune && git checkout ${branch} && git pull origin ${branch}`,
      { timeout: 30_000 },
    );
    const out = [stdout, stderr].filter(Boolean).join("\n").trim();
    const truncated = out.length > 1500 ? out.slice(0, 1500) + "\n[...kesildi]" : out;
    await send(chatId, `✅ Sync:\n\n${truncated || "(temiz, değişiklik yok)"}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await send(chatId, `❌ Sync hatası:\n${message.slice(0, 1500)}`);
  }
}
