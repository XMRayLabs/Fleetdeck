<script setup lang="ts">
import {
  computed,
  ref,
  watch,
  onMounted,
  onBeforeUnmount,
  nextTick,
} from "vue";
import { useI18n } from "vue-i18n";
import api from "../utils/apiClient";
import { takeAiDraft } from "../utils/aiDraft";
import { useAuthStore } from "../stores/auth.store";
import { useAgentStore } from "../stores/agent.store";
import { useSessionStore } from "../stores/session.store";
import type { ConnectionInfo } from "../stores/connections.store";

const { t } = useI18n(),
  agent = useAgentStore(),
  sessions = useSessionStore();
const draft = takeAiDraft(useAuthStore().user?.id || 0);
const runs = ref<any[]>([]),
  current = ref<any>(null),
  connections = ref<ConnectionInfo[]>([]);
const selected = ref<number[]>(draft?.targets || []),
  task = ref(""),
  context = ref(draft?.context || ""),
  message = ref(""),
  search = ref("");
const error = ref(""),
  notice = ref(""),
  busy = ref(false),
  settingsOpen = ref(false),
  scopeOpen = ref(false),
  tasksOpen = ref(false);
const contextPreview = ref("");
const base = ref(""),
  apiKey = ref(""),
  hasKey = ref(false),
  models = ref<string[]>([]),
  model = ref("");
const savedBase = ref("");
const configDirty = computed(
  () => base.value !== savedBase.value || Boolean(apiKey.value),
);
const reasoning = ref("auto"),
  mode = ref("manual"),
  concurrency = ref(5),
  timeout = ref(120),
  maxRounds = ref(10);
const includeMonitor = ref(false),
  includeInventory = ref(false),
  consent = ref(false),
  autoConsent = ref(false),
  approvalConsent = ref(false);
const passwords = ref<
    Record<number, { password?: string; passphrase?: string }>
  >({}),
  matches = ref<any[]>([]),
  ambiguous = ref(false),
  legacy = ref<any[]>([]);
const end = ref<HTMLElement | null>(null),
  controller = new AbortController();
let disposed = false,
  poll: ReturnType<typeof setTimeout> | undefined;
