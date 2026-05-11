// Daily SQLite backup pipeline to Backblaze B2.
//
// Why: panel state — agents, workflows, runs, conversation threads, the
// telegram poller offset — all sits in a single SQLite file on the Mac
// Mini. If the Mac dies/loses its disk while the founder is in Korea,
// 6+ weeks of accumulated state would be unrecoverable. This module
// runs `sqlite3 .backup` (atomic, hot snapshot) every night at 03:00
// Europe/Istanbul, gzips it, and uploads to B2. Keeps 14 most recent.
//
// Native B2 API used (not S3-compatible) — no extra deps, just fetch.
// Costs: free 10GB storage; our DB compressed is <1MB so we'll never
// approach the limit.
//
// Telegram commands wired in control-commands.ts:
//   /backup status   list of backups + age
//   /backup now      trigger backup immediately

import { exec as childExec } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import cron from "node-cron";

const execAsync = promisify(childExec);

const KEEP_BACKUPS = 14;
const TMP_DIR = "/tmp";

// Path to the SQLite file. In production (panel runs from
// ~/agent-control-panel) this resolves to ~/agent-control-panel/prisma/dev.db
function dbPath(): string {
  // DATABASE_URL is "file:./dev.db" relative to project root; assume cwd
  // is project root when scheduled cron fires (which it is via PM2).
  return path.resolve(process.cwd(), "prisma/dev.db");
}

// ── B2 native API ───────────────────────────────────────────────────────

interface B2AuthResponse {
  authorizationToken: string;
  apiUrl: string;
  accountId: string;
  allowed: { bucketId: string | null; bucketName: string | null };
}

interface B2UploadAuth {
  authorizationToken: string;
  uploadUrl: string;
}

export interface B2File {
  fileName: string;
  fileId: string;
  contentLength: number;
  uploadTimestamp: number;
}

async function b2Authorize(): Promise<B2AuthResponse> {
  const keyId = process.env.B2_APPLICATION_KEY_ID;
  const appKey = process.env.B2_APPLICATION_KEY;
  if (!keyId || !appKey) {
    throw new Error(
      "B2 credentials not configured (B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY)",
    );
  }
  const creds = Buffer.from(`${keyId}:${appKey}`).toString("base64");
  const res = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
    headers: { Authorization: `Basic ${creds}` },
  });
  if (!res.ok) {
    throw new Error(`B2 auth failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return res.json() as Promise<B2AuthResponse>;
}

async function b2ResolveBucketId(auth: B2AuthResponse, bucketName: string): Promise<string> {
  // If the application key is scoped to a single bucket, we already have its ID
  if (auth.allowed.bucketId && auth.allowed.bucketName === bucketName) {
    return auth.allowed.bucketId;
  }
  const res = await fetch(`${auth.apiUrl}/b2api/v3/b2_list_buckets`, {
    method: "POST",
    headers: {
      Authorization: auth.authorizationToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ accountId: auth.accountId, bucketName }),
  });
  if (!res.ok) throw new Error(`b2_list_buckets failed: ${res.status}`);
  const data = (await res.json()) as { buckets?: Array<{ bucketId: string; bucketName: string }> };
  const match = data.buckets?.find((b) => b.bucketName === bucketName);
  if (!match) throw new Error(`bucket not found: ${bucketName}`);
  return match.bucketId;
}

async function b2GetUploadAuth(auth: B2AuthResponse, bucketId: string): Promise<B2UploadAuth> {
  const res = await fetch(`${auth.apiUrl}/b2api/v3/b2_get_upload_url`, {
    method: "POST",
    headers: {
      Authorization: auth.authorizationToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ bucketId }),
  });
  if (!res.ok) throw new Error(`b2_get_upload_url failed: ${res.status}`);
  return res.json() as Promise<B2UploadAuth>;
}

async function b2UploadFile(
  upload: B2UploadAuth,
  fileName: string,
  body: Buffer,
): Promise<{ fileId: string; size: number }> {
  const sha1 = crypto.createHash("sha1").update(body).digest("hex");
  const res = await fetch(upload.uploadUrl, {
    method: "POST",
    headers: {
      Authorization: upload.authorizationToken,
      "X-Bz-File-Name": encodeURIComponent(fileName),
      "Content-Type": "application/octet-stream",
      "Content-Length": String(body.length),
      "X-Bz-Content-Sha1": sha1,
    },
    body: new Uint8Array(body),
  });
  if (!res.ok) {
    throw new Error(`b2 upload failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { fileId: string };
  return { fileId: data.fileId, size: body.length };
}

async function b2DeleteFile(auth: B2AuthResponse, fileId: string, fileName: string): Promise<void> {
  const res = await fetch(`${auth.apiUrl}/b2api/v3/b2_delete_file_version`, {
    method: "POST",
    headers: {
      Authorization: auth.authorizationToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ fileId, fileName }),
  });
  if (!res.ok) {
    throw new Error(`b2 delete failed: ${res.status}`);
  }
}

