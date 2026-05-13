// Automatic memory writer — called after each successful task to
// extract "what was learned" from the task input/output and append it
// to the appropriate agent's memory file.
//
// Design:
//   - Fires fire-and-forget after task completion (does NOT block the
//     next task in the queue)
//   - Uses Haiku (cheap, ~$0.001/call) for synthesis
//   - Synthesizer prompt explicitly tolerates "nothing notable" — if
//     the response is empty/null/skipped marker, we don't append
//   - Errors during synthesis are logged but never propagate
//   - File-size guard: if agent memory grows past MAX_MEMORY_KB, the
//     OLDEST entries (top of file, just under the header) are pruned
//     to keep the file under the cap. Recent learnings are preserved.
//
// Why agent-specific not shared:
//   The orchestrator path knows which agent it dispatched to. Each
//   agent has its own learning context (software-engineer learns about
//   code patterns, debug learns about error signatures, pa about
//   founder preferences). Cross-agent learnings can be /memo'd
//   manually by the founder when needed.

import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { agentSlug } from "./memory";

const SYNTHESIZER_MODEL = "claude-haiku-4-5-20251001";
const MEMORY_DIR = path.resolve(process.cwd(), "memory");
const MAX_MEMORY_KB = 80; // cap per agent file before old-entry pruning kicks in
const MAX_TASK_CONTENT_CHARS = 8000; // truncate input/output before sending to synthesizer

const SYNTHESIZER_SYSTEM_PROMPT_SUCCESS = `Sen bir agent'ın "ne öğrendi" özet yazarısın.
Bir agent görevi BAŞARIYLA tamamladı (input + output verilecek). Senin işin:

Bu görevden ÖNEMLİ, KALICI, TEKRAR İŞE YARAYACAK öğrenmeler çıkar. Örnek:
- "Splitbill'de /admin/tables route'u App Router'da, Pages Router değil" ← evet, kalıcı
- "PR #42 mergelendi" ← hayır, geçici, atla
- "claude-3-5-sonnet-20241022 modeli yok, claude-sonnet-4-6 kullan" ← evet, kritik
- "Bir buton eklendi" ← hayır, rutin

ÖNEMLİ KURALLAR:
1. Eğer kayda değer bir şey YOKSA tek kelime cevap ver: SKIP
2. Aksi halde 1-3 madde, her madde tek satır Türkçe
3. Maddeler "agent'a hatırlatma" şeklinde olsun: "Yapma X" veya "Hatırla Y"
4. ASLA görev özetini tekrar etme — sadece öğrenmeleri çıkar
5. ASLA mesajına "İşte öğrenmeler:" gibi başlık koyma — direkt maddeler

Format:
- madde 1
- madde 2

VEYA tek kelime: SKIP`;

const SYNTHESIZER_SYSTEM_PROMPT_FAILURE = `Sen bir agent'ın "ne hata yaptım, bir daha yapma" özet yazarısın.
Bir agent görevi BAŞARISIZ tamamladı (input + error verilecek). Senin işin:

Bu hatadan KALICI, TEKRAR ETMEMEK İÇİN AGENT'A HATIRLATILACAK dersler çıkar.

ÖZELLİKLE ÖNEMLİ (mutlaka kaydet):
- "X modeli artık yok, Y kullan" tarzı model adı hataları
- "X env var eksik, kontrol etmeden başlama" tarzı env var hataları
- "X dosyası deny-list'te, PR açma" tarzı policy hataları
- "X kütüphanesinin Y metodu yok, Z kullan" tarzı API hataları
- "Schema'da X yok, önce Z migration gerek" tarzı veri hataları

ATLA:
- Geçici network/timeout hataları
- Founder'ın yazım hatasından gelen hatalar
- "Bilemedim/Anlamadım" tarzı belirsiz ifadeler

KURALLAR:
1. Kayda değer öğrenme yoksa tek kelime: SKIP
2. Aksi halde 1-3 madde, her biri "❌ HATA: ..." veya "✅ DOĞRU: ..." formatında, tek satır Türkçe
3. Spesifik ol — "buton hatası" değil, "next.config.js'te output: 'export' kullanma, App Router ile uyumsuz"
4. Direkt maddeler, başlık YOK

Format:
- ❌ HATA: <ne yaptın>  ✅ DOĞRU: <ne yapmalıydın>
- ❌ HATA: <başka şey>  ✅ DOĞRU: <doğrusu>

VEYA tek kelime: SKIP`;

interface SynthesizeArgs {
  agentName: string;
  taskInput: string;
  taskOutput: string;
  /** When true, the synthesizer is asked to extract "don't repeat this mistake"
   *  learnings instead of "what worked" learnings. taskOutput then contains
   *  the error message (prefixed with "[FAILURE]" by the caller). */
  failed?: boolean;
}

