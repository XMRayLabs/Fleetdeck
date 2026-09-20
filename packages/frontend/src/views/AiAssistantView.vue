<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import api from '../utils/apiClient';
import { takeAiDraft } from '../utils/aiDraft';
import { useAuthStore } from '../stores/auth.store';
import type { ConnectionInfo } from '../stores/connections.store';
import { useAgentStore } from '../stores/agent.store';
import { useSessionStore } from '../stores/session.store';
import { analyzeStream } from '../utils/agentStream';

const { t } = useI18n();
const agent = useAgentStore(); const sessions = useSessionStore();
const includeMonitor = ref(false); const includeInventory = ref(false);
const streamingText=ref('');const generating=ref(false);let generation:AbortController|undefined;
const planId=ref<string|undefined>();const autoReview=ref(false);const rounds=ref(0);
const matches = ref<any[]>([]); const ambiguous = ref(false); const savedChats = ref<any[]>([]);
const draft = takeAiDraft(useAuthStore().user?.id || 0);
const task = ref('');
const context = ref(draft?.context || '');
const selected = ref<number[]>(draft?.targets || []);
const connections = ref<ConnectionInfo[]>([]);
const search = ref('');
const base = ref(''); const model = ref(''); const apiKey = ref(''); const hasKey = ref(false);
const models = ref<string[]>([]); const modelsError = ref(''); const manualModel = ref(false);
const scopeOpen = ref(window.innerWidth > 1000);
const savedBase = ref(''); const savedModel = ref('');
const configDirty = computed(() => base.value !== savedBase.value || model.value !== savedModel.value || Boolean(apiKey.value));
const turns = ref<{ task: string; analysis: string; commands: string[]; model: string; result?: string }[]>([]);
const currentTask = ref(''); const currentModel = ref(''); const threadEnd = ref<HTMLElement | null>(null);
const agentState = computed(() => busy.value ? t('ai.working') : activeJob.value ? t('agent.running') : answer.value?.proposalId ? t('agent.approval') : t('agent.ready'));
const configOpen = ref(false); const busy = ref(false); const message = ref(''); const error = ref('');
const preview = ref<{ previewId: string; content: string; base: string; model: string; planId?:string } | null>(null);
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

