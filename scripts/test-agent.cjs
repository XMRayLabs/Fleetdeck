// Isolated database and local HTTP fixture. No production API or SSH is contacted.
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { createRequire } = require("node:module");
const { randomBytes } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "fleetdeck-agent-test-"),
);
process.env.DATA_DIR = temporary;
process.env.ENCRYPTION_KEY = randomBytes(32).toString("hex");
process.env.SESSION_SECRET = randomBytes(32).toString("hex");
const root = path.resolve(__dirname, "../packages/backend/dist");
const backendRequire = createRequire(
  path.resolve(__dirname, "../packages/backend/package.json"),
);
const db = require(path.join(root, "database/connection"));
const { encrypt, decrypt } = require(path.join(root, "utils/crypto"));
const provider = require(path.join(root, "ai/provider"));
const realAsk = provider.askAgentProvider;
const jobs = require(path.join(root, "orchestration/orchestration.service"));
let executed = [],
  contents = [],
  reply = () => ({ analysis: "All good", actions: [] }),
  jobStatus = "success",
  cancelled = 0,
  release;
provider.askAgentProvider = async (base, key, model, content, options) => {
  contents.push({ base, key, model, content, options });
  return JSON.stringify(await reply(JSON.parse(content), options));
};
jobs.createCommandJob = async (input, user) => {
  executed.push({ input, user });
  return "fixture-" + executed.length;
};
jobs.getJobDetail = async (id) => ({
  id,
  status: jobStatus,
  targets: [
    {
      connectionId: 1,
      status: jobStatus,
      exitCode: jobStatus === "success" ? 0 : 1,
      stdout: "Linux fixture\npassword=output-secret\nknown-secret",
      stderr: "",
      error: null,
    },
  ],
});
jobs.cancelJob = async () => {
  cancelled++;
  jobStatus = "cancelled";
};
let database, server;
(async () => {
  const http = require("node:http");
  let payloads = [];
  const fixture = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      payloads.push(JSON.parse(body));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '{"analysis":"OK","actions":[]}' } }],
        }),
      );
    });
  });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${fixture.address().port}/v1`;
    await realAsk(url, "fixture-key", "picked-model", "test", {
      reasoning: "high",
    });
    await realAsk(url, "fixture-key", "picked-model", "test", {
      reasoning: "auto",
    });
    assert.equal(payloads[0].reasoning_effort, "high");
    assert.equal(payloads[0].model, "picked-model");
    assert.equal(payloads[1].reasoning_effort, undefined);
    assert.equal(payloads[0].max_completion_tokens, 8192);
  } finally {
    await new Promise((r) => fixture.close(r));
  }
  console.log(
    "PASS Agent actual HTTP model and reasoning_effort parameters; provider default omitted",
  );
  const { runSettings, agentActions, agentHistory } = require(
    path.join(root, "ai/agent-runs"),
  );
  const noisy = Array.from({ length: 24 }, (_, i) => ({
    id: String(i),
    type: "result",
    at: i,
    result: {
      targets: Array.from({ length: 50 }, (_, id) => ({
        connectionId: id,
        status: "failed",
        exitCode: 1,
        stdout: "x".repeat(10000),
        stderr: "err",
        error: "failure",
      })),
    },
  }));
  const bounded = agentHistory(noisy);
  assert.ok(JSON.stringify(bounded).length < 150000);
  assert.equal(bounded.at(-1).result.targets.length, 50);
  assert.ok(
    bounded
      .at(-1)
      .result.targets.every(
        (v) => v.exitCode === 1 && v.stdout.includes("CONTEXT TRUNCATED"),
      ),
  );
  for (const bad of [
    { mode: "unsafe" },
    { reasoning: "anything" },
    { concurrency: 21 },
    { timeoutSeconds: 0 },
    { maxRounds: 31 },
  ])
    assert.throws(() => runSettings(bad, "model"));
  assert.throws(() =>
    agentActions([{ targetIds: [2], commands: ["true"] }], [1]),
  );
  assert.throws(() =>
    agentActions([{ targetIds: [1], commands: ["echo [REDACTED]"] }], [1]),
  );
  assert.throws(() =>
    agentActions([{ targetIds: [1], commands: Array(9).fill("true") }], [1]),
  );
  database = await db.getDbInstance();
  await db.runDb(
    database,
    "CREATE TABLE ai_agent_runs (id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,phase TEXT NOT NULL,updated_at INTEGER NOT NULL,encrypted_body TEXT NOT NULL)",
  );
  await db.runDb(database, "INSERT INTO ai_agent_runs VALUES (?,?,?,?,?)", [
    "before-restart",
    1,
    "executing",
    0,
    encrypt(
      JSON.stringify({
        id: "before-restart",
        user: 1,
        title: "Interrupted task",
        phase: "executing",
        entries: [],
        settings: { model: "old-model" },
        revision: 1,
        targetIds: [1],
      }),
    ),
  ]);
  await db.runDb(
    database,
    "INSERT INTO users (id,username,hashed_password) VALUES (1,?,?)",
    ["fixture", "not-a-login"],
  );
  for (const id of [1, 2])
    await db.runDb(
      database,
      "INSERT INTO connections (id,name,type,host,port,username,auth_method,encrypted_password) VALUES (?,?,?,?,?,?,?,?)",
      [
        id,
        "server-" + id,
        "SSH",
        "192.0.2." + id,
        22,
        "root",
        "password",
        encrypt("known-secret"),
      ],
    );
  const express = backendRequire("express"),
    app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = {
      userId: Number(req.get("fixture-user")) || undefined,
      username: "fixture",
    };
    next();
  });
  app.use("/ai", require(path.join(root, "ai/ai.routes")).default);
  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const url = `http://127.0.0.1:${server.address().port}/ai`;
  const call = async (method, route, data, user = 1) => {
    const res = await fetch(url + route, {
      method,
      headers: {
        "content-type": "application/json",
        "fixture-user": String(user),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: res.status, body: await res.json() };
  };
  const wait = async (id, phases) => {
    for (let i = 0; i < 150; i++) {
      const r = await call("GET", "/runs/" + id);
      assert.equal(r.status, 200);
      if (phases.includes(r.body.phase)) {
        await delay(15);
        return (await call("GET", "/runs/" + id)).body;
      }
      await delay(100);
    }
    throw new Error("Task did not enter " + phases);
  };
  const start = async (settings = {}, extra = {}) => {
    const r = await call("POST", "/runs", {
      task: "Check server health",
      targetIds: [1, 2],
      context: "password=input-secret\nknown-secret",
      settings: {
        model: "picked-model",
        reasoning: "high",
        mode: "manual",
        concurrency: 12,
        ...settings,
      },
      confirmSend: true,
      ...extra,
    });
    assert.equal(r.status, 202, JSON.stringify(r));
    return r.body;
  };
  assert.equal((await call("GET", "/runs", undefined, 0)).status, 401);
  assert.equal(
    (await call("GET", "/runs/before-restart")).body.phase,
    "interrupted",
  );
  assert.equal(executed.length, 0);
  console.log(
    "PASS Agent restart recovery marks interrupted tasks without resuming SSH execution",
  );
  assert.equal(
    (
      await call("PUT", "/config", {
        base: "http://cpa:8317/v1",
        apiKey: "fixture-api-key",
        model: "default-model",
      })
    ).status,
    200,
  );
  assert.equal(
    (await call("POST", "/runs", { task: "x", confirmSend: false })).status,
    400,
  );
  assert.equal(
    (
      await call("POST", "/runs", {
        task: "x",
        targetIds: [1],
        settings: { mode: "auto" },
        confirmSend: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("POST", "/runs", {
        task: "x",
        targetIds: [500],
        settings: { mode: "manual" },
        confirmSend: true,
      })
    ).status,
    400,
  );
  const preview = await call("POST", "/runs/preview", {
    task: "test",
    targetIds: [1],
    context: "password=input-secret\nknown-secret",
  });
  assert.equal(preview.status, 200);
  assert.ok(!preview.body.content.includes("input-secret"));
  assert.ok(!preview.body.content.includes("known-secret"));
  const proposal = {
    analysis: "Inspect hosts",
    plan: ["Check versions"],
    actions: [
      { targetIds: [1], commands: ["uname -a"], purpose: "OS" },
      { targetIds: [2], commands: ["df -h"], purpose: "Disk" },
    ],
  };
  reply = () => proposal;
  const analysis = await start({ mode: "analysis" });
  await wait(analysis.id, ["completed"]);
  assert.equal(executed.length, 0);
  assert.equal(contents.at(-1).model, "picked-model");
  assert.equal(contents.at(-1).options.reasoning, "high");
  assert.ok(!contents.at(-1).content.includes("input-secret"));
  assert.ok(!contents.at(-1).content.includes("known-secret"));
  const run = await start();
  let pending = await wait(run.id, ["approval"]);
  assert.equal(executed.length, 0);
  assert.equal(
    (await call("GET", "/runs/" + run.id, undefined, 2)).status,
    400,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/runs/" + run.id + "/approve",
        { approvalId: pending.approval.id, confirm: true },
        2,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call("POST", "/runs/" + run.id + "/approve", {
        approvalId: pending.approval.id,
        confirm: false,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("POST", "/runs/" + run.id + "/approve", {
        approvalId: "fake",
        confirm: true,
      })
    ).status,
    400,
  );
  reply = () => ({ analysis: "Reviewed actual results", actions: [] });
  assert.equal(
    (
      await call("POST", "/runs/" + run.id + "/approve", {
        approvalId: pending.approval.id,
        confirm: true,
      })
    ).status,
    202,
  );
  assert.equal(
    (
      await call("POST", "/runs/" + run.id + "/approve", {
        approvalId: pending.approval.id,
        confirm: true,
      })
    ).status,
    400,
  );
  const complete = await wait(run.id, ["completed"]);
  const same = await call(
    "GET",
    "/runs/" + run.id + "?revision=" + complete.revision,
  );
  assert.equal(same.body.unchanged, true);
  assert.equal(same.body.entries, undefined);
  assert.equal(executed.length, 2);
  assert.deepEqual(executed[0].input.targetIds, [1]);
  assert.deepEqual(executed[1].input.commands, ["df -h"]);
  assert.equal(executed[0].input.concurrency, 12);
  assert.ok(executed[0].input.redactOutput);
  assert.ok(contents.at(-1).content.includes("Linux fixture"));
  assert.ok(!JSON.stringify(complete).includes("output-secret"));
  assert.ok(!JSON.stringify(complete).includes("known-secret"));
  const row = await db.getDb(
    database,
    "SELECT encrypted_body FROM ai_agent_runs WHERE id=?",
    [run.id],
  );
  assert.ok(!row.encrypted_body.includes("Inspect hosts"));
  assert.ok(!decrypt(row.encrypted_body).includes("input-secret"));
  assert.equal(
    (
      await call(
        "POST",
        "/runs/" + run.id + "/settings",
        { settings: { ...complete.settings, mode: "auto" } },
        2,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call("POST", "/runs/" + run.id + "/settings", {
        settings: { ...complete.settings, mode: "auto" },
      })
    ).status,
    400,
  );
  const switched = await call("POST", "/runs/" + run.id + "/settings", {
    settings: {
      ...complete.settings,
      model: "second-model",
      reasoning: "low",
      mode: "auto",
    },
    confirmAuto: true,
  });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.phase, "paused");
  assert.equal(switched.body.settings.model, "second-model");
  assert.equal(
    (
      await call("POST", "/runs/" + run.id + "/message", {
        message: "Summarize again",
        context: "Fresh log password=followup-secret\nconnection refused",
      })
    ).status,
    202,
  );
  await wait(run.id, ["completed"]);
  assert.equal(contents.at(-1).model, "second-model");
  assert.equal(contents.at(-1).options.reasoning, "low");
  assert.ok(contents.at(-1).content.includes("connection refused"));
  assert.ok(!contents.at(-1).content.includes("followup-secret"));
  console.log(
    "PASS Agent per-round approval, immutable host-specific commands, owner isolation, replay denial, real-result review and encrypted/redacted history",
  );
  reply = () => proposal;
  const rejected = await start();
  pending = await wait(rejected.id, ["approval"]);
  const oldApproval = pending.approval.id;
  reply = () => ({ analysis: "No changes requested", actions: [] });
  assert.equal(
    (
      await call("POST", "/runs/" + rejected.id + "/message", {
        message: "Do not execute; explain only.",
      })
    ).status,
    202,
  );
  await wait(rejected.id, ["completed"]);
  assert.equal(
    (
      await call("POST", "/runs/" + rejected.id + "/approve", {
        approvalId: oldApproval,
        confirm: true,
      })
    ).status,
    400,
  );
  const beforeAuto = executed.length;
  reply = (content) =>
    content.round === 0 ? proposal : { analysis: "Verified", actions: [] };
  const automatic = await start({ mode: "auto" }, { confirmAuto: true });
  await wait(automatic.id, ["completed"]);
  assert.equal(executed.length, beforeAuto + 2);
  reply = () => proposal;
  const limited = await start(
    { mode: "auto", maxRounds: 1 },
    { confirmAuto: true },
  );
  await wait(limited.id, ["limited"]);
  assert.equal(executed.length, beforeAuto + 4);
  console.log(
    "PASS Agent proposal rejection by discussion, authorized multi-host automation, and hard round limit",
  );
  await db.runDb(
    database,
    "UPDATE connections SET credential_mode='prompt' WHERE id=1",
  );
  reply = () => ({
    analysis: "Inspect prompt server",
    actions: [{ targetIds: [1], commands: ["uname -a"], purpose: "Check" }],
  });
  const prompted = await start({ mode: "auto" }, { confirmAuto: true });
  pending = await wait(prompted.id, ["approval"]);
  const beforePrompt = executed.length;
  assert.equal(
    (
      await call("POST", "/runs/" + prompted.id + "/approve", {
        approvalId: pending.approval.id,
        confirm: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (await call("GET", "/runs/" + prompted.id)).body.approval.id,
    pending.approval.id,
  );
  assert.equal(
    (
      await call("POST", "/runs/" + prompted.id + "/approve", {
        approvalId: pending.approval.id,
        confirm: true,
        ephemeralCredentials: { 99: { password: "wrong" } },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("POST", "/runs/" + prompted.id + "/approve", {
        approvalId: pending.approval.id,
        confirm: true,
        ephemeralCredentials: { 1: { password: "temporary-secret" } },
      })
    ).status,
    202,
  );
  pending = await wait(prompted.id, ["approval"]);
  assert.equal(executed.length, beforePrompt + 1);
  assert.equal(
    executed.at(-1).input.ephemeralCredentials[1].password,
    "temporary-secret",
  );
  assert.ok(contents.every((c) => !c.content.includes("temporary-secret")));
  assert.ok(!JSON.stringify(pending).includes("temporary-secret"));
  assert.ok(
    !decrypt(
      (
        await db.getDb(
          database,
          "SELECT encrypted_body FROM ai_agent_runs WHERE id=?",
          [prompted.id],
        )
      ).encrypted_body,
    ).includes("temporary-secret"),
  );
  await call("POST", "/runs/" + prompted.id + "/stop", {});
  await db.runDb(
    database,
    "UPDATE connections SET credential_mode='saved' WHERE id=1",
  );
  console.log(
    "PASS Agent prompt credentials remain memory-only, are never sent to AI, and require renewed approval each round",
  );
  reply = () =>
    new Promise((r) => {
      release = () => r(proposal);
    });
  const stopped = await start({ mode: "auto" }, { confirmAuto: true });
  while (!release) await delay(10);
  const beforeStop = executed.length;
  await call("POST", "/runs/" + stopped.id + "/stop", {});
  release();
  release = undefined;
  await wait(stopped.id, ["cancelled"]);
  assert.equal(executed.length, beforeStop);
  reply = () =>
    new Promise((r) => {
      release = () => r(proposal);
    });
  const paused = await start({ mode: "auto" }, { confirmAuto: true });
  while (!release) await delay(10);
  await call("POST", "/runs/" + paused.id + "/pause", {});
  release();
  release = undefined;
  await wait(paused.id, ["paused"]);
  assert.equal(executed.length, beforeStop);
  reply = () => ({ analysis: "Continue discussion", actions: [] });
  await call("POST", "/runs/" + paused.id + "/message", {
    message: "Discuss only now",
  });
  await wait(paused.id, ["completed"]);
  reply = () => proposal;
  const changed = await start();
  pending = await wait(changed.id, ["approval"]);
  await db.runDb(
    database,
    "UPDATE connections SET host='192.0.2.50' WHERE id=1",
  );
  assert.equal(
    (
      await call("POST", "/runs/" + changed.id + "/approve", {
        approvalId: pending.approval.id,
        confirm: true,
      })
    ).status,
    400,
  );
  await call("POST", "/runs/" + changed.id + "/stop", {});
  reply = () => ({
    analysis: "Out of scope",
    actions: [{ targetIds: [999], commands: ["true"] }],
  });
  const outside = await start();
  await wait(outside.id, ["failed"]);
  assert.equal(executed.length, beforeStop);
  console.log(
    "PASS Agent stop/pause during model calls, safe continuation, changed SSH configuration invalidation and out-of-scope command rejection",
  );
  reply = () => ({
    analysis: "Run",
    actions: [{ targetIds: [1], commands: ["sleep 5"] }],
  });
  jobStatus = "running";
  const inFlight = await start({ mode: "auto" }, { confirmAuto: true });
  await wait(inFlight.id, ["executing"]);
  await call("POST", "/runs/" + inFlight.id + "/stop", {});
  await wait(inFlight.id, ["cancelled"]);
  assert.ok(cancelled > 0);
  jobStatus = "success";
  assert.equal(
    (await call("DELETE", "/runs/" + run.id, undefined, 2)).status,
    400,
  );
  assert.equal((await call("DELETE", "/runs/" + run.id)).status, 200);
  assert.equal((await call("GET", "/runs/" + run.id)).status, 400);
  console.log(
    "PASS Agent running SSH job cancellation, owner-scoped task export/detail/deletion",
  );
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (release) release();
    if (server) await new Promise((r) => server.close(r));
    if (database) await new Promise((r) => database.close(r));
    if (
      path.dirname(temporary) === os.tmpdir() &&
      path.basename(temporary).startsWith("fleetdeck-agent-test-")
    )
      fs.rmSync(temporary, { recursive: true, force: true });
  });
