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
    await prisma.$executeRawUnsafe("PRAGMA journal_mode=WAL;");
    // Reduce fsync stalls without losing durability across power loss.
    // Synchronous=NORMAL is the recommended pairing with WAL.
    await prisma.$executeRawUnsafe("PRAGMA synchronous=NORMAL;");
  } catch (e) {
    console.warn("[prisma] failed to enable WAL mode:", e);
  }
}

void enableWalMode();
