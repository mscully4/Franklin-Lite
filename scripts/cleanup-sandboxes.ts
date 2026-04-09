#!/usr/bin/env npx tsx
/**
 * Cleanup stale quest sandbox directories.
 *
 * Deletes ~/franklin-sandbox/quest-* directories when:
 * - The quest is completed or failed
 * - The quest's updated_at is older than RETENTION_DAYS
 *
 * Skips:
 * - Active quests
 * - Quests with needs_info status (waiting for user input)
 * - Orphan dirs younger than RETENTION_DAYS (by filesystem mtime)
 */

import { readdirSync, readFileSync, statSync, rmSync, existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RETENTION_DAYS = 7;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const SANDBOX_DIR = join(homedir(), "franklin-sandbox");
const QUESTS_ACTIVE = join(__dirname, "..", "state", "quests", "active");
const QUESTS_COMPLETED = join(__dirname, "..", "state", "quests", "completed");

function readQuestJson(dir: string, id: string): Record<string, unknown> | null {
  const path = join(dir, `${id}.json`);
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function main(): void {
  if (!existsSync(SANDBOX_DIR)) {
    console.log("No sandbox directory — nothing to clean up.");
    return;
  }

  const dirs = readdirSync(SANDBOX_DIR).filter((d: string) => d.startsWith("quest-"));
  if (dirs.length === 0) {
    console.log("No sandbox directories found.");
    return;
  }

  const now = Date.now();
  let deleted = 0;
  let skipped = 0;

  for (const dir of dirs) {
    const questId = dir; // e.g. "quest-00000014" or "quest-007"
    const fullPath = join(SANDBOX_DIR, dir);

    // Check active quests first — never touch these
    const active = readQuestJson(QUESTS_ACTIVE, questId);
    if (active) {
      const status = active.status as string;
      if (status === "active" || (active as Record<string, unknown>).agent_status === "running") {
        console.log(`  SKIP ${questId} — active`);
        skipped++;
        continue;
      }
    }

    // Check completed quests
    const completed = readQuestJson(QUESTS_COMPLETED, questId);
    const quest = active ?? completed;

    if (quest) {
      // Skip needs_info — worker is waiting for user response
      const workerStatus = quest.agent_status as string | undefined;
      if (workerStatus === "needs_info" || quest.status === "needs_info") {
        console.log(`  SKIP ${questId} — needs_info`);
        skipped++;
        continue;
      }

      // Check retention period
      const updatedAt = quest.updated_at as string | undefined;
      if (updatedAt) {
        const age = now - new Date(updatedAt).getTime();
        if (age < RETENTION_MS) {
          console.log(`  SKIP ${questId} — updated ${Math.round(age / 86_400_000)}d ago (< ${RETENTION_DAYS}d)`);
          skipped++;
          continue;
        }
      }
    } else {
      // Orphan dir — no quest file found. Use filesystem mtime.
      try {
        const mtime = statSync(fullPath).mtimeMs;
        const age = now - mtime;
        if (age < RETENTION_MS) {
          console.log(`  SKIP ${questId} — orphan, mtime ${Math.round(age / 86_400_000)}d ago (< ${RETENTION_DAYS}d)`);
          skipped++;
          continue;
        }
      } catch {
        // Can't stat — skip
        skipped++;
        continue;
      }
    }

    // Safe to delete
    try {
      rmSync(fullPath, { recursive: true, force: true });
      console.log(`  DELETE ${questId}`);
      deleted++;
    } catch (err) {
      console.error(`  ERROR deleting ${questId}:`, err);
    }
  }

  console.log(`Done. Deleted: ${deleted}, Skipped: ${skipped}`);
}

main();
