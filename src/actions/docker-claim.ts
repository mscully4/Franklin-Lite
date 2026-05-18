/**
 * Claim a loopback IP for Docker port isolation and write the compose override.
 *
 * Usage: npx tsx src/scripts/docker_claim.ts <task_id> <repo_path>
 *
 * Outputs JSON: { "ip": "127.0.0.2", "envVars": { "APP_CONFIG_OPTION_PG_URL": "127.0.0.2:5432" } }
 * Exits with code 1 if the pool is exhausted.
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { openDb } from "../db.js";
import { getDockerPorts, writeDockerOverride, getRepoDockerEnvVars } from "../docker_override.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRANKLIN_ROOT = join(__dirname, "..", "..");
const KNOWLEDGE_ROOT = join(FRANKLIN_ROOT, "knowledge");

const taskId = process.argv[2];
const repoPath = process.argv[3];

if (!taskId || !repoPath) {
  console.error("Usage: docker_claim.ts <task_id> <repo_path>");
  process.exit(1);
}

const db = openDb();
const ip = db.claimDockerIp(taskId);
db.close();

if (!ip) {
  console.error("Docker IP pool exhausted — all 127.0.0.2–127.0.0.254 addresses are claimed");
  process.exit(1);
}

const ports = getDockerPorts(repoPath);
writeDockerOverride(repoPath, ip, ports);

const envVars = getRepoDockerEnvVars(repoPath, ip, KNOWLEDGE_ROOT);

console.log(JSON.stringify({ ip, envVars }));
