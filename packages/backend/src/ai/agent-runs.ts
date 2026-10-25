import { Router } from "express";
import { randomUUID, createHash } from "node:crypto";
import { getDbInstance, getDb, allDb, runDb } from "../database/connection";
import { encrypt, decrypt } from "../utils/crypto";
import {
  createCommandJob,
  getJobDetail,
  cancelJob,
} from "../orchestration/orchestration.service";
import {
  askAgentProvider,
  reasoningEfforts,
  ReasoningEffort,
} from "./provider";
import { redact, redactValue } from "./redact";
import { inventory, monitorSnapshot } from "./resources";
import { reviewEvidence } from "./evidence";

type Mode = "analysis" | "manual" | "auto";
type Phase =
  | "thinking"
  | "approval"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled"
  | "paused"
  | "interrupted"
  | "limited";
type Action = { targetIds: number[]; commands: string[]; purpose: string };
type Settings = {
  model: string;
  reasoning: ReasoningEffort;
  mode: Mode;
  concurrency: number;
  timeoutSeconds: number;
  maxRounds: number;
};
type Entry = {
  id: string;
  type: string;
  at: number;
  text?: string;
  commands?: Action[];
  jobId?: string;
  result?: unknown;
  plan?: string[];
};
type Run = {
  id: string;
  user: number;
  title: string;
  objective: string;
  targetIds: number[];
  settings: Settings;
  phase: Phase;
  round: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
  base: string;
  configHash: string;
  fingerprint: string;
  entries: Entry[];
  approval?: { id: string; actions: Action[] };
  activeJob?: string;
  includeMonitor: boolean;
  includeInventory: boolean;
  context: string;
  deadline: number;
  error?: string;
};
type Deps = {
  config: (
    user: number,
  ) => Promise<{ base: string; model: string; key: string }>;
  secrets: (user: number) => Promise<string[]>;
  fingerprint: (ids: number[]) => Promise<string>;
  event: (user: number, action: string, job?: string) => Promise<void>;
};
const active = new Map<
  string,
  {
    controller: AbortController;
    stop: boolean;
    pause: boolean;
    credentials: Record<string, any>;
  }
