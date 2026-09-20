<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import api from '../utils/apiClient';
import { useAgentStore } from '../stores/agent.store';
const { t } = useI18n(); const agent = useAgentStore();
const url = ref(''); const snapshot = ref<any>(null); const devices = ref<any[]>([]);
const aliases = ref<Record<number,string>>({}); const error = ref(''); const busy = ref(false); const configured = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined; let disposed = false;
const controller = new AbortController();
async function loadDevices() { devices.value = (await api.get('/ai/context/inventory', {signal:controller.signal})).data; for (const d of devices.value) aliases.value[d.id] = d.aliases.join(', '); }
async function refresh() {
 clearTimeout(timer); if (busy.value || !configured.value || disposed) return;
 busy.value = true;
 try { snapshot.value = (await api.get('/ai/context/monitor/snapshot', {signal:controller.signal,timeout:20000})).data; error.value = ''; }
 catch { if (!disposed) error.value = t('ops.stale'); }
 finally { busy.value = false; if (!disposed && document.visibilityState === 'visible') timer = setTimeout(refresh,5000); }
}
async function save() {
 if (busy.value) return; busy.value = true; error.value = '';
 try { await api.put('/ai/context/monitor', {url:url.value}, {signal:controller.signal}); configured.value = true; snapshot.value = null; await loadDevices(); }
 catch { error.value = t('ai.failed'); }
 finally { busy.value = false; }
 if (!error.value) await refresh();
}
async function bind(node: number, event: Event) {
 const value = (event.target as HTMLSelectElement).value;
 try { await api.put('/ai/context/monitor/bindings/'+node, {connectionId:value ? Number(value) : null}); await loadDevices(); }
 catch { error.value = t('ai.failed'); (event.target as HTMLSelectElement).value = String(devices.value.find(d=>d.monitorNodeId===node)?.id || ''); }
}
async function saveAliases(id: number) { try { await api.put('/ai/context/aliases/'+id,{aliases:aliases.value[id].split(/[,，\n]/).map(s=>s.trim()).filter(Boolean)}); await loadDevices(); error.value=''; } catch { error.value=t('ai.failed'); } }
function bytes(v: number | null) { if (v === null || v === undefined) return '—'; const n = Math.min(4,Math.floor(Math.log(Math.max(v,1))/Math.log(1024))); return (v/1024**n).toFixed(1)+' '+['B','KiB','MiB','GiB','TiB'][n]; }
function metric(v: number | null) { return v === null || v === undefined ? '—' : v.toFixed(1); }
function recent(node:any) { const age=Date.now()-Date.parse(node.lastActive);return Number.isFinite(age)&&age>=-5000&&age<60000; }
function discuss() { agent.show(); agent.monitorRequest = Date.now(); }
function visibility() { if (document.visibilityState === 'visible') void refresh(); else clearTimeout(timer); }
onMounted(async()=>{ document.addEventListener('visibilitychange',visibility); try { const config=(await api.get('/ai/context/monitor',{signal:controller.signal})).data; url.value=config.url; configured.value=Boolean(config.url); await loadDevices(); await refresh(); } catch { if (!disposed) error.value=t('ai.failed'); } });
onBeforeUnmount(()=>{disposed=true;controller.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);});
</script>
<template>
 <div class="monitor-page">
  <p v-if="error" role="alert" class="monitor-alert">{{ error }}</p>
  <form class="monitor-card" @submit.prevent="save"><label>{{ t('ops.url') }}<input v-model="url" placeholder="https://tz.xmray.de" required maxlength="2048" /></label><p>{{ t('ops.hint') }}</p><button :disabled="busy">{{ t('ai.save') }}</button></form>
  <section class="monitor-card"><header><div><h2>{{ t('ops.monitoring') }}</h2><p v-if="snapshot">{{ t('ops.lastUpdate') }}: {{ new Date(snapshot.fetchedAt).toLocaleString() }}</p></div><div class="monitor-actions"><button :disabled="busy || !configured" @click="refresh">{{ t('ai.refresh') }}</button><button :disabled="!snapshot" @click="discuss">{{ t('ops.analyze') }}</button></div></header>
   <p v-if="!snapshot">{{ t('ops.empty') }}</p>
   <div v-else class="monitor-table"><table><thead><tr><th>{{ t('ops.node') }}</th><th>CPU</th><th>{{ t('ops.memory') }}</th><th>{{ t('ops.disk') }}</th><th>{{ t('ops.load') }}</th><th>{{ t('ops.network') }}</th><th>{{ t('ops.device') }}</th></tr></thead><tbody><tr v-for="node in snapshot.servers" :key="node.id"><td><strong>{{ node.name }}</strong><small :class="{'monitor-warning':!recent(node)}">{{ recent(node) ? t('ops.online') : t('ops.offline') }} · {{ node.platform }}</small></td><td>{{ metric(node.cpu) }}%</td><td>{{ bytes(node.memoryUsed) }} / {{ bytes(node.memoryTotal) }}</td><td>{{ bytes(node.diskUsed) }} / {{ bytes(node.diskTotal) }}</td><td>{{ metric(node.load1) }} / {{ metric(node.load5) }} / {{ metric(node.load15) }}</td><td>↓ {{ bytes(node.netIn) }}/s<br>↑ {{ bytes(node.netOut) }}/s</td><td><select :aria-label="node.name+' '+t('ops.device')" :value="devices.find(d=>d.monitorNodeId===node.id)?.id || ''" @change="bind(node.id,$event)"><option value="">{{ t('ops.unbound') }}</option><option v-for="d in devices" :key="d.id" :value="d.id" :disabled="d.monitorNodeId !== null && d.monitorNodeId !== node.id">{{ d.name }} · {{ d.host }}</option></select></td></tr></tbody></table></div>
  </section>
  <section class="monitor-card"><h2>{{ t('ops.aliases') }}</h2><p>{{ t('ops.aliasHint') }}</p><form v-for="d in devices" :key="d.id" class="monitor-alias" @submit.prevent="saveAliases(d.id)"><label>{{ d.name }}<small>{{ d.host }}</small></label><input v-model="aliases[d.id]" :aria-label="d.name+' '+t('ops.aliases')" maxlength="1300" /><button>{{ t('ai.save') }}</button></form></section>
 </div>
