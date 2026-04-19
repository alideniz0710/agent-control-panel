import { EventEmitter } from "node:events";

type EventMap = {
  [runId: string]: unknown;
};

const globalForBus = globalThis as unknown as { runBus?: EventEmitter };

export const runBus: EventEmitter =
  globalForBus.runBus ??
  (() => {
    const bus = new EventEmitter();
    bus.setMaxListeners(0);
    return bus;
  })();

globalForBus.runBus = runBus;

export type RunEvent =
  | { kind: "log"; taskId: string; level: string; text: string; at: string }
  | { kind: "task-status"; taskId: string; status: string; stepOrder: number }
  | { kind: "run-status"; runId: string; status: string }
  | { kind: "task-done"; taskId: string; tokensIn: number; tokensOut: number; cost: number; output: string | null };

export function emitRunEvent(runId: string, event: RunEvent) {
  runBus.emit(runId, event);
}

export function onRunEvent(runId: string, handler: (e: RunEvent) => void) {
  runBus.on(runId, handler);
  return () => runBus.off(runId, handler);
}

export type EventMapType = EventMap;
