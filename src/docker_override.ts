/**
 * Docker port isolation helpers.
 *
 * Generates a docker-compose.override.yml that binds all published host ports
 * to a specific loopback IP, allowing multiple workers to run the same compose
 * stack in parallel without port conflicts.
 */

import { execSync } from "child_process";
import { existsSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { join, basename } from "path";

export interface PortBinding {
  service: string;
  hostPort: number;
  containerPort: number;
}

/**
 * Get all host-published port bindings from a repo's docker-compose setup.
 * Uses `docker compose config --format json` (Compose V2); falls back to
 * a simple text scan of docker-compose.yml if that fails.
 */
export function getDockerPorts(repoPath: string): PortBinding[] {
  try {
    const out = execSync("docker compose config --format json", {
      cwd: repoPath,
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    return parsePortsFromJson(out);
  } catch {
    // Fall back to scanning docker-compose.yml directly
    const composePath = join(repoPath, "docker-compose.yml");
    if (!existsSync(composePath)) return [];
    return parsePortsFromYaml(readFileSync(composePath, "utf8"));
  }
}

function parsePortsFromJson(json: string): PortBinding[] {
  const config = JSON.parse(json) as {
    services?: Record<string, { ports?: Array<{ published?: string | number; target?: number } | string> }>;
  };
  const result: PortBinding[] = [];
  for (const [service, def] of Object.entries(config.services ?? {})) {
    for (const p of def.ports ?? []) {
      if (typeof p === "string") {
        const binding = parsePortString(service, p);
        if (binding) result.push(binding);
      } else if (p.published != null && p.target != null) {
        result.push({ service, hostPort: Number(p.published), containerPort: p.target });
      }
    }
  }
  return result;
}

function parsePortsFromYaml(yaml: string): PortBinding[] {
  const result: PortBinding[] = [];
  let currentService = "";
  let inPorts = false;
  let serviceIndent = -1;

  for (const raw of yaml.split("\n")) {
    const line = raw.trimEnd();
    if (!line || line.trimStart().startsWith("#")) continue;

    const indent = line.length - line.trimStart().length;

    // Detect service-level key (2-space indent, ends with colon, no leading dash)
    if (indent === 2 && /^\s{2}\w[\w-]*:\s*$/.test(line)) {
      currentService = line.trim().replace(/:$/, "");
      inPorts = false;
      serviceIndent = indent;
      continue;
    }

    // Detect ports: key under a service
    if (currentService && /^\s+ports:\s*$/.test(line)) {
      inPorts = true;
      continue;
    }

    // Leaving ports section when indent drops back to service level or higher
    if (inPorts && indent <= serviceIndent && !line.trim().startsWith("-")) {
      inPorts = false;
    }

    if (inPorts && line.trim().startsWith("-")) {
      const portStr = line.trim().replace(/^-\s*/, "").replace(/^["']|["']$/g, "");
      const binding = parsePortString(currentService, portStr);
      if (binding) result.push(binding);
    }
  }
  return result;
}

function parsePortString(service: string, portStr: string): PortBinding | null {
  // Strip protocol suffix and quotes
  const cleaned = portStr.split("/")[0].replace(/^["']|["']$/g, "").trim();
  const parts = cleaned.split(":");
  // ip:host:container or host:container
  const hostPort = parseInt(parts[parts.length - 2] ?? "", 10);
  const containerPort = parseInt(parts[parts.length - 1] ?? "", 10);
  if (isNaN(hostPort) || isNaN(containerPort)) return null;
  return { service, hostPort, containerPort };
}

/**
 * Write a docker-compose.override.yml in the repo that binds all host ports
 * to the given loopback IP.
 */
export function writeDockerOverride(repoPath: string, ip: string, ports: PortBinding[]): void {
  if (ports.length === 0) return;

  // Group by service
  const byService = new Map<string, PortBinding[]>();
  for (const p of ports) {
    const list = byService.get(p.service) ?? [];
    list.push(p);
    byService.set(p.service, list);
  }

  const lines: string[] = ["services:"];
  for (const [service, bindings] of byService) {
    lines.push(`  ${service}:`);
    lines.push(`    ports:`);
    for (const b of bindings) {
      lines.push(`      - "${ip}:${b.hostPort}:${b.containerPort}"`);
    }
  }

  writeFileSync(join(repoPath, "docker-compose.override.yml"), lines.join("\n") + "\n", "utf8");
}

/**
 * Remove the generated override file, if it exists.
 */
export function removeDockerOverride(repoPath: string): void {
  const f = join(repoPath, "docker-compose.override.yml");
  if (existsSync(f)) unlinkSync(f);
}

/**
 * Read env var templates from knowledge/repos/<repo>/docker.md and substitute
 * the assigned IP. Returns a key→value map ready to inject into the environment.
 *
 * The docker.md file should contain a section like:
 *   ## Env Vars
 *   APP_CONFIG_OPTION_PG_URL={ip}:5432
 */
export function getRepoDockerEnvVars(repoPath: string, ip: string, knowledgeRoot: string): Record<string, string> {
  const repoName = basename(repoPath);
  const knowledgePath = join(knowledgeRoot, "repos", repoName, "docker.md");
  if (!existsSync(knowledgePath)) return {};

  const content = readFileSync(knowledgePath, "utf8");
  const result: Record<string, string> = {};

  let inEnvSection = false;
  for (const line of content.split("\n")) {
    if (/^##\s+Env Vars/i.test(line)) { inEnvSection = true; continue; }
    if (/^##/.test(line) && inEnvSection) break;
    if (!inEnvSection) continue;

    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)/);
    if (match) {
      result[match[1]] = match[2].replace(/\{ip\}/g, ip).trim();
    }
  }

  return result as unknown as Record<string, string>;
}
