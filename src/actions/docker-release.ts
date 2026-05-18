/**
 * Release a previously claimed Docker loopback IP and remove the compose override.
 *
 * Usage: npx tsx src/scripts/docker_release.ts <task_id> <repo_path>
 *
 * Call this on worker exit (success or failure) after `docker compose down`.
 * The IP is also released automatically when the task row is removed from
 * running_tasks, but calling this explicitly ensures the override file is
 * cleaned up even if the supervisor reaper handles the DB row.
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { openDb } from "../db.js";
import { removeDockerOverride } from "../docker_override.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const taskId = process.argv[2];
const repoPath = process.argv[3];

if (!taskId || !repoPath) {
  console.error("Usage: docker_release.ts <task_id> <repo_path>");
  process.exit(1);
}

const db = openDb();
db.releaseDockerIp(taskId);
db.close();

removeDockerOverride(repoPath);

console.log(`Released Docker IP for task ${taskId}`);