function invalidate() {
  if (answer.value) turns.value = [...turns.value, { task: currentTask.value, analysis: answer.value.analysis, commands: answer.value.commands, model: currentModel.value, result: job.value ? JSON.stringify(job.value).slice(0,32000) : '' }].slice(-6);
  preview.value = null; answer.value = null; sendConsent.value = false; executeConsent.value = false; passwords.value = {};
}
watch([task, context, selected], invalidate, { deep: true });
watch(task,()=>{matches.value=[];ambiguous.value=false;});
watch(selected,()=>{planId.value=undefined;rounds.value=0;},{deep:true});
watch([includeMonitor, includeInventory], invalidate);
watch(()=>agent.open,open=>{if(open)scopeOpen.value=false;},{immediate:true});
watch([()=>agent.attachment,busy], ([value,isBusy])=>{
 if (!value || isBusy) return;
 if ((context.value || selected.value.some(id=>id!==value.connectionId)) && !window.confirm(t('ops.switchScope'))) {agent.attachment=null;return;}
 selected.value=[value.connectionId]; context.value=value.text; agent.attachment=null;
}, {immediate:true});
watch(()=>agent.monitorRequest, value=>{if(value){includeMonitor.value=true;includeInventory.value=true;if(!task.value)task.value=t('ops.askMonitor');}}, {immediate:true});
watch([base, model, apiKey], invalidate);
watch(base, () => { models.value = []; modelsError.value = ''; });
watch(apiKey, value => { if (value) { models.value = []; modelsError.value = ''; } });
async function scrollThread() { await nextTick(); threadEnd.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
async function readModels() {
  modelsError.value = '';
  try {
    const { data } = await api.post('/ai/models', { base: base.value, apiKey: apiKey.value }, { timeout: 70000, signal: controller.signal });
    models.value = data.models;
    if (!model.value || !data.models.includes(model.value)) model.value = data.suggestedModel;
  } catch (e: any) { modelsError.value = e.response?.data?.message || t('agent.modelsFailed'); }
}
function refreshModels() { void run(readModels); }
function capture(kind:'selection'|'recent') { if (!sessions.activeSessionId || !agent.capture(sessions.activeSessionId,kind)) error.value=t('ops.noTerminal'); }
async function refreshConnections(){connections.value=(await api.get<ConnectionInfo[]>('/connections',{signal:controller.signal})).data.filter(c=>c.type==='SSH');}
function resolveDevices() { void run(async()=>{ await refreshConnections();const data=(await api.post('/ai/context/resolve',{task:task.value})).data;matches.value=data.matches;ambiguous.value=data.ambiguous; }); }
function useMatches() { selected.value=matches.value.map(d=>d.id); matches.value=[]; scopeOpen.value=true; }
async function listChats() {savedChats.value=(await api.get('/ai/context/conversations',{signal:controller.signal})).data;}
function saveChat() {void run(async()=>{invalidate();await api.post('/ai/context/conversations',{title:turns.value[0]?.task.slice(0,150)||'Conversation',turns:turns.value,targetIds:selected.value});await listChats();message.value=t('ai.saved');});}
function loadChat(id:string) {if(!window.confirm(t('ops.switchScope')))return;void run(async()=>{const data=(await api.get('/ai/context/conversations/'+id)).data;invalidate();turns.value=data.turns.slice(-6);task.value='';context.value='';job.value=null;clearTimeout(poll);selected.value=data.targetIds.filter((id:number)=>connections.value.some(c=>c.id===id));});}
function deleteChat(id:string) {if(!window.confirm(t('ops.deleteConfirm')))return;void run(async()=>{await api.delete('/ai/context/conversations/'+id);await listChats();});}
function newConversation() {
  if (!window.confirm(t('agent.clearConfirm'))) return;
  invalidate(); turns.value = []; task.value = ''; context.value = ''; currentTask.value = ''; job.value = null;
  planId.value=undefined;rounds.value=0;matches.value=[];
  clearTimeout(poll);
}
async function run(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true; error.value = ''; message.value = '';
  try { await action(); }
  catch (e: any) { if (!disposed) error.value = e.response?.data?.message || (e.name==='AbortError' ? t('ai.cancelled') : t('ai.failed')); }
  finally { busy.value = false; }
}
async function loadConfig() {
  const { data } = await api.get('/ai/config', { signal: controller.signal });
  base.value = data.base; model.value = data.model; hasKey.value = data.hasKey;
  savedBase.value = data.base; savedModel.value = data.model;
  configOpen.value = !data.hasKey;
}
async function loadEvents() { events.value = (await api.get('/ai/events', { signal: controller.signal })).data; }
function saveConfig() { void run(async () => {
  if ((!model.value || !models.value.length) && !manualModel.value) await readModels();
  if (modelsError.value && !manualModel.value) { error.value = modelsError.value; return; }
  if (!model.value) { error.value = modelsError.value || t('agent.modelsFailed'); return; }
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
  if (configDirty.value) { error.value = t('agent.saveFirst'); return; }
  await refreshConnections();
  if(selected.value.some(id=>!connections.value.some(c=>c.id===id))){error.value=t('ai.failed');return;}
  invalidate();
  const history = turns.value.flatMap(turn => [{ role: 'user', content: turn.task.slice(0, 1000) }, { role: 'assistant', content: JSON.stringify({analysis:turn.analysis.slice(0,1800),commands:turn.commands.map(c=>c.slice(0,100)).slice(0,8),result:turn.result?.slice(-1200)}).slice(0,6000) }]);
  preview.value = (await api.post('/ai/preview', { task: task.value, context: context.value, targetIds: selected.value, history, includeInventory:includeInventory.value, includeMonitor:includeMonitor.value,planId:planId.value }, { signal: controller.signal })).data;
  planId.value=preview.value?.planId;if(!activeJob.value){job.value=null;clearTimeout(poll);}
  currentTask.value = JSON.parse(preview.value!.content).task; currentModel.value = preview.value!.model;
  await scrollThread();
}); }
function analyze() { if (!preview.value || !sendConsent.value) return; void run(async () => {
  const id = preview.value!.previewId;
  generation=new AbortController();generating.value=true;streamingText.value='';
  try {
    const result = await analyzeStream(id,generation.signal,text=>{streamingText.value=text;});
    task.value = ''; context.value = ''; await nextTick();
    answer.value = result;
  }
  finally { preview.value = null; sendConsent.value = false;generating.value=false;streamingText.value='';generation=undefined; }
  await loadEvents(); await scrollThread();
}); }
function stopGeneration(){generation?.abort();void api.post('/ai/cancel').catch(()=>{});}
async function refreshJob(id: string) {
  clearTimeout(poll);
  const result = await api.get('/ai/jobs/' + encodeURIComponent(id), { signal: controller.signal });
  if (disposed) return;
  const wasRunning=activeJob.value;
  job.value = result.data.job;
  if(wasRunning && !activeJob.value && autoReview.value && rounds.value<5) follow();
  if (activeJob.value) poll = setTimeout(() => {
    void refreshJob(id).catch(() => { if (!disposed) error.value = t('ai.failed'); });
  }, 2500);
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
  rounds.value++;await loadEvents(); await refreshJob(id);
  if(!activeJob.value && autoReview.value && rounds.value<5)follow();
}); }
function stop() { void run(async () => { await api.post('/ai/jobs/' + encodeURIComponent(job.value.id) + '/cancel'); message.value = t('ai.cancelled'); await refreshJob(job.value.id); }); }
function follow() { context.value = JSON.stringify(job.value, null, 2).slice(0, 64000); task.value=t('ops.reviewResult'); invalidate(); }
onMounted(() => { void run(async () => {
  await loadConfig();
  await nextTick();
  if (hasKey.value) await readModels();
  connections.value = (await api.get<ConnectionInfo[]>('/connections', { signal: controller.signal })).data.filter(c => c.type === 'SSH');
  selected.value = selected.value.filter(id => connections.value.some(c => c.id === id));
  await loadEvents(); await listChats();
}); });
onBeforeUnmount(() => { disposed = true; controller.abort();generation?.abort(); clearTimeout(poll); context.value = ''; apiKey.value = ''; passwords.value = {}; });
</script>

