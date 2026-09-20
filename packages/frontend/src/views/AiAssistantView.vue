<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import api from '../utils/apiClient';
import { takeAiDraft } from '../utils/aiDraft';
import { useAuthStore } from '../stores/auth.store';
import type { ConnectionInfo } from '../stores/connections.store';

const { t } = useI18n();
const draft = takeAiDraft(useAuthStore().user?.id || 0);
const task = ref('');
const context = ref(draft?.context || '');
const selected = ref<number[]>(draft?.targets || []);
const connections = ref<ConnectionInfo[]>([]);
const search = ref('');
const base = ref(''); const model = ref(''); const apiKey = ref(''); const hasKey = ref(false);
const configOpen = ref(false); const busy = ref(false); const message = ref(''); const error = ref('');
const preview = ref<{ previewId: string; content: string; base: string; model: string } | null>(null);
const answer = ref<{ analysis: string; commands: string[]; proposalId: string | null; targetIds: number[] } | null>(null);
const sendConsent = ref(false); const executeConsent = ref(false);
const passwords = ref<Record<number, string>>({});
const events = ref<{ action: string; job_id: string | null; created_at: number }[]>([]);
const job = ref<any>(null);
let disposed = false; let poll: ReturnType<typeof setTimeout> | undefined;
const controller = new AbortController();
const targets = computed(() => connections.value.filter(c => selected.value.includes(c.id)));
const visibleConnections = computed(() => connections.value.filter(c => `${c.name} ${c.host}`.toLowerCase().includes(search.value.toLowerCase())));
const promptTargets = computed(() => targets.value.filter(c => c.credential_mode === 'prompt'));
const activeJob = computed(() => ['queued', 'running'].includes(job.value?.status));

function invalidate() { preview.value = null; answer.value = null; sendConsent.value = false; executeConsent.value = false; passwords.value = {}; }
watch([task, context, selected], invalidate, { deep: true });
watch([base, model, apiKey], invalidate);
async function run(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true; error.value = ''; message.value = '';
  try { await action(); }
  catch (e: any) { if (!disposed) error.value = e.response?.data?.message || t('ai.failed'); }
  finally { busy.value = false; }
}
async function loadConfig() {
  const { data } = await api.get('/ai/config', { signal: controller.signal });
  base.value = data.base; model.value = data.model; hasKey.value = data.hasKey;
  configOpen.value = !data.hasKey;
}
async function loadEvents() { events.value = (await api.get('/ai/events', { signal: controller.signal })).data; }
function saveConfig() { void run(async () => {
  try { await api.put('/ai/config', { base: base.value, model: model.value, apiKey: apiKey.value }, { signal: controller.signal }); }
  finally { apiKey.value = ''; }
  invalidate(); await loadConfig(); message.value = t('ai.saved'); await loadEvents();
}); }
function testConfig() { void run(async () => { await api.post('/ai/test', {}, { timeout: 70000, signal: controller.signal }); message.value = t('ai.tested'); await loadEvents(); }); }
function deleteConfig() {
  if (!window.confirm(t('ai.removeConfirm'))) return;
  void run(async () => { await api.delete('/ai/config'); invalidate(); await loadConfig(); await loadEvents(); });
}
function makePreview() { void run(async () => {
  invalidate();
  preview.value = (await api.post('/ai/preview', { task: task.value, context: context.value, targetIds: selected.value }, { signal: controller.signal })).data;
}); }
function analyze() { if (!preview.value || !sendConsent.value) return; void run(async () => {
  const id = preview.value!.previewId;
  try { answer.value = (await api.post('/ai/analyze', { previewId: id, confirm: true }, { timeout: 70000, signal: controller.signal })).data; }
  finally { preview.value = null; sendConsent.value = false; }
  await loadEvents();
}); }
async function refreshJob(id: string) {
  clearTimeout(poll);
  const result = await api.get('/ai/jobs/' + encodeURIComponent(id), { signal: controller.signal });
  if (disposed) return;
  job.value = result.data.job;
  if (activeJob.value) poll = setTimeout(() => {
    void refreshJob(id).catch(() => { if (!disposed) error.value = t('ai.failed'); });
  }, 5000);
}
function execute() { if (!answer.value?.proposalId || !executeConsent.value) return; void run(async () => {
  const ephemeralCredentials: Record<string, { password?: string; passphrase?: string }> = {};
  for (const c of promptTargets.value) {
    const secret = passwords.value[c.id] || '';
    if (c.auth_method === 'password' && !secret) { error.value = t('ai.requiredPassword') + ' ' + c.name; return; }
    ephemeralCredentials[c.id] = c.auth_method === 'key' ? { passphrase: secret } : { password: secret };
  }
  let id: string;
  try { id = (await api.post('/ai/execute', { proposalId: answer.value!.proposalId, confirm: true, ephemeralCredentials })).data.jobId; }
  finally { passwords.value = {}; if (answer.value) answer.value.proposalId = null; executeConsent.value = false; }
  await loadEvents(); await refreshJob(id);
}); }
function stop() { void run(async () => { await api.post('/ai/jobs/' + encodeURIComponent(job.value.id) + '/cancel'); message.value = t('ai.cancelled'); await refreshJob(job.value.id); }); }
function follow() { context.value = JSON.stringify(job.value, null, 2).slice(0, 64000); invalidate(); }
onMounted(() => { void run(async () => {
  await loadConfig();
  connections.value = (await api.get<ConnectionInfo[]>('/connections', { signal: controller.signal })).data.filter(c => c.type === 'SSH');
  selected.value = selected.value.filter(id => connections.value.some(c => c.id === id));
  await loadEvents();
}); });
onBeforeUnmount(() => { disposed = true; controller.abort(); clearTimeout(poll); context.value = ''; apiKey.value = ''; passwords.value = {}; });
</script>

