<script setup lang="ts">
import { formatConnectionAddress } from '../utils/formatConnectionAddress';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import apiClient from '../utils/apiClient';
import { useConnectionsStore, type ConnectionInfo } from '../stores/connections.store';
import { useTagsStore } from '../stores/tags.store';
import { useRouter } from 'vue-router';

const router = useRouter();

type JobStatus = 'queued' | 'running' | 'success' | 'partial' | 'failed' | 'cancelled';

interface JobSummary {
  id: string;
  name: string;
  type: 'command' | 'upload';
  status: JobStatus;
  targetCount: number;
  completedCount: number;
  successCount: number;
  failedCount: number;
  concurrency: number;
  timeoutSeconds: number;
  summary: Record<string, any>;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  cancelRequested: boolean;
}

interface JobTarget {
  id: number;
  connectionId: number | null;
  connectionName: string;
  host: string;
  status: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  durationMs: number | null;
}

interface JobDetail extends JobSummary {
  payload: Record<string, any>;
  targets: JobTarget[];
}

const connectionsStore = useConnectionsStore();
const tagsStore = useTagsStore();
const { connections, isLoading: connectionsLoading } = storeToRefs(connectionsStore);
const { tags } = storeToRefs(tagsStore);

const mode = ref<'command' | 'upload'>('command');
const jobs = ref<JobSummary[]>([]);
const jobsLoading = ref(false);
const submitting = ref(false);
const selectedIds = ref<number[]>([]);
const selectedTagId = ref<number | 'all'>('all');
const search = ref('');
const jobName = ref('');
const commandsText = ref('sudo apt-get update\nuname -a\ndf -h');
const concurrency = ref(5);
const timeoutSeconds = ref(300);
const stopOnError = ref(true);
const recordOutput = ref(true);
const remotePath = ref('/tmp/fleetdeck/');
const overwrite = ref(true);
const selectedFiles = ref<File[]>([]);
const ephemeralSecrets = ref<Record<number, string>>({});
const fileInput = ref<HTMLInputElement | null>(null);
const errorMessage = ref('');
const successMessage = ref('');
const detail = ref<JobDetail | null>(null);
const detailLoading = ref(false);
const expandedTargetId = ref<number | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;

const sshConnections = computed(() => connections.value.filter(connection => connection.type === 'SSH'));
const activeJobs = computed(() => jobs.value.filter(job => job.status === 'queued' || job.status === 'running').length);
const completedTargets = computed(() => jobs.value.reduce((sum, job) => sum + job.completedCount, 0));
const successfulTargets = computed(() => jobs.value.reduce((sum, job) => sum + job.successCount, 0));
const successRate = computed(() => completedTargets.value ? Math.round(successfulTargets.value / completedTargets.value * 100) : 100);

const filteredConnections = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return sshConnections.value.filter(connection => {
    const tagMatch = selectedTagId.value === 'all' || connection.tag_ids?.includes(Number(selectedTagId.value));
    const textMatch = !needle || [connection.name, connection.host, connection.username].some(value => value?.toLowerCase().includes(needle));
    return tagMatch && textMatch;
  });
});

const allVisibleSelected = computed(() => filteredConnections.value.length > 0 && filteredConnections.value.every(connection => selectedIds.value.includes(connection.id)));
const commandCount = computed(() => commandsText.value.split('\n').map(value => value.trim()).filter(Boolean).length);
const totalFileBytes = computed(() => selectedFiles.value.reduce((sum, file) => sum + file.size, 0));
const promptConnections = computed(() => sshConnections.value.filter(connection => selectedIds.value.includes(connection.id) && connection.credential_mode === 'prompt'));

const statusLabel = (status: string): string => ({
  queued: '等待执行', running: '执行中', success: '全部成功', partial: '部分成功', failed: '失败', cancelled: '已取消',
}[status] || status);

const statusClass = (status: string): string => `status-${status}`;
const formatTime = (timestamp: number | null): string => timestamp ? new Date(timestamp * 1000).toLocaleString('zh-CN', { hour12: false }) : '—';
const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};
const formatDuration = (duration: number | null): string => duration === null ? '—' : duration < 1000 ? `${duration} ms` : `${(duration / 1000).toFixed(1)} s`;
const progress = (job: JobSummary): number => job.targetCount ? Math.round(job.completedCount / job.targetCount * 100) : 0;
const isPlaybookJob = (job: JobSummary | JobDetail): boolean => job.summary?.source === 'playbook';
const jobIcon = (job: JobSummary | JobDetail): string => isPlaybookJob(job)
  ? 'fas fa-book-open'
  : job.type === 'command' ? 'fas fa-terminal' : 'fas fa-file-arrow-up';
const jobSubtitle = (job: JobSummary): string => isPlaybookJob(job)
  ? `剧本 r${job.summary.revision || 1} · ${job.summary.stepCount || 0} 个步骤`
  : job.type === 'command' ? `${job.summary.commandCount || 0} 条命令` : `${job.summary.fileCount || 0} 个文件`;