// ── public API ──────────────────────────────────────────────────────────

export interface BackupResult {
  fileName: string;
  fileId: string;
  sizeBytes: number;
  durationMs: number;
}

/** Atomic sqlite backup → gzip → B2 upload. Throws on any failure. */
export async function runBackup(): Promise<BackupResult> {
  const start = Date.now();
  const bucketName = process.env.B2_BUCKET_NAME;
  if (!bucketName) {
    throw new Error("B2_BUCKET_NAME not configured");
  }

  // 1. sqlite3 .backup writes a fully consistent snapshot even while
  //    the panel is actively reading/writing the live DB.
  const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  const tmpDb = path.join(TMP_DIR, `agent-panel-${ts}.db`);
  await execAsync(`sqlite3 "${dbPath()}" ".backup '${tmpDb}'"`, { timeout: 30_000 });

  // 2. gzip compress in place
  await execAsync(`gzip -9 "${tmpDb}"`, { timeout: 30_000 });
  const gzPath = `${tmpDb}.gz`;
  const buf = await fs.readFile(gzPath);

  try {
    // 3. Upload
    const auth = await b2Authorize();
    const bucketId = await b2ResolveBucketId(auth, bucketName);
    const uploadAuth = await b2GetUploadAuth(auth, bucketId);
    const result = await b2UploadFile(uploadAuth, path.basename(gzPath), buf);

    return {
      fileName: path.basename(gzPath),
      fileId: result.fileId,
      sizeBytes: result.size,
      durationMs: Date.now() - start,
    };
  } finally {
    // 4. Clean up local tmp file regardless of upload outcome
    await fs.unlink(gzPath).catch(() => undefined);
  }
}

/** List backups in the bucket, newest first. */
export async function listBackups(): Promise<B2File[]> {
  const bucketName = process.env.B2_BUCKET_NAME;
  if (!bucketName) throw new Error("B2_BUCKET_NAME not configured");

  const auth = await b2Authorize();
  const bucketId = await b2ResolveBucketId(auth, bucketName);

  const res = await fetch(`${auth.apiUrl}/b2api/v3/b2_list_file_names`, {
    method: "POST",
    headers: {
      Authorization: auth.authorizationToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({ bucketId, maxFileCount: 200 }),
  });
  if (!res.ok) throw new Error(`b2_list_file_names failed: ${res.status}`);
  const data = (await res.json()) as { files?: B2File[] };
  return (data.files ?? [])
    .filter((f) => f.fileName.startsWith("agent-panel-") && f.fileName.endsWith(".db.gz"))
    .sort((a, b) => b.uploadTimestamp - a.uploadTimestamp);
}

/** Delete backups older than the most recent `keep` count. Returns count deleted. */
export async function pruneOldBackups(keep: number = KEEP_BACKUPS): Promise<number> {
  const files = await listBackups();
  if (files.length <= keep) return 0;
  const toDelete = files.slice(keep);
  const auth = await b2Authorize();
  let deleted = 0;
  for (const f of toDelete) {
    try {
      await b2DeleteFile(auth, f.fileId, f.fileName);
      deleted++;
    } catch (e) {
      console.warn(`[backup] failed to delete ${f.fileName}:`, e instanceof Error ? e.message : e);
    }
  }
  return deleted;
}

// ── schedule ────────────────────────────────────────────────────────────

type BackupGlobal = { backupScheduled?: boolean };
const globalForBackup = globalThis as unknown as BackupGlobal;

export function startBackupSchedule(): void {
  if (globalForBackup.backupScheduled) return;
  if (!process.env.B2_BUCKET_NAME || !process.env.B2_APPLICATION_KEY_ID) {
    console.log("[backup] B2 credentials missing — skipping scheduled backups");
    return;
  }
  globalForBackup.backupScheduled = true;
  cron.schedule(
    "0 3 * * *",
    () => {
      void (async () => {
        try {
          console.log("[backup] starting daily backup...");
          const result = await runBackup();
          console.log(
            `[backup] uploaded ${result.fileName} (${(result.sizeBytes / 1024).toFixed(1)} KB) in ${result.durationMs}ms`,
          );
          const pruned = await pruneOldBackups();
          if (pruned > 0) console.log(`[backup] pruned ${pruned} old backup(s)`);
        } catch (e) {
          console.error("[backup] failed:", e instanceof Error ? e.message : e);
        }
      })();
    },
    { timezone: "Europe/Istanbul" },
  );
  console.log(`[backup] scheduled — daily 03:00 Europe/Istanbul, bucket: ${process.env.B2_BUCKET_NAME}`);
}
