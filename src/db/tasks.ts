import type Database from "better-sqlite3";

export function makeTaskMethods(db: InstanceType<typeof Database>) {
  return {
    // ── Dispatch log ────────────────────────────────────────────────────────

    insertDispatch(entry: {
      task_id: string;
      type: string;
      priority: string;
      dedup_key?: string;
      dispatched_at: string;
      completed_at: string;
      status: string;
      summary: string | null;
    }): void {
      db.prepare(`
        INSERT INTO dispatch_log (task_id, type, priority, dedup_key, dispatched_at, completed_at, status, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          completed_at = excluded.completed_at,
          status = excluded.status,
          summary = excluded.summary
      `).run(entry.task_id, entry.type, entry.priority, entry.dedup_key ?? "", entry.dispatched_at, entry.completed_at, entry.status, entry.summary);
    },

    lastTaskId(): string | null {
      const row = db.prepare(`SELECT task_id FROM dispatch_log ORDER BY id DESC LIMIT 1`).get() as { task_id: string } | undefined;
      return row?.task_id ?? null;
    },

    nextTaskIds(count: number): string[] {
      const update = db.prepare(`UPDATE counters SET value = value + ? WHERE name = 'task_id'`);
      const select = db.prepare(`SELECT value FROM counters WHERE name = 'task_id'`);
      const ids: string[] = [];
      db.transaction(() => {
        update.run(count);
        const row = select.get() as { value: number };
        const end = row.value;
        for (let i = count; i >= 1; i--) {
          ids.push(`task-${String(end - i + 1).padStart(8, "0")}`);
        }
      })();
      return ids;
    },

    getRecentDispatches(limit = 20): Array<Record<string, unknown>> {
      return db.prepare(`SELECT * FROM dispatch_log WHERE type != 'dm_reply' ORDER BY id DESC LIMIT ?`).all(limit) as Array<Record<string, unknown>>;
    },

    getRecentDmReplies(limit = 15): Array<Record<string, unknown>> {
      return db.prepare(`SELECT * FROM dispatch_log WHERE type = 'dm_reply' ORDER BY id DESC LIMIT ?`).all(limit) as Array<Record<string, unknown>>;
    },

    getRecentScheduledRuns(limit = 20): Array<Record<string, unknown>> {
      return db.prepare(`SELECT * FROM dispatch_log WHERE type = 'scheduled' ORDER BY id DESC LIMIT ?`).all(limit) as Array<Record<string, unknown>>;
    },

    pruneDispatchLog(days = 30): number {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const result = db.prepare(`DELETE FROM dispatch_log WHERE completed_at < ?`).run(cutoff);
      return result.changes;
    },

    // ── Quests ──────────────────────────────────────────────────────────────

    upsertQuest(quest: {
      id: string;
      status: string;
      objective: string;
      approach?: string[];
      requested_by?: string;
      source_platform?: string;
      source_task_id?: string;
      ticket_key?: string;
      sandbox_path?: string;
      pr_url?: string;
      outcome?: string;
      agent_status?: string;
    }): void {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO quests (id, status, objective, approach, requested_by, source_platform, source_task_id, ticket_key, sandbox_path, pr_url, outcome, agent_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          objective = excluded.objective,
          approach = excluded.approach,
          requested_by = excluded.requested_by,
          source_platform = excluded.source_platform,
          source_task_id = excluded.source_task_id,
          ticket_key = excluded.ticket_key,
          sandbox_path = excluded.sandbox_path,
          pr_url = excluded.pr_url,
          outcome = excluded.outcome,
          agent_status = excluded.agent_status,
          updated_at = excluded.updated_at
      `).run(
        quest.id, quest.status, quest.objective,
        JSON.stringify(quest.approach ?? []),
        quest.requested_by ?? null, quest.source_platform ?? null,
        quest.source_task_id ?? null, quest.ticket_key ?? null,
        quest.sandbox_path ?? null, quest.pr_url ?? null,
        quest.outcome ?? null, quest.agent_status ?? "pending",
        now, now,
      );
    },

    nextQuestId(): string {
      const row = db.prepare(`SELECT id FROM quests ORDER BY id DESC LIMIT 1`).get() as { id: string } | undefined;
      const lastNum = row?.id?.match(/(\d+)/)?.[1] ? parseInt(row.id.match(/(\d+)/)![1], 10) : 0;
      return `quest-${String(lastNum + 1).padStart(8, "0")}`;
    },

    getQuest(id: string): Record<string, unknown> | null {
      const row = db.prepare(`SELECT * FROM quests WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      return { ...row, approach: JSON.parse(row.approach as string) };
    },

    getQuestsByStatus(status: string): Array<Record<string, unknown>> {
      const rows = db.prepare(`SELECT * FROM quests WHERE status = ? ORDER BY created_at DESC`).all(status) as Array<Record<string, unknown>>;
      return rows.map((r) => ({ ...r, approach: JSON.parse(r.approach as string) }));
    },

    updateQuestStatus(id: string, status: string, fields?: { agent_status?: string; outcome?: string; pr_url?: string }): void {
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE quests SET status = ?, agent_status = COALESCE(?, agent_status), outcome = COALESCE(?, outcome), pr_url = COALESCE(?, pr_url), updated_at = ? WHERE id = ?
      `).run(status, fields?.agent_status ?? null, fields?.outcome ?? null, fields?.pr_url ?? null, now, id);
    },

    // ── Running tasks ────────────────────────────────────────────────────────

    insertRunningTask(task: {
      task_id: string; type: string; priority: string; pid: number | null;
      timeout_ms: number; quest_id: string | null; dispatched_at: string;
      mark_surfaced: string | null; context: string;
    }): void {
      db.prepare(`
        INSERT OR REPLACE INTO running_tasks (task_id, type, priority, pid, timeout_ms, quest_id, dispatched_at, mark_surfaced, context)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(task.task_id, task.type, task.priority, task.pid, task.timeout_ms, task.quest_id, task.dispatched_at, task.mark_surfaced, task.context);
    },

    updateRunningTaskPid(taskId: string, pid: number): void {
      db.prepare(`UPDATE running_tasks SET pid = ? WHERE task_id = ?`).run(pid, taskId);
    },

    getRunningTasks(): Array<{
      task_id: string; type: string; priority: string; pid: number | null;
      timeout_ms: number; quest_id: string | null; dispatched_at: string;
      mark_surfaced: string | null; context: string; assigned_ip: string | null;
    }> {
      return db.prepare(`SELECT * FROM running_tasks`).all() as ReturnType<
        ReturnType<typeof makeTaskMethods>["getRunningTasks"]
      >;
    },

    removeRunningTask(taskId: string): void {
      db.prepare(`DELETE FROM running_tasks WHERE task_id = ?`).run(taskId);
    },

    claimDockerIp(taskId: string): string | null {
      let ip: string | null = null;
      db.transaction(() => {
        const claimed = new Set(
          (db.prepare(`SELECT assigned_ip FROM running_tasks WHERE assigned_ip IS NOT NULL`).all() as Array<{ assigned_ip: string }>)
            .map(r => r.assigned_ip)
        );
        for (let i = 2; i <= 254; i++) {
          const candidate = `127.0.0.${i}`;
          if (!claimed.has(candidate)) { ip = candidate; break; }
        }
        if (ip) {
          db.prepare(`UPDATE running_tasks SET assigned_ip = ? WHERE task_id = ?`).run(ip, taskId);
        }
      })();
      return ip;
    },

    releaseDockerIp(taskId: string): void {
      db.prepare(`UPDATE running_tasks SET assigned_ip = NULL WHERE task_id = ?`).run(taskId);
    },

    hasRunningTaskWithScheduledId(scheduledTaskId: string): boolean {
      const row = db.prepare(
        `SELECT 1 FROM running_tasks WHERE json_extract(context, '$.scheduled_task_id') = ? LIMIT 1`
      ).get(scheduledTaskId);
      return !!row;
    },

    // ── Metrics ──────────────────────────────────────────────────────────────

    getMetrics(since: string | null): {
      tasks: number;
      byType: Record<string, number>;
      byStatus: Record<string, number>;
      quests: number;
      questsWithPr: number;
      deploys: number;
    } {
      const whereClause = since ? `WHERE completed_at >= ?` : ``;
      const params = since ? [since] : [];

      const rows = db.prepare(
        `SELECT type, status, COUNT(*) as cnt FROM dispatch_log ${whereClause} GROUP BY type, status`
      ).all(...params) as Array<{ type: string; status: string; cnt: number }>;

      const byType: Record<string, number> = {};
      const byStatus: Record<string, number> = {};
      let tasks = 0;
      for (const r of rows) {
        byType[r.type] = (byType[r.type] ?? 0) + r.cnt;
        byStatus[r.status] = (byStatus[r.status] ?? 0) + r.cnt;
        tasks += r.cnt;
      }

      const questWhere = since ? `WHERE status = 'completed' AND updated_at >= ?` : `WHERE status = 'completed'`;
      const questParams = since ? [since] : [];
      const questRow = db.prepare(`SELECT COUNT(*) as cnt FROM quests ${questWhere}`).get(...questParams) as { cnt: number };

      const questPrWhere = since
        ? `WHERE status = 'completed' AND pr_url IS NOT NULL AND updated_at >= ?`
        : `WHERE status = 'completed' AND pr_url IS NOT NULL`;
      const questPrRow = db.prepare(`SELECT COUNT(*) as cnt FROM quests ${questPrWhere}`).get(...questParams) as { cnt: number };

      const deployWhere = since ? `WHERE created_at >= ?` : ``;
      const deployRow = db.prepare(`SELECT COUNT(*) as cnt FROM deploys ${deployWhere}`).get(...params) as { cnt: number };

      return { tasks, byType, byStatus, quests: questRow.cnt, questsWithPr: questPrRow.cnt, deploys: deployRow.cnt };
    },
  };
}
