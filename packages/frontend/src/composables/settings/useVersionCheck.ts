import { computed, ref } from 'vue';
import axios from 'axios';
import pkg from '../../../package.json';

const parseRepository = (repositoryUrl: string): { owner: string; repo: string } | null => {
  const match = repositoryUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/);
  return match ? { owner: match[1], repo: match[2].replace(/\.git$/, '') } : null;
};

const compareVersions = (left: string, right: string): number => {
  const a = left.replace(/^v/, '').split('.').map(Number);
  const b = right.replace(/^v/, '').split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

export function useVersionCheck() {
  const appVersion = ref(pkg.version);
  const latestVersion = ref<string | null>(null);
  const isCheckingVersion = ref(false);
  const versionCheckError = ref<string | null>(null);
  const repository = parseRepository(import.meta.env.VITE_PROJECT_REPOSITORY_URL || '');

  const isUpdateAvailable = computed(() => Boolean(
    latestVersion.value && compareVersions(latestVersion.value, appVersion.value) > 0,
  ));

  const checkLatestVersion = async (): Promise<void> => {
    if (!repository) {
      versionCheckError.value = '尚未配置项目仓库地址。';
      return;
    }
    isCheckingVersion.value = true;
    versionCheckError.value = null;
    try {
      const response = await axios.get(`https://api.github.com/repos/${repository.owner}/${repository.repo}/releases/latest`, { timeout: 8000 });
      latestVersion.value = response.data?.tag_name || null;
      if (!latestVersion.value) versionCheckError.value = '仓库尚未发布 Release。';
    } catch {
      versionCheckError.value = '无法检查更新，请稍后重试。';
    } finally {
      isCheckingVersion.value = false;
    }
  };

  return { appVersion, latestVersion, isCheckingVersion, versionCheckError, isUpdateAvailable, checkLatestVersion };
}
