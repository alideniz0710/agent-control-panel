import { NextRequest } from "next/server";
import { onRunEvent, type RunEvent } from "@/lib/events";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { id: runId } = await params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };
      send({ kind: "hello", runId });
      const off = onRunEvent(runId, (e: RunEvent) => send(e));
      const keepalive = setInterval(() => {
        controller.enqueue(encoder.encode(": ping\n\n"));
      }, 15000);
      req.signal.addEventListener("abort", () => {
        off();
        clearInterval(keepalive);
        try {
          controller.close();
        } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
