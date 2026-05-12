import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Anthropic SDK mock ────────────────────────────────────────────────────────
// vi.hoisted ensures mockMessagesCreate is available when the vi.mock factory
// runs (which is hoisted before imports).
const mockMessagesCreate = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: mockMessagesCreate };
  },
}));

// ── fetch mock ────────────────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Import AFTER mocks are registered
import { downloadTelegramPhoto, analyzeWithClaude } from "../vision";

// ─────────────────────────────────────────────────────────────────────────────

const FILE_ID = "AgACAgIAAx";
const FILE_PATH = "photos/file_0.jpg";

function makeGetFileResponse(ok: boolean, filePath?: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok,
      result: ok ? { file_path: filePath } : undefined,
    }),
  } as unknown as Response;
}

function makeFileResponse(data: Uint8Array) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => data.buffer,
  } as unknown as Response;
}

describe("downloadTelegramPhoto", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mockFetch.mockReset();
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-bot-token");
  });

  it("returns buffer and jpeg mime for a jpg path", async () => {
    const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
    mockFetch
      .mockResolvedValueOnce(makeGetFileResponse(true, FILE_PATH))
      .mockResolvedValueOnce(makeFileResponse(imageBytes));

    const result = await downloadTelegramPhoto(FILE_ID);

    expect(result.mime).toBe("image/jpeg");
    expect(result.filename).toBe("file_0.jpg");
    expect(result.buffer).toEqual(Buffer.from(imageBytes));
  });

  it("calls getFile with the correct file_id", async () => {
    mockFetch
      .mockResolvedValueOnce(makeGetFileResponse(true, "photos/img.png"))
      .mockResolvedValueOnce(makeFileResponse(new Uint8Array([0x89, 0x50])));

    await downloadTelegramPhoto(FILE_ID);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`getFile?file_id=${FILE_ID}`),
    );
  });

  it("returns image/png for a png path", async () => {
    mockFetch
      .mockResolvedValueOnce(makeGetFileResponse(true, "photos/shot.png"))
      .mockResolvedValueOnce(makeFileResponse(new Uint8Array([0])));

    const result = await downloadTelegramPhoto(FILE_ID);
    expect(result.mime).toBe("image/png");
  });

  it("throws when getFile returns ok=false", async () => {
    mockFetch.mockResolvedValueOnce(makeGetFileResponse(false));

    await expect(downloadTelegramPhoto(FILE_ID)).rejects.toThrow(
      "telegram getFile returned no path",
    );
  });

  it("throws when TELEGRAM_BOT_TOKEN is missing", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");

    await expect(downloadTelegramPhoto(FILE_ID)).rejects.toThrow(
      "TELEGRAM_BOT_TOKEN not set",
    );
  });
});

describe("analyzeWithClaude", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mockMessagesCreate.mockReset();
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
  });

  it("returns the text from Claude's response", async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "  A cat sitting on a table.  " }],
    });

    const result = await analyzeWithClaude(Buffer.from("fake-image-data"));

    expect(result).toBe("A cat sitting on a table.");
  });

  it("includes hint in the prompt when provided", async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Invoice for 500 TL." }],
    });

    await analyzeWithClaude(Buffer.from("fake-image-data"), "bu bir fatura");

    const callArg = mockMessagesCreate.mock.calls[0][0];
    const textBlock = callArg.messages[0].content.find(
      (b: { type: string }) => b.type === "text",
    );
    expect(textBlock.text).toContain("bu bir fatura");
  });

  it("sends a base64 image block to Claude", async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
    });

    const buf = Buffer.from("hello");
    await analyzeWithClaude(buf);

    const callArg = mockMessagesCreate.mock.calls[0][0];
    const imageBlock = callArg.messages[0].content.find(
      (b: { type: string }) => b.type === "image",
    );
    expect(imageBlock.source.type).toBe("base64");
    expect(imageBlock.source.data).toBe(buf.toString("base64"));
  });

  it("throws when ANTHROPIC_API_KEY is missing", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    await expect(analyzeWithClaude(Buffer.from("x"))).rejects.toThrow(
      "ANTHROPIC_API_KEY not set",
    );
  });

  it("throws when Claude returns no text block", async () => {
    mockMessagesCreate.mockResolvedValueOnce({
      content: [{ type: "tool_use", id: "x", name: "fn", input: {} }],
    });

    await expect(analyzeWithClaude(Buffer.from("x"))).rejects.toThrow(
      "Claude returned no text content",
    );
  });
});