<template>
  <div class="ai-page">
    <p v-if="error" role="alert" class="ai-notice ai-error">{{ error }}</p>
    <p v-if="message" role="status" class="ai-notice">{{ message }}</p>
    <p v-if="busy" role="status">{{ t('ai.working') }}</p>
    <button v-if="generating" @click="stopGeneration">{{ t('ai.stop') }}</button>
    <pre v-if="streamingText" class="ai-output" aria-live="polite">{{ streamingText }}</pre>
    <details :open="configOpen" class="ai-card" @toggle="configOpen = ($event.target as HTMLDetailsElement).open">
      <summary>{{ t('ai.config') }}</summary>
      <form @submit.prevent="saveConfig">
        <fieldset :disabled="busy" class="ai-config">
          <p class="ai-muted ai-wide">{{ t('ai.policy') }}</p>
          <label>{{ t('ai.base') }}<input v-model="base" type="url" required placeholder="https://api.example.com/v1" autocomplete="off" /></label>
          <label>{{ t('agent.model') }}<select v-model="model" :aria-label="t('agent.model')"><option value="">{{ t('agent.auto') }}</option><option v-if="model && !models.includes(model)" :value="model">{{ model }}</option><option v-for="id in models" :key="id" :value="id">{{ id }}</option></select></label>
          <label class="ai-wide">{{ t('ai.key') }}<input v-model="apiKey" type="password" autocomplete="new-password" :placeholder="hasKey ? t('ai.keySaved') : 'API Key'" /></label>
          <div class="ai-wide ai-model-tools"><button type="button" :disabled="!base || (!apiKey && !hasKey)" @click="refreshModels">{{ t('agent.readModels') }}</button><span class="ai-muted">{{ models.length }} {{ t('agent.modelLoaded') }}</span></div>
          <p v-if="modelsError" class="ai-notice ai-wide" role="alert">{{ modelsError }}</p>
          <p class="ai-muted ai-wide">{{ t('agent.modelHint') }}</p>
          <details class="ai-wide" @toggle="manualModel = ($event.target as HTMLDetailsElement).open"><summary>{{ t('agent.manual') }}</summary><label>{{ t('ai.model') }}<input v-model="model" placeholder="model-id" autocomplete="off" /></label></details>
          <div class="ai-actions ai-wide"><button class="ai-primary" type="submit">{{ t('ai.save') }}</button><button type="button" :disabled="!hasKey" @click="testConfig">{{ t('ai.test') }}</button><button type="button" :disabled="!hasKey" @click="deleteConfig">{{ t('ai.remove') }}</button></div>
        </fieldset>
      </form>
    </details>

    <div class="ai-workbench">
    <main class="ai-conversation">
      <header class="ai-thread-header"><div><strong>{{ t('agent.conversation') }}</strong><span class="ai-presence">{{ agentState }}</span></div><button :disabled="busy || activeJob" @click="newConversation">{{ t('agent.newChat') }}</button></header>
      <div class="ai-transcript" aria-live="polite" :aria-busy="busy">
      <section v-if="!turns.length && !answer && !preview" class="ai-welcome">
        <span class="ai-agent-mark" aria-hidden="true"><i class="fa-solid fa-wand-magic-sparkles"></i></span>
        <h2>{{ t('agent.welcome') }}</h2><p>{{ t('agent.intro') }}</p>
        <div class="ai-suggestions"><button v-for="suggestion in ['disk', 'system', 'logs']" :key="suggestion" :disabled="busy" @click="task = t('agent.' + suggestion)">{{ t('agent.' + suggestion) }} ↗</button></div>
      </section>
      <template v-for="(turn, index) in turns" :key="index">
        <article class="ai-bubble ai-user-bubble"><small>{{ t('agent.you') }}</small><p>{{ turn.task }}</p></article>
        <article class="ai-bubble ai-assistant-bubble"><small>{{ t('agent.assistant') }} · {{ turn.model }}</small><pre class="ai-archived-analysis">{{ turn.analysis }}</pre><details v-if="turn.commands.length"><summary>{{ t('agent.previous') }}</summary><pre v-for="(command, n) in turn.commands" :key="n" class="ai-code ai-output">{{ command }}</pre></details></article>
      </template>
      <article v-if="preview || answer" class="ai-bubble ai-user-bubble"><small>{{ t('agent.you') }}</small><p>{{ currentTask }}</p></article>

    <section v-if="preview" class="ai-card ai-stage">
      <h2>{{ t('ai.previewTitle') }}</h2>
      <p class="ai-destination">{{ preview.base }} · {{ preview.model }}</p>
      <p class="ai-notice">{{ t('ai.warning') }}</p>
      <pre class="ai-code ai-output" data-testid="ai-preview">{{ preview.content }}</pre>
      <label class="ai-check"><input v-model="sendConsent" type="checkbox" :disabled="busy" />{{ t('ai.sendConsent') }}</label>
      <button class="ai-primary" :disabled="busy || !sendConsent" @click="analyze">{{ t('ai.send') }}</button>
    </section>

    <section v-if="answer" class="ai-card ai-stage ai-assistant-bubble">
      <small>{{ t('agent.assistant') }} · {{ currentModel }}</small>
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
      <div ref="threadEnd"></div>
      </div>
      <form class="ai-composer-shell" @submit.prevent="makePreview">
        <fieldset :disabled="busy" class="ai-inputs">
          <div class="ai-actions"><button type="button" @click="capture('selection')">{{ t('ops.selection') }}</button><button type="button" @click="capture('recent')">{{ t('ops.recent') }}</button></div>
          <label>{{ t('ai.task') }}<textarea v-model="task" :placeholder="t('agent.composer')" rows="3" maxlength="8000" @keydown.ctrl.enter.prevent="hasKey && task.trim() && makePreview()" @keydown.meta.enter.prevent="hasKey && task.trim() && makePreview()" /></label>
          <details :open="Boolean(context)"><summary>{{ t('agent.attach') }} <span v-if="context" class="ai-count">{{ context.length }}</span></summary>
            <label>{{ t('ai.logs') }}<textarea v-model="context" rows="5" maxlength="64000" spellcheck="false" class="ai-code" /></label>
            <p class="ai-muted">{{ t('ai.contextHint') }}</p>
          </details>
          <label class="ai-check"><input v-model="includeInventory" type="checkbox" />{{ t('ops.includeInventory') }}</label>
          <label class="ai-check"><input v-model="includeMonitor" type="checkbox" />{{ t('ops.includeMonitor') }}</label>
          <label class="ai-check"><input v-model="autoReview" type="checkbox" />{{ t('ops.autoReview') }}</label>
          <p class="ai-muted">{{ t('ops.limits') }} · {{ rounds }}/5</p>
          <button type="button" :disabled="!task.trim()" @click="resolveDevices">{{ t('ops.resolve') }}</button>
          <div v-if="matches.length"><p v-if="ambiguous" role="alert">{{ t('ops.ambiguous') }}</p><p v-for="d in matches" :key="d.id">{{ d.name }} · {{ d.host }} · {{ d.aliases.join(', ') }}</p><button v-if="!ambiguous" type="button" @click="useMatches">{{ t('ops.useMatches') }}</button></div>
          <p v-if="configDirty" class="ai-muted">{{ t('agent.saveFirst') }}</p>
          <div class="ai-composer-footer"><span class="ai-muted">{{ savedModel || t('agent.auto') }} · {{ selected.length ? selected.length + ' SSH' : t('agent.noScope') }}</span><button type="submit" class="ai-primary" :disabled="!hasKey || !task.trim() || configDirty">{{ t('ai.preview') }}</button></div>
          <p class="ai-muted">{{ t('ops.persisted') }}</p>
        </fieldset>
      </form>
    </main>
    <aside class="ai-context-panel">
      <details class="ai-card"><summary>{{ t('ops.savedChats') }}</summary><button :disabled="busy || activeJob || (!turns.length && !answer)" @click="saveChat">{{ t('ops.saveChat') }}</button><div v-for="chat in savedChats" :key="chat.id" class="ai-event"><span>{{ chat.title }} · {{ new Date(chat.updated_at).toLocaleString() }}</span><button :disabled="busy || activeJob" @click="loadChat(chat.id)">{{ t('ops.loadChat') }}</button><button :disabled="busy" @click="deleteChat(chat.id)">{{ t('ops.deleteChat') }}</button></div></details>
      <details class="ai-card ai-scope" :open="scopeOpen" @toggle="scopeOpen = ($event.target as HTMLDetailsElement).open">
      <summary>{{ t('agent.scope') }} <span class="ai-count">{{ selected.length }}</span></summary>
      <fieldset :disabled="busy" class="ai-targets">
        <p class="ai-muted">{{ t('ai.targetHint') }}</p>
        <input v-model="search" :placeholder="t('ai.search')" :aria-label="t('ai.search')" type="search" />
        <div class="ai-server-list"><label v-for="c in visibleConnections" :key="c.id" class="ai-check ai-server"><input v-model="selected" type="checkbox" :value="c.id" /><span><strong>{{ c.name || c.host }}</strong><small>{{ c.username }} · {{ c.host }}:{{ c.port }}</small></span></label><p v-if="!visibleConnections.length" class="ai-muted">{{ t('ai.empty') }}</p></div>
        <span class="ai-guard"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i> {{ t('agent.approved') }}</span>
      </fieldset>
      </details>
    <details class="ai-card"><summary>{{ t('ai.audit') }}</summary>
      <div v-for="(item, i) in events" :key="i" class="ai-event"><span>{{ new Date(item.created_at).toLocaleString() }} · {{ item.action }}</span><button v-if="item.job_id" :disabled="busy" @click="run(() => refreshJob(item.job_id!))">{{ t('ai.restoreJob') }}</button></div>
    </details>
    </aside>
    </div>
  </div>
