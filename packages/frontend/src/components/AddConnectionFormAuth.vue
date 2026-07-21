<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import SshKeySelector from './SshKeySelector.vue'; // Assuming SshKeySelector is used here

// Define Props. formData is expected to be a reactive object from the parent composable.
const props = defineProps<{
  formData: {
    type: 'SSH' | 'RDP' | 'VNC';
    username: string;
    auth_method: 'password' | 'key'; // SSH specific
    credential_mode: 'saved' | 'prompt';
    password?: string; // Optional because it might not be set or sent
    selected_ssh_key_id: number | null; // SSH specific
    vncPassword?: string; // VNC specific, optional for the same reasons as password
  };
  isEditMode: boolean; // To determine if fields are required
}>();

const { t } = useI18n();
</script>

<template>
  <!-- Authentication Section -->
  <div class="space-y-4 p-4 border border-border rounded-md bg-header/30">
    <h4 class="text-base font-semibold mb-3 pb-2 border-b border-border/50">{{ t('connections.form.sectionAuth', '认证信息') }}</h4>
    <div>
      <label for="conn-username" class="block text-sm font-medium text-text-secondary mb-1">{{ t('connections.form.username') }}</label>
      <input type="text" id="conn-username" v-model="props.formData.username" required
             class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary" />
    </div>

    <div>
      <label class="block text-sm font-medium text-text-secondary mb-1">凭据保存方式</label>
      <div class="grid grid-cols-2 gap-2">
        <button type="button" @click="props.formData.credential_mode = 'prompt'"
                :class="['px-3 py-2 border rounded-md text-sm text-left', props.formData.credential_mode === 'prompt' ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background']">
          <strong class="block">每次连接输入</strong><small class="block mt-1 opacity-70">密码或密钥口令不落盘</small>
        </button>
        <button type="button" @click="props.formData.credential_mode = 'saved'"
                :class="['px-3 py-2 border rounded-md text-sm text-left', props.formData.credential_mode === 'saved' ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background']">
          <strong class="block">独立安全保存</strong><small class="block mt-1 opacity-70">AES-256-GCM 加密存储</small>
        </button>
      </div>
    </div>

    <!-- SSH Specific Auth -->
    <template v-if="props.formData.type === 'SSH'">
      <div>
        <label class="block text-sm font-medium text-text-secondary mb-1">{{ t('connections.form.authMethod') }}</label>
        <div class="flex rounded-md shadow-sm">
          <button type="button"
                  @click="props.formData.auth_method = 'password'"
                  :class="['flex-1 px-3 py-2 border border-border text-sm font-medium focus:outline-none',
                           props.formData.auth_method === 'password' ? 'bg-primary text-white' : 'bg-background text-foreground hover:bg-border',
                           'rounded-l-md']">
            {{ t('connections.form.authMethodPassword') }}
          </button>
          <button type="button"
                  @click="props.formData.auth_method = 'key'"
                  :class="['flex-1 px-3 py-2 border-t border-b border-r border-border text-sm font-medium focus:outline-none -ml-px',
                           props.formData.auth_method === 'key' ? 'bg-primary text-white' : 'bg-background text-foreground hover:bg-border',
                           'rounded-r-md']">
            {{ t('connections.form.authMethodKey') }}
          </button>
        </div>
      </div>

      <div v-if="props.formData.auth_method === 'password' && props.formData.credential_mode === 'saved'">
        <label for="conn-password" class="block text-sm font-medium text-text-secondary mb-1">{{ t('connections.form.password') }}</label>
        <input type="password" id="conn-password" v-model="props.formData.password" :required="props.formData.auth_method === 'password' && !isEditMode" autocomplete="new-password"
               class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary" />
      </div>

      <div v-if="props.formData.auth_method === 'key'" class="space-y-4">
        <div>
            <label class="block text-sm font-medium text-text-secondary mb-1">{{ t('connections.form.sshKey') }}</label>
            <SshKeySelector v-model="props.formData.selected_ssh_key_id" />
        </div>
      </div>
    </template>

    <!-- RDP Specific Auth -->
    <template v-if="props.formData.type === 'RDP'">
       <div v-if="props.formData.credential_mode === 'saved'">
         <label for="conn-password-rdp" class="block text-sm font-medium text-text-secondary mb-1">{{ t('connections.form.password') }}</label>
         <input type="password" id="conn-password-rdp" v-model="props.formData.password" :required="!isEditMode" autocomplete="new-password"
                class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary" />
       </div>
     </template>

    <!-- VNC Specific Auth -->
    <template v-if="props.formData.type === 'VNC'">
      <div v-if="props.formData.credential_mode === 'saved'">
        <label for="conn-password-vnc" class="block text-sm font-medium text-text-secondary mb-1">{{ t('connections.form.vncPassword', 'VNC 密码') }}</label>
        <input type="password" id="conn-password-vnc" v-model="props.formData.vncPassword" :required="!isEditMode" autocomplete="new-password"
               class="w-full px-3 py-2 border border-border rounded-md shadow-sm bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary" />
      </div>
    </template>

    <p v-if="props.formData.credential_mode === 'prompt'" class="text-xs text-text-secondary rounded-md border border-border bg-background p-3">
      连接时才会在当前浏览器中询问{{ props.formData.type === 'SSH' && props.formData.auth_method === 'key' ? '密钥口令（无口令可留空）' : '密码' }}，临时值只用于本次连接，后端不会保存。
    </p>
  </div>
</template>