<template>
  <div class="ai-page">
    <p v-if="error" role="alert" class="ai-notice ai-error">{{ error }}</p>
    <p v-if="message" role="status" class="ai-notice">{{ message }}</p>
    <p v-if="busy" role="status">{{ t('ai.working') }}</p>
    <details :open="configOpen" class="ai-card" @toggle="configOpen = ($event.target as HTMLDetailsElement).open">
      <summary>{{ t('ai.config') }}</summary>
      <form @submit.prevent="saveConfig">
        <fieldset :disabled="busy" class="ai-config">
          <p class="ai-muted ai-wide">{{ t('ai.policy') }}</p>
          <label>{{ t('ai.base') }}<input v-model="base" type="url" required placeholder="https://api.example.com/v1" autocomplete="off" /></label>
          <label>{{ t('ai.model') }}<input v-model="model" required placeholder="model-id" autocomplete="off" /></label>
          <label class="ai-wide">{{ t('ai.key') }}<input v-model="apiKey" type="password" autocomplete="new-password" :placeholder="hasKey ? t('ai.keySaved') : 'API Key'" /></label>
          <div class="ai-actions ai-wide"><button class="ai-primary" type="submit">{{ t('ai.save') }}</button><button type="button" :disabled="!hasKey" @click="testConfig">{{ t('ai.test') }}</button><button type="button" :disabled="!hasKey" @click="deleteConfig">{{ t('ai.remove') }}</button></div>
        </fieldset>
      </form>
    </details>

    <fieldset :disabled="busy" class="ai-compose">
      <section class="ai-card ai-inputs">
        <label>{{ t('ai.task') }}<textarea v-model="task" rows="3" maxlength="8000" /></label>
        <label>{{ t('ai.logs') }}<textarea v-model="context" rows="10" maxlength="64000" spellcheck="false" class="ai-code" /></label>
        <p class="ai-muted">{{ t('ai.contextHint') }}</p>
        <p class="ai-muted">{{ t('ai.changeHint') }}</p>
        <button class="ai-primary" :disabled="!hasKey || !task.trim()" @click="makePreview">{{ t('ai.preview') }}</button>
      </section>
      <section class="ai-card ai-targets">
        <h2>{{ t('ai.targets') }} <span class="ai-count">{{ selected.length }}</span></h2>
        <p class="ai-muted">{{ t('ai.targetHint') }}</p>
        <input v-model="search" :placeholder="t('ai.search')" :aria-label="t('ai.search')" type="search" />
        <div class="ai-server-list">
          <label v-for="c in visibleConnections" :key="c.id" class="ai-check ai-server">
            <input v-model="selected" type="checkbox" :value="c.id" />
            <span><strong>{{ c.name || c.host }}</strong><small>{{ c.username }} · {{ c.host }}:{{ c.port }}</small></span>
          </label>
          <p v-if="!visibleConnections.length" class="ai-muted">{{ t('ai.empty') }}</p>
        </div>
      </section>
    </fieldset>

    <section v-if="preview" class="ai-card ai-stage">
      <h2>{{ t('ai.previewTitle') }}</h2>
      <p class="ai-destination">{{ preview.base }} · {{ preview.model }}</p>
      <p class="ai-notice">{{ t('ai.warning') }}</p>
      <pre class="ai-code ai-output" data-testid="ai-preview">{{ preview.content }}</pre>
      <label class="ai-check"><input v-model="sendConsent" type="checkbox" :disabled="busy" />{{ t('ai.sendConsent') }}</label>
      <button class="ai-primary" :disabled="busy || !sendConsent" @click="analyze">{{ t('ai.send') }}</button>
    </section>

    <section v-if="answer" class="ai-card ai-stage">
      <h2>{{ t('ai.result') }}</h2>
      <pre class="ai-analysis">{{ answer.analysis }}</pre>
      <p v-if="!answer.commands.length" class="ai-muted">{{ t('ai.noCommands') }}</p>
      <pre v-for="(command, index) in answer.commands" :key="index" class="ai-code ai-output">{{ command }}</pre>
      <template v-if="answer.proposalId">
        <p class="ai-notice">{{ t('ai.executeWarning') }}</p>
        <ul class="ai-approved-targets"><li v-for="c in targets" :key="c.id">{{ c.name }} — {{ c.username }} · {{ c.host }}:{{ c.port }}</li></ul>
        <label v-for="c in promptTargets" :key="c.id">{{ c.name }} · {{ t('ai.password') }}<input v-model="passwords[c.id]" :disabled="busy" type="password" autocomplete="new-password" /></label>
        <label class="ai-check"><input v-model="executeConsent" :disabled="busy" type="checkbox" />{{ t('ai.executeConsent') }}</label>
        <button class="ai-primary" :disabled="busy || !executeConsent || activeJob" @click="execute">{{ t('ai.execute') }}</button>
      </template>
    </section>

    <section v-if="job" class="ai-card ai-stage">
      <h2>{{ t('ai.job') }} · {{ job.status }}</h2>
      <p class="ai-muted">{{ job.id }} · {{ job.completedCount }}/{{ job.targetCount }}</p>
      <div class="ai-actions"><button :disabled="busy" @click="run(() => refreshJob(job.id))">{{ t('ai.refresh') }}</button><button v-if="activeJob" :disabled="busy" @click="stop">{{ t('ai.stop') }}</button><button :disabled="busy" @click="follow">{{ t('ai.follow') }}</button></div>
      <details v-for="target in job.targets" :key="target.id">
        <summary>{{ target.connectionName }} · {{ target.status }} · {{ target.exitCode }}</summary>
        <pre class="ai-code ai-output">{{ target.stdout }}{{ target.stderr }}{{ target.error }}</pre>
      </details>
    </section>
    <details class="ai-card"><summary>{{ t('ai.audit') }}</summary>
      <div v-for="(item, i) in events" :key="i" class="ai-event"><span>{{ new Date(item.created_at).toLocaleString() }} · {{ item.action }}</span><button v-if="item.job_id" :disabled="busy" @click="run(() => refreshJob(item.job_id!))">{{ t('ai.restoreJob') }}</button></div>
    </details>
  </div>
