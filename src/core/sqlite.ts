// Thin wrapper around the built-in `node:sqlite` (Node >= 22.5).
// Loaded lazily so the rest of baton still works on runtimes without it,
// and with its ExperimentalWarning silenced (it is noise for CLI users).

type DatabaseSyncCtor = typeof import("node:sqlite").DatabaseSync;
let ctor: DatabaseSyncCtor | null | undefined;

async function loadSqlite(): Promise<DatabaseSyncCtor | null> {
  if (ctor !== undefined) return ctor;
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: any[]) => {
    const msg = typeof warning === "string" ? warning : warning?.message;
    if (/sqlite/i.test(String(msg))) return;
    return (original as any).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    ctor = (await import("node:sqlite")).DatabaseSync;
  } catch {
    ctor = null;
  } finally {
    process.emitWarning = original;
  }
  return ctor;
}

export interface ReadOnlyDb {
  all<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T[];
  close(): void;
}

const TRANSIENT = /disk I\/O error|database is locked|busy|SQLITE_(?:BUSY|IOERR|LOCKED)/i;

/**
 * Open read-only, run `fn`, close; retry on transient errors. The owning agent may be
 * checkpointing or deleting its WAL at that very moment (opencode does on exit, which is
 * exactly when our send-side hook runs), and a read-only connection then fails briefly.
 * Returns null if node:sqlite is unavailable.
 */
export async function withReadOnly<T>(file: string, fn: (db: ReadOnlyDb) => T, attempts = 8): Promise<T | null> {
  for (let i = 1; ; i++) {
    let db: ReadOnlyDb | null = null;
    try {
      db = await openReadOnly(file);
      if (!db) return null;
      return fn(db);
    } catch (e) {
      if (i >= attempts || !TRANSIENT.test(String((e as Error).message))) throw e;
      await new Promise((r) => setTimeout(r, 250 * i));
    } finally {
      try {
        db?.close();
      } catch {
        /* already closed */
      }
    }
  }
}

/** Open a database strictly read-only. Returns null if node:sqlite is unavailable. */
export async function openReadOnly(file: string): Promise<ReadOnlyDb | null> {
  const DatabaseSync = await loadSqlite();
  if (!DatabaseSync) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  return {
    all: <T>(sql: string, ...params: (string | number | null)[]) => db.prepare(sql).all(...params) as T[],
    close: () => db.close(),
  };
}
