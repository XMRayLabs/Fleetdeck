<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useRouter } from 'vue-router';
import apiClient from '../utils/apiClient';
import { useConnectionsStore, type ConnectionInfo } from '../stores/connections.store';
import { useTagsStore } from '../stores/tags.store';

interface PlaybookVariable {
  name: string;
  label: string;
  defaultValue: string;
  required: boolean;
  secret: boolean;
}

interface CommandStep {
  id: string;
  name: string;
  type: 'command';
  command: string;
  continueOnError: boolean;
}

interface UploadStep {
  id: string;
  name: string;
  type: 'upload';
  fileId: string;
  remotePath: string;
  overwrite: boolean;
  continueOnError: boolean;
}

type PlaybookStep = CommandStep | UploadStep;

interface PlaybookFile {
  id: string;
  name: string;
  size: number;
  createdAt: number;
}

interface Playbook {
  id: string;
  name: string;
  description: string;
  category: string;
  revision: number;
  definition: { variables: PlaybookVariable[]; steps: PlaybookStep[] };
  files: PlaybookFile[];
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

interface EditorModel {
  id: string | null;
  name: string;
  description: string;
  category: string;
  revision: number;
  definition: { variables: PlaybookVariable[]; steps: PlaybookStep[] };
  files: PlaybookFile[];
}

const router = useRouter();
const connectionsStore = useConnectionsStore();
const tagsStore = useTagsStore();
const { connections } = storeToRefs(connectionsStore);
const { tags } = storeToRefs(tagsStore);

const playbooks = ref<Playbook[]>([]);
const loading = ref(false);
const saving = ref(false);
const uploading = ref(false);
const running = ref(false);
const search = ref('');
const categoryFilter = ref('all');
const errorMessage = ref('');
const successMessage = ref('');
const editor = ref<EditorModel | null>(null);
const runPlaybook = ref<Playbook | null>(null);
const attachmentInput = ref<HTMLInputElement | null>(null);
const selectedIds = ref<number[]>([]);
const selectedTagId = ref<number | 'all'>('all');
const serverSearch = ref('');
const runVariableValues = ref<Record<string, string>>({});
const ephemeralSecrets = ref<Record<number, string>>({});
const concurrency = ref(5);
const timeoutSeconds = ref(900);
const stopOnError = ref(true);
const createdJobId = ref('');

const newId = (): string => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const sshConnections = computed(() => connections.value.filter(connection => connection.type === 'SSH'));
const categories = computed(() => [...new Set(playbooks.value.map(playbook => playbook.category))].sort());
const totalSteps = computed(() => playbooks.value.reduce((sum, playbook) => sum + playbook.definition.steps.length, 0));
const uploadStepCount = computed(() => playbooks.value.reduce(
  (sum, playbook) => sum + playbook.definition.steps.filter(step => step.type === 'upload').length,
  0,
));
const filteredPlaybooks = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return playbooks.value.filter(playbook => {
    const categoryMatches = categoryFilter.value === 'all' || playbook.category === categoryFilter.value;
    const textMatches = !needle || [playbook.name, playbook.description, playbook.category]
      .some(value => value.toLowerCase().includes(needle));
    return categoryMatches && textMatches;
  });
});
const filteredConnections = computed(() => {
  const needle = serverSearch.value.trim().toLowerCase();
  return sshConnections.value.filter(connection => {
    const tagMatches = selectedTagId.value === 'all' || connection.tag_ids?.includes(Number(selectedTagId.value));
    const textMatches = !needle || [connection.name, connection.host, connection.username]
      .some(value => value?.toLowerCase().includes(needle));
    return tagMatches && textMatches;
  });
});
const allVisibleSelected = computed(() => filteredConnections.value.length > 0
  && filteredConnections.value.every(connection => selectedIds.value.includes(connection.id)));
const promptConnections = computed(() => sshConnections.value.filter(
  connection => selectedIds.value.includes(connection.id) && connection.credential_mode === 'prompt',
));

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};
const formatDate = (timestamp: number): string => new Date(timestamp * 1000).toLocaleString('zh-CN', { hour12: false });
const tagNames = (connection: ConnectionInfo): string[] => (connection.tag_ids || [])
  .map(id => tags.value.find(tag => tag.id === id)?.name)
  .filter((name): name is string => Boolean(name));
const stepIcon = (step: PlaybookStep): string => step.type === 'command' ? 'fas fa-terminal' : 'fas fa-cloud-arrow-up';

const fetchPlaybooks = async (): Promise<void> => {
  loading.value = true;
  errorMessage.value = '';
  try {
    const response = await apiClient.get<{ playbooks: Playbook[] }>('/playbooks');
    playbooks.value = response.data.playbooks;
  } catch (error: any) {
    errorMessage.value = error.response?.data?.message || '无法加载剧本库。';
  } finally {
    loading.value = false;
  }
};

const openNewEditor = (): void => {
  errorMessage.value = '';
  successMessage.value = '';
  editor.value = {
    id: null,
    name: '',
    description: '',
    category: '常规运维',
    revision: 0,
    definition: {
      variables: [],
      steps: [{
        id: newId(),
        name: '执行命令',
        type: 'command',
        command: 'uname -a\ndf -h',
        continueOnError: false,
      }],
    },
    files: [],
  };
};

const openEditor = (playbook: Playbook): void => {
  errorMessage.value = '';
  successMessage.value = '';
  editor.value = JSON.parse(JSON.stringify({ ...playbook })) as EditorModel;
};

const addVariable = (): void => {
  editor.value?.definition.variables.push({
    name: `VARIABLE_${(editor.value?.definition.variables.length || 0) + 1}`,
    label: '执行变量',
    defaultValue: '',
    required: false,
    secret: false,
  });
};

const setSecret = (variable: PlaybookVariable): void => {
  if (variable.secret) variable.defaultValue = '';
};