</template>
<style scoped>
.monitor-page{container-type:inline-size}@container(max-width:600px){.monitor-alias{grid-template-columns:1fr !important}}
.monitor-page{display:grid;gap:20px;max-width:1600px;margin:auto;color:var(--text-color)}.monitor-card{min-width:0;padding:22px;border:1px solid var(--fd-line);border-radius:var(--fd-radius);background:var(--fd-surface)}h2{font-size:17px;margin:0}p,small{font-size:12px;color:var(--text-color-secondary);line-height:1.7}small{display:block}label{display:grid;gap:8px;font-size:13px}input,select{border:1px solid var(--fd-line);border-radius:8px;background:var(--fd-surface);color:var(--text-color);padding:10px;min-width:0}button{padding:9px 14px;border:1px solid var(--fd-line);border-radius:8px;background:var(--fd-accent-soft);color:var(--link-active-color);cursor:pointer}button:disabled{opacity:.5}header,.monitor-actions{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}.monitor-table{overflow:auto;margin-top:16px}table{border-collapse:collapse;width:100%;font-size:12px;text-align:left}th,td{padding:14px 12px;border-bottom:1px solid var(--fd-line);white-space:nowrap}th{color:var(--text-color-secondary);font-weight:500}.monitor-alias{display:grid;grid-template-columns:minmax(140px,1fr) 2fr auto;gap:14px;align-items:center;padding:14px 0;border-bottom:1px solid var(--fd-line)}.monitor-alert{padding:14px;border:1px solid var(--fd-line);border-radius:8px}.monitor-warning,.monitor-alert{color:var(--error-color,#c2413a)}@media(max-width:700px){.monitor-alias{grid-template-columns:1fr}.monitor-card{padding:14px}}
</style>
