// Auto-merge gate.
//
// Periodically scans open PRs on the splitbill repo and merges those
// that meet ALL safety criteria:
//   1. /auto is enabled globally (Setting "auto.enabled" = "on")
//   2. PR title has [XS] or [S] size tag (agent must self-tag)
//   3. PR is not a draft
//   4. All CI check-runs on the head SHA are "success" (and at least 1
//      check-run exists — protects against "no CI configured yet")
//   5. No file in the diff matches the path-based deny-list
//      (.env, package.json, *.config.*, /migrations/, /auth/, /api/webhook/,
//      middleware.*, etc.)
//   6. At least one file is a test (path matches /test|spec/i) OR
//      commit message contains [no-test] (escape hatch for docs-only PRs)
//
// Runs every 60 seconds from a background interval started in
// instrumentation.ts. Records merged PRs in-memory to avoid double-merging.

import {
  listOpenPRs,
  listPRFiles,
  getPRCheckRuns,
  squashMergePR,
  type PullRequest,
  type PullRequestFile,
} from "./github";
import { prisma } from "./prisma";

const SIZE_TAG_RE = /^\[(XS|S|M|L)\]/i;
const TEST_FILE_RE = /(test|spec)\.(t|j)sx?$|\/__tests__\/|\.test\.|\.spec\./i;
const NO_TEST_TOKEN_RE = /\[no-test\]/i;

const DENY_LIST: RegExp[] = [
  /(^|\/)\.env/,
  /(^|\/)package\.json$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/).*\.config\.(ts|js|mjs|cjs)$/,
  /(^|\/)next\.config\./,
  /(^|\/)vercel\.json$/,
  /\/middleware\.(ts|js)$/,
  /\/migrations\//,
  /\/auth\//,
  /\/api\/webhook\//,
];

const AUTO_KEY = "auto.enabled";
const CHECK_INTERVAL_MS = 60_000;

type AutoMergeGlobal = {
  autoMergeStarted?: boolean;
  autoMergeAttempted?: Set<number>;
  autoMergeLastNotify?: (chatId: string | number, text: string) => Promise<void>;
};
const globalForAuto = globalThis as unknown as AutoMergeGlobal;
const attempted = globalForAuto.autoMergeAttempted ?? new Set<number>();
globalForAuto.autoMergeAttempted = attempted;

export interface MergeDecision {
  prNumber: number;
  willMerge: boolean;
  reason: string;
  sizeTag: string | null;
  ciOk: boolean;
  denyHit: string | null;
  hasTestOrNoTestToken: boolean;
}

export async function decideOnPR(pr: PullRequest, files: PullRequestFile[], ciOk: boolean): Promise<MergeDecision> {
  const sizeMatch = pr.title.match(SIZE_TAG_RE);
  const sizeTag = sizeMatch ? sizeMatch[1].toUpperCase() : null;

  // Deny-list check
  let denyHit: string | null = null;
  for (const f of files) {
    if (DENY_LIST.some((re) => re.test(f.filename))) {
      denyHit = f.filename;
      break;
    }
  }

  // Test presence check
  const hasTestFile = files.some((f) => TEST_FILE_RE.test(f.filename));
  // We approximate "has [no-test] token" by checking the PR title (we
  // don't fetch the commit message here; agent should put it in the
  // title if needed for auto-merge). Cheap heuristic.
  const hasNoTestToken = NO_TEST_TOKEN_RE.test(pr.title);
  const hasTestOrNoTestToken = hasTestFile || hasNoTestToken;

  // Decision tree
  if (pr.draft) {
    return { prNumber: pr.number, willMerge: false, reason: "draft PR", sizeTag, ciOk, denyHit, hasTestOrNoTestToken };
  }
  if (!sizeTag || (sizeTag !== "XS" && sizeTag !== "S")) {
    return { prNumber: pr.number, willMerge: false, reason: `size ${sizeTag ?? "(none)"} — needs human review`, sizeTag, ciOk, denyHit, hasTestOrNoTestToken };
  }
  if (!ciOk) {
    return { prNumber: pr.number, willMerge: false, reason: "CI not green", sizeTag, ciOk, denyHit, hasTestOrNoTestToken };
  }
  if (denyHit) {
    return { prNumber: pr.number, willMerge: false, reason: `deny-list: ${denyHit}`, sizeTag, ciOk, denyHit, hasTestOrNoTestToken };
  }
  if (!hasTestOrNoTestToken) {
    return { prNumber: pr.number, willMerge: false, reason: "no test file changed AND no [no-test] token in title", sizeTag, ciOk, denyHit, hasTestOrNoTestToken };
  }
  return { prNumber: pr.number, willMerge: true, reason: "all checks passed", sizeTag, ciOk, denyHit, hasTestOrNoTestToken };
}