>();
const locks = new Set<string>();
const terminal = new Set<Phase>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "limited",
]);
let initialization: Promise<void> | undefined;
async function database() {
  const db = await getDbInstance();
  initialization ||= (async () => {
    await runDb(
      db,
      "CREATE TABLE IF NOT EXISTS ai_agent_runs (id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,phase TEXT NOT NULL,updated_at INTEGER NOT NULL,encrypted_body TEXT NOT NULL)",
    );
    const columns = await allDb<{ name: string }>(
      db,
      "PRAGMA table_info(ai_agent_runs)",
    );
    if (!columns.some((c) => c.name === "encrypted_summary"))
      await runDb(
        db,
        "ALTER TABLE ai_agent_runs ADD COLUMN encrypted_summary TEXT",
      );
    await runDb(
      db,
      "CREATE INDEX IF NOT EXISTS idx_ai_agent_owner_time ON ai_agent_runs(user_id,updated_at DESC)",
    );
    const rows = await allDb<{ id: string; encrypted_body: string }>(
      db,
      "SELECT id,encrypted_body FROM ai_agent_runs WHERE phase IN ('thinking','executing')",
    );
    for (const row of rows) {
      const run: Run = JSON.parse(decrypt(row.encrypted_body));
      run.phase = "interrupted";
      run.approval = undefined;
      run.error =
        "Backend restarted. Review results before starting another task.";
      add(run, { type: "error", text: run.error });
      await persist(run);
    }
  })();
  await initialization;
  return db;
}
async function persist(run: Run) {
  run.updatedAt = Date.now();
  run.revision++;
  await runDb(
    await getDbInstance(),
    "INSERT INTO ai_agent_runs (id,user_id,phase,updated_at,encrypted_body,encrypted_summary) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,updated_at=excluded.updated_at,encrypted_body=excluded.encrypted_body,encrypted_summary=excluded.encrypted_summary",
    [
      run.id,
      run.user,
      run.phase,
      run.updatedAt,
      encrypt(JSON.stringify(run)),
      encrypt(JSON.stringify(summary(run))),
    ],
  );
}
async function read(id: string, user: number): Promise<Run> {
  const row = await getDb(
    await database(),
    "SELECT encrypted_body FROM ai_agent_runs WHERE id=? AND user_id=?",
    [id, user],
  );
  if (!row) throw new Error("Agent task not found.");
  return JSON.parse(decrypt(row.encrypted_body));
}
function add(run: Run, entry: Omit<Entry, "id" | "at">) {
  run.entries.push({ ...entry, id: randomUUID(), at: Date.now() });
  if (run.entries.length > 180) run.entries.splice(0, run.entries.length - 180);
}
/** Keep recent evidence bounded without allowing one host to hide another. */
export function agentHistory(entries: Entry[], budget = 140000): Entry[] {
  const recent: Entry[] = [];
  let used = 0;
  for (const original of entries.slice(-24).reverse()) {
    const entry = JSON.parse(JSON.stringify(original)) as Entry;
    if (entry.text && entry.text.length > 20000)
      entry.text =
        entry.text.slice(0, 10000) +
        "\n[CONTEXT TRUNCATED]\n" +
        entry.text.slice(-10000);
    const targets = (entry.result as any)?.targets;
    if (Array.isArray(targets)) {
      const limit = Math.max(
        120,
        Math.floor(15000 / Math.max(1, targets.length) / 3),
      );
      for (const target of targets)
        for (const field of ["stdout", "stderr", "error"]) {
          const value = target[field];
          if (typeof value === "string" && value.length > limit)
            target[field] =
              value.slice(0, limit / 2) +
              "\n[CONTEXT TRUNCATED]\n" +
              value.slice(-Math.floor(limit / 2));
        }
    }
    const length = JSON.stringify(entry).length;
    if (used + length > budget) break;
    recent.unshift(entry);
    used += length;
  }
  if (recent.length < entries.length)
    recent.unshift({
      id: "context-boundary",
      type: "context",
      at: 0,
      text: "Earlier entries are omitted from this bounded context. Do not assume missing actions or results; ask the user if needed.",
    });
  return recent;
}
function hash(c: { base: string; key: string }) {
  return createHash("sha256")
    .update(c.base + "\0" + c.key)
    .digest("hex");
}
function integer(value: unknown, fallback: number, min: number, max: number) {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || Number(n) < min || Number(n) > max)
    throw new Error(`Expected integer ${min}–${max}.`);
  return Number(n);
}
export function runSettings(raw: any, model: string): Settings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid agent settings.");
  const selected = raw.model ?? model,
    reasoning = raw.reasoning ?? "auto",
    mode = raw.mode ?? "manual";
  if (
    typeof selected !== "string" ||
    !selected.trim() ||
    selected.length > 150 ||
    /[\x00-\x1f\x7f]/.test(selected) ||
    !reasoningEfforts.includes(reasoning) ||
    !["analysis", "manual", "auto"].includes(mode)
  )
    throw new Error("Invalid model, reasoning effort or approval mode.");
  return {
    model: selected,
    reasoning,
    mode,
    concurrency: integer(raw.concurrency, 5, 1, 20),
    timeoutSeconds: integer(raw.timeoutSeconds, 120, 10, 1800),
    maxRounds: integer(raw.maxRounds, 10, 1, 30),
  };
}
export function agentActions(value: any, scope: number[]): Action[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8)
    throw new Error("AI returned invalid actions.");
  let total = 0;
  return value.map((v) => {
    if (
      !v ||
      !Array.isArray(v.targetIds) ||
      !v.targetIds.length ||
      v.targetIds.length > 50 ||
      v.targetIds.some(
        (id: unknown) => !Number.isInteger(id) || !scope.includes(id as number),
      ) ||
      !Array.isArray(v.commands) ||
      !v.commands.length
    )
      throw new Error("AI command targets are outside the selected scope.");
    const commands = v.commands.map((s: unknown) => {
      if (
        typeof s !== "string" ||
        !s.trim() ||
        s.length > 8000 ||
        /[\x00-\x08\x0b-\x1f\x7f]/.test(s) ||
        /\[REDACTED/i.test(s)
      )
        throw new Error("AI returned invalid or redacted commands.");
      return s;
    });
    total += commands.length;
    if (total > 8) throw new Error("At most 8 commands per round.");
    return {
      targetIds: [...new Set<number>(v.targetIds)],
      commands,
      purpose: typeof v.purpose === "string" ? v.purpose.slice(0, 1000) : "",
    };
  });
}
function publicRun(run: Run) {
  const { configHash, fingerprint, context, deadline, ...safe } = run;
  return safe;
}
function summary(run: Run) {
  return {
    id: run.id,
    title: run.title,
    phase: run.phase,
    round: run.round,
    updatedAt: run.updatedAt,
    model: run.settings.model,
    targetIds: run.targetIds,
  };
}
async function credentials(
  raw: unknown,
  ids: number[],
): Promise<Record<string, any>> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid SSH credentials.");
  const result: Record<string, any> = {};
  for (const [key, v] of Object.entries(raw)) {
    if (!ids.includes(Number(key)) || !v || typeof v !== "object")
      throw new Error("Unexpected credential target.");
    const value = v as any;
    result[key] = {};
    for (const field of ["password", "passphrase"]) {
      if (value[field] !== undefined) {
        if (typeof value[field] !== "string" || value[field].length > 4096)
          throw new Error("Invalid SSH credential.");
        result[key][field] = value[field];
      }
    }
  }
  return result;
}
export function agentRunRouter(deps: Deps) {
  const router = Router();
  async function capacity(user: number, id: string) {
    const count = await getDb(
      await database(),
      "SELECT COUNT(*) AS n FROM ai_agent_runs WHERE user_id=? AND id<>? AND phase IN ('thinking','executing','approval','paused')",
      [user, id],
    );
    if (count.n >= 5)
      throw new Error(
        "Finish or stop an existing task (maximum 5 active tasks).",
      );
  }
  async function known(run: Run, session?: Record<string, any>) {
    return [
      ...(await deps.secrets(run.user)),
      ...Object.values(session || {})
        .flatMap((v) => [v.password, v.passphrase])
        .filter(Boolean),
    ];
  }
  async function validate(run: Run) {
    if (Date.now() > run.deadline)
      throw new Error(
        "Task authorization expired after one hour. Start a new task.",
      );
    const c = await deps.config(run.user);
    if (!c.key || hash(c) !== run.configHash)
      throw new Error("AI endpoint or key changed. Start a new task.");
    if ((await deps.fingerprint(run.targetIds)) !== run.fingerprint)
      throw new Error("SSH configuration changed. Start a new task.");
    return c;
  }
  async function executeActions(
    run: Run,
    actions: Action[],
    state: NonNullable<ReturnType<typeof active.get>>,
  ) {
    await validate(run);
    if (run.settings.mode === "analysis")
      throw new Error("Analysis mode cannot execute SSH commands.");
    if (run.round >= run.settings.maxRounds)
      throw new Error("Execution round limit reached.");
    run.round++;
    run.approval = undefined;
    run.phase = "executing";
    await persist(run);
    for (const action of actions) {
      if (state.stop || state.pause) return;
      await validate(run);
      const redactions = await known(run, state.credentials);
      if (state.stop || state.pause) return;
      const jobId = await createCommandJob(
        {
          name: `Agent · ${run.title.slice(0, 80)} · ${run.round}`,
          targetIds: action.targetIds,
          commands: action.commands,
          concurrency: run.settings.concurrency,
          timeoutSeconds: run.settings.timeoutSeconds,
          stopOnError: true,
          recordOutput: true,
          redactOutput: true,
          redactedValues: redactions,
          ephemeralCredentials: Object.fromEntries(
            action.targetIds
              .filter((id) => state.credentials[id])
              .map((id) => [id, state.credentials[id]]),
          ),
        },
        run.user,
      );
      if (state.stop) {
        await cancelJob(jobId, run.user).catch(() => {});
        return;
      }
      run.activeJob = jobId;
      add(run, { type: "execution", jobId, commands: [action] });
      await deps.event(run.user, "executed", jobId);
      await persist(run);
      while (true) {
        if (state.stop) {
          await cancelJob(jobId, run.user).catch(() => {});
          return;
        }
        if (Date.now() > run.deadline) {
          await cancelJob(jobId, run.user).catch(() => {});
          throw new Error("Agent task exceeded its one-hour limit.");
        }
        const job = await getJobDetail(jobId, run.user);
        if (!job) throw new Error("SSH task disappeared.");
        if (!["queued", "running"].includes(String(job.status))) {
          add(run, {
            type: "result",
            jobId,
            result: reviewEvidence(redactValue(job, redactions)),
          });
          run.activeJob = undefined;
          await persist(run);
          if (job.status === "cancelled") {
            state.stop = true;
            return;
          }
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    // Prompt-on-connect credentials authorize only this round, never a later AI proposal.
    state.credentials = {};
  }
  async function drive(
    run: Run,
    approved?: Action[],
    supplied: Record<string, any> = {},
  ) {
    if (active.has(run.id)) throw new Error("Agent task is already running.");
    const state = {
      controller: new AbortController(),
      stop: false,
      pause: false,
      credentials: supplied,
    };
    active.set(run.id, state);
    void (async () => {
      try {
        if (approved) await executeActions(run, approved, state);
        while (!state.stop && !state.pause) {
          if (Date.now() > run.deadline)
            throw new Error("Agent task exceeded its one-hour limit.");
          const c = await validate(run);
          run.phase = "thinking";
          await persist(run);
          const redactions = await known(run, state.credentials);
          const devices = await inventory(run.user);
          const monitor = run.includeMonitor
            ? await monitorSnapshot(run.user)
            : undefined;
          if (state.stop || state.pause) break;
          const content = JSON.stringify(
            redactValue(
              {
                objective: run.objective,
                context: run.context,
                executionScope: run.targetIds,
                targets: devices.filter((d) => run.targetIds.includes(d.id)),
                inventory: run.includeInventory ? devices : undefined,
                monitoring: monitor,
                mode: run.settings.mode,
                round: run.round,
                maxRounds: run.settings.maxRounds,
                history: agentHistory(run.entries),
              },
              redactions,
            ),
          );
          if (content.length > 280000)
            throw new Error(
              "Agent context is too large. Start a smaller task.",
            );
          const raw = await askAgentProvider(
            c.base,
            c.key,
            run.settings.model,
            content,
            {
              signal: state.controller.signal,
              reasoning: run.settings.reasoning,
            },
          );
          if (state.stop || state.pause) break;
          let answer: any;
          try {
            answer = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
          } catch {
            answer = { analysis: raw, actions: [] };
          }
          if (!answer || typeof answer !== "object")
            throw new Error("AI response format is invalid.");
          const safe = redactValue(answer, redactions);
          const actions = agentActions(
            safe.done === true
              ? []
              : (safe.actions ??
                  (Array.isArray(safe.commands) && safe.commands.length
                    ? [{ targetIds: run.targetIds, commands: safe.commands }]
                    : [])),
            run.targetIds,
          );
          add(run, {
            type: "assistant",
            text: String(safe.analysis || "").slice(0, 24000),
            plan: Array.isArray(safe.plan)
              ? safe.plan
                  .filter((p: unknown) => typeof p === "string")
                  .slice(0, 12)
                  .map((p: string) => p.slice(0, 500))
              : [],
            commands: actions,
          });
          if (!actions.length || run.settings.mode === "analysis") {
            run.phase = "completed";
            break;
          }
          if (run.round >= run.settings.maxRounds) {
            run.phase = "limited";
            break;
          }
          run.approval = { id: randomUUID(), actions };
          const actionTargets = [
            ...new Set(actions.flatMap((action) => action.targetIds)),
          ];
          const prompt = await allDb<{ id: number }>(
            await database(),
            `SELECT id FROM connections WHERE credential_mode='prompt' AND id IN (${actionTargets.map(() => "?").join(",")})`,
            actionTargets,
          );
          if (
            run.settings.mode === "manual" ||
            prompt.some((p) => !state.credentials[p.id])
          ) {
            run.phase = "approval";
            break;
          }
          await executeActions(run, actions, state);
        }
        if (state.stop) {
          run.phase = "cancelled";
          run.approval = undefined;
          add(run, { type: "cancelled", text: "Execution stopped." });
        } else if (state.pause) {
          run.phase = run.approval ? "approval" : "paused";
          add(run, { type: "paused", text: "Automatic execution paused." });
        }
      } catch (e) {
        // Do not leave an unobserved SSH job running after runner/persistence errors.
        if (run.activeJob)
          await cancelJob(run.activeJob, run.user).catch(() => {});
        run.phase = state.stop
          ? "cancelled"
          : state.pause
            ? "paused"
            : "failed";
        run.approval = undefined;
        const text = e instanceof Error ? e.message : "Agent operation failed.";
        run.error = redact(
          text,
          await known(run, state.credentials).catch(() => []),
        );
        add(run, { type: "error", text: run.error });
      } finally {
        state.credentials = {};
        try {
          await persist(run);
        } finally {
          active.delete(run.id);
        }
      }
    })().catch(() => {
      console.error("[Agent] Unable to persist final task state.");
    });
  }
  const handle =
    (fn: (req: any, res: any, user: number) => Promise<void>) =>
    async (req: any, res: any) => {
      try {
        await fn(req, res, req.session.userId);
      } catch (e) {
        res.status(400).json({
          message:
            e instanceof Error && !/SQLITE|decrypt/i.test(e.message)
              ? e.message
              : "Agent operation failed.",
        });
      }
    };
  const mutate = (fn: (req: any, res: any, user: number) => Promise<void>) =>
    handle(async (req, res, user) => {
      const id = `user:${user}`;
      if (locks.has(id)) throw new Error("Task update in progress.");
      locks.add(id);
      try {
        await fn(req, res, user);
      } finally {
        locks.delete(id);
      }
    });
  router.get(
    "/",
    handle(async (_req, res, user) => {
      const rows = await allDb<{
        encrypted_body?: string;
        encrypted_summary?: string;
      }>(
        await database(),
        "SELECT encrypted_summary,CASE WHEN encrypted_summary IS NULL THEN encrypted_body END AS encrypted_body FROM ai_agent_runs WHERE user_id=? ORDER BY updated_at DESC LIMIT 100",
        [user],
      );
      res.json(
        rows.map((row) => {
          return row.encrypted_summary
            ? JSON.parse(decrypt(row.encrypted_summary))
            : summary(JSON.parse(decrypt(row.encrypted_body!)));
        }),
      );
    }),
  );
  router.post(
    "/preview",
    handle(async (req, res, user) => {
      const {
        task,
        context = "",
        targetIds = [],
        includeInventory = false,
        includeMonitor = false,
      } = req.body;
      if (
        typeof task !== "string" ||
        task.length > 8000 ||
        typeof context !== "string" ||
        context.length > 64000 ||
        !Array.isArray(targetIds) ||
        targetIds.length > 50 ||
        targetIds.some((id) => !Number.isInteger(id) || id < 1)
      )
        throw new Error("Invalid context.");
      await deps.fingerprint(targetIds);
      const devices = await inventory(user);
      const monitor =
        includeMonitor === true ? await monitorSnapshot(user) : undefined;
      res.json({
        content: JSON.stringify(
          redactValue(
            {
              task,
              context,
              executionScope: targetIds,
              targets: devices.filter((d) => targetIds.includes(d.id)),
              inventory: includeInventory === true ? devices : undefined,
              monitoring: monitor,
            },
            await deps.secrets(user),
          ),
          null,
          2,
        ),
      });
    }),
  );
  router.post(
    "/",
    mutate(async (req, res, user) => {
      const {
        task,
        context = "",
        targetIds = [],
        settings = {},
        includeMonitor = false,
        includeInventory = false,
      } = req.body;
      if (
        typeof task !== "string" ||
        !task.trim() ||
        task.length > 8000 ||
        typeof context !== "string" ||
        context.length > 64000 ||
        !Array.isArray(targetIds) ||
        targetIds.length > 50 ||
        targetIds.some((id) => !Number.isInteger(id) || id < 1)
      )
        throw new Error("Invalid task, context or target scope.");
      if (req.body.confirmSend !== true)
        throw new Error(
          "Approve sending this task to the configured provider.",
        );
      if (
        (
          await allDb(
            await database(),
            "SELECT id FROM ai_agent_runs WHERE user_id=? AND phase IN ('thinking','executing','approval','paused')",
            [user],
          )
        ).length >= 5
      )
        throw new Error(
          "Finish or stop an existing task (maximum 5 active tasks).",
        );
      if (
        (
          await getDb(
            await database(),
            "SELECT COUNT(*) AS n FROM ai_agent_runs WHERE user_id=?",
            [user],
          )
        ).n >= 100
      )
        throw new Error("Delete old tasks before creating more (maximum 100).");
      const c = await deps.config(user);
      if (!c.key) throw new Error("Configure an AI API first.");
      const chosen = runSettings(settings, c.model);
      if (chosen.mode === "auto" && req.body.confirmAuto !== true)
        throw new Error("Explicit task automation approval is required.");
      const ids = [...new Set<number>(targetIds)];
      if (chosen.mode !== "analysis" && !ids.length)
        throw new Error("Select at least one SSH server.");
      const fingerprint = await deps.fingerprint(ids),
        redactions = await deps.secrets(user),
        now = Date.now();
      const run: Run = {
        id: randomUUID(),
        user,
        title: redact(task, redactions).slice(0, 150),
        objective: redact(task, redactions),
        context: redact(context, redactions),
        targetIds: ids,
        settings: chosen,
        phase: "thinking",
        round: 0,
        revision: 0,
        createdAt: now,
        updatedAt: now,
        base: c.base,
        configHash: hash(c),
        fingerprint,
        entries: [],
        includeMonitor: includeMonitor === true,
        includeInventory: includeInventory === true,
        deadline: now + 3600000,
      };
      add(run, { type: "user", text: run.objective });
      await persist(run);
      await deps.event(user, "agent_started");
      await drive(run);
      res.status(202).json(publicRun(run));
    }),
  );
  router.get(
    "/:id",
    handle(async (req, res, user) => {
      const run = await read(req.params.id, user);
      const result: any =
        String(req.query.revision) === String(run.revision)
          ? { unchanged: true, revision: run.revision }
          : publicRun(run);
      if (run.activeJob) {
        const job = await getJobDetail(run.activeJob, user);
        result.liveJob = job
          ? reviewEvidence(redactValue(job, await deps.secrets(user)))
          : null;
      }
      res.json(result);
    }),
  );
  router.post(
    "/:id/settings",
    mutate(async (req, res, user) => {
      const run = await read(req.params.id, user);
      if (
        active.has(run.id) ||
        ["cancelled", "interrupted", "limited"].includes(run.phase)
      )
        throw new Error(
          "Pause or finish the current round before changing task settings.",
        );
      await validate(run);
      const settings = runSettings(req.body.settings, run.settings.model);
      if (terminal.has(run.phase)) await capacity(user, run.id);
      if (settings.mode !== "analysis" && !run.targetIds.length)
        throw new Error("This discussion has no SSH scope. Start a new task.");
      if (
        settings.mode === "auto" &&
        run.settings.mode !== "auto" &&
        req.body.confirmAuto !== true
      )
        throw new Error("Explicit task automation approval is required.");
      run.settings = settings;
      run.approval = undefined;
      run.error = undefined;
      run.phase = "paused";
      add(run, {
        type: "settings",
        text: `${settings.model} · reasoning: ${settings.reasoning} · approval: ${settings.mode}`,
      });
      await persist(run);
      await deps.event(user, "agent_settings_changed");
      res.json(publicRun(run));
    }),
  );
  router.post(
    "/:id/approve",
    mutate(async (req, res, user) => {
      const run = await read(req.params.id, user);
      if (
        active.has(run.id) ||
        run.phase !== "approval" ||
        !run.approval ||
        req.body.approvalId !== run.approval.id ||
        req.body.confirm !== true
      )
        throw new Error("Approval expired or already used.");
      await validate(run);
      const supplied = await credentials(
        req.body.ephemeralCredentials,
        run.targetIds,
      );
      const actions = run.approval.actions;
      const actionTargets = [
        ...new Set(actions.flatMap((action) => action.targetIds)),
      ];
      const prompt = await allDb<{
        id: number;
        name: string;
        auth_method: string;
      }>(
        await database(),
        `SELECT id,name,auth_method FROM connections WHERE credential_mode='prompt' AND id IN (${actionTargets.map(() => "?").join(",")})`,
        actionTargets,
      );
      for (const target of prompt)
        if (target.auth_method === "password" && !supplied[target.id]?.password)
          throw new Error(`Temporary SSH password required: ${target.name}`);
      run.approval = undefined;
      add(run, {
        type: "approved",
        text: "Approved exact commands for this round.",
      });
      run.phase = "executing";
      await persist(run);
      await drive(run, actions, supplied);
      res.status(202).json(publicRun(run));
    }),
  );
  router.post(
    "/:id/message",
    mutate(async (req, res, user) => {
      const run = await read(req.params.id, user);
      if (
        active.has(run.id) ||
        run.phase === "cancelled" ||
        run.phase === "interrupted" ||
        run.phase === "limited"
      )
        throw new Error("Stop or wait for this task before continuing.");
      if (
        typeof req.body.message !== "string" ||
        !req.body.message.trim() ||
        req.body.message.length > 8000
      )
        throw new Error("Enter a message (maximum 8000 characters).");
      if (terminal.has(run.phase)) await capacity(user, run.id);
      await validate(run);
      run.approval = undefined;
      run.error = undefined;
      run.deadline = Date.now() + 3600000;
      if (
        req.body.context !== undefined &&
        (typeof req.body.context !== "string" ||
          req.body.context.length > 64000)
      )
        throw new Error("Attached context exceeds 64000 characters.");
      if (req.body.context)
        add(run, {
          type: "user",
          text: redact(
            "Attached context (untrusted data):\n" + req.body.context,
            await deps.secrets(user),
          ),
        });
      add(run, {
        type: "user",
        text: redact(req.body.message, await deps.secrets(user)),
      });
      run.phase = "thinking";
      await persist(run);
      await drive(run);
      res.status(202).json(publicRun(run));
    }),
  );
  router.post(
    "/:id/pause",
    mutate(async (req, res, user) => {
      const run = await read(req.params.id, user);
      const state = active.get(run.id);
      if (state) {
        state.pause = true;
        state.controller.abort();
      } else if (!terminal.has(run.phase)) {
        run.phase = run.approval ? "approval" : "paused";
        await persist(run);
      }
      res.json({ ok: true });
    }),
  );
  router.post(
    "/:id/stop",
    mutate(async (req, res, user) => {
      const run = await read(req.params.id, user);
      const state = active.get(run.id);
      if (state) {
        state.stop = true;
        state.controller.abort();
        if (run.activeJob) await cancelJob(run.activeJob, user).catch(() => {});
      } else {
        run.phase = "cancelled";
        run.approval = undefined;
        await persist(run);
      }
      await deps.event(user, "agent_stopped");
      res.json({ ok: true });
    }),
  );
  router.delete(
    "/:id",
    mutate(async (req, res, user) => {
      const run = await read(req.params.id, user);
      if (active.has(run.id) || !terminal.has(run.phase))
        throw new Error("Stop the task before deleting.");
      await runDb(
        await database(),
        "DELETE FROM ai_agent_runs WHERE id=? AND user_id=?",
        [run.id, user],
      );
      res.json({ ok: true });
    }),
  );
  return router;
}