function truncateForLLM(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const head = s.slice(0, Math.floor(maxChars * 0.6));
  const tail = s.slice(-Math.floor(maxChars * 0.3));
  return `${head}\n\n[... ${s.length - maxChars} chars truncated ...]\n\n${tail}`;
}

/** One Haiku call → returns synthesized learnings or null if SKIP / empty / error. */
async function synthesizeLearning(args: SynthesizeArgs): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const client = new Anthropic();
  const outputLabel = args.failed ? "Task error (what went wrong)" : "Task output (what the agent produced)";
  const userMsg =
    `# Agent\n${args.agentName}\n\n` +
    `# Task input (what the agent was asked to do)\n${truncateForLLM(args.taskInput, MAX_TASK_CONTENT_CHARS)}\n\n` +
    `# ${outputLabel}\n${truncateForLLM(args.taskOutput, MAX_TASK_CONTENT_CHARS)}`;

  const systemPrompt = args.failed
    ? SYNTHESIZER_SYSTEM_PROMPT_FAILURE
    : SYNTHESIZER_SYSTEM_PROMPT_SUCCESS;

  try {
    const res = await client.messages.create({
      model: SYNTHESIZER_MODEL,
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: userMsg }],
    });
    const block = res.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return null;
    const text = block.text.trim();
    if (!text || /^SKIP\s*$/i.test(text)) return null;
    return text;
  } catch (e) {
    console.warn("[memory-writer] synthesize failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** If the file exceeds MAX_MEMORY_KB, prune the oldest auto-written entries.
 *  We use a marker line ("<!-- auto-write entries below -->") to demarcate
 *  the seed content (which never gets pruned) from auto-written entries
 *  (FIFO pruned).
 *
 *  Seed content remains. Old auto-entries get dropped from the top
 *  of the auto-write section.
 */
async function pruneIfTooLarge(filePath: string): Promise<void> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size <= MAX_MEMORY_KB * 1024) return;
    const content = await fs.readFile(filePath, "utf-8");
    const marker = "<!-- auto-write entries below -->";
    const markerIdx = content.indexOf(marker);
    if (markerIdx === -1) {
      // No marker — file is all seed content, can't safely prune
      console.warn(`[memory-writer] ${filePath} oversized but no prune marker; skipping prune`);
      return;
    }
    const seed = content.slice(0, markerIdx + marker.length);
    const autoEntries = content.slice(markerIdx + marker.length);
    // Auto-entries are separated by "\n\n## <iso-timestamp>\n..."
    // Drop the FIRST (oldest) ~33% of them.
    const entries = autoEntries.split(/\n(?=## 20\d\d-)/g);
    if (entries.length < 4) return;
    const dropCount = Math.floor(entries.length / 3);
    const kept = entries.slice(dropCount);
    const rebuilt = seed + "\n" + kept.join("\n");
    await fs.writeFile(filePath, rebuilt);
    console.log(`[memory-writer] pruned ${dropCount} old entries from ${filePath}`);
  } catch (e) {
    console.warn(`[memory-writer] prune failed for ${filePath}:`, e instanceof Error ? e.message : e);
  }
}

/** Ensure the agent memory file has the auto-write marker. Idempotent. */
async function ensureMarker(filePath: string): Promise<void> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    if (content.includes("<!-- auto-write entries below -->")) return;
    await fs.appendFile(filePath, "\n\n<!-- auto-write entries below -->\n");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      // Memory dir might not exist yet (first auto-write before any seed)
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        `# ${path.basename(filePath, ".md")} memory\n\n_Auto-written learnings appear below._\n\n<!-- auto-write entries below -->\n`,
      );
    }
  }
}

/** Public entry: synthesize and write. Fire-and-forget safe — never throws. */
export async function autoWriteMemory(args: SynthesizeArgs): Promise<void> {
  try {
    const learning = await synthesizeLearning(args);
    if (!learning) return; // nothing notable, skip silently

    const filePath = path.join(MEMORY_DIR, "agents", `${agentSlug(args.agentName)}.md`);
    await ensureMarker(filePath);

    const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    // Tag failure-derived entries so they're visually distinct when
    // reviewing the memory file later. Both kinds are equally important
    // but failures often warrant a slightly different scan when
    // debugging "why does the agent keep doing this".
    const tag = args.failed ? " (failure)" : "";
    const block = `\n\n## ${ts}${tag}\n${learning}\n`;
    await fs.appendFile(filePath, block);

    await pruneIfTooLarge(filePath);
  } catch (e) {
    // Never let memory-writing break a successful task
    console.warn("[memory-writer] autoWriteMemory failed:", e instanceof Error ? e.message : e);
  }
}