const addCommandStep = (): void => {
  editor.value?.definition.steps.push({
    id: newId(),
    name: '执行命令',
    type: 'command',
    command: '',
    continueOnError: false,
  });
};

const addUploadStep = (): void => {
  if (!editor.value?.files.length) {
    errorMessage.value = '请先保存剧本并上传附件，再添加文件分发步骤。';
    return;
  }
  editor.value.definition.steps.push({
    id: newId(),
    name: '分发文件',
    type: 'upload',
    fileId: editor.value.files[0].id,
    remotePath: '/tmp/',
    overwrite: true,
    continueOnError: false,
  });
};

const moveStep = (index: number, direction: -1 | 1): void => {
  if (!editor.value) return;
  const target = index + direction;
  if (target < 0 || target >= editor.value.definition.steps.length) return;
  const [step] = editor.value.definition.steps.splice(index, 1);
  editor.value.definition.steps.splice(target, 0, step);
};

const saveEditor = async (): Promise<void> => {
  if (!editor.value || saving.value) return;
  errorMessage.value = '';
  successMessage.value = '';
  if (!editor.value.name.trim()) {
    errorMessage.value = '请输入剧本名称。';
    return;
  }
  saving.value = true;
  try {
    const payload = {
      name: editor.value.name,
      description: editor.value.description,
      category: editor.value.category,
      definition: editor.value.definition,
    };
    const response = editor.value.id
      ? await apiClient.put<{ playbook: Playbook }>(`/playbooks/${editor.value.id}`, payload)
      : await apiClient.post<{ playbook: Playbook }>('/playbooks', payload);
    editor.value = JSON.parse(JSON.stringify(response.data.playbook)) as EditorModel;
    successMessage.value = `剧本“${response.data.playbook.name}”已保存为 r${response.data.playbook.revision}。`;
    await fetchPlaybooks();
  } catch (error: any) {
    errorMessage.value = error.response?.data?.message || '保存剧本失败。';
  } finally {
    saving.value = false;
  }
};

const uploadAttachments = async (event: Event): Promise<void> => {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  if (!editor.value?.id || !files.length) return;
  uploading.value = true;
  errorMessage.value = '';
  try {
    const form = new FormData();
    files.forEach(file => form.append('files', file));
    const response = await apiClient.post<{ playbook: Playbook }>(`/playbooks/${editor.value.id}/files`, form, { timeout: 120000 });
    editor.value = JSON.parse(JSON.stringify(response.data.playbook)) as EditorModel;
    await fetchPlaybooks();
  } catch (error: any) {
    errorMessage.value = error.response?.data?.message || '上传附件失败。';
  } finally {
    uploading.value = false;
    input.value = '';
  }
};

const removeAttachment = async (file: PlaybookFile): Promise<void> => {
  if (!editor.value?.id || !confirm(`确定删除附件“${file.name}”吗？`)) return;
  try {
    await apiClient.delete(`/playbooks/${editor.value.id}/files/${file.id}`);
    editor.value.files = editor.value.files.filter(item => item.id !== file.id);
    await fetchPlaybooks();
  } catch (error: any) {
    errorMessage.value = error.response?.data?.message || '删除附件失败。';
  }
};

const removePlaybook = async (playbook: Playbook): Promise<void> => {
  if (!confirm(`确定删除剧本“${playbook.name}”吗？已有任务记录不会被删除。`)) return;
  try {
    await apiClient.delete(`/playbooks/${playbook.id}`);
    successMessage.value = `剧本“${playbook.name}”已删除。`;
    await fetchPlaybooks();
  } catch (error: any) {
    errorMessage.value = error.response?.data?.message || '删除剧本失败。';
  }
};

const openRun = (playbook: Playbook): void => {
  errorMessage.value = '';
  successMessage.value = '';
  runPlaybook.value = playbook;
  selectedIds.value = [];
  selectedTagId.value = 'all';
  serverSearch.value = '';
  runVariableValues.value = Object.fromEntries(playbook.definition.variables.map(variable => [variable.name, variable.defaultValue]));
  ephemeralSecrets.value = {};
  concurrency.value = 5;
  timeoutSeconds.value = 900;
  stopOnError.value = true;
  createdJobId.value = '';
};

const toggleConnection = (id: number): void => {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter(value => value !== id)
    : [...selectedIds.value, id];
};

const toggleVisible = (): void => {
  const visibleIds = filteredConnections.value.map(connection => connection.id);
  selectedIds.value = allVisibleSelected.value
    ? selectedIds.value.filter(id => !visibleIds.includes(id))
    : [...new Set([...selectedIds.value, ...visibleIds])];
};

const execute = async (): Promise<void> => {
  if (!runPlaybook.value || running.value) return;
  errorMessage.value = '';
  if (!selectedIds.value.length) {
    errorMessage.value = '请至少选择一台 SSH 服务器。';
    return;
  }
  const ephemeralCredentials: Record<string, { password?: string; passphrase?: string }> = {};
  for (const connection of promptConnections.value) {
    const secret = ephemeralSecrets.value[connection.id] || '';
    if (connection.auth_method === 'password' && !secret) {
      errorMessage.value = `请输入 ${connection.name || connection.host} 的本次 SSH 密码。`;
      return;
    }
    ephemeralCredentials[String(connection.id)] = connection.auth_method === 'key' ? { passphrase: secret } : { password: secret };
  }
  running.value = true;
  try {
    const response = await apiClient.post<{ jobId: string }>(`/playbooks/${runPlaybook.value.id}/run`, {
      targetIds: selectedIds.value,
      variableValues: runVariableValues.value,
      concurrency: concurrency.value,
      timeoutSeconds: timeoutSeconds.value,
      stopOnError: stopOnError.value,
      ephemeralCredentials,
    });
    createdJobId.value = response.data.jobId;
    ephemeralSecrets.value = {};
    runVariableValues.value = {};
    successMessage.value = `剧本已分发到 ${selectedIds.value.length} 台服务器。`;
  } catch (error: any) {
    errorMessage.value = error.response?.data?.message || '执行剧本失败。';
  } finally {
    running.value = false;
  }
};

