import type { Executor } from "./types";

export const fakeExecutor: Executor = async ({ userInput, onLog, signal }) => {
  const steps = ["thinking...", "drafting response...", "finalizing..."];
  for (const step of steps) {
    if (signal?.aborted) throw new Error("aborted");
    onLog({ level: "info", text: step });
    await new Promise((r) => setTimeout(r, 600));
  }
  const output = `[fake output] Received input of ${userInput.length} chars.\nEcho: ${userInput.slice(0, 200)}`;
  onLog({ level: "stdout", text: output });
  return {
    output,
    tokensIn: Math.ceil(userInput.length / 4),
    tokensOut: Math.ceil(output.length / 4),
  };
};