</template>

<style scoped>
.ai-page{display:grid;gap:20px;max-width:1320px;margin:0 auto;color:var(--text-color)}
.ai-card{min-width:0;padding:22px;background:var(--fd-surface);border:1px solid var(--fd-line);border-radius:var(--fd-radius);box-shadow:var(--fd-shadow)}
.ai-compose{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(260px,1fr);gap:20px;min-width:0}
fieldset{border:0;padding:0;margin:0} fieldset:disabled{opacity:.7}
.ai-inputs,.ai-stage{display:grid;gap:14px}.ai-config{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding-top:18px}.ai-wide{grid-column:1/-1}
label{display:grid;gap:7px;font-size:13px;font-weight:600}h2,summary{font-size:15px;font-weight:650}summary{cursor:pointer}h2{margin:0}
input:not([type=checkbox]),textarea{width:100%;min-width:0;box-sizing:border-box;border:1px solid var(--fd-line);border-radius:8px;background:var(--fd-surface);color:var(--text-color);padding:10px 12px;font-weight:400}
textarea{resize:vertical}input:focus-visible,textarea:focus-visible,button:focus-visible{outline:2px solid var(--link-active-color);outline-offset:2px}
.ai-muted{color:var(--text-color-secondary);font-size:12px;line-height:1.7;margin:0}.ai-notice{padding:13px;border:1px solid var(--fd-line);background:var(--fd-accent-soft);border-radius:8px;font-size:13px;line-height:1.7;margin:0}.ai-error{color:var(--error-color,#c2413a)}
.ai-actions{display:flex;gap:8px;flex-wrap:wrap}button{width:fit-content;border:1px solid var(--fd-line);border-radius:8px;padding:9px 14px;background:var(--fd-surface);color:var(--text-color);font-size:13px;cursor:pointer}button:hover{background:var(--fd-subtle)}button.ai-primary{background:var(--link-active-color);color:var(--button-text-color,#fff);border-color:transparent}button:disabled{opacity:.45;cursor:not-allowed}
.ai-check{display:flex;align-items:flex-start;gap:10px;font-weight:400;line-height:1.6}.ai-check input{margin-top:4px;flex-shrink:0;accent-color:var(--link-active-color)}
.ai-targets{display:flex;flex-direction:column;gap:14px}.ai-count{display:inline-block;padding:1px 7px;border-radius:5px;font-size:12px;background:var(--fd-accent-soft);color:var(--link-active-color)}
.ai-server-list{max-height:330px;overflow:auto}.ai-server{padding:10px 0;border-bottom:1px solid var(--fd-line)}.ai-server span{min-width:0;overflow-wrap:anywhere}.ai-server strong{display:block;font-size:13px}.ai-server small{color:var(--text-color-secondary);font-size:11px}
.ai-code{font:12px/1.75 Consolas,monospace}.ai-output{white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;max-height:420px;padding:14px;background:var(--fd-subtle);border:1px solid var(--fd-line);border-radius:8px;margin:0}.ai-analysis{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.8 inherit;margin:0}.ai-destination{overflow-wrap:anywhere;font-size:13px;margin:0}.ai-approved-targets{list-style:disc;padding-left:20px;font-size:13px;overflow-wrap:anywhere}.ai-event{display:flex;justify-content:space-between;align-items:center;gap:10px;padding-top:12px;font-size:12px;flex-wrap:wrap}
@media(max-width:800px){.ai-compose,.ai-config{grid-template-columns:1fr}.ai-card{padding:16px}.ai-page{gap:14px}}
</style>
