import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaWalEnabled?: boolean;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// Enable SQLite WAL mode once per process. WAL allows concurrent readers
// while a writer holds the write lock — needed because the panel runs
// the worker, scheduler, and Telegram poller in the same process and
// they all touch the DB simultaneously. Without WAL, control commands
// can wait or fail with SQLITE_BUSY while a long-running task writes.
//
// PRAGMA journal_mode=WAL is persisted in the DB file metadata, so
// once it's set the file stays in WAL mode forever — but we re-set it
// every boot for new fresh DBs and as a safety check.
async function enableWalMode(): Promise<void> {
  if (globalForPrisma.prismaWalEnabled) return;
  globalForPrisma.prismaWalEnabled = true;
  try {
    // PRAGMA journal_mode=WAL returns a row with the new mode, so we
    // must use $queryRawUnsafe (which expects a result set) instead of
    // $executeRawUnsafe (which expects a no-result write).
    const modeResult = await prisma.$queryRawUnsafe<Array<{ journal_mode: string }>>(
      "PRAGMA journal_mode=WAL;",
    );
    const mode = modeResult?.[0]?.journal_mode;
    // synchronous=NORMAL doesn't return a row when assigning, so
    // $queryRawUnsafe + ignoring the result is fine; $executeRawUnsafe
    // fails because Prisma sees an unexpected result set on some PRAGMAs.
    await prisma.$queryRawUnsafe("PRAGMA synchronous=NORMAL;");
    if (mode && mode.toLowerCase() === "wal") {
      console.log("[prisma] WAL mode enabled");
    } else {
      console.warn(`[prisma] WAL request returned mode='${mode ?? "(unknown)"}'`);
    }
  } catch (e) {
    console.warn("[prisma] failed to enable WAL mode:", e);
  }
}

void enableWalMode();
