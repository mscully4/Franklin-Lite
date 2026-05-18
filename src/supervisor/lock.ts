import { unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readJson, writeJson } from "../config.js";
import log from "../logger.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const LOCK_FILE = join(ROOT, "state", "franklin.lock");
const LOCK_STALE_MS = 3 * 60 * 1000;

export interface LockFile {
  pid: number;
  started_at: string;
  last_heartbeat: string;
}

export function readLock(): LockFile | null {
  return readJson<LockFile>(LOCK_FILE);
}

export function checkLock(): boolean {
  const lock = readLock();
  if (!lock) return true;

  const ageMs = Date.now() - new Date(lock.last_heartbeat).getTime();
  if (ageMs >= LOCK_STALE_MS) {
    log.info(` Stale lock (heartbeat ${Math.round(ageMs / 1000)}s old) — overriding.`);
    return true;
  }

  try {
    process.kill(lock.pid, 0);
    return false;
  } catch {
    log.info(` Lock PID ${lock.pid} is dead — overriding.`);
    return true;
  }
}

export function writeLock(startedAt: string): void {
  writeJson(LOCK_FILE, {
    pid: process.pid,
    started_at: startedAt,
    last_heartbeat: new Date().toISOString(),
  });
}

export function deleteLock(): void {
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
}
