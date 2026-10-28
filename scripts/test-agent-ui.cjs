const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
module.exports = async (page, context, origin) => {
  let modelReads = 0,
    created,
    approved,
    heldTaskRead,
    run = null;
  await page.route("**/api/v1/ai/models", (r) => {
    modelReads++;
    return r.fulfill({
      json: {
        models: ["fixture-model", "fixture-instruct"],
        suggestedModel: "fixture-model",
      },
    });
  });
  const response = await context.request.post(origin + "/api/v1/connections", {
    data: {
      name: "ai-execution-fixture",
      type: "SSH",
      host: "192.0.2.99",
      port: 22,
      username: "operator",
      auth_method: "password",
      credential_mode: "prompt",
    },
  });
  assert.ok(response.ok());
  const { connection: device } = await response.json();
  await page.route("**/api/v1/ai/runs**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      suffix = url.pathname.split("/ai/runs")[1];
    if (suffix === "/preview") return route.continue();
    if (
      heldTaskRead &&
      req.method() === "GET" &&
      suffix === "/ui-task" &&
      !url.searchParams.has("revision")
    ) {
      const pending = heldTaskRead;
      heldTaskRead = null;
      await pending;
    }
    const body = req.method() === "POST" ? req.postDataJSON() : {};
    if (!suffix && req.method() === "POST") {
      created = body;
      run = {
        id: "ui-task",
        title: body.task,
        objective: body.task,
        targetIds: body.targetIds,
        settings: body.settings,
        round: 0,
        revision: 1,
        phase: body.settings.mode === "analysis" ? "completed" : "approval",
        includeMonitor: body.includeMonitor,
        includeInventory: body.includeInventory,
        entries: [
          { id: "u1", type: "user", at: Date.now(), text: body.task },
          {
            id: "a1",
            type: "assistant",
            at: Date.now(),
            text: "<img src=x onerror=alert(1)> Inspect the OS.",
            plan: ["Inspect system version"],
            commands:
              body.settings.mode === "analysis"
                ? []
                : [
                    {
                      targetIds: [device.id],
                      commands: ["uname -a"],
                      purpose: "Check OS",
                    },
                  ],
          },
        ],
      };
      if (run.phase === "approval")
        run.approval = {
          id: "exact-approval",
          actions: [
            {
              targetIds: [device.id],
              commands: ["uname -a"],
              purpose: "Check OS",
            },
          ],
        };
    } else if (suffix.endsWith("/approve")) {
      approved = body;
      run = {
        ...run,
        phase: "completed",
        round: 1,
        revision: run.revision + 1,
        approval: undefined,
        entries: [
          ...run.entries,
          {
            id: "r1",
            at: Date.now(),
            type: "result",
            result: {
              status: "success",
              targets: [
                {
                  connectionId: device.id,
                  status: "success",
                  exitCode: 0,
                  stdout: "Linux fixture",
                  stderr: "",
                },
              ],
            },
          },
          {
            id: "a2",
            at: Date.now(),
            type: "assistant",
            text: "Verified from SSH output.",
            commands: [],
          },
        ],
      };
    } else if (suffix.endsWith("/message")) {
      run = {
        ...run,
        revision: run.revision + 1,
        phase: "completed",
        approval: undefined,
        entries: [
          ...run.entries,
          { id: "u2", type: "user", at: Date.now(), text: body.message },
          {
            id: "a3",
            type: "assistant",
            at: Date.now(),
            text: "Follow-up response",
          },
        ],
      };
    } else if (suffix.endsWith("/settings"))
      run = {
        ...run,
        revision: run.revision + 1,
        phase: "paused",
        approval: undefined,
        settings: body.settings,
      };
    else if (suffix.endsWith("/stop"))
      run = {
        ...run,
        phase: "cancelled",
        approval: undefined,
        revision: run.revision + 1,
      };
    else if (req.method() === "DELETE") run = null;
    const result =
      !suffix && req.method() === "GET"
        ? run
          ? [{ ...run, model: run.settings.model }]
          : []
        : suffix.endsWith("/stop")
          ? { ok: true }
          : run;
    return route.fulfill({
      status: req.method() === "POST" ? 202 : 200,
      json: result,
    });
  });
  await page.goto(origin + "/ai", { waitUntil: "networkidle" });
  await page
    .getByLabel("API base URL", { exact: true })
    .fill("http://cpa:8317/v1");
  await page
    .getByLabel("API key (leave blank to keep)", { exact: true })
    .fill("fixture-ui-key-not-real");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "API settings saved" })
    .waitFor();
  assert.ok(modelReads > 0);
  assert.equal(
    (await (await context.request.get(origin + "/api/v1/ai/config")).json())
      .model,
    "fixture-model",
  );
  await page.getByRole("button", { name: /^Servers & context/ }).click();
  await page
    .locator(".server")
    .filter({ hasText: device.name })
    .getByRole("checkbox")
    .check();
  await page.getByRole("button", { name: "Close server selector" }).click();
  await page
    .getByLabel("Describe the task…", { exact: true })
    .fill("Check system");
  await page
    .getByLabel("Model", { exact: true })
    .selectOption("fixture-instruct");
  await page.getByLabel("Reasoning", { exact: true }).selectOption("high");
  await page.locator(".execution-limits summary").click();
  await page.getByLabel("Parallel servers (1–20)", { exact: true }).fill("12");
  assert.equal(
    await page.getByLabel("Command timeout (seconds)", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByLabel("Maximum rounds (1–30)", { exact: true }).count(),
    0,
  );
  await page.locator(".context-attachment summary").click();
  await page
    .getByLabel("Attached logs / context", { exact: true })
    .fill("password=browser-secret\nTOKEN=browser-token\nFilesystem full");
  await page
    .getByRole("button", { name: "Preview redacted content", exact: true })
    .click();
  const preview = page.getByTestId("agent-preview");
  await preview.waitFor();
  assert.ok(!(await preview.innerText()).includes("browser-secret"));
  assert.ok(!(await preview.innerText()).includes("browser-token"));
  const start = page.getByRole("button", { name: /^Start task/ });
  assert.ok(await start.isDisabled());
  await page.locator(".consent input").check();
  await start.click();
  await page.locator(".approval-card").waitFor();
  const temporaryPassword = page.getByLabel("Temporary SSH password", {
    exact: true,
  });
  const approvalConsent = page.getByLabel(
    "I approve these exact commands on the listed servers.",
    { exact: true },
  );
  let releaseTaskRead;
  heldTaskRead = new Promise((resolve) => {
    releaseTaskRead = resolve;
  });
  const taskReadRequested = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return (
      request.method() === "GET" &&
      url.pathname.endsWith("/ai/runs/ui-task") &&
      !url.searchParams.has("revision")
    );
  });
  try {
    await page
      .locator(".task-item")
      .filter({ hasText: "Check system" })
      .click();
    await taskReadRequested;
    assert.ok(
      await temporaryPassword.isDisabled(),
      "Do not accept credentials while a task reload can clear them",
    );
    assert.ok(
      await approvalConsent.isDisabled(),
      "Do not approve a task that is still loading",
    );
  } finally {
    releaseTaskRead();
  }
  assert.equal(created.settings.model, "fixture-instruct");
  assert.equal(created.settings.reasoning, "high");
  assert.equal(created.settings.concurrency, 12);
  assert.equal(created.settings.timeoutSeconds, undefined);
  assert.equal(created.settings.maxRounds, undefined);
  assert.deepEqual(created.targetIds, [device.id]);
  assert.equal(created.settings.mode, "manual");
  assert.equal(
    await page.locator(".timeline-entry img").count(),
    0,
    "Model output is plain text",
  );
  const approve = page.getByRole("button", {
    name: "Approve & execute",
    exact: true,
  });
  assert.ok(await approve.isDisabled());
  await temporaryPassword.fill("ephemeral-ui-secret");
  await approvalConsent.check();
  await approve.click();
  await page.getByText("Verified from SSH output.", { exact: true }).waitFor();
  assert.equal(approved.approvalId, "exact-approval");
  assert.equal(
    approved.ephemeralCredentials[device.id].password,
    "ephemeral-ui-secret",
  );
  assert.equal(approved.confirm, true);
  assert.equal(approved.commands, undefined);
  assert.equal(approved.targetIds, undefined);
  assert.equal(await page.locator(".approval-card").count(), 0);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".task-item").filter({ hasText: "Check system" }).click();
  await page.getByText("Verified from SSH output.", { exact: true }).waitFor();
  assert.ok(
    !(await page.evaluate(() => JSON.stringify(localStorage))).includes(
      "ephemeral-ui-secret",
    ),
  );
  await page.getByLabel("Model", { exact: true }).selectOption("fixture-model");
  await page.getByLabel("Reasoning", { exact: true }).selectOption("low");
  await page
    .getByLabel(
      "Add instructions, reject a proposal, or continue the discussion…",
      { exact: true },
    )
    .fill("Explain this result");
  await page.getByRole("button", { name: /^Send ↑/ }).click();
  await page.getByText("Follow-up response", { exact: true }).waitFor();
  assert.equal(run.settings.model, "fixture-model");
  assert.equal(run.settings.reasoning, "low");
  if (process.env.UI_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.UI_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(process.env.UI_SCREENSHOT_DIR, "1440-agent-task.png"),
      fullPage: true,
    });
  }
  await page
    .locator(".fd-nav")
    .getByRole("link", { name: "Monitoring", exact: true })
    .click();
  await page.getByRole("button", { name: "AI assistant", exact: true }).click();
  await page.locator(".fd-agent-dock").waitFor();
  await page.getByText("Follow-up response", { exact: true }).waitFor();
  const dock = await page.locator(".fd-agent-dock").boundingBox(),
    main = await page.locator("main.fd-console").boundingBox();
  assert.ok(
    main.x + main.width <= dock.x + 2,
    JSON.stringify({
      dock,
      main,
      css: await page.locator("main.fd-console").evaluate((el) => ({
        width: getComputedStyle(el).width,
        classes: el.className,
        style: el.getAttribute("style"),
        padding: getComputedStyle(el).padding,
        box: getComputedStyle(el).boxSizing,
        viewport: innerWidth,
      })),
    }),
  );
  await page.locator(".fd-agent-dock-header button").click();
  const telemetry = {
    source: "https://monitor.example",
    fetchedAt: Date.now(),
    servers: [
      {
        id: 7,
        name: "monitor-node",
        platform: "linux",
        lastActive: new Date().toISOString(),
        cpu: 12,
        memoryUsed: 1024,
        memoryTotal: 4096,
        diskUsed: 4096,
        diskTotal: 8192,
        load1: 0.1,
        load5: 0.2,
        load15: 0.3,
        netIn: 1024,
        netOut: 2048,
      },
    ],
  };
  await page.route("**/api/v1/ai/context/monitor/snapshot", (r) =>
    r.fulfill({ json: telemetry }),
  );
  await page
    .getByLabel("Public Nezha dashboard URL", { exact: true })
    .fill("https://monitor.example");
  await page
    .locator("form")
    .filter({
      has: page.getByLabel("Public Nezha dashboard URL", { exact: true }),
    })
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await page.getByText("monitor-node", { exact: true }).waitFor();
  assert.ok(
    (await page.locator(".monitor-table").innerText()).includes("12.0%"),
  );
  await page
    .getByLabel(device.name + " Device aliases", { exact: true })
    .fill("1号服务器");
  await page
    .locator(".monitor-alias")
    .filter({ hasText: device.name })
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Discuss with agent", exact: true })
    .click();
  await page
    .getByLabel("Describe the task…", { exact: true })
    .fill("1号服务器执行 uname -a");
  await page
    .getByRole("button", { name: "Resolve server aliases", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Use matched servers", exact: true })
    .click();
  assert.ok(
    await page
      .getByLabel("Share monitoring snapshot", { exact: true })
      .isChecked(),
  );
  assert.ok(
    await page
      .locator(".server")
      .filter({ hasText: device.name })
      .getByRole("checkbox")
      .isChecked(),
  );
  await page.getByRole("button", { name: "Close server selector" }).click();
  if (process.env.UI_SCREENSHOT_DIR) {
    await page.screenshot({
      path: path.join(process.env.UI_SCREENSHOT_DIR, "1440-agent-dock.png"),
      fullPage: true,
    });
  }
  await page.locator(".fd-agent-dock-header button").click();
  await page
    .locator(".fd-nav")
    .getByRole("link", { name: "AI assistant", exact: true })
    .click();
  await page.getByRole("button", { name: /^Servers & context/ }).click();
  await page.getByLabel("Share monitoring snapshot", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Close server selector" }).click();
  await page.getByLabel("Approval", { exact: true }).selectOption("auto");
  await page.locator(".consent input").check();
  assert.ok(
    await page.getByRole("button", { name: /^Start task/ }).isDisabled(),
  );
  await page.locator(".auto-consent input").check();
  await page.getByRole("button", { name: /^Start task/ }).click();
  await page.locator(".approval-card").waitFor();
  assert.equal(created.settings.mode, "auto");
  assert.equal(created.confirmAuto, true);
  await page.getByRole("button", { name: "Stop task", exact: true }).click();
  const followAfterStop = page.getByLabel(
    "Add instructions, reject a proposal, or continue the discussion…",
    { exact: true },
  );
  await followAfterStop.fill(
    "Continue in this same conversation after stopping",
  );
  await page.getByRole("button", { name: /^Send/ }).click();
  await page
    .getByText("Continue in this same conversation after stopping", {
      exact: true,
    })
    .waitFor();
  assert.equal(run.id, "ui-task");
  await page
    .getByRole("button", { name: "Copy to new task", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Copy to new task", exact: true })
    .click();
  await page.getByLabel("Approval", { exact: true }).selectOption("analysis");
  await page.locator(".consent input").check();
  await page.getByRole("button", { name: /^Start task/ }).click();
  await page
    .getByRole("button", { name: "Copy to new task", exact: true })
    .waitFor();
  assert.equal(await page.locator(".approval-card").count(), 0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 });
    if (width === 390) await page.locator(".tasks-toggle").click();
    if (process.env.UI_SCREENSHOT_DIR)
      await page.screenshot({
        path: path.join(process.env.UI_SCREENSHOT_DIR, `${width}-agent.png`),
        fullPage: true,
      });
    assert.ok(
      !(await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 2,
      )),
    );
    if (width === 390) {
      await page.locator(".task-item").first().click();
      await page.locator(".agent-rail.is-open").waitFor({ state: "hidden" });
      if (process.env.UI_SCREENSHOT_DIR)
        await page.screenshot({
          path: path.join(
            process.env.UI_SCREENSHOT_DIR,
            "390-agent-conversation.png",
          ),
          fullPage: true,
        });
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => {
    const s = document.documentElement.style;
    s.setProperty("--app-bg-color", "#101722");
    s.setProperty("--text-color", "#e4edf8");
    s.setProperty("--text-color-secondary", "#9dacbf");
  });
  await page.waitForTimeout(250);
  if (process.env.UI_SCREENSHOT_DIR)
    await page.screenshot({
      path: path.join(process.env.UI_SCREENSHOT_DIR, "1440-agent-dark.png"),
      fullPage: true,
    });
  const colors = await page.locator(".agent-workspace").evaluate((el) => ({
    bg: getComputedStyle(el).backgroundColor,
    text: getComputedStyle(el).color,
  }));
  assert.equal(colors.bg, "rgb(16, 23, 34)");
  assert.equal(colors.text, "rgb(228, 237, 248)");
  assert.equal(
    await page
      .locator(".workbench-header button")
      .last()
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(16, 23, 34)",
  );
  await page.evaluate(() => {
    for (const key of [
      "--app-bg-color",
      "--text-color",
      "--text-color-secondary",
    ])
      document.documentElement.style.removeProperty(key);
  });
  await page.unroute("**/api/v1/ai/context/monitor/snapshot");
  console.log(
    "PASS Agent browser: model/reasoning/limits, redacted preview, exact approval, temporary credentials, text output, reload and dock continuity",
  );
  await page.unroute("**/api/v1/ai/runs**");
  await page.unroute("**/api/v1/ai/models");
  await context.request.delete(origin + "/api/v1/connections/" + device.id);
};