async function notify(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (e) {
    console.error("[auto-merge] notify failed:", e);
  }
}

async function checkAndMergePRs(): Promise<void> {
  // Global toggle
  const autoRow = await prisma.setting.findUnique({ where: { key: AUTO_KEY } });
  if (autoRow?.value !== "on") return;

  if (!process.env.GITHUB_TOKEN) {
    // Don't spam logs if not configured
    return;
  }

  let prs: PullRequest[];
  try {
    prs = await listOpenPRs();
  } catch (e) {
    console.warn("[auto-merge] listOpenPRs failed:", e instanceof Error ? e.message : e);
    return;
  }

  for (const pr of prs) {
    if (attempted.has(pr.number)) continue; // already considered this run cycle

    let files: PullRequestFile[];
    let checks;
    try {
      files = await listPRFiles(pr.number);
      checks = await getPRCheckRuns(pr.head.sha);
    } catch (e) {
      console.warn(`[auto-merge] fetch PR #${pr.number} details failed:`, e instanceof Error ? e.message : e);
      continue;
    }

    // CI rule: at least one check exists AND all are success
    const ciOk =
      checks.total_count > 0 &&
      checks.check_runs.every((cr) => cr.status === "completed" && (cr.conclusion === "success" || cr.conclusion === "skipped"));

    // Skip if CI still pending (don't add to attempted — try again next cycle)
    const stillRunning = checks.check_runs.some((cr) => cr.status !== "completed");
    if (stillRunning) continue;

    const decision = await decideOnPR(pr, files, ciOk);

    if (decision.willMerge) {
      try {
        await squashMergePR(pr.number);
        attempted.add(pr.number);
        await notify(`✅ auto-merged #${pr.number} [${decision.sizeTag}] — ${pr.title}`);
        console.log(`[auto-merge] merged #${pr.number}`);
      } catch (e) {
        attempted.add(pr.number);
        await notify(`❌ auto-merge #${pr.number} failed: ${e instanceof Error ? e.message : String(e)}`);
        console.error(`[auto-merge] merge #${pr.number} failed:`, e);
      }
    } else {
      // Mark attempted so we don't notify again every minute
      attempted.add(pr.number);
      await notify(`👀 #${pr.number} ${decision.sizeTag ? "[" + decision.sizeTag + "] " : ""}needs review: ${decision.reason}\n${pr.title}`);
      console.log(`[auto-merge] skipped #${pr.number}: ${decision.reason}`);
    }
  }

  // Prune attempted entries that aren't in current open list (closed/merged)
  const currentNumbers = new Set(prs.map((p) => p.number));
  for (const n of attempted) {
    if (!currentNumbers.has(n)) attempted.delete(n);
  }
}

export function startAutoMerge(): void {
  if (globalForAuto.autoMergeStarted) return;
  globalForAuto.autoMergeStarted = true;
  console.log(`[auto-merge] started — checking every ${CHECK_INTERVAL_MS / 1000}s (gated by Setting auto.enabled + GITHUB_TOKEN env)`);
  // Don't fire immediately on boot — wait one tick so the panel is fully
  // settled and any pre-start activity (Day 1 migrations etc.) has finished.
  setTimeout(() => {
    void checkAndMergePRs().catch((e) => console.error("[auto-merge] cycle error:", e));
    setInterval(() => {
      void checkAndMergePRs().catch((e) => console.error("[auto-merge] cycle error:", e));
    }, CHECK_INTERVAL_MS);
  }, 10_000);
}