</template>

<style scoped>
.ai-page{display:grid;gap:20px;max-width:1320px;margin:0 auto;color:var(--text-color)}
.ai-scope[open] .ai-targets{margin-top:14px}
.ai-card{min-width:0;padding:22px;background:var(--fd-surface);border:1px solid var(--fd-line);border-radius:var(--fd-radius);box-shadow:var(--fd-shadow)}
.ai-compose{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(260px,1fr);gap:20px;min-width:0}
fieldset{border:0;padding:0;margin:0} fieldset:disabled{opacity:.7}
.ai-inputs,.ai-stage{display:grid;gap:14px}.ai-config{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding-top:18px}.ai-wide{grid-column:1/-1}
label{display:grid;gap:7px;font-size:13px;font-weight:600}h2,summary{font-size:15px;font-weight:650}summary{cursor:pointer}h2{margin:0}
input:not([type=checkbox]),textarea,select{width:100%;min-width:0;box-sizing:border-box;border:1px solid var(--fd-line);border-radius:8px;background:var(--fd-surface);color:var(--text-color);padding:10px 12px;font-weight:400}
textarea{resize:vertical}input:focus-visible,textarea:focus-visible,button:focus-visible{outline:2px solid var(--link-active-color);outline-offset:2px}
.ai-muted{color:var(--text-color-secondary);font-size:12px;line-height:1.7;margin:0}.ai-notice{padding:13px;border:1px solid var(--fd-line);background:var(--fd-accent-soft);border-radius:8px;font-size:13px;line-height:1.7;margin:0}.ai-error{color:var(--error-color,#c2413a)}
.ai-actions{display:flex;gap:8px;flex-wrap:wrap}button{width:fit-content;border:1px solid var(--fd-line);border-radius:8px;padding:9px 14px;background:var(--fd-surface);color:var(--text-color);font-size:13px;cursor:pointer}button:hover{background:var(--fd-subtle)}button.ai-primary{background:var(--link-active-color);color:var(--button-text-color,#fff);border-color:transparent}button:disabled{opacity:.45;cursor:not-allowed}
.ai-check{display:flex;align-items:flex-start;gap:10px;font-weight:400;line-height:1.6}.ai-check input{margin-top:4px;flex-shrink:0;accent-color:var(--link-active-color)}
.ai-targets{display:flex;flex-direction:column;gap:14px}.ai-count{display:inline-block;padding:1px 7px;border-radius:5px;font-size:12px;background:var(--fd-accent-soft);color:var(--link-active-color)}
.ai-server-list{max-height:330px;overflow:auto}.ai-server{padding:10px 0;border-bottom:1px solid var(--fd-line)}.ai-server span{min-width:0;overflow-wrap:anywhere}.ai-server strong{display:block;font-size:13px}.ai-server small{color:var(--text-color-secondary);font-size:11px}
.ai-code{font:12px/1.75 Consolas,monospace}.ai-output{white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;max-height:420px;padding:14px;background:var(--fd-subtle);border:1px solid var(--fd-line);border-radius:8px;margin:0}.ai-analysis{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.8 inherit;margin:0}.ai-destination{overflow-wrap:anywhere;font-size:13px;margin:0}.ai-approved-targets{list-style:disc;padding-left:20px;font-size:13px;overflow-wrap:anywhere}.ai-event{display:flex;justify-content:space-between;align-items:center;gap:10px;padding-top:12px;font-size:12px;flex-wrap:wrap}
.ai-workbench{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:20px;align-items:start}.ai-conversation{min-width:0;border:1px solid var(--fd-line);border-radius:16px;background:var(--fd-surface);overflow:hidden}.ai-thread-header{display:flex;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid var(--fd-line);gap:12px}.ai-thread-header strong{font-size:14px}.ai-presence{display:block;font-size:11px;color:var(--text-color-secondary);margin-top:5px}.ai-presence:before{content:'';display:inline-block;width:6px;height:6px;margin-right:6px;border-radius:50%;background:var(--link-active-color)}.ai-transcript{padding:24px;display:flex;flex-direction:column;gap:20px;min-height:350px;max-height:65vh;overflow:auto;overscroll-behavior:contain}.ai-transcript>.ai-card{box-shadow:none;border-radius:12px;padding:18px}.ai-welcome{margin:auto;text-align:center;max-width:570px;padding:24px 12px}.ai-welcome h2{font-size:23px;letter-spacing:-.5px;margin:18px 0 10px}.ai-welcome p{font-size:13px;line-height:1.8;color:var(--text-color-secondary)}.ai-agent-mark{display:inline-grid;place-items:center;width:48px;height:48px;border-radius:14px;background:var(--fd-accent-soft);color:var(--link-active-color);font-size:22px}.ai-suggestions{display:flex;justify-content:center;flex-wrap:wrap;gap:8px;margin-top:22px}.ai-suggestions button{font-size:12px;text-align:left}.ai-context-panel{display:grid;gap:16px;min-width:0}.ai-context-panel .ai-card{padding:18px}.ai-bubble{max-width:100%;min-width:0;overflow-wrap:anywhere}.ai-bubble small,.ai-stage>small{font-size:11px;font-weight:600;color:var(--text-color-secondary)}.ai-bubble p{margin:6px 0 0;white-space:pre-wrap;line-height:1.7;font-size:13px}.ai-user-bubble{align-self:flex-end;max-width:90%;padding:13px 17px;background:var(--fd-accent-soft);border-radius:14px 14px 3px 14px}.ai-assistant-bubble{padding:12px 0;line-height:1.8}.ai-archived-analysis{font-family:inherit;font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0}.ai-composer-shell{padding:18px 22px;border-top:1px solid var(--fd-line);background:var(--fd-subtle)}.ai-composer-shell textarea{background:var(--fd-surface)}.ai-composer-shell summary{font-size:12px;font-weight:500}.ai-composer-shell details label{margin-top:12px}.ai-composer-footer,.ai-model-tools{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.ai-composer-footer>span{overflow-wrap:anywhere;max-width:100%}.ai-guard{padding:10px;border-radius:8px;background:var(--fd-accent-soft);font-size:11px;color:var(--link-active-color)}
@media(max-width:1000px){.ai-workbench{grid-template-columns:1fr}.ai-context-panel{grid-row:1}.ai-server-list{max-height:130px}.ai-transcript{max-height:65vh}}@media(max-width:800px){.ai-compose,.ai-config{grid-template-columns:1fr}.ai-card{padding:16px}.ai-page{gap:14px}.ai-transcript{padding:14px}.ai-thread-header,.ai-composer-shell{padding:14px}.ai-welcome{padding:14px 0}.ai-thread-header button{padding:7px;font-size:11px}}
</style>