const goToJobCenter = async (): Promise<void> => {
  runPlaybook.value = null;
  await router.push('/orchestration');
};

onMounted(async () => {
  await Promise.all([fetchPlaybooks(), connectionsStore.fetchConnections(), tagsStore.fetchTags()]);
});
</script>

<template>
  <div class="playbooks-page">
    <section class="hero">
      <div>
        <div class="eyebrow"><span></span> REUSABLE AUTOMATION</div>
        <h1>自动化剧本库</h1>
        <p>像 Ansible 一样提前编排命令、变量与文件，保存为可复用执行包，选中服务器即可直接运行。</p>
      </div>
      <div class="hero-actions">
        <button class="button secondary" @click="fetchPlaybooks"><i class="fas fa-rotate"></i> 刷新</button>
        <button class="button primary" @click="openNewEditor"><i class="fas fa-plus"></i> 新建剧本</button>
      </div>
    </section>

    <section class="metrics">
      <article><span>已保存剧本</span><strong>{{ playbooks.length }}</strong><small>{{ categories.length }} 个分类</small></article>
      <article><span>编排步骤</span><strong>{{ totalSteps }}</strong><small>按顺序执行</small></article>
      <article><span>文件分发步骤</span><strong>{{ uploadStepCount }}</strong><small>附件私有存储</small></article>
      <article class="secure"><span>敏感变量</span><strong><i class="fas fa-memory"></i> MEMORY ONLY</strong><small>任务结束即清除</small></article>
    </section>

    <div v-if="errorMessage" class="feedback error"><i class="fas fa-circle-exclamation"></i>{{ errorMessage }}<button @click="errorMessage = ''">×</button></div>
    <div v-if="successMessage" class="feedback success"><i class="fas fa-circle-check"></i>{{ successMessage }}<button @click="successMessage = ''">×</button></div>

    <section class="library">
      <header>
        <div><h2>预设执行包</h2><p>将常用巡检、初始化、安装和发布流程固化为模板。</p></div>
        <div class="filters">
          <label><i class="fas fa-magnifying-glass"></i><input v-model="search" placeholder="搜索剧本或用途" /></label>
          <select v-model="categoryFilter"><option value="all">全部分类</option><option v-for="category in categories" :key="category">{{ category }}</option></select>
        </div>
      </header>

      <div v-if="loading" class="empty"><i class="fas fa-circle-notch fa-spin"></i><strong>正在加载剧本库</strong></div>
      <div v-else-if="filteredPlaybooks.length" class="playbook-grid">
        <article v-for="playbook in filteredPlaybooks" :key="playbook.id" class="playbook-card">
          <div class="card-top"><span class="category">{{ playbook.category }}</span><span class="revision">r{{ playbook.revision }}</span></div>
          <div class="book-icon"><i class="fas fa-book-open"></i></div>
          <h3>{{ playbook.name }}</h3>
          <p>{{ playbook.description || '暂无说明' }}</p>
          <div class="steps-preview">
            <span v-for="(step, index) in playbook.definition.steps.slice(0, 4)" :key="step.id"><i :class="stepIcon(step)"></i>{{ index + 1 }}. {{ step.name }}</span>
            <span v-if="playbook.definition.steps.length > 4">+ {{ playbook.definition.steps.length - 4 }} 个步骤</span>
          </div>
          <div class="card-meta"><span><i class="fas fa-list-check"></i>{{ playbook.definition.steps.length }} 步</span><span><i class="fas fa-paperclip"></i>{{ playbook.files.length }} 附件</span><span>{{ formatDate(playbook.updatedAt) }}</span></div>
          <footer>
            <button class="run" @click="openRun(playbook)"><i class="fas fa-play"></i> 选择服务器执行</button>
            <button title="编辑" @click="openEditor(playbook)"><i class="fas fa-pen"></i></button>
            <button class="delete" title="删除" @click="removePlaybook(playbook)"><i class="fas fa-trash"></i></button>
          </footer>
        </article>
      </div>
      <div v-else class="empty"><i class="fas fa-book-open"></i><strong>还没有匹配的剧本</strong><span>创建第一个预设执行包，把重复操作交给系统。</span><button class="button primary" @click="openNewEditor">新建剧本</button></div>
    </section>

    <div v-if="editor" class="backdrop" @mousedown.self="editor = null">
      <section class="drawer editor-drawer">
        <header class="drawer-header"><div><span>PLAYBOOK DESIGNER</span><h2>{{ editor.id ? '编辑剧本' : '创建剧本' }}</h2><p>{{ editor.id ? `当前版本 r${editor.revision}` : '先保存基础步骤，再上传附件。' }}</p></div><button @click="editor = null">×</button></header>
        <div v-if="errorMessage" class="drawer-feedback error"><i class="fas fa-circle-exclamation"></i>{{ errorMessage }}<button @click="errorMessage = ''">×</button></div>
        <div v-if="successMessage" class="drawer-feedback success"><i class="fas fa-circle-check"></i>{{ successMessage }}<button @click="successMessage = ''">×</button></div>
        <div class="drawer-body">
          <section class="form-section">
            <div class="section-title"><span>01</span><div><h3>基本信息</h3><p>让团队能快速识别这个执行包的用途。</p></div></div>
            <div class="two-columns"><label class="field"><span>剧本名称</span><input v-model="editor.name" maxlength="120" placeholder="例如：Ubuntu 新节点初始化" /></label><label class="field"><span>分类</span><input v-model="editor.category" maxlength="80" placeholder="例如：系统初始化" /></label></div>
            <label class="field"><span>用途说明</span><textarea v-model="editor.description" maxlength="2000" placeholder="说明适用系统、执行前提和预期结果。"></textarea></label>
          </section>

          <section class="form-section">
            <div class="section-title"><span>02</span><div><h3>执行变量</h3><p>命令和远程路径中使用 <code v-pre>{{ VARIABLE_NAME }}</code> 引用。</p></div><button class="mini" @click="addVariable"><i class="fas fa-plus"></i> 添加变量</button></div>
            <div v-if="!editor.definition.variables.length" class="compact-empty">当前没有变量；固定流程可以直接编排步骤。</div>
            <article v-for="(variable, index) in editor.definition.variables" :key="index" class="variable-row">
              <label><span>变量名</span><input v-model="variable.name" class="mono" placeholder="PACKAGE_NAME" /></label>
              <label><span>显示名称</span><input v-model="variable.label" placeholder="软件包名称" /></label>
              <label><span>默认值</span><input v-model="variable.defaultValue" :disabled="variable.secret" :type="variable.secret ? 'password' : 'text'" :placeholder="variable.secret ? '敏感变量不保存默认值' : '可留空'" /></label>
              <div class="variable-options"><label><input v-model="variable.required" type="checkbox" /> 必填</label><label><input v-model="variable.secret" type="checkbox" @change="setSecret(variable)" /> 敏感</label><button @click="editor.definition.variables.splice(index, 1)"><i class="fas fa-trash"></i></button></div>
            </article>
            <div class="security-note"><i class="fas fa-shield-halved"></i><div><strong>敏感变量不保存默认值</strong><span>密码、令牌等只在每次执行时填写，并只保留在运行进程内存中。变量按原文替换，外部输入用于 Shell 时请正确引用和转义。</span></div></div>
          </section>

          <section class="form-section">
            <div class="section-title"><span>03</span><div><h3>执行步骤</h3><p>所有步骤按从上到下的顺序在每台服务器执行。</p></div><div class="section-actions"><button class="mini" @click="addCommandStep"><i class="fas fa-terminal"></i> 命令</button><button class="mini" @click="addUploadStep"><i class="fas fa-file-arrow-up"></i> 文件</button></div></div>
            <article v-for="(step, index) in editor.definition.steps" :key="step.id" class="step-card">
              <header><span class="step-number">{{ String(index + 1).padStart(2, '0') }}</span><i :class="stepIcon(step)"></i><input v-model="step.name" maxlength="120" aria-label="步骤名称" /><em>{{ step.type === 'command' ? 'SHELL' : 'SFTP' }}</em><button :disabled="index === 0" @click="moveStep(index, -1)"><i class="fas fa-arrow-up"></i></button><button :disabled="index === editor.definition.steps.length - 1" @click="moveStep(index, 1)"><i class="fas fa-arrow-down"></i></button><button class="delete" @click="editor.definition.steps.splice(index, 1)"><i class="fas fa-trash"></i></button></header>
              <div v-if="step.type === 'command'" class="command-editor"><div><span></span><span></span><span></span><em>bash / sh</em></div><textarea v-model="step.command" spellcheck="false" placeholder="sudo apt-get update"></textarea></div>
              <div v-else class="upload-fields"><label class="field"><span>剧本附件</span><select v-model="step.fileId"><option v-for="file in editor.files" :key="file.id" :value="file.id">{{ file.name }} · {{ formatBytes(file.size) }}</option></select></label><label class="field"><span>远程路径</span><input v-model="step.remotePath" class="mono" placeholder="/opt/app/config.yml" /></label><label class="check"><input v-model="step.overwrite" type="checkbox" /> 覆盖同名文件</label></div>
              <label class="continue"><input v-model="step.continueOnError" type="checkbox" /> 此步骤失败后继续后续步骤</label>
            </article>
            <div v-if="!editor.definition.steps.length" class="compact-empty warning">剧本至少需要一个步骤才能执行。</div>
          </section>

          <section class="form-section attachments">
            <div class="section-title"><span>04</span><div><h3>剧本附件</h3><p>脚本、配置和安装包将以私有权限保存。</p></div><button class="mini" :disabled="!editor.id || uploading" @click="attachmentInput?.click()"><i class="fas fa-paperclip"></i> {{ uploading ? '上传中' : '上传附件' }}</button></div>
            <input ref="attachmentInput" class="sr-only" type="file" multiple @change="uploadAttachments" />
            <div v-if="!editor.id" class="compact-empty">保存剧本后即可上传附件。</div>
            <div v-else-if="editor.files.length" class="attachment-list"><div v-for="file in editor.files" :key="file.id"><i class="fas fa-file-shield"></i><span><strong>{{ file.name }}</strong><small>{{ formatBytes(file.size) }}</small></span><button @click="removeAttachment(file)"><i class="fas fa-trash"></i></button></div></div>
            <div v-else class="compact-empty">暂无附件。</div>
          </section>
        </div>
        <footer class="drawer-footer"><span>保存会生成新的剧本修订版本。</span><div><button class="button secondary" @click="editor = null">关闭</button><button class="button primary" :disabled="saving" @click="saveEditor"><i class="fas fa-floppy-disk"></i> {{ saving ? '保存中' : '保存剧本' }}</button></div></footer>
      </section>
    </div>

    <div v-if="runPlaybook" class="backdrop" @mousedown.self="runPlaybook = null">
      <section class="drawer run-drawer">
        <header class="drawer-header run-header"><div><span>ONE-CLICK EXECUTION · r{{ runPlaybook.revision }}</span><h2>{{ runPlaybook.name }}</h2><p>{{ runPlaybook.definition.steps.length }} 个步骤将在所选 SSH 服务器上依次运行。</p></div><button @click="runPlaybook = null">×</button></header>
        <div v-if="errorMessage" class="drawer-feedback error"><i class="fas fa-circle-exclamation"></i>{{ errorMessage }}<button @click="errorMessage = ''">×</button></div>
        <div v-if="createdJobId" class="run-complete"><i class="fas fa-circle-check"></i><h3>剧本任务已进入执行队列</h3><p>临时凭据和敏感变量已经从当前表单清除。可前往批量任务中心查看每台服务器的实时结果。</p><code>{{ createdJobId }}</code><div><button class="button secondary" @click="runPlaybook = null">返回剧本库</button><button class="button primary" @click="goToJobCenter">查看任务进度</button></div></div>
        <div v-else class="drawer-body">
          <section class="form-section">
            <div class="section-title"><span>01</span><div><h3>选择目标服务器</h3><p>支持按分组筛选，也可逐台指定。</p></div><strong class="selected-count">已选 {{ selectedIds.length }} 台</strong></div>
            <div class="server-filters"><label><i class="fas fa-magnifying-glass"></i><input v-model="serverSearch" placeholder="名称、IP 或用户" /></label><select v-model="selectedTagId"><option value="all">全部分组</option><option v-for="tag in tags" :key="tag.id" :value="tag.id">{{ tag.name }}</option></select><button @click="toggleVisible">{{ allVisibleSelected ? '取消当前结果' : '选择当前结果' }}</button></div>
            <div class="server-list">
              <button v-for="connection in filteredConnections" :key="connection.id" :class="{ selected: selectedIds.includes(connection.id) }" @click="toggleConnection(connection.id)"><span class="checkbox"><i v-if="selectedIds.includes(connection.id)" class="fas fa-check"></i></span><i class="fas fa-server"></i><span><strong>{{ connection.name || connection.host }}</strong><small>{{ connection.username }}@{{ connection.host }}:{{ connection.port }}</small></span><em>{{ tagNames(connection).slice(0, 2).join(' · ') }}</em><small class="credential">{{ connection.credential_mode === 'prompt' ? '每次输入' : '已保存凭据' }}</small></button>
              <div v-if="!filteredConnections.length" class="compact-empty">没有匹配的 SSH 服务器。</div>
            </div>
          </section>

          <section v-if="runPlaybook.definition.variables.length" class="form-section">
            <div class="section-title"><span>02</span><div><h3>本次执行变量</h3><p>敏感值不会保存到剧本、任务数据库或审计日志。</p></div></div>
            <div class="run-variables"><label v-for="variable in runPlaybook.definition.variables" :key="variable.name" class="field"><span>{{ variable.label }} <small>{{ variable.name }}{{ variable.required ? ' · 必填' : '' }}</small></span><input v-model="runVariableValues[variable.name]" :type="variable.secret ? 'password' : 'text'" autocomplete="off" :placeholder="variable.secret ? '仅用于本次执行' : variable.defaultValue || '可留空'" /></label></div>
          </section>

          <section v-if="promptConnections.length" class="form-section prompt-box">
            <div class="section-title"><span><i class="fas fa-key"></i></span><div><h3>服务器临时凭据</h3><p>这些服务器配置为每次连接时输入凭据。</p></div></div>
            <div class="run-variables"><label v-for="connection in promptConnections" :key="connection.id" class="field"><span>{{ connection.name || connection.host }} <small>{{ connection.auth_method === 'key' ? '密钥口令，可留空' : 'SSH 密码' }}</small></span><input v-model="ephemeralSecrets[connection.id]" type="password" autocomplete="off" :placeholder="connection.auth_method === 'key' ? '无口令可留空' : '请输入本次密码'" /></label></div>
          </section>

          <section class="form-section">
            <div class="section-title"><span>03</span><div><h3>执行策略</h3><p>控制并发、单步骤超时和失败行为。</p></div></div>
            <div class="strategy"><label class="field"><span>并发服务器数</span><input v-model.number="concurrency" type="number" min="1" max="20" /></label><label class="field"><span>单步骤超时（秒）</span><input v-model.number="timeoutSeconds" type="number" min="10" max="7200" /></label><label class="switch"><input v-model="stopOnError" type="checkbox" /><span></span><div><strong>遇错停止</strong><small>可在单独步骤上允许继续</small></div></label></div>
            <div class="execution-plan"><div v-for="(step, index) in runPlaybook.definition.steps" :key="step.id"><span>{{ index + 1 }}</span><i :class="stepIcon(step)"></i><strong>{{ step.name }}</strong><small>{{ step.type === 'command' ? '执行命令' : '分发附件' }}</small></div></div>
          </section>
        </div>
        <footer v-if="!createdJobId" class="drawer-footer"><span><i class="fas fa-triangle-exclamation"></i> 命令会以目标服务器配置的 SSH 用户权限执行。</span><div><button class="button secondary" @click="runPlaybook = null">取消</button><button class="button primary launch" :disabled="running || !selectedIds.length" @click="execute"><i class="fas fa-play"></i> {{ running ? '正在创建任务' : `立即执行 · ${selectedIds.length} 台` }}</button></div></footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.playbooks-page{min-height:calc(100vh - 56px);padding:38px clamp(16px,4vw,62px) 70px;background:#f2f5f3;color:#21312c;font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif}.hero{display:flex;align-items:flex-end;justify-content:space-between;max-width:1500px;margin:0 auto 25px}.eyebrow{display:flex;align-items:center;gap:8px;color:#28755e;font:700 10px/1.2 Consolas,monospace;letter-spacing:.16em}.eyebrow span{width:7px;height:7px;border-radius:50%;background:#34a477;box-shadow:0 0 0 4px rgba(52,164,119,.12)}.hero h1{margin:9px 0 7px;font-family:Georgia,"Noto Serif SC",serif;font-size:39px;font-weight:500;letter-spacing:-.02em}.hero p{max-width:720px;margin:0;color:#77837f;font-size:12px;line-height:1.7}.hero-actions{display:flex;gap:9px}.button{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:38px;padding:0 15px;border:1px solid transparent;border-radius:8px;font-size:11px;font-weight:800;cursor:pointer}.button.primary{background:#176b55;color:#fff;box-shadow:0 5px 15px rgba(23,107,85,.16)}.button.primary:hover{background:#105c49}.button.secondary{border-color:#d6dfdc;background:#fff;color:#4b5b56}.button:disabled,.mini:disabled{cursor:not-allowed;opacity:.5}.metrics{display:grid;grid-template-columns:repeat(4,1fr);max-width:1500px;margin:0 auto 22px;border:1px solid #dfe6e3;border-radius:11px;background:#fff;box-shadow:0 4px 18px rgba(21,48,39,.04);overflow:hidden}.metrics article{min-height:105px;padding:18px 21px;border-right:1px solid #e7ecea;box-sizing:border-box}.metrics article:last-child{border:0}.metrics span,.metrics small{display:block;color:#87918e;font-size:9px}.metrics strong{display:block;margin:7px 0 5px;font-family:Georgia,serif;font-size:28px;font-weight:500}.metrics .secure{background:#173c32;color:#fff}.metrics .secure span,.metrics .secure small{color:#97b3aa}.metrics .secure strong{font:700 13px Consolas,monospace;letter-spacing:.05em}.feedback{display:flex;align-items:center;gap:8px;max-width:1500px;box-sizing:border-box;margin:0 auto 12px;padding:10px 13px;border-radius:8px;font-size:11px}.feedback button{margin-left:auto;border:0;background:transparent;color:inherit;font-size:18px}.feedback.error{border:1px solid #efc7c1;background:#fff0ee;color:#9f3e31}.feedback.success{border:1px solid #bfe1d2;background:#ecf8f2;color:#176b55}.library{max-width:1500px;margin:auto;border:1px solid #dfe6e3;border-radius:12px;background:#fff;box-shadow:0 5px 20px rgba(21,48,39,.04);overflow:hidden}.library>header{display:flex;align-items:center;justify-content:space-between;padding:19px 21px;border-bottom:1px solid #e7ecea}.library h2{margin:0;font-family:Georgia,"Noto Serif SC",serif;font-size:21px;font-weight:500}.library header p{margin:4px 0 0;color:#818d89;font-size:10px}.filters{display:flex;gap:8px}.filters label,.server-filters label{position:relative}.filters label i,.server-filters label i{position:absolute;left:11px;top:50%;z-index:1;transform:translateY(-50%);color:#94a19d;font-size:10px}.filters input,.filters select,.server-filters input,.server-filters select,.server-filters button{height:35px;box-sizing:border-box;border:1px solid #d7dfdc;border-radius:7px;background:#fff;color:#364640;padding:0 10px;font-size:10px}.filters input,.server-filters input{width:230px;padding-left:31px}.playbook-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;padding:20px}.playbook-card{display:flex;flex-direction:column;min-height:315px;padding:18px;border:1px solid #dfe6e3;border-radius:10px;background:#fff;transition:.18s}.playbook-card:hover{border-color:#a9c7bd;box-shadow:0 8px 24px rgba(23,75,59,.08);transform:translateY(-2px)}.card-top{display:flex;justify-content:space-between}.category,.revision{padding:4px 7px;border-radius:5px;background:#edf5f2;color:#236f58;font-size:8px;font-weight:800}.revision{background:#f0f2f1;color:#74817d;font-family:Consolas,monospace}.book-icon{display:flex;align-items:center;justify-content:center;width:39px;height:39px;margin-top:13px;border-radius:10px;background:#173c32;color:#a9d4c6}.playbook-card h3{margin:12px 0 5px;font-family:Georgia,"Noto Serif SC",serif;font-size:18px;font-weight:500}.playbook-card>p{display:-webkit-box;min-height:34px;margin:0;color:#7b8783;font-size:10px;line-height:1.6;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}.steps-preview{display:flex;flex-direction:column;gap:5px;margin:13px 0;padding:10px;border-radius:7px;background:#f5f8f7}.steps-preview span{overflow:hidden;color:#5d6b66;font-size:9px;text-overflow:ellipsis;white-space:nowrap}.steps-preview i{width:17px;color:#2c7c63}.card-meta{display:flex;align-items:center;gap:12px;margin-top:auto;color:#88938f;font-size:8px}.card-meta span:last-child{margin-left:auto}.card-meta i{margin-right:4px}.playbook-card footer{display:grid;grid-template-columns:1fr 34px 34px;gap:7px;margin-top:13px;padding-top:13px;border-top:1px solid #e8ecea}.playbook-card footer button{height:34px;border:1px solid #dce4e1;border-radius:7px;background:#f7f9f8;color:#53635e;font-size:10px}.playbook-card footer .run{border-color:#176b55;background:#176b55;color:#fff;font-weight:800}.playbook-card footer .delete{color:#a84a3c}.empty{display:flex;min-height:280px;flex-direction:column;align-items:center;justify-content:center;color:#87938f}.empty>i{margin-bottom:10px;color:#aab7b3;font-size:30px}.empty strong{font-size:13px}.empty span{margin:5px 0 14px;font-size:9px}.backdrop{position:fixed;inset:0;z-index:100;background:rgba(9,28,22,.48);backdrop-filter:blur(3px)}.drawer{position:absolute;top:0;right:0;width:min(820px,96vw);height:100%;display:flex;flex-direction:column;background:#f5f7f6;box-shadow:-20px 0 60px rgba(9,30,23,.24)}.run-drawer{width:min(910px,97vw)}.drawer-header{display:flex;justify-content:space-between;padding:24px 27px 20px;background:#173c32;color:#fff}.drawer-header span{color:#7fb09f;font:700 9px Consolas,monospace;letter-spacing:.13em}.drawer-header h2{margin:8px 0 4px;font-family:Georgia,"Noto Serif SC",serif;font-size:27px;font-weight:500}.drawer-header p{margin:0;color:#9bb8ae;font-size:9px}.drawer-header>button{align-self:flex-start;border:0;background:transparent;color:#afc9c0;font-size:27px}.run-header{background:linear-gradient(135deg,#173c32,#225846)}.drawer-body{flex:1;overflow:auto;padding:17px 20px 90px}.form-section{margin-bottom:14px;padding:17px;border:1px solid #dfe6e3;border-radius:10px;background:#fff}.section-title{display:flex;align-items:center;gap:10px;margin-bottom:14px}.section-title>span{display:flex;align-items:center;justify-content:center;width:27px;height:27px;border-radius:7px;background:#e7f3ef;color:#176b55;font:800 9px Consolas,monospace}.section-title h3,.section-title p{margin:0}.section-title h3{font-size:12px}.section-title p{margin-top:2px;color:#87918e;font-size:8px}.section-title code{padding:1px 4px;background:#edf2f0;color:#286c58}.section-title>.mini,.section-title>.section-actions,.selected-count{margin-left:auto}.section-actions{display:flex;gap:6px}.mini{height:29px;padding:0 9px;border:1px solid #cfdcd8;border-radius:6px;background:#f7faf9;color:#286c58;font-size:9px;font-weight:800}.two-columns,.strategy{display:grid;grid-template-columns:1fr 1fr;gap:11px}.field{display:flex;flex-direction:column;gap:6px}.field>span{display:flex;justify-content:space-between;color:#475650;font-size:9px;font-weight:800}.field>span small{color:#8a9591;font-size:8px;font-weight:400}.field input,.field textarea,.field select,.variable-row input{width:100%;box-sizing:border-box;border:1px solid #d6dfdc;border-radius:7px;background:#fff;color:#283934;padding:0 10px;font-size:10px;outline:0}.field input,.field select,.variable-row input{height:35px}.field textarea{min-height:73px;padding:9px;resize:vertical}.field input:focus,.field textarea:focus,.field select:focus,.variable-row input:focus{border-color:#3a8b72;box-shadow:0 0 0 3px rgba(58,139,114,.1)}.mono{font-family:Consolas,monospace!important}.variable-row{display:grid;grid-template-columns:1fr 1fr 1.2fr auto;align-items:end;gap:8px;margin-bottom:7px;padding:9px;border-radius:8px;background:#f6f8f7}.variable-row>label{display:flex;flex-direction:column;gap:4px}.variable-row>label>span{color:#7b8783;font-size:8px}.variable-options{display:flex;align-items:center;gap:7px;height:35px}.variable-options label{font-size:8px;white-space:nowrap}.variable-options button,.attachment-list button{border:0;background:transparent;color:#aa4b3e}.security-note{display:flex;gap:9px;margin-top:10px;padding:10px;border:1px solid #d3e8e0;border-radius:7px;background:#f1f8f5;color:#176b55}.security-note strong,.security-note span{display:block}.security-note strong{font-size:9px}.security-note span{margin-top:2px;color:#658078;font-size:8px}.compact-empty{padding:14px;border:1px dashed #d4dfdb;border-radius:7px;background:#fafbfb;color:#88938f;font-size:9px;text-align:center}.compact-empty.warning{border-color:#e9d1b2;background:#fff9f0;color:#8b652b}.step-card{margin-bottom:9px;border:1px solid #dae3e0;border-radius:9px;overflow:hidden}.step-card>header{display:grid;grid-template-columns:28px 18px 1fr auto repeat(3,25px);align-items:center;gap:6px;padding:7px 9px;background:#f2f6f4}.step-card header input{height:28px;border:0;background:transparent;font-size:10px;font-weight:800;outline:0}.step-card header em{color:#7f8b87;font:8px Consolas,monospace}.step-card header button{width:25px;height:25px;border:0;border-radius:5px;background:#fff;color:#70807a}.step-card header button.delete{color:#aa4b3e}.step-card header button:disabled{opacity:.3}.step-number{font:800 9px Consolas,monospace;color:#28775e}.command-editor{margin:9px;border-radius:7px;background:#102720;overflow:hidden}.command-editor>div{display:flex;align-items:center;gap:4px;height:25px;padding:0 8px;background:#19372f}.command-editor>div span{width:6px;height:6px;border-radius:50%;background:#d67b65}.command-editor>div span:nth-child(2){background:#d0ad59}.command-editor>div span:nth-child(3){background:#58a47e}.command-editor>div em{margin-left:auto;color:#7fa094;font:8px Consolas,monospace}.command-editor textarea{display:block;width:100%;min-height:105px;box-sizing:border-box;resize:vertical;border:0;outline:0;background:#102720;color:#d6eee6;padding:10px 12px;font:10px/1.65 Consolas,monospace}.upload-fields{display:grid;grid-template-columns:1fr 1.2fr auto;align-items:end;gap:9px;padding:10px}.check,.continue{display:flex;align-items:center;gap:6px;color:#687670;font-size:8px}.check{height:35px}.continue{padding:0 10px 9px}.attachments{margin-bottom:0}.attachment-list{display:flex;flex-direction:column;gap:6px}.attachment-list>div{display:grid;grid-template-columns:27px 1fr 26px;align-items:center;gap:7px;padding:8px;border-radius:7px;background:#f4f7f6}.attachment-list>div>i{color:#34775f}.attachment-list strong,.attachment-list small{display:block}.attachment-list strong{font-size:9px}.attachment-list small{margin-top:2px;color:#89938f;font-size:8px}.drawer-footer{position:absolute;right:0;bottom:0;left:0;display:flex;align-items:center;justify-content:space-between;padding:11px 20px;border-top:1px solid #dbe3e0;background:rgba(255,255,255,.97);box-shadow:0 -5px 18px rgba(17,43,34,.06)}.drawer-footer>span{color:#7d8985;font-size:8px}.drawer-footer>div{display:flex;gap:7px}.server-filters{display:grid;grid-template-columns:1fr 150px auto;gap:7px}.server-filters input{width:100%}.server-filters button{color:#246e58;font-weight:800}.selected-count{color:#176b55;font-size:10px}.server-list{max-height:270px;margin-top:9px;overflow:auto;border:1px solid #e0e6e4;border-radius:8px}.server-list>button{display:grid;grid-template-columns:20px 22px 1fr auto auto;align-items:center;gap:8px;width:100%;padding:9px 10px;border:0;border-bottom:1px solid #ebefed;background:#fff;text-align:left}.server-list>button.selected{background:#edf7f3}.server-list .checkbox{display:flex;align-items:center;justify-content:center;width:16px;height:16px;border:1px solid #b8c5c0;border-radius:4px;color:#fff;font-size:8px}.server-list .selected .checkbox{border-color:#1c7b60;background:#1c7b60}.server-list button>span strong,.server-list button>span small{display:block}.server-list button>span strong{font-size:9px}.server-list button>span small{color:#89938f;font:8px Consolas,monospace}.server-list button>em,.credential{color:#7c8884;font-size:8px;font-style:normal}.run-variables{display:grid;grid-template-columns:1fr 1fr;gap:9px}.prompt-box{border-color:#e8d6b5;background:#fffbf3}.strategy{grid-template-columns:1fr 1fr 1.1fr;align-items:end}.switch{display:flex;align-items:center;gap:8px;height:35px}.switch>input{position:absolute;opacity:0}.switch>span{position:relative;width:31px;height:18px;border-radius:10px;background:#cdd7d3}.switch>span:after{content:"";position:absolute;top:3px;left:3px;width:12px;height:12px;border-radius:50%;background:#fff;transition:.2s}.switch input:checked+span{background:#1d8064}.switch input:checked+span:after{transform:translateX(13px)}.switch strong,.switch small{display:block}.switch strong{font-size:9px}.switch small{color:#8b9591;font-size:7px}.execution-plan{display:flex;flex-direction:column;gap:5px;margin-top:13px}.execution-plan>div{display:grid;grid-template-columns:22px 20px 1fr auto;align-items:center;padding:7px 9px;border-radius:6px;background:#f5f8f7}.execution-plan span{display:flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:5px;background:#dfece7;color:#1e7058;font-size:8px}.execution-plan i{color:#337a63}.execution-plan strong{font-size:9px}.execution-plan small{color:#89938f;font-size:8px}.launch{min-width:155px}.run-complete{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;padding:30px;text-align:center}.run-complete>i{color:#21815f;font-size:53px}.run-complete h3{margin:18px 0 7px;font-family:Georgia,"Noto Serif SC",serif;font-size:25px;font-weight:500}.run-complete p{max-width:480px;color:#798681;font-size:10px;line-height:1.7}.run-complete code{margin:12px 0 20px;padding:7px 10px;border-radius:6px;background:#e7eeeb;color:#426056;font-size:9px}.run-complete>div{display:flex;gap:8px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
@media(max-width:1100px){.playbook-grid{grid-template-columns:repeat(2,1fr)}.metrics{grid-template-columns:repeat(2,1fr)}.metrics article:nth-child(2){border-right:0}.variable-row{grid-template-columns:1fr 1fr}.variable-options{grid-column:span 2}.upload-fields{grid-template-columns:1fr 1fr}.upload-fields .check{grid-column:span 2}}
@media(max-width:700px){.playbooks-page{padding:22px 11px 50px}.hero{align-items:flex-start;flex-direction:column;gap:16px}.hero h1{font-size:31px}.hero-actions{width:100%}.hero-actions .button{flex:1}.metrics{grid-template-columns:1fr 1fr}.metrics article{min-height:95px;padding:14px}.library>header{align-items:flex-start;flex-direction:column;gap:12px}.filters{width:100%}.filters label{flex:1}.filters input{width:100%}.playbook-grid{grid-template-columns:1fr;padding:12px}.drawer{width:100vw}.drawer-header{padding:20px}.drawer-body{padding:12px 11px 90px}.form-section{padding:13px}.two-columns,.run-variables,.strategy{grid-template-columns:1fr}.variable-row{grid-template-columns:1fr}.variable-options{grid-column:auto}.step-card>header{grid-template-columns:24px 16px 1fr repeat(3,23px)}.step-card header em{display:none}.upload-fields{grid-template-columns:1fr}.upload-fields .check{grid-column:auto}.server-filters{grid-template-columns:1fr 1fr}.server-filters label{grid-column:span 2}.server-list>button{grid-template-columns:18px 18px 1fr auto}.server-list button>em{display:none}.drawer-footer>span{display:none}.drawer-footer{justify-content:flex-end}.section-title{align-items:flex-start}.section-title>.section-actions{display:flex}.run-complete h3{font-size:21px}}
.drawer-feedback{display:flex;align-items:center;gap:8px;margin:10px 16px 0;padding:9px 11px;border-radius:7px;font-size:10px}.drawer-feedback button{margin-left:auto;border:0;background:transparent;color:inherit;font-size:16px}.drawer-feedback.error{border:1px solid #efc7c1;background:#fff0ee;color:#9f3e31}.drawer-feedback.success{border:1px solid #bfe1d2;background:#ecf8f2;color:#176b55}
</style>