const startNewTask = (): void => {
  mode.value = 'command';
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

const tagNames = (connection: ConnectionInfo): string[] => (connection.tag_ids || [])
  .map(id => tags.value.find(tag => tag.id === id)?.name)
  .filter((name): name is string => Boolean(name));

const toggleConnection = (id: number): void => {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter(value => value !== id)
    : [...selectedIds.value, id];
};

const toggleVisible = (): void => {
  const visibleIds = filteredConnections.value.map(connection => connection.id);
  if (allVisibleSelected.value) selectedIds.value = selectedIds.value.filter(id => !visibleIds.includes(id));
  else selectedIds.value = [...new Set([...selectedIds.value, ...visibleIds])];
};

const fetchJobs = async (quiet = false): Promise<void> => {
  if (!quiet) jobsLoading.value = true;
  try {
    const response = await apiClient.get<{ jobs: JobSummary[] }>('/orchestration/jobs');
    jobs.value = response.data.jobs;
    if (detail.value && ['queued', 'running'].includes(detail.value.status)) await openDetail(detail.value.id, true);
  } catch (error: any) {
    if (!quiet) errorMessage.value = error.response?.data?.message || '无法加载任务列表。';
  } finally {
    if (!quiet) jobsLoading.value = false;
  }
};

const openDetail = async (jobId: string, quiet = false): Promise<void> => {
  if (!quiet) {
    detailLoading.value = true;
    expandedTargetId.value = null;
  }
  try {
    const response = await apiClient.get<{ job: JobDetail }>(`/orchestration/jobs/${jobId}`);
    detail.value = response.data.job;
  } catch (error: any) {
    errorMessage.value = error.response?.data?.message || '无法加载任务详情。';
  } finally {
    detailLoading.value = false;
  }
};

const resetFeedback = (): void => {
  errorMessage.value = '';
  successMessage.value = '';
};

const validateTargets = (): boolean => {
  if (selectedIds.value.length > 0) return true;
  errorMessage.value = '请至少选择一台 SSH 服务器。';
  return false;
};

const collectEphemeralCredentials = (): Record<string, { password?: string; passphrase?: string }> | null => {
  const credentials: Record<string, { password?: string; passphrase?: string }> = {};
  for (const connection of promptConnections.value) {
    const secret = ephemeralSecrets.value[connection.id] || '';
    if (connection.auth_method === 'password' && !secret) {
      errorMessage.value = `请输入 ${connection.name || connection.host} 的临时密码。`;
      return null;
    }
    credentials[String(connection.id)] = connection.auth_method === 'key' ? { passphrase: secret } : { password: secret };
  }
  return credentials;
};

const submitCommandJob = async (): Promise<void> => {
  resetFeedback();
  if (!validateTargets()) return;
  const ephemeralCredentials = collectEphemeralCredentials();
  if (!ephemeralCredentials) return;
  const commands = commandsText.value.split('\n').map(command => command.trim()).filter(Boolean);
  if (!commands.length) {
    errorMessage.value = '请至少输入一条命令。';
    return;
  }
  submitting.value = true;
  try {
    const response = await apiClient.post<{ jobId: string }>('/orchestration/jobs/command', {
      name: jobName.value,
      targetIds: selectedIds.value,
      commands,
      concurrency: concurrency.value,
      timeoutSeconds: timeoutSeconds.value,
      stopOnError: stopOnError.value,
      recordOutput: recordOutput.value,
      ephemeralCredentials,
    });
    successMessage.value = `任务已进入队列，正在分发到 ${selectedIds.value.length} 台服务器。`;
    jobName.value = '';
    ephemeralSecrets.value = {};
    await fetchJobs(true);
    await openDetail(response.data.jobId);
  } catch (error: any) {
    errorMessage.value = error.response?.data?.message || '创建批量任务失败。';
  } finally {
    submitting.value = false;
  }
};

const onFilesSelected = (event: Event): void => {
  const input = event.target as HTMLInputElement;
  selectedFiles.value = Array.from(input.files || []);
};

const submitUploadJob = async (): Promise<void> => {
  resetFeedback();
  if (!validateTargets()) return;
  const ephemeralCredentials = collectEphemeralCredentials();
  if (!ephemeralCredentials) return;
  if (!selectedFiles.value.length) {
    errorMessage.value = '请选择要分发的文件。';
    return;
  }
  if (!remotePath.value.trim()) {
    errorMessage.value = '请输入远程目标路径。';
    return;
  }
  submitting.value = true;
  try {
    const form = new FormData();
    form.append('name', jobName.value);
    form.append('targetIds', JSON.stringify(selectedIds.value));
    form.append('remotePath', remotePath.value);
    form.append('overwrite', String(overwrite.value));
    form.append('concurrency', String(Math.min(concurrency.value, 10)));
    form.append('timeoutSeconds', String(Math.max(timeoutSeconds.value, 10)));
    form.append('ephemeralCredentials', JSON.stringify(ephemeralCredentials));
    selectedFiles.value.forEach(file => form.append('files', file));
    const response = await apiClient.post<{ jobId: string }>('/orchestration/jobs/upload', form, { timeout: 120000 });
    successMessage.value = `文件分发任务已创建，共 ${selectedFiles.value.length} 个文件、${selectedIds.value.length} 台服务器。`;
    selectedFiles.value = [];
    if (fileInput.value) fileInput.value.value = '';
    jobName.value = '';
    ephemeralSecrets.value = {};
    await fetchJobs(true);
    await openDetail(response.data.jobId);
  } catch (error: any) {
    errorMessage.value = error.response?.data?.message || '创建文件分发任务失败。';
  } finally {
    submitting.value = false;
  }
};

const cancel = async (job: JobSummary | JobDetail): Promise<void> => {
  if (!confirm(`确定取消任务“${job.name}”吗？正在执行的 SSH 连接会被关闭。`)) return;
  try {
    await apiClient.post(`/orchestration/jobs/${job.id}/cancel`);
    await fetchJobs(true);
    await openDetail(job.id, true);
  } catch (error: any) {
    errorMessage.value = error.response?.data?.message || '取消任务失败。';
  }
};

onMounted(async () => {
  await Promise.all([connectionsStore.fetchConnections(), tagsStore.fetchTags(), fetchJobs()]);
  pollTimer = setInterval(() => fetchJobs(true), 3000);
});

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <div class="orchestration-page">
    <section class="hero">
      <div class="hero-actions">
        <button class="button button-secondary" @click="router.push('/playbooks')"><i class="fas fa-book-open"></i> 自动化剧本</button>
        <button class="button button-secondary" @click="fetchJobs()"><i class="fas fa-rotate"></i> 刷新状态</button>
        <button class="button button-primary" @click="startNewTask"><i class="fas fa-plus"></i> 新建任务</button>
      </div>
    </section>

    <section class="metrics" aria-label="编排概览">
      <article><span>可编排服务器</span><strong>{{ sshConnections.length }}</strong><small>共 {{ connections.length }} 个资产</small></article>
      <article><span>正在运行</span><strong>{{ activeJobs }}</strong><small>{{ activeJobs ? '执行器工作中' : '当前队列空闲' }}</small></article>
      <article><span>目标成功率</span><strong>{{ successRate }}%</strong><small>基于最近 {{ completedTargets }} 次执行</small></article>
      <article class="security-metric"><span>凭据保护</span><strong><i class="fas fa-shield-halved"></i> AES-256</strong><small>任务与输出加密落盘</small></article>
    </section>

    <div v-if="errorMessage" class="feedback feedback-error"><i class="fas fa-circle-exclamation"></i>{{ errorMessage }}<button @click="errorMessage = ''">×</button></div>
    <div v-if="successMessage" class="feedback feedback-success"><i class="fas fa-circle-check"></i>{{ successMessage }}<button @click="successMessage = ''">×</button></div>

    <section class="composer">
      <div class="composer-title">
        <div>
          <span class="section-index">01</span>
          <h2>创建任务</h2>
        </div>
        <div class="mode-switch" role="tablist" aria-label="任务类型">
          <button :class="{ active: mode === 'command' }" @click="mode = 'command'"><i class="fas fa-terminal"></i> 命令编排</button>
          <button :class="{ active: mode === 'upload' }" @click="mode = 'upload'"><i class="fas fa-cloud-arrow-up"></i> 文件分发</button>
        </div>
      </div>

      <div class="composer-grid">
        <div class="target-panel">
          <div class="panel-heading">
            <div><span class="step">A</span><h3>选择目标</h3></div>
            <span class="selection-count">已选 {{ selectedIds.length }} / {{ sshConnections.length }}</span>
          </div>
          <div class="filters">
            <label class="search-box"><i class="fas fa-magnifying-glass"></i><input v-model="search" placeholder="搜索名称、IP 或用户" /></label>
            <select v-model="selectedTagId" aria-label="按分组筛选">
              <option value="all">全部分组</option>
              <option v-for="tag in tags" :key="tag.id" :value="tag.id">{{ tag.name }}</option>
            </select>
          </div>
          <div class="select-row">
            <button class="text-button" @click="toggleVisible"><i :class="allVisibleSelected ? 'fas fa-square-check' : 'far fa-square'"></i>{{ allVisibleSelected ? '取消当前结果' : '选择当前结果' }}</button>
            <span>仅 SSH 资产可用于批量执行</span>
          </div>
          <div class="server-list" :class="{ loading: connectionsLoading }">
            <button
              v-for="connection in filteredConnections"
              :key="connection.id"
              class="server-row"
              :class="{ selected: selectedIds.includes(connection.id) }"
              @click="toggleConnection(connection.id)"
            >
              <span class="checkbox"><i v-if="selectedIds.includes(connection.id)" class="fas fa-check"></i></span>
              <span class="server-icon"><i class="fas fa-server"></i></span>
              <span class="server-main"><strong>{{ connection.name || connection.host }}</strong><small>{{ formatConnectionAddress(connection) }}</small></span>
              <span class="server-tags"><em v-for="name in tagNames(connection).slice(0, 2)" :key="name">{{ name }}</em></span>
              <span class="credential"><i :class="connection.credential_mode === 'prompt' ? 'fas fa-keyboard' : connection.auth_method === 'key' ? 'fas fa-key' : 'fas fa-lock'"></i>{{ connection.credential_mode === 'prompt' ? '每次输入' : connection.auth_method === 'key' ? '密钥' : '密码' }}</span>
            </button>
            <div v-if="!connectionsLoading && !filteredConnections.length" class="empty-state"><i class="fas fa-server"></i><strong>没有匹配的 SSH 服务器</strong><span>请调整搜索条件或先添加服务器资产。</span></div>
          </div>
        </div>

        <div class="task-panel">
          <div class="panel-heading"><div><span class="step">B</span><h3>{{ mode === 'command' ? '定义命令序列' : '选择文件与路径' }}</h3></div></div>
          <label class="field"><span>任务名称 <small>可选</small></span><input v-model="jobName" maxlength="120" :placeholder="mode === 'command' ? '例如：更新生产节点安全补丁' : '例如：分发 Nginx 配置'" /></label>

          <template v-if="mode === 'command'">
            <label class="field command-field">
              <span>命令脚本 <small>{{ commandCount }} 行有效命令</small></span>
              <div class="editor-shell">
                <div class="editor-bar"><span></span><span></span><span></span><em>shell · UTF-8</em></div>
                <textarea v-model="commandsText" spellcheck="false" aria-label="命令脚本"></textarea>
              </div>
            </label>
            <div class="safety-note"><i class="fas fa-shield-halved"></i><div><strong>命令内容不会写入审计摘要</strong><span>完整脚本和执行输出使用服务器主密钥加密后保存。请避免把长期密码直接写进命令。</span></div></div>
          </template>

          <template v-else>
            <input ref="fileInput" type="file" multiple class="sr-only" @change="onFilesSelected" />
            <button class="upload-zone" @click="fileInput?.click()">
              <i class="fas fa-cloud-arrow-up"></i>
              <strong>{{ selectedFiles.length ? `已选择 ${selectedFiles.length} 个文件` : '选择要分发的文件' }}</strong>
              <span>{{ selectedFiles.length ? `总大小 ${formatBytes(totalFileBytes)}` : '单文件上限由 BATCH_UPLOAD_MAX_MB 控制，最多 20 个文件' }}</span>
            </button>
            <div v-if="selectedFiles.length" class="file-list">
              <div v-for="file in selectedFiles" :key="`${file.name}-${file.size}`"><i class="fas fa-file"></i><span>{{ file.name }}</span><small>{{ formatBytes(file.size) }}</small></div>
            </div>
            <label class="field"><span>远程目标路径</span><input v-model="remotePath" placeholder="/opt/myapp/" /></label>
          </template>

          <div v-if="promptConnections.length" class="prompt-credentials">
            <div class="prompt-heading"><i class="fas fa-keyboard"></i><div><strong>本次执行凭据</strong><small>仅保存在内存中，任务结束即销毁</small></div></div>
            <label v-for="connection in promptConnections" :key="connection.id">
              <span>{{ connection.name || connection.host }}<small>{{ connection.auth_method === 'key' ? '密钥口令（可留空）' : 'SSH 密码' }}</small></span>
              <input v-model="ephemeralSecrets[connection.id]" type="password" autocomplete="off" :placeholder="connection.auth_method === 'key' ? '无口令可留空' : '输入本次密码'" />
            </label>
          </div>

          <div class="options-grid">
            <label class="field"><span>并发数量</span><input v-model.number="concurrency" type="number" min="1" :max="mode === 'command' ? 20 : 10" /></label>
            <label class="field"><span>单台超时（秒）</span><input v-model.number="timeoutSeconds" type="number" min="5" max="7200" /></label>
          </div>
          <div class="toggles">
            <label v-if="mode === 'command'"><input v-model="stopOnError" type="checkbox" /><span></span><div><strong>遇错即停</strong><small>远端脚本使用 set -e</small></div></label>
            <label v-if="mode === 'command'"><input v-model="recordOutput" type="checkbox" /><span></span><div><strong>保存输出</strong><small>加密保存 stdout / stderr</small></div></label>
            <label v-if="mode === 'upload'"><input v-model="overwrite" type="checkbox" /><span></span><div><strong>允许覆盖</strong><small>目标文件已存在时替换</small></div></label>
          </div>
          <div class="launch-bar">
            <div><strong>{{ selectedIds.length }} 台目标</strong><span>并发 {{ Math.min(concurrency, mode === 'command' ? 20 : 10) }} · 超时 {{ timeoutSeconds }} 秒</span></div>
            <button class="button button-primary launch" :disabled="submitting" @click="mode === 'command' ? submitCommandJob() : submitUploadJob()">
              <i :class="submitting ? 'fas fa-spinner fa-spin' : 'fas fa-play'"></i>{{ submitting ? '正在创建…' : '创建并执行' }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <section class="history-section">
      <div class="section-heading"><div><span class="section-index">02</span><div><h2>最近任务</h2><p>执行进度、逐台结果和加密输出均集中保留。</p></div></div><span>{{ jobs.length }} 条记录</span></div>
      <div class="job-table-wrap">
        <table class="job-table">
          <thead><tr><th>任务</th><th>进度</th><th>结果</th><th>创建时间</th><th></th></tr></thead>
          <tbody>
            <tr v-for="job in jobs" :key="job.id" @click="openDetail(job.id)">
              <td><div class="job-name"><span :class="{ [job.type]: true, playbook: isPlaybookJob(job) }"><i :class="jobIcon(job)"></i></span><div><strong>{{ job.name }}</strong><small>{{ jobSubtitle(job) }} · {{ job.targetCount }} 台目标</small></div></div></td>
              <td><div class="progress-cell"><div><span :style="{ width: `${progress(job)}%` }"></span></div><small>{{ job.completedCount }} / {{ job.targetCount }}</small></div></td>
              <td><span class="status-pill" :class="statusClass(job.status)"><i></i>{{ statusLabel(job.status) }}</span><small class="result-count"><b>{{ job.successCount }}</b> 成功 · <em>{{ job.failedCount }}</em> 失败</small></td>
              <td><span class="time">{{ formatTime(job.createdAt) }}</span></td>
              <td><button class="icon-button" aria-label="查看任务详情"><i class="fas fa-chevron-right"></i></button></td>
            </tr>
            <tr v-if="!jobsLoading && !jobs.length"><td colspan="5"><div class="empty-state"><i class="fas fa-list-check"></i><strong>还没有批量任务</strong><span>从上方选择服务器并创建第一个任务。</span></div></td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <div v-if="detail || detailLoading" class="detail-backdrop" @click.self="detail = null">
      <aside class="detail-drawer" aria-label="任务详情">
        <div v-if="detailLoading" class="drawer-loading"><i class="fas fa-spinner fa-spin"></i>加载任务详情…</div>
        <template v-else-if="detail">
          <header>
            <div><span class="status-pill" :class="statusClass(detail.status)"><i></i>{{ statusLabel(detail.status) }}</span><h2>{{ detail.name }}</h2><p>{{ detail.id }}</p></div>
            <button class="drawer-close" @click="detail = null">×</button>
          </header>
          <div class="detail-summary">
            <div><span>完成</span><strong>{{ detail.completedCount }}/{{ detail.targetCount }}</strong></div>
            <div><span>成功</span><strong class="success-text">{{ detail.successCount }}</strong></div>
            <div><span>失败</span><strong class="error-text">{{ detail.failedCount }}</strong></div>
            <div><span>开始</span><strong class="small-value">{{ formatTime(detail.startedAt) }}</strong></div>
          </div>
          <div v-if="detail.payload.kind === 'command'" class="payload-preview"><div><span>执行脚本</span><small>加密存储</small></div><pre>{{ detail.payload.commands.join('\n') }}</pre></div>
          <div v-else-if="detail.payload.kind === 'playbook'" class="payload-preview"><div><span>自动化剧本 · r{{ detail.payload.revision }}</span><small>{{ detail.payload.steps.length }} 个步骤</small></div><pre>{{ detail.payload.steps.map((step: any, index: number) => `${index + 1}. [${step.type === 'command' ? '命令' : '文件'}] ${step.name}`).join('\n') }}</pre></div>
          <div v-else class="payload-preview"><div><span>文件分发</span><small>{{ detail.payload.remotePath }}</small></div><pre>{{ detail.payload.files.map((file: any) => `${file.originalName}  (${formatBytes(file.size)})`).join('\n') }}</pre></div>
          <div class="target-results">
            <h3>逐台结果</h3>
            <article v-for="target in detail.targets" :key="target.id" :class="{ expanded: expandedTargetId === target.id }">
              <button @click="expandedTargetId = expandedTargetId === target.id ? null : target.id">
                <span class="target-status" :class="statusClass(target.status)"><i :class="target.status === 'success' ? 'fas fa-check' : target.status === 'running' ? 'fas fa-spinner fa-spin' : target.status === 'queued' ? 'fas fa-clock' : 'fas fa-xmark'"></i></span>
                <span><strong>{{ target.connectionName }}</strong><small>{{ target.host }} · {{ formatDuration(target.durationMs) }}</small></span>
                <em>{{ statusLabel(target.status) }}</em><i class="fas fa-chevron-down"></i>
              </button>
              <div v-if="expandedTargetId === target.id" class="target-output">
                <p v-if="target.error" class="target-error">{{ target.error }}</p>
                <div v-if="target.stdout"><span>STDOUT</span><pre>{{ target.stdout }}</pre></div>
                <div v-if="target.stderr"><span>STDERR</span><pre class="stderr">{{ target.stderr }}</pre></div>
                <p v-if="!target.error && !target.stdout && !target.stderr">此目标没有保存输出。</p>
              </div>
            </article>
          </div>
          <footer><button v-if="['queued', 'running'].includes(detail.status)" class="button danger-button" @click="cancel(detail)"><i class="fas fa-stop"></i>取消任务</button><button class="button button-secondary" @click="openDetail(detail.id)"><i class="fas fa-rotate"></i>刷新</button></footer>
        </template>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.orchestration-page{min-height:calc(100vh - 56px);padding:34px clamp(18px,3vw,48px) 64px;background:var(--fd-subtle);color:var(--text-color);font-family:var(--font-family-sans-serif)}
.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;max-width:1500px;margin:0 auto 28px}
.eyebrow{display:flex;align-items:center;gap:9px;color:var(--text-color-secondary);font-size:12px;font-weight:800;letter-spacing:.18em}
.live-dot{width:8px;height:8px;border-radius:50%;background:var(--link-active-color);box-shadow:0 0 0 5px rgba(35,163,123,.12)}
.hero h1{margin:9px 0 8px;font-family:var(--font-family-sans-serif);font-size:clamp(32px,4vw,52px);font-weight:500;letter-spacing:-.035em;color:var(--text-color)}
.hero p{max-width:760px;margin:0;color:var(--text-color-secondary);font-size:15px;line-height:1.75}
.hero-actions{display:flex;gap:10px;flex-shrink:0}
.button{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;border-radius:9px;padding:11px 16px;font-weight:700;font-size:13px;transition:.18s ease}
.button-primary{background:var(--link-active-color);color:#fff;box-shadow:0 6px 16px rgba(23,107,85,.18)}
.button-primary:hover{background:var(--link-active-color);transform:translateY(-1px)}
.button-secondary{background:var(--fd-surface);color:var(--text-color);border:1px solid var(--fd-line)}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;max-width:1500px;margin:0 auto 24px;overflow:hidden;border:1px solid var(--fd-line);border-radius:13px;background:var(--fd-subtle)}
.metrics article{display:flex;flex-direction:column;min-height:118px;padding:19px 22px;background:var(--fd-surface)}
.metrics span{color:var(--text-color-secondary);font-size:12px;font-weight:700}
.metrics strong{margin:5px 0 1px;font-family:var(--font-family-sans-serif);font-size:31px;font-weight:500;color:var(--text-color)}
.metrics small{color:var(--text-color-secondary);font-size:12px}
.metrics .security-metric{background:var(--link-active-color)}
.metrics .security-metric span,.metrics .security-metric small{color:var(--text-color-secondary)}
.metrics .security-metric strong{display:flex;align-items:center;gap:10px;color:var(--text-color-secondary);font-family:var(--font-family-sans-serif);font-size:22px;font-weight:700}
.feedback{display:flex;align-items:center;gap:10px;max-width:1500px;margin:0 auto 14px;padding:12px 15px;border-radius:9px;font-size:13px;font-weight:600}
.feedback button{margin-left:auto;border:0;background:transparent;font-size:19px}
.feedback-error{background:var(--fd-subtle);color:#a13b2d;border:1px solid #f2cdc5}
.feedback-success{background:var(--fd-subtle);color:var(--link-active-color);border:1px solid var(--fd-line)}
.composer,.history-section{max-width:1500px;margin:0 auto 26px;border:1px solid var(--fd-line);border-radius:14px;background:var(--fd-surface);box-shadow:0 12px 35px rgba(25,42,37,.045);overflow:hidden}
.composer-title{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid var(--fd-line)}
.composer-title>div:first-child,.section-heading>div{display:flex;align-items:center;gap:12px}
.section-index{display:inline-flex;align-items:center;justify-content:center;width:29px;height:29px;border-radius:8px;background:var(--fd-subtle);color:var(--link-active-color);font-family:var(--font-family-sans-serif);font-size:13px}
.composer h2,.history-section h2{margin:0;font-family:var(--font-family-sans-serif);font-size:22px;font-weight:500}
.mode-switch{display:flex;padding:3px;border-radius:9px;background:var(--fd-subtle)}
.mode-switch button{display:flex;align-items:center;gap:7px;padding:8px 13px;border:0;border-radius:7px;background:transparent;color:var(--text-color-secondary);font-size:12px;font-weight:700}
.mode-switch button.active{background:var(--fd-surface);color:var(--link-active-color);box-shadow:0 2px 7px rgba(24,44,39,.1)}
.composer-grid{display:grid;grid-template-columns:minmax(420px,.9fr) minmax(520px,1.1fr)}
.target-panel,.task-panel{padding:22px}
.target-panel{border-right:1px solid var(--fd-line);background:var(--fd-surface)}
.panel-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:17px}
.panel-heading>div{display:flex;align-items:center;gap:10px}
.panel-heading h3{margin:0;font-size:15px}
.step{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:var(--link-active-color);color:#fff;font-size:12px;font-weight:800}
.selection-count{padding:5px 9px;border-radius:999px;background:var(--fd-subtle);color:var(--link-active-color);font-size:12px;font-weight:800}
.filters{display:grid;grid-template-columns:1fr 130px;gap:9px}
.search-box{position:relative}
.search-box i{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text-color-secondary);font-size:12px}
.filters input,.filters select,.field input{width:100%;height:40px;box-sizing:border-box;border:1px solid var(--fd-line);border-radius:8px;background:var(--fd-surface);color:var(--text-color);padding:0 12px;font-size:13px}
.filters input{padding-left:34px}
.filters input:focus,.filters select:focus,.field input:focus{border-color:var(--fd-line);box-shadow:0 0 0 3px rgba(60,142,117,.1)!important}
.select-row{display:flex;align-items:center;justify-content:space-between;margin:11px 2px;color:var(--text-color-secondary);font-size:12px}
.text-button{border:0;background:transparent;color:var(--link-active-color);padding:0;font-size:12px;font-weight:800}
.text-button i{margin-right:6px;color:inherit}
.server-list{height:365px;overflow:auto;border:1px solid var(--fd-line);border-radius:9px;background:var(--fd-surface)}
.server-row{display:grid;grid-template-columns:22px 34px minmax(0,1fr) auto auto;align-items:center;gap:9px;width:100%;padding:11px 12px;border:0;border-bottom:1px solid var(--fd-line);background:var(--fd-surface);text-align:left}
.server-row:last-child{border-bottom:0}
.server-row:hover{background:var(--fd-subtle)}
.server-row.selected{background:var(--fd-subtle)}
.checkbox{display:flex;align-items:center;justify-content:center;width:17px;height:17px;border:1.5px solid var(--fd-line);border-radius:5px;color:#fff;font-size:12px}
.selected .checkbox{border-color:var(--fd-line);background:var(--link-active-color)}
.server-icon{display:flex;align-items:center;justify-content:center;width:31px;height:31px;border-radius:8px;background:var(--fd-subtle);color:var(--text-color-secondary)}
.server-main{min-width:0}
.server-main strong,.server-main small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.server-main strong{font-size:12px;color:var(--text-color)}
.server-main small{margin-top:2px;color:var(--text-color-secondary);font-family:"SFMono-Regular",Consolas,monospace;font-size:12px}
.server-tags{display:flex;gap:4px}
.server-tags em{padding:3px 6px;border-radius:5px;background:var(--fd-subtle);color:var(--text-color-secondary);font-size:12px;font-style:normal}
.credential{display:flex;align-items:center;gap:5px;min-width:48px;color:var(--text-color-secondary);font-size:12px}
.credential i{color:var(--link-active-color)}
.task-panel{display:flex;flex-direction:column;gap:15px}
.field{display:flex;flex-direction:column;gap:7px}
.field>span{display:flex;justify-content:space-between;color:var(--text-color);font-size:12px;font-weight:750}
.field>span small{color:var(--text-color-secondary);font-size:12px;font-weight:500}
.command-field{gap:7px}
.editor-shell{overflow:hidden;border:1px solid var(--fd-line);border-radius:9px;background:var(--link-active-color)}
.editor-bar{display:flex;align-items:center;gap:5px;height:29px;padding:0 10px;background:var(--link-active-color)}
.editor-bar span{width:7px;height:7px;border-radius:50%;background:var(--link-active-color)}
.editor-bar span:first-child{background:#d77761}
.editor-bar span:nth-child(2){background:#d4ae55}
.editor-bar span:nth-child(3){background:var(--link-active-color)}
.editor-bar em{margin-left:auto;color:var(--text-color-secondary);font-size:12px;font-style:normal}
.editor-shell textarea{display:block;width:100%;height:142px;box-sizing:border-box;resize:vertical;border:0;outline:0;background:var(--link-active-color);color:var(--text-color-secondary);padding:13px 15px;font:12px/1.75 "SFMono-Regular",Consolas,monospace}
.safety-note{display:flex;gap:10px;padding:11px 12px;border:1px solid var(--fd-line);border-radius:8px;background:var(--fd-subtle);color:var(--link-active-color)}
.safety-note>i{margin-top:2px}
.safety-note strong,.safety-note span{display:block}
.safety-note strong{font-size:12px}
.safety-note span{margin-top:2px;color:var(--text-color-secondary);font-size:12px;line-height:1.5}
.options-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.toggles{display:flex;gap:22px;padding:2px 0}
.toggles label{display:flex;align-items:center;gap:8px;cursor:pointer}
.toggles input{position:absolute;opacity:0}
.toggles label>span{position:relative;width:31px;height:18px;border-radius:10px;background:var(--link-active-color);transition:.2s}
.toggles label>span:after{content:"";position:absolute;top:3px;left:3px;width:12px;height:12px;border-radius:50%;background:var(--fd-surface);transition:.2s}
.toggles input:checked+span{background:var(--link-active-color)}
.toggles input:checked+span:after{transform:translateX(13px)}
.toggles strong,.toggles small{display:block}
.toggles strong{font-size:12px}
.toggles small{color:var(--text-color-secondary);font-size:12px}
.launch-bar{display:flex;align-items:center;justify-content:space-between;margin-top:auto;padding-top:14px;border-top:1px solid var(--fd-line)}
.launch-bar strong,.launch-bar span{display:block}
.launch-bar strong{font-size:13px}
.launch-bar span{margin-top:2px;color:var(--text-color-secondary);font-size:12px}
.launch{min-width:142px}
.launch:disabled{opacity:.65;transform:none}
.upload-zone{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:120px;border:1.5px dashed var(--fd-line);border-radius:10px;background:var(--fd-subtle);color:var(--text-color-secondary)}
.upload-zone i{margin-bottom:8px;color:var(--link-active-color);font-size:25px}
.upload-zone strong{font-size:12px}
.upload-zone span{margin-top:5px;color:var(--text-color-secondary);font-size:12px}
.file-list{max-height:100px;overflow:auto;border:1px solid var(--fd-line);border-radius:8px}
.file-list div{display:grid;grid-template-columns:18px 1fr auto;align-items:center;gap:7px;padding:7px 10px;border-bottom:1px solid var(--fd-line);font-size:12px}
.file-list div:last-child{border:0}
.file-list i{color:var(--link-active-color)}
.file-list small{color:var(--text-color-secondary)}
.history-section{padding-bottom:6px}
.section-heading{display:flex;align-items:center;justify-content:space-between;padding:20px 22px}
.section-heading p{margin:3px 0 0;color:var(--text-color-secondary);font-size:12px}
.section-heading>span{color:var(--text-color-secondary);font-size:12px}
.job-table-wrap{overflow-x:auto}
.job-table{width:100%;border-collapse:collapse}
.job-table th{padding:10px 18px;background:var(--fd-subtle);color:var(--text-color-secondary);font-size:12px;letter-spacing:.08em;text-align:left;text-transform:uppercase}
.job-table td{padding:13px 18px;border-top:1px solid var(--fd-line);vertical-align:middle}
.job-table tbody tr{cursor:pointer;transition:.15s}
.job-table tbody tr:hover{background:var(--fd-subtle)}
.job-name{display:flex;align-items:center;gap:10px}
.job-name>span{display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;background:var(--fd-subtle);color:var(--link-active-color)}
.job-name>span.upload{background:var(--fd-subtle);color:#9a6a27}
.job-name strong,.job-name small{display:block}
.job-name strong{font-size:12px}
.job-name small{margin-top:2px;color:var(--text-color-secondary);font-size:12px}
.progress-cell{display:flex;align-items:center;gap:8px;min-width:150px}
.progress-cell>div{width:105px;height:5px;overflow:hidden;border-radius:4px;background:var(--fd-subtle)}
.progress-cell>div span{display:block;height:100%;border-radius:inherit;background:var(--link-active-color)}
.progress-cell small{color:var(--text-color-secondary);font-size:12px}
.status-pill{display:inline-flex;align-items:center;gap:6px;padding:5px 8px;border-radius:999px;background:var(--fd-subtle);color:var(--text-color-secondary);font-size:12px;font-weight:800}
.status-pill>i{width:6px;height:6px;border-radius:50%;background:currentColor}
.status-success{background:var(--fd-subtle);color:var(--link-active-color)}
.status-running{background:var(--fd-subtle);color:var(--link-active-color)}
.status-queued{background:var(--fd-subtle);color:var(--text-color-secondary)}
.status-partial{background:var(--fd-subtle);color:#a66317}
.status-failed{background:var(--fd-subtle);color:#aa4335}
.status-cancelled{background:var(--fd-subtle);color:var(--text-color-secondary)}
.result-count{display:block;margin-top:5px;color:var(--text-color-secondary);font-size:12px}
.result-count b{color:var(--link-active-color)}
.result-count em{color:#b04b3c;font-style:normal}
.time{color:var(--text-color-secondary);font-size:12px}
.icon-button{width:28px;height:28px;border:0;border-radius:7px;background:var(--fd-subtle);color:var(--text-color-secondary)}
.empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:190px;color:var(--text-color-secondary)}
.empty-state i{margin-bottom:8px;font-size:25px;color:var(--text-color-secondary)}
.empty-state strong{font-size:12px}
.empty-state span{margin-top:4px;font-size:12px}
.detail-backdrop{position:fixed;inset:0;z-index:100;background:rgba(10,25,21,.4);backdrop-filter:blur(2px)}
.detail-drawer{position:absolute;top:0;right:0;width:min(650px,94vw);height:100%;box-sizing:border-box;overflow:auto;background:var(--fd-subtle);box-shadow:-18px 0 50px rgba(8,26,21,.18)}
.drawer-loading{display:flex;align-items:center;justify-content:center;height:100%;gap:9px;color:var(--text-color-secondary)}
.detail-drawer header{display:flex;justify-content:space-between;padding:25px 26px 19px;background:var(--link-active-color);color:#fff}
.detail-drawer header h2{margin:12px 0 5px;font-family:var(--font-family-sans-serif);font-size:25px;font-weight:500}
.detail-drawer header p{margin:0;color:var(--text-color-secondary);font:9px Consolas,monospace}
.drawer-close{align-self:flex-start;border:0;background:transparent;color:var(--text-color-secondary);font-size:28px}
.detail-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;margin:17px 20px;background:var(--fd-subtle);border:1px solid var(--fd-line);border-radius:10px;overflow:hidden}
.detail-summary div{min-height:66px;padding:11px;background:var(--fd-surface)}
.detail-summary span,.detail-summary strong{display:block}
.detail-summary span{color:var(--text-color-secondary);font-size:12px}
.detail-summary strong{margin-top:5px;font-family:var(--font-family-sans-serif);font-size:20px;font-weight:500}
.detail-summary .small-value{font-family:var(--font-family-sans-serif);font-size:12px;line-height:1.4}
.success-text{color:var(--link-active-color)}
.error-text{color:#aa4335}
.payload-preview{margin:0 20px 17px;border:1px solid var(--fd-line);border-radius:9px;background:var(--fd-surface);overflow:hidden}
.payload-preview>div{display:flex;justify-content:space-between;padding:9px 11px;border-bottom:1px solid var(--fd-line);font-size:12px;font-weight:700}
.payload-preview small{color:var(--text-color-secondary);font-weight:400}
.payload-preview pre,.target-output pre{margin:0;white-space:pre-wrap;word-break:break-word;background:var(--link-active-color);color:var(--text-color-secondary);padding:12px;font:10px/1.6 Consolas,monospace}
.target-results{padding:0 20px 80px}
.target-results h3{font-size:12px}
.target-results article{margin-bottom:7px;border:1px solid var(--fd-line);border-radius:9px;background:var(--fd-surface);overflow:hidden}
.target-results article>button{display:grid;grid-template-columns:28px 1fr auto 12px;align-items:center;gap:9px;width:100%;padding:10px 11px;border:0;background:var(--fd-surface);text-align:left}
.target-status{display:flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:7px}
.target-results button strong,.target-results button small{display:block}
.target-results button strong{font-size:12px}
.target-results button small{margin-top:2px;color:var(--text-color-secondary);font-size:12px}
.target-results button em{font-size:12px;font-style:normal;color:var(--text-color-secondary)}
.target-output{border-top:1px solid var(--fd-line);background:var(--fd-subtle);padding:9px}
.target-output>div{margin-top:7px;border-radius:6px;overflow:hidden}
.target-output>div>span{display:block;padding:5px 8px;background:var(--fd-subtle);color:var(--text-color-secondary);font-size:12px;font-weight:800}
.target-output pre.stderr{color:#ffc7bd}
.target-output p{margin:3px;color:var(--text-color-secondary);font-size:12px}
.target-output .target-error{color:#a64233}
.detail-drawer footer{position:sticky;bottom:0;display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--fd-line);background:rgba(255,255,255,.95)}
.danger-button{background:#a84738;color:#fff}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}

@media(max-width:1050px){.metrics{grid-template-columns:repeat(2,1fr)}
.composer-grid{grid-template-columns:1fr}
.target-panel{border-right:0;border-bottom:1px solid var(--fd-line)}
.server-list{height:300px}
}
@media(max-width:700px){.orchestration-page{padding:22px 12px 45px}
.hero{align-items:flex-start;flex-direction:column}
.hero-actions{width:100%}
.hero-actions .button{flex:1}
.metrics{grid-template-columns:1fr 1fr}
.metrics article{min-height:98px;padding:15px}
.composer-title{align-items:flex-start;flex-direction:column;gap:12px}
.mode-switch{width:100%}
.mode-switch button{flex:1;justify-content:center}
.composer-grid{display:block}
.target-panel,.task-panel{padding:16px}
.filters{grid-template-columns:1fr}
.server-row{grid-template-columns:20px 30px minmax(0,1fr) auto}
.server-tags{display:none}
.credential{font-size:0}
.credential i{font-size:12px}
.options-grid{grid-template-columns:1fr 1fr}
.launch-bar{align-items:stretch;flex-direction:column;gap:10px}
.toggles{flex-wrap:wrap}
.job-table th:nth-child(4),.job-table td:nth-child(4){display:none}
.detail-summary{grid-template-columns:1fr 1fr}
.detail-drawer header{padding:21px}
.section-heading{align-items:flex-start}
.metrics strong{font-size:25px}
}

.prompt-credentials{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--fd-line);border-radius:9px;background:var(--fd-subtle)}
.prompt-heading{display:flex;align-items:center;gap:9px;color:#76591f}
.prompt-heading strong,.prompt-heading small{display:block}
.prompt-heading strong{font-size:12px}
.prompt-heading small{margin-top:2px;font-size:12px;font-weight:400}
.prompt-credentials>label{display:grid;grid-template-columns:minmax(120px,1fr) minmax(150px,1.3fr);align-items:center;gap:10px}
.prompt-credentials>label>span{font-size:12px;font-weight:700}
.prompt-credentials>label small{display:block;margin-top:2px;color:var(--text-color-secondary);font-size:12px;font-weight:400}
.prompt-credentials input{height:34px;border:1px solid var(--fd-line);border-radius:7px;background:var(--fd-surface);padding:0 10px;font-size:12px}

.job-name>span.playbook{background:var(--fd-subtle);color:var(--text-color-secondary)}

</style>
