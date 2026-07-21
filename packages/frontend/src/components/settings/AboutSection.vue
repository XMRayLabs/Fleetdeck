<template>
  <section class="overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
    <div class="border-b border-border bg-header/50 px-6 py-5">
      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-primary">FleetDeck</p>
      <h2 class="mt-1 text-lg font-semibold text-foreground">{{ $t('settings.category.about') }}</h2>
    </div>
    <div class="space-y-4 p-6 text-sm text-text-secondary">
      <div class="flex flex-wrap items-center gap-3">
        <span class="rounded-full border border-border px-3 py-1">v{{ appVersion }}</span>
        <button
          v-if="repositoryUrl"
          class="rounded-full border border-border px-3 py-1 transition hover:border-primary hover:text-primary"
          :disabled="isCheckingVersion"
          @click="checkLatestVersion"
        >
          {{ isCheckingVersion ? $t('settings.about.checkingUpdate') : '检查 GitHub Release' }}
        </button>
        <a v-if="isUpdateAvailable && releaseUrl" :href="releaseUrl" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline">
          {{ $t('settings.about.updateAvailable', { version: latestVersion }) }}
        </a>
        <span v-else-if="versionCheckError" class="text-error">{{ versionCheckError }}</span>
      </div>
      <p>
        FleetDeck 是一个 GPL-3.0 自托管服务器管理平台。本项目基于
        <a href="https://github.com/Heavrnl/nexus-terminal" target="_blank" rel="noopener noreferrer" class="text-primary hover:underline">Heavrnl/nexus-terminal</a>
        进行大幅重构，并保留原项目署名与许可证。
      </p>
      <a v-if="repositoryUrl" :href="repositoryUrl" target="_blank" rel="noopener noreferrer" class="inline-flex text-primary hover:underline">项目仓库</a>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useVersionCheck } from '../../composables/settings/useVersionCheck';

const repositoryUrl = (import.meta.env.VITE_PROJECT_REPOSITORY_URL || '').replace(/\/$/, '');
const { appVersion, latestVersion, isCheckingVersion, versionCheckError, isUpdateAvailable, checkLatestVersion } = useVersionCheck();
const releaseUrl = computed(() => repositoryUrl && latestVersion.value
  ? `${repositoryUrl}/releases/tag/${latestVersion.value}`
  : '');
</script>
