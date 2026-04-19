export type LogEntry = {
  level: "info" | "stdout" | "tool" | "error";
  text: string;
};

export type ExecutorInput = {
  model: string;
  systemPrompt: string | null;
  userInput: string;
  tools?: unknown;
  onLog: (entry: LogEntry) => void;
  signal?: AbortSignal;
};

export type ExecutorOutput = {
  output: string;
  tokensIn: number;
  tokensOut: number;
};

export type Executor = (input: ExecutorInput) => Promise<ExecutorOutput>;
