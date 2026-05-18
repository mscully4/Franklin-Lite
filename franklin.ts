#!/usr/bin/env npx tsx
/**
 * Franklin — Process Supervisor
 *
 * Usage:
 *   npx tsx franklin.ts                    Start the supervisor loop
 *   npx tsx franklin.ts status             Print current status and exit
 *   npx tsx franklin.ts --only=gmail        Run only the gmail scout
 *   npx tsx franklin.ts --skip=calendar    Skip specific scouts
 */
import "./src/supervisor/index.js";
