// Browser-only SSH/model fixtures; never connects to a real server or AI provider.
const assert = require("node:assert/strict");
const path = require("node:path");
module.exports = async (context, origin) => {
  const devices = [];
  const page = await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  const inputs = [];
  let run = null,
    created,
    approved,
    apiCalls = 0;
  const edit =
    "cp -p /tmp/agent-example.conf /tmp/agent-example.conf.bak && sed -i 's/workers=1/workers=2/' /tmp/agent-example.conf";
  try {
    for (const name of ["terminal-agent-a", "terminal-agent-b"]) {
      const response = await context.request.post(
        origin + "/api/v1/connections",
        {
          data: {
            name,
            type: "SSH",
            host: "192.0.2.200",
            port: 22,
            username: "fixture",
            auth_method: "password",
            password: "fixture-only",
          },
        },
      );
      assert.ok(response.ok());
      devices.push((await response.json()).connection);
    }
    await page.route("**/api/v1/ai/models", (r) =>
      r.fulfill({
        json: { models: ["fixture-model"], suggestedModel: "fixture-model" },
      }),
    );
    await page.route("**/api/v1/ai/runs**", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      const suffix = url.pathname.split("/ai/runs")[1];
      if (suffix === "/preview") return route.continue();
      if (request.method() === "POST") {
        apiCalls++;
        const body = request.postDataJSON();
        if (!suffix) {
          created = body;
          run = {
            id: "terminal-task",
            title: body.task,
            objective: body.task,
            targetIds: body.targetIds,
            settings: body.settings,
            phase: "approval",
            revision: 1,
            round: 0,
            entries: [
              { id: "u", at: Date.now(), type: "user", text: body.task },
            ],
            approval: {
              id: "terminal-edit-approval",
              actions: [
                {
                  targetIds: [devices[0].id],
                  commands: [edit],
                  purpose: "Fixture file change after inspection",
                },
              ],
            },
          };
        } else if (suffix.endsWith("/approve")) {
          approved = body;
          run = {
            ...run,
            phase: "completed",
            revision: 2,
            round: 1,
            approval: undefined,
            entries: [
              ...run.entries,
              {
                id: "r",
                at: Date.now(),
                type: "result",
                result: {
                  status: "success",
                  targets: [
                    {
                      connectionId: devices[0].id,
                      status: "success",
                      exitCode: 0,
                      stdout: "workers=2",
                      stderr: "",
                    },
                  ],
                },
              },
              {
                id: "a",
                at: Date.now(),
                type: "assistant",
                text: "File change verified from SSH output.",
              },
            ],
          };
        }
      }
      return route.fulfill({
        json: !suffix && request.method() === "GET" ? (run ? [run] : []) : run,
      });
    });
    await page.routeWebSocket("**/ws/", (ws) => {
      let connectionId,
        sent = false;
      ws.onMessage((raw) => {
        const m = JSON.parse(String(raw));
        if (m.type === "ssh:connect") {
          connectionId = Number(m.payload.connectionId);
          ws.send(
            JSON.stringify({
              type: "ssh:connected",
              payload: {
                sessionId: "agent-terminal-" + connectionId,
                connectionId,
              },
            }),
          );
        }
        if (m.type === "ssh:resize" && !sent) {
          sent = true;
          ws.send(
            JSON.stringify({
              type: "ssh:output",
              payload: `terminal host ${connectionId}\r\npassword=terminal-secret\r\n$ `,
            }),
          );
        }
        if (m.type === "ssh:input") inputs.push(m.payload.data);
      });
    });
    await page.goto(origin + "/", { waitUntil: "networkidle" });
    await page
      .locator("li")
      .filter({ hasText: devices[0].name })
      .getByRole("button", { name: "Connect", exact: true })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector(".xterm-rows")
        ?.textContent.includes("terminal host"),
    );
    const keyboard = page.locator(".terminal-inner-container:visible textarea");
    const toggle = page.getByTestId("terminal-agent-toggle");
    const dock = page.locator(".fd-agent-dock");
    await keyboard.focus();
    await page.keyboard.press("Control+i");
    await dock.waitFor({ state: "visible" });
    const task = dock.getByLabel("Describe the task…", { exact: true });
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute("aria-label") ===
        "Describe the task…",
    );
    assert.equal(
      inputs.length,
      0,
      "Opening Agent must never send Ctrl+I to SSH",
    );
    assert.equal(
      apiCalls,
      0,
      "Opening Agent must not send logs or start a task",
    );
    assert.ok(
      (await dock.getByTestId("agent-execution-scope").innerText()).includes(
        devices[0].name,
      ),
    );
    const box = await dock.boundingBox();
    assert.equal(box.y, 0, "Focus mode Agent starts at viewport top");
    assert.equal(box.height, 900);
    const terminalBox = await page
      .locator(".terminal-inner-container:visible")
      .boundingBox();
    assert.ok(
      terminalBox.x + terminalBox.width <= box.x + 2,
      "Agent must not cover the terminal",
    );
    await task.fill("Inspect and modify /tmp/agent-example.conf");
    await dock
      .getByRole("button", { name: "Preview redacted content", exact: true })
      .click();
    const preview = dock.getByTestId("agent-preview");
    await preview.waitFor();
    assert.ok(!(await preview.innerText()).includes("terminal-secret"));
    await dock.locator(".consent input").check();
    await dock.getByRole("button", { name: /^Start task/ }).click();
    await dock.locator(".approval-card").waitFor();
    assert.deepEqual(created.targetIds, [devices[0].id]);
    assert.ok(created.context.includes("terminal host"));
    assert.equal(created.settings.mode, "manual");
    assert.equal(approved, undefined, "An edit must wait for approval");
    assert.equal(await dock.locator(".approval-card pre").innerText(), edit);
    await dock
      .getByLabel("I approve these exact commands on the listed servers.", {
        exact: true,
      })
      .check();
    await dock
      .getByRole("button", { name: "Approve & execute", exact: true })
      .click();
    await dock
      .getByText("File change verified from SSH output.", { exact: true })
      .waitFor();
    assert.equal(approved.approvalId, "terminal-edit-approval");
    assert.equal(approved.commands, undefined);
    assert.equal(
      inputs.length,
      0,
      "Agent operations never type into the human SSH terminal",
    );
    await dock
      .getByLabel(
        "Add instructions, reject a proposal, or continue the discussion…",
        { exact: true },
      )
      .fill("Keep this discussion");
    await page.keyboard.press("Escape");
    await dock.waitFor({ state: "hidden" });
    assert.ok(
      await keyboard.evaluate((el) => el === document.activeElement),
      "Escape returns focus to terminal",
    );
    await page.getByTitle("New Connection Tab", { exact: true }).click();
    await page
      .locator(".popup-connection-list")
      .getByTitle(devices[1].name, { exact: true })
      .click();
    await page.waitForFunction(
      (id) =>
        [...document.querySelectorAll(".terminal-inner-container")].some(
          (el) =>
            el.offsetWidth && el.textContent.includes("terminal host " + id),
        ),
      devices[1].id,
    );
    await toggle.click();
    await dock.getByTestId("agent-terminal-request").waitFor();
    assert.ok(
      (await dock.getByTestId("agent-execution-scope").innerText()).includes(
        devices[0].name,
      ),
      "Changing terminal must preserve approved task target",
    );
    assert.ok(
      (await dock.locator(".scope-warning").innerText()).includes(
        devices[1].name,
      ),
    );
    assert.equal(
      await dock
        .getByLabel(
          "Add instructions, reject a proposal, or continue the discussion…",
          { exact: true },
        )
        .inputValue(),
      "Keep this discussion",
    );
    await dock
      .getByRole("button", { name: "New task on this server", exact: true })
      .click();
    assert.ok(
      (await dock.getByTestId("agent-execution-scope").innerText()).includes(
        devices[1].name,
      ),
    );
    assert.equal(
      apiCalls,
      2,
      "Switching context does not execute another task",
    );
    await task.fill("Unsent draft on server B");
    await toggle.click();
    await toggle.click();
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="agent-terminal-request"]'),
    );
    assert.equal(await task.inputValue(), "Unsent draft on server B");
    await dock.getByText("Attach terminal output", { exact: true }).click();
    await dock
      .getByRole("button", { name: "Recent output", exact: true })
      .click();
    await dock.getByTestId("agent-terminal-request").waitFor();
    await dock
      .getByRole("button", { name: "Keep current task", exact: true })
      .click();
    if (process.env.UI_SCREENSHOT_DIR)
      await page.screenshot({
        path: path.join(
          process.env.UI_SCREENSHOT_DIR,
          "terminal-agent-desktop.png",
        ),
      });
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileBox = await dock.boundingBox();
    assert.ok(
      mobileBox.x >= 0 && mobileBox.width <= 390 && mobileBox.height <= 844,
    );
    await task.focus();
    await page.keyboard.press("Escape");
    await dock.waitFor({ state: "hidden" });
    assert.ok(await toggle.isVisible(), "Mobile terminal retains Agent entry");
    await toggle.click();
    await dock.waitFor({ state: "visible" });
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="agent-terminal-request"]'),
    );
    if (process.env.UI_SCREENSHOT_DIR)
      await page.screenshot({
        path: path.join(
          process.env.UI_SCREENSHOT_DIR,
          "terminal-agent-mobile.png",
        ),
      });
    console.log(
      "PASS terminal Agent: cold open, Ctrl+I/Escape focus, redacted context, immutable edit approval, isolated SSH, two-host scope and draft protection, mobile layout",
    );
  } finally {
    await page.close();
    for (const device of devices)
      await context.request.delete(origin + "/api/v1/connections/" + device.id);
  }
};