const active = computed(() =>
  ["thinking", "executing"].includes(current.value?.phase),
);
const ended = computed(() =>
  ["completed", "failed", "cancelled", "interrupted", "limited"].includes(
    current.value?.phase,
  ),
);
const canFollow = computed(
  () =>
    current.value &&
    !active.value &&
    !["cancelled", "interrupted", "limited"].includes(current.value.phase),
);
const visible = computed(() =>
  connections.value.filter((c) =>
    `${c.name} ${c.host}`.toLowerCase().includes(search.value.toLowerCase()),
  ),
);
const promptTargets = computed(() =>
  connections.value.filter(
    (c) =>
      c.credential_mode === "prompt" &&
      current.value?.approval?.actions.some((a: any) =>
        a.targetIds.includes(c.id),
      ),
  ),
);
const efforts = [
  "auto",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const name = (id: number) =>
  connections.value.find((c) => c.id === id)?.name || `#${id}`;
const names = (ids: number[]) => ids.map(name).join(", ");
const phase = (s: string) => t(`wb.${s || "ready"}`);
async function perform(fn: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await fn();
  } catch (e: any) {
    if (!disposed)
      error.value = e.response?.data?.message || e.message || t("ai.failed");
  } finally {
    busy.value = false;
  }
}
async function scroll() {
  await nextTick();
  const timeline = end.value?.parentElement;
  if (timeline) timeline.scrollTop = timeline.scrollHeight;
}
async function list() {
  runs.value = (await api.get("/ai/runs", { signal: controller.signal })).data;
}
async function refresh() {
  if (!current.value) return;
  const id = current.value.id;
  const data = (
    await api.get("/ai/runs/" + id, {
      signal: controller.signal,
      params: { revision: current.value.revision },
    })
  ).data;
  if (current.value?.id !== id || data.revision < current.value.revision)
    return;
  if (data.unchanged) {
    current.value.liveJob = data.liveJob;
    return;
  }
  const changed = data.revision !== current.value.revision;
  current.value = data;
  if (changed) {
    await list();
    await scroll();
  }
}
function schedule() {
  clearTimeout(poll);
  if (!disposed)
    poll = setTimeout(
      async () => {
        try {
          if (current.value) await refresh();
          else await list();
        } catch (e: any) {
          if (!disposed) error.value = e.response?.data?.message || e.message;
        } finally {
          schedule();
        }
      },
      active.value ? 1500 : 8000,
    );
}
function openRun(id: string) {
  void perform(async () => {
    resetApprovalInputs();
    current.value = (await api.get("/ai/runs/" + id)).data;
    message.value = "";
    tasksOpen.value = false;
    resetApprovalInputs();
    await scroll();
    schedule();
  });
}
function resetApprovalInputs() {
  approvalConsent.value = false;
  passwords.value = {};
  for (const c of promptTargets.value) passwords.value[c.id] = {};
}
function fresh() {
  if (busy.value) return;
  current.value = null;
  task.value = "";
  context.value = "";
  message.value = "";
  consent.value = false;
  autoConsent.value = false;
  error.value = "";
  notice.value = "";
  matches.value = [];
  tasksOpen.value = false;
  contextPreview.value = "";
  approvalConsent.value = false;
  passwords.value = {};
  void nextTick(() => {
    const timeline = end.value?.parentElement;
    if (timeline) timeline.scrollTop = 0;
  });
}
async function readModels() {
  const { data } = await api.post(
    "/ai/models",
    { base: base.value, apiKey: apiKey.value },
    { timeout: 70000, signal: controller.signal },
  );
  models.value = data.models;
  if (!model.value || !data.models.includes(model.value))
    model.value = data.suggestedModel;
}
async function loadConfig() {
  const { data } = await api.get("/ai/config");
  base.value = data.base;
  savedBase.value = data.base;
  model.value = data.model;
  hasKey.value = data.hasKey;
  settingsOpen.value = !data.hasKey;
}
function saveConfig() {
  void perform(async () => {
    if (!model.value) await readModels();
    await api.put("/ai/config", {
      base: base.value,
      model: model.value,
      apiKey: apiKey.value || undefined,
    });
    apiKey.value = "";
    savedBase.value = base.value;
    hasKey.value = true;
    notice.value = t("wb.saved");
    settingsOpen.value = false;
  });
}
function testApi() {
  void perform(async () => {
    if (configDirty.value) throw new Error(t("agent.saveFirst"));
    await api.post(
      "/ai/test",
      {},
      { timeout: 70000, signal: controller.signal },
    );
    notice.value = t("ai.tested");
  });
}
function removeApi() {
  if (!window.confirm(t("ai.removeConfirm"))) return;
  void perform(async () => {
    await api.delete("/ai/config");
    base.value = "";
    savedBase.value = "";
    model.value = "";
    models.value = [];
    hasKey.value = false;
    apiKey.value = "";
  });
}
function start() {
  void perform(async () => {
    if (!hasKey.value || !model.value) throw new Error(t("wb.noModel"));
    if (mode.value !== "analysis" && !selected.value.length)
      throw new Error(t("wb.scopeRequired"));
    if (configDirty.value) throw new Error(t("agent.saveFirst"));
    current.value = (
      await api.post("/ai/runs", {
        task: task.value,
        context: context.value,
        targetIds: selected.value,
        settings: {
          model: model.value,
          reasoning: reasoning.value,
          mode: mode.value,
          concurrency: concurrency.value,
          timeoutSeconds: timeout.value,
          maxRounds: maxRounds.value,
        },
        includeMonitor: includeMonitor.value,
        includeInventory: includeInventory.value,
        confirmSend: consent.value,
        confirmAuto: autoConsent.value,
      })
    ).data;
    task.value = "";
    context.value = "";
    scopeOpen.value = false;
    await list();
    await scroll();
    schedule();
  });
}
function approve() {
  void perform(async () => {
    current.value = (
      await api.post("/ai/runs/" + current.value.id + "/approve", {
        approvalId: current.value.approval.id,
        confirm: approvalConsent.value,
        ephemeralCredentials: passwords.value,
      })
    ).data;
    passwords.value = {};
    approvalConsent.value = false;
    await list();
    schedule();
  });
}
function follow() {
  void perform(async () => {
    current.value = (
      await api.post("/ai/runs/" + current.value.id + "/message", {
        message: message.value,
        context: context.value,
      })
    ).data;
    message.value = "";
    context.value = "";
    await list();
    await scroll();
    schedule();
  });
}
function changeSetting(field: string, event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (
    field === "mode" &&
    value === "auto" &&
    current.value.settings.mode !== "auto" &&
    !window.confirm(t("wb.autoConsent"))
  ) {
    (event.target as HTMLSelectElement).value = current.value.settings.mode;
    return;
  }
  void perform(async () => {
    current.value = (
      await api.post("/ai/runs/" + current.value.id + "/settings", {
        settings: { ...current.value.settings, [field]: value },
        confirmAuto: field === "mode" && value === "auto",
      })
    ).data;
    await list();
  });
}
function control(action: "stop" | "pause") {
  void perform(async () => {
    await api.post("/ai/runs/" + current.value.id + "/" + action);
    await refresh();
    schedule();
  });
}
function remove() {
  if (!window.confirm(t("wb.deleteConfirm"))) return;
  void perform(async () => {
    await api.delete("/ai/runs/" + current.value.id);
    fresh();
    await list();
  });
}
function retry() {
  const old = current.value;
  fresh();
  task.value = old.objective;
  selected.value = old.targetIds;
  model.value = old.settings.model;
  reasoning.value = old.settings.reasoning;
  mode.value = old.settings.mode;
  concurrency.value = old.settings.concurrency;
  timeout.value = old.settings.timeoutSeconds;
  maxRounds.value = old.settings.maxRounds;
  includeMonitor.value = old.includeMonitor;
  includeInventory.value = old.includeInventory;
}
function download() {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(current.value, null, 2)], {
      type: "application/json",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `fleetdeck-agent-${current.value.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function capture(kind: "selection" | "recent") {
  if (
    !sessions.activeSessionId ||
    !agent.capture(sessions.activeSessionId, kind)
  )
    error.value = t("ops.noTerminal");
}
function resolve() {
  void perform(async () => {
    const { data } = await api.post("/ai/context/resolve", {
      task: task.value,
    });
    matches.value = data.matches;
    ambiguous.value = data.ambiguous;
    scopeOpen.value = true;
  });
}
function useMatches() {
  selected.value = matches.value.map((d) => d.id);
  matches.value = [];
}
function preview() {
  void perform(async () => {
    contextPreview.value = (
      await api.post("/ai/runs/preview", {
        task: task.value,
        context: context.value,
        targetIds: selected.value,
        includeMonitor: includeMonitor.value,
        includeInventory: includeInventory.value,
      })
    ).data.content;
  });
}
function loadLegacy(id: string) {
  void perform(async () => {
    const { data } = await api.get("/ai/context/conversations/" + id);
    fresh();
    context.value = JSON.stringify(data.turns);
    selected.value = data.targetIds.filter((id: number) =>
      connections.value.some((c) => c.id === id),
    );
  });
}
function outputs(entry: any) {
  return entry?.result?.targets || entry?.targets || [];
}
watch(
  [
    task,
    context,
    selected,
    model,
    reasoning,
    mode,
    concurrency,
    timeout,
    maxRounds,
    includeMonitor,
    includeInventory,
  ],
  () => {
    consent.value = false;
    autoConsent.value = false;
    contextPreview.value = "";
  },
  { deep: true },
);
watch(() => current.value?.approval?.id, resetApprovalInputs);
watch(
  () => agent.attachment,
  (value) => {
    if (!value) return;
    if (current.value?.targetIds.includes(value.connectionId)) {
      context.value = value.text;
      agent.attachment = null;
      return;
    }
    if (
      (current.value || context.value) &&
      !window.confirm(t("ops.switchScope"))
    ) {
      agent.attachment = null;
      return;
    }
    fresh();
    selected.value = [value.connectionId];
    context.value = value.text;
    agent.attachment = null;
  },
  { immediate: true },
);
watch(
  () => agent.monitorRequest,
  (value) => {
    if (value) {
      fresh();
      includeMonitor.value = true;
      includeInventory.value = true;
      task.value = t("ops.askMonitor");
    }
  },
  { immediate: true },
);
onMounted(() => {
  void perform(async () => {
    await loadConfig();
    connections.value = (
      await api.get<ConnectionInfo[]>("/connections")
    ).data.filter((c) => c.type === "SSH");
    await list();
    legacy.value = (await api.get("/ai/context/conversations")).data;
    if (hasKey.value) {
      try {
        await readModels();
      } catch (e: any) {
        error.value = e.response?.data?.message || e.message;
      }
    }
    schedule();
  });
});
onBeforeUnmount(() => {
  disposed = true;
  controller.abort();
  clearTimeout(poll);
});
</script>

<template>
  <div class="agent-workspace">
    <aside class="agent-rail" :class="{ 'is-open': tasksOpen }">
      <div class="rail-heading">
        <strong>{{ t("wb.tasks") }}</strong
        ><button type="button" :disabled="busy" @click="fresh">
          ＋ {{ t("wb.newTask") }}
        </button>
        <button
          class="rail-close"
          @click="tasksOpen = false"
          :aria-label="t('wb.exit')"
        >
          ×
        </button>
      </div>
      <div class="task-list">
        <p v-if="!runs.length" class="muted">{{ t("wb.empty") }}</p>
        <button
          v-for="run in runs"
          :key="run.id"
          class="task-item"
          :class="{ chosen: current?.id === run.id }"
          :disabled="busy"
          @click="openRun(run.id)"
        >
          <span class="task-title"
            ><i class="phase-dot" :class="run.phase" />{{ run.title }}</span
          ><span class="task-sub"
            >{{ phase(run.phase) }} · {{ run.model }}</span
          >
        </button>
      </div>
      <details v-if="legacy.length" class="legacy">
        <summary>{{ t("wb.history") }}</summary>
        <button
          v-for="chat in legacy"
          :key="chat.id"
          @click="loadLegacy(chat.id)"
          :title="t('wb.loadHistory')"
        >
          {{ chat.title }}
        </button>
      </details>
      <p class="rail-note">{{ t("wb.phaseNote") }}</p>
    </aside>
    <section class="agent-main">
      <header class="workbench-header">
        <button
          class="tasks-toggle"
          @click="tasksOpen = !tasksOpen"
          :aria-label="t('wb.tasks')"
        >
          ☰
        </button>
        <div class="header-title">
          <strong>{{ current?.title || t("wb.title") }}</strong
          ><span
            ><i class="phase-dot" :class="current?.phase" />{{
              phase(current?.phase)
            }}</span
          >
        </div>
        <button
          class="scope-toggle"
          :class="{ pressed: scopeOpen }"
          @click="scopeOpen = !scopeOpen"
        >
          {{ t("wb.scope") }}
          <b>{{ (current?.targetIds || selected).length }}</b>
        </button>
        <button @click="settingsOpen = !settingsOpen">
          {{ t("wb.settings") }}</button
        ><button
          v-if="current && !ended"
          class="danger"
          @click="control('stop')"
          :disabled="busy"
        >
          {{ t("wb.stop") }}
        </button>
      </header>
      <div v-if="error" role="alert" class="agent-alert">
        {{ error
        }}<button @click="error = ''" :aria-label="t('wb.exit')">×</button>
      </div>
      <div v-if="notice" role="status" class="agent-notice">{{ notice }}</div>
      <form
        v-if="settingsOpen"
        class="api-settings"
        @submit.prevent="saveConfig"
      >
        <p>{{ t("wb.apiHint") }}</p>
        <label
          >{{ t("wb.base")
          }}<input
            v-model.trim="base"
            type="url"
            required
            placeholder="http://cpa:8317/v1" /></label
        ><label
          >{{ t("wb.key")
          }}<input
            v-model="apiKey"
            type="password"
            autocomplete="new-password"
            :required="!hasKey"
        /></label>
        <div class="inline-actions">
          <button type="button" @click="perform(readModels)" :disabled="busy">
            {{ t("wb.models") }}</button
          ><button class="primary" :disabled="busy">{{ t("wb.save") }}</button
          ><button
            type="button"
            v-if="hasKey"
            @click="testApi"
            :disabled="busy"
          >
            {{ t("ai.test") }}</button
          ><button
            type="button"
            v-if="hasKey"
            @click="removeApi"
            class="danger"
            :disabled="busy"
          >
            {{ t("ai.remove") }}</button
          ><button type="button" @click="settingsOpen = false">
            {{ t("wb.exit") }}
          </button>
        </div>
      </form>
      <aside v-if="scopeOpen" class="scope-panel">
        <div class="scope-heading">
          <strong>{{ t("wb.scope") }}</strong
          ><button @click="scopeOpen = false" :aria-label="t('wb.closeScope')">
            ×
          </button>
        </div>
        <p class="muted">
          {{ current ? t("wb.scopeChange") : t("wb.scopeWarning") }}
        </p>
        <template v-if="!current"
          ><input
            v-model="search"
            :placeholder="t('wb.search')"
            :aria-label="t('wb.search')"
          />
          <div class="inline-actions">
            <button
              @click="
                selected = [
                  ...new Set([...selected, ...visible.map((c) => c.id)]),
                ]
              "
            >
              {{ t("wb.all") }}</button
            ><button @click="selected = []">{{ t("wb.clear") }}</button
            ><small>{{ selected.length }} / 50</small>
          </div>
          <div class="server-list">
            <label v-for="c in visible" :key="c.id" class="server"
              ><input
                v-model="selected"
                type="checkbox"
                :value="c.id"
                :disabled="!selected.includes(c.id) && selected.length >= 50"
              /><span
                ><strong>{{ c.name }}</strong
                ><small>{{ c.username }} · {{ c.host }}</small></span
              ></label
            >
            <p v-if="!visible.length" class="muted">{{ t("wb.emptyScope") }}</p>
          </div>
          <label class="check"
            ><input v-model="includeInventory" type="checkbox" />{{
              t("wb.inventory")
            }}</label
          ><label class="check"
            ><input v-model="includeMonitor" type="checkbox" />{{
              t("wb.monitor")
            }}</label
          >
          <div v-if="matches.length" class="matched">
            <strong>{{ t("wb.matches") }}</strong>
            <p>{{ names(matches.map((d) => d.id)) }}</p>
            <p v-if="ambiguous">{{ t("wb.ambiguous") }}</p>
            <button @click="useMatches">{{ t("wb.useMatches") }}</button>
          </div> </template
        ><template v-else
          ><p>{{ names(current.targetIds) || "—" }}</p>
          <p>{{ current.includeInventory ? t("wb.inventory") : "" }}</p>
          <p>{{ current.includeMonitor ? t("wb.monitor") : "" }}</p></template
        >
      </aside>
      <div class="timeline" aria-live="polite">
        <section v-if="!current" class="agent-welcome">
          <div class="agent-mark">⌘</div>
          <h1>{{ t("wb.welcome") }}</h1>
          <p>{{ t("wb.intro") }}</p>
          <div class="suggestions">
            <button v-for="n in 3" :key="n" @click="task = t('wb.example' + n)">
              {{ t("wb.example" + n) }} <span>↗</span>
            </button>
          </div>
          <small>{{ t("wb.redacted") }}</small>
        </section>
        <template v-else>
          <div class="task-metadata">
            <span>{{ current.settings.model }}</span
            ><span
              >{{ t("wb.reasoning") }}:
              {{ t("wb." + current.settings.reasoning) }}</span
            ><span>{{
              t(
                current.settings.mode === "auto"
                  ? "wb.autonomous"
                  : "wb." + current.settings.mode,
              )
            }}</span
            ><span
              >{{ t("wb.round") }} {{ current.round }} /
              {{ current.settings.maxRounds }}</span
            ><span>{{ current.targetIds.length }} {{ t("wb.servers") }}</span>
          </div>
          <article
            v-for="entry in current.entries"
            :key="entry.id"
            class="timeline-entry"
            :class="entry.type"
          >
            <div class="entry-heading">
              <strong>{{
                entry.type === "user"
                  ? t("agent.you")
                  : entry.type === "assistant"
                    ? "FleetDeck Agent"
                    : entry.type === "execution"
                      ? t("wb.executing")
                      : entry.type === "result"
                        ? t("wb.output")
                        : entry.type === "approved"
                          ? t("wb.approve")
                          : entry.type === "error"
                            ? t("wb.failed")
                            : phase(entry.type)
              }}</strong
              ><time>{{
                new Date(entry.at).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              }}</time>
            </div>
            <p v-if="entry.text" class="entry-text">{{ entry.text }}</p>
            <ol v-if="entry.plan?.length" class="agent-plan">
              <li v-for="(step, i) in entry.plan" :key="i">{{ step }}</li>
            </ol>
            <div
              v-for="(action, i) in entry.commands"
              :key="i"
              class="command-block"
            >
              <div>
                <strong>{{ names(action.targetIds) }}</strong
                ><span>{{ action.purpose }}</span>
              </div>
              <pre>{{ action.commands.join("\n") }}</pre>
            </div>
            <div
              v-for="(target, i) in outputs(entry)"
              :key="i"
              class="host-result"
            >
              <details :open="target.status === 'failed'">
                <summary>
                  {{ name(target.connectionId) }}
                  <span :class="target.status"
                    >{{ target.status
                    }}<template v-if="target.exitCode != null">
                      · exit {{ target.exitCode }}</template
                    ></span
                  >
                </summary>
                <pre
                  >{{ target.stdout || ""
                  }}{{ target.stderr ? "\n" + target.stderr : ""
                  }}{{ target.error ? "\n" + target.error : "" }}</pre
                >
              </details>
            </div>
          </article>
          <section v-if="active" class="agent-progress">
            <span class="progress-spinner" />{{ phase(current.phase)
            }}<span v-if="current.phase === 'executing'">
              · {{ t("wb.live") }}</span
            >
          </section>
          <section v-if="current.liveJob" class="live-job">
            <div
              v-for="target in outputs(current.liveJob)"
              :key="target.connectionId"
              class="host-result"
            >
              <details :open="target.status === 'running'">
                <summary>
                  {{ name(target.connectionId) }} · {{ target.status }}
                </summary>
                <pre>{{ target.stdout }}{{ target.stderr }}</pre>
              </details>
            </div>
          </section>
          <section
            v-if="current.phase === 'approval' && current.approval"
            class="approval-card"
          >
            <h3>{{ t("wb.approvalTitle") }}</h3>
            <div
              v-for="(action, i) in current.approval.actions"
              :key="i"
              class="command-block"
            >
              <div>
                <strong>{{ names(action.targetIds) }}</strong
                ><span>{{ action.purpose }}</span>
              </div>
              <pre>{{ action.commands.join("\n") }}</pre>
            </div>
            <div v-if="promptTargets.length" class="temporary-credentials">
              <p>{{ t("wb.temporary") }}</p>
              <div v-for="c in promptTargets" :key="c.id">
                <strong>{{ c.name }}</strong
                ><label v-if="c.auth_method === 'password'"
                  >{{ t("wb.password")
                  }}<input
                    v-if="passwords[c.id]"
                    v-model="passwords[c.id].password"
                    :disabled="busy"
                    type="password"
                    autocomplete="off" /></label
                ><label v-if="c.auth_method === 'key'"
                  >{{ t("wb.passphrase")
                  }}<input
                    v-if="passwords[c.id]"
                    v-model="passwords[c.id].passphrase"
                    :disabled="busy"
                    type="password"
                    autocomplete="off"
                /></label>
              </div>
            </div>
            <label class="check"
              ><input
                v-model="approvalConsent"
                :disabled="busy"
                type="checkbox"
              />{{ t("wb.approveConsent") }}</label
            ><button
              class="primary"
              :disabled="busy || !approvalConsent"
              @click="approve"
            >
              {{ t("wb.approve") }}
            </button>
            <p class="muted">{{ t("wb.rejectHint") }}</p>
          </section>
          <div class="task-actions">
            <button @click="perform(refresh)" :disabled="busy">
              {{ t("wb.refresh") }}</button
            ><button v-if="active" @click="control('pause')" :disabled="busy">
              {{ t("wb.pause") }}</button
            ><button v-if="!active" @click="retry">{{ t("wb.retry") }}</button
            ><button @click="download">{{ t("wb.export") }}</button
            ><button v-if="ended" class="danger" @click="remove">
              {{ t("wb.delete") }}
            </button>
          </div>
        </template>
        <div ref="end" />
      </div>
      <form class="composer" @submit.prevent="current ? follow() : start()">
        <template v-if="!current">
          <div class="attachment-actions">
            <button
              type="button"
              @click="resolve"
              :disabled="busy || !task.trim()"
            >
              {{ t("wb.resolve") }}
            </button>
            <details>
              <summary>{{ t("wb.capture") }}</summary>
              <button type="button" @click="capture('selection')">
                {{ t("wb.selection") }}</button
              ><button type="button" @click="capture('recent')">
                {{ t("wb.recent") }}
              </button>
            </details>
            <button type="button" @click="scopeOpen = !scopeOpen">
              {{ selected.length }} {{ t("wb.servers") }}
            </button>
          </div>
          <textarea
            v-model="task"
            :aria-label="t('wb.task')"
            :placeholder="t('wb.task')"
            rows="3"
            maxlength="8000"
            required
          />
          <details class="context-attachment" :open="!!context">
            <summary>
              {{ t("wb.logs") }}
              <span v-if="context"
                >({{ context.length.toLocaleString() }})</span
              >
            </summary>
            <textarea
              v-model="context"
              :aria-label="t('wb.logs')"
              rows="4"
              maxlength="64000"
            />
          </details>
          <div class="composer-controls">
            <label
              >{{ t("wb.model")
              }}<select v-model="model" :aria-label="t('wb.model')">
                <option value="">{{ t("wb.noModel") }}</option>
                <option v-if="model && !models.includes(model)" :value="model">
                  {{ model }}
                </option>
                <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
              </select></label
            ><label
              >{{ t("wb.reasoning")
              }}<select
                v-model="reasoning"
                :aria-label="t('wb.reasoning')"
                :title="t('wb.modelHint')"
              >
                <option v-for="e in efforts" :key="e" :value="e">
                  {{ t("wb." + e) }}
                </option>
              </select></label
            ><label
              >{{ t("wb.mode")
              }}<select v-model="mode" :aria-label="t('wb.mode')">
                <option value="analysis">{{ t("wb.analysis") }}</option>
                <option value="manual">{{ t("wb.manual") }}</option>
                <option value="auto">{{ t("wb.autonomous") }}</option>
              </select></label
            >
          </div>
          <p class="mode-hint">
            {{ t(mode === "auto" ? "wb.autoHint" : "wb." + mode + "Hint") }}
          </p>
          <details class="execution-limits">
            <summary>{{ t("wb.advanced") }}</summary>
            <p>{{ t("wb.modelHint") }}</p>
            <div>
              <label
                >{{ t("wb.manualModel")
                }}<input v-model.trim="model" maxlength="150" /></label
              ><label
                >{{ t("wb.concurrency")
                }}<input
                  v-model.number="concurrency"
                  type="number"
                  min="1"
                  max="20" /></label
              ><label
                >{{ t("wb.timeout")
                }}<input
                  v-model.number="timeout"
                  type="number"
                  min="10"
                  max="1800" /></label
              ><label
                >{{ t("wb.rounds")
                }}<input
                  v-model.number="maxRounds"
                  type="number"
                  min="1"
                  max="30"
              /></label>
            </div>
          </details>
          <button
            type="button"
            class="preview-context"
            @click="preview"
            :disabled="busy"
          >
            {{ t("ai.preview") }}
          </button>
          <details v-if="contextPreview" open class="context-preview">
            <summary>{{ t("ai.preview") }}</summary>
            <pre data-testid="agent-preview">{{ contextPreview }}</pre>
          </details>
          <label class="check consent"
            ><input v-model="consent" type="checkbox" />{{
              t("wb.consent")
            }}</label
          ><label v-if="mode === 'auto'" class="check auto-consent"
            ><input v-model="autoConsent" type="checkbox" />{{
              t("wb.autoConsent")
            }}</label
          >
          <div class="composer-bottom">
            <span>{{ hasKey ? base : t("wb.noModel") }}</span
            ><button
              class="primary start-task"
              :disabled="
                busy ||
                !task.trim() ||
                !consent ||
                (mode === 'auto' && !autoConsent)
              "
            >
              {{ busy ? t("wb.working") : t("wb.start") }} ↑
            </button>
          </div>
        </template>
        <template v-else>
          <div class="attachment-actions">
            <button type="button" @click="capture('selection')">
              {{ t("wb.selection") }}</button
            ><button type="button" @click="capture('recent')">
              {{ t("wb.recent") }}
            </button>
          </div>
          <details v-if="context" class="context-attachment" open>
            <summary>
              {{ t("wb.logs") }} ({{ context.length.toLocaleString() }})
            </summary>
            <textarea
              v-model="context"
              :aria-label="t('wb.logs')"
              rows="3"
              maxlength="64000"
            />
          </details>
          <textarea
            v-model="message"
            :disabled="!canFollow || busy"
            :aria-label="t('wb.follow')"
            :placeholder="
              active
                ? t('wb.activeHint')
                : !canFollow
                  ? t('wb.cancelledHint')
                  : t('wb.follow')
            "
            rows="2"
            maxlength="8000"
            required
          />
          <div class="composer-controls">
            <label
              >{{ t("wb.model")
              }}<select
                :value="current.settings.model"
                :disabled="!canFollow || busy"
                :aria-label="t('wb.model')"
                @change="changeSetting('model', $event)"
              >
                <option
                  v-if="!models.includes(current.settings.model)"
                  :value="current.settings.model"
                >
                  {{ current.settings.model }}
                </option>
                <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
              </select></label
            ><label
              >{{ t("wb.reasoning")
              }}<select
                :value="current.settings.reasoning"
                :disabled="!canFollow || busy"
                :aria-label="t('wb.reasoning')"
                @change="changeSetting('reasoning', $event)"
              >
                <option v-for="e in efforts" :key="e" :value="e">
                  {{ t("wb." + e) }}
                </option>
              </select></label
            ><label
              >{{ t("wb.mode")
              }}<select
                :value="current.settings.mode"
                :disabled="!canFollow || busy"
                :aria-label="t('wb.mode')"
                @change="changeSetting('mode', $event)"
              >
                <option value="analysis">{{ t("wb.analysis") }}</option>
                <option value="manual">{{ t("wb.manual") }}</option>
                <option value="auto">{{ t("wb.autonomous") }}</option>
              </select></label
            >
          </div>
          <div class="composer-bottom">
            <span>{{ t("wb.followConsent") }}</span
            ><button
              class="primary"
              :disabled="busy || !canFollow || !message.trim()"
            >
              {{ t("wb.send") }} ↑
            </button>
          </div></template
        >
      </form>
    </section>
  </div>
</template>

<style scoped src="./agent-workbench.css"></style>
