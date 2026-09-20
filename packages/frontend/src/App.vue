<script setup lang="ts">
import { RouterLink, RouterView, useRoute } from 'vue-router';
import ConsolePageHeader from './components/ConsolePageHeader.vue';
import { ref, onMounted, onUnmounted, watch, nextTick, computed, defineAsyncComponent } from 'vue';
import { useAgentStore } from './stores/agent.store';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from './stores/auth.store';
import { useDeviceDetection } from './composables/useDeviceDetection';
import { useSettingsStore } from './stores/settings.store';
import { useAppearanceStore } from './stores/appearance.store';
import { useLayoutStore } from './stores/layout.store';
import { useFocusSwitcherStore } from './stores/focusSwitcher.store';
import { useSessionStore } from './stores/session.store';
import { useFavoritePathsStore } from './stores/favoritePaths.store';
import { storeToRefs } from 'pinia';
import UINotificationDisplay from './components/UINotificationDisplay.vue';
import FileEditorOverlay from './components/FileEditorOverlay.vue';
import StyleCustomizer from './components/StyleCustomizer.vue';
import FocusSwitcherConfigurator from './components/FocusSwitcherConfigurator.vue';
import RemoteDesktopModal from './components/RemoteDesktopModal.vue';
import VncModal from './components/VncModal.vue';
import ConfirmDialog from './components/common/ConfirmDialog.vue';
import { useDialogStore } from './stores/dialog.store';

const { t } = useI18n();
const authStore = useAuthStore();
const route = useRoute();
const agent = useAgentStore();
const AgentView = defineAsyncComponent(() => import('./views/AiAssistantView.vue'));
watch(() => route.path, path => { if (path === '/ai') agent.initialized = true; }, { immediate: true });
watch(() => authStore.isAuthenticated, value => { if (!value) agent.reset(); });
function resizeAgent(event: PointerEvent) {
  const handle = event.currentTarget as HTMLElement; handle.setPointerCapture(event.pointerId);
  const move = (e: PointerEvent) => { agent.width = Math.max(360, Math.min(window.innerWidth * .7, window.innerWidth - e.clientX)); };
  const end = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('lostpointercapture', end); };
  handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('lostpointercapture', end);
}
const settingsStore = useSettingsStore();
const appearanceStore = useAppearanceStore();
const layoutStore = useLayoutStore();
const focusSwitcherStore = useFocusSwitcherStore(); // +++ 实例化焦点切换 Store +++
const sessionStore = useSessionStore(); // +++ 实例化 Session Store +++
const dialogStore = useDialogStore(); // +++ 实例化 DialogStore +++
const { state: dialogState } = storeToRefs(dialogStore); 
const favoritePathsStore = useFavoritePathsStore(); // +++ 实例化 favoritePathsStore +++
const { isAuthenticated } = storeToRefs(authStore);
const { showPopupFileEditorBoolean } = storeToRefs(settingsStore);
const { isStyleCustomizerVisible } = storeToRefs(appearanceStore);
const { isLayoutVisible, isHeaderVisible } = storeToRefs(layoutStore); // 添加 isHeaderVisible
const { isConfiguratorVisible: isFocusSwitcherVisible } = storeToRefs(focusSwitcherStore);
const { isRdpModalOpen, rdpConnectionInfo, isVncModalOpen, vncConnectionInfo } = storeToRefs(sessionStore); // +++ 获取 RDP 和 VNC 状态 +++
const { isMobile } = useDeviceDetection();

const navRef = ref<HTMLElement | null>(null);
const underlineRef = ref<HTMLElement | null>(null);
const mobileMenuOpen = ref(false);
const sidebarCollapsed = ref(localStorage.getItem('fleetdeck-sidebar-collapsed') === 'true');
const toggleSidebar = () => {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  localStorage.setItem('fleetdeck-sidebar-collapsed', String(sidebarCollapsed.value));
};

// +++ 存储上一次由切换器聚焦的 ID +++
const lastFocusedIdBySwitcher = ref<string | null>(null);
const isAltPressed = ref(false); // 跟踪 Alt 键是否按下
const altShortcutKey = ref<string | null>(null);
// --- 移除 shortcutTriggeredInKeyDown 标志 ---

const updateUnderline = async () => {
  await nextTick(); // 等待 DOM 更新
  if (navRef.value && underlineRef.value) {
    const activeLink = navRef.value.querySelector('.router-link-exact-active') as HTMLElement;
    if (activeLink) {
      const offsetBottom = 2; // 下划线距离文字底部的距离 (px)
      underlineRef.value.style.left = `${activeLink.offsetLeft}px`;
      underlineRef.value.style.width = `${activeLink.offsetWidth}px`;
      // underlineRef.value.style.top = `${activeLink.offsetTop + activeLink.offsetHeight + offsetBottom}px`; // 移除 top 设置
      underlineRef.value.style.opacity = '1'; // Make it visible
    } else {
      underlineRef.value.style.opacity = '0'; // Hide if no active link (e.g., on login page if not a nav link)
    }
  }
};

onMounted(() => {
  // Initial position update
  // Use setTimeout to ensure styles are applied and elements have dimensions
  setTimeout(updateUnderline, 100);

  // +++ 全局 Alt 键监听器 +++
  window.addEventListener('keydown', handleAltKeyDown); // +++ 监听 keydown 设置状态 +++
  window.addEventListener('keyup', handleGlobalKeyUp);   // +++ 监听 keyup 执行切换 +++
  
  // PWA Install Prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    console.log('[App.vue] beforeinstallprompt event fired. Browser will handle install prompt.');
  });

  window.addEventListener('appinstalled', () => {
    console.log('[App.vue] PWA was installed');
  });
  
  // +++ 加载 Header 可见性状态 +++
  layoutStore.loadHeaderVisibility();

});

// +++ 监听用户认证状态，登录后初始化收藏路径 +++
watch(isAuthenticated, (loggedIn) => {
  if (loggedIn) {
    favoritePathsStore.initializeFavoritePaths(t);
  }
}, { immediate: true });

// +++ 卸载钩子以移除监听器 +++
onUnmounted(() => {
  window.removeEventListener('keydown', handleAltKeyDown); // +++ 移除 keydown 监听 +++
  window.removeEventListener('keyup', handleGlobalKeyUp);   // +++ 移除 keyup 监听 +++
});


// *** 计算属性，判断是否在 workspace 路由 ***
const isWorkspaceRoute = computed(() => route.path === '/workspace');
const showAppShell = computed(() => isAuthenticated.value && (!isWorkspaceRoute.value || isHeaderVisible.value));
const showDesktopSidebar = computed(() => showAppShell.value);
const navigationItems = computed(() => [
  { to: '/', label: t('nav.dashboard'), icon: 'fa-solid fa-chart-pie' },
  { to: '/workspace', label: t('nav.terminal'), icon: 'fa-solid fa-terminal' },
  { to: '/ai', label: t('ai.title'), icon: 'fa-solid fa-wand-magic-sparkles' },
  { to: '/monitoring', label: t('ops.monitoring'), icon: 'fa-solid fa-chart-line' },
  { to: '/connections', label: t('nav.connections'), icon: 'fa-solid fa-server' },
  { to: '/orchestration', label: t('nav.orchestration'), icon: 'fa-solid fa-layer-group' },
  { to: '/playbooks', label: t('nav.playbooks'), icon: 'fa-solid fa-book-open' },
  { to: '/proxies', label: t('nav.proxies'), icon: 'fa-solid fa-route' },
  { to: '/notifications', label: t('nav.notifications'), icon: 'fa-solid fa-bell' },
  { to: '/audit-logs', label: t('nav.auditLogs'), icon: 'fa-solid fa-shield-halved' },
  { to: '/settings', label: t('nav.settings'), icon: 'fa-solid fa-gear' },
]);

const currentPageTitle = computed(() => navigationItems.value.find(item => item.to === route.path)?.label || t('nav.terminal'));

watch(route, () => {
  mobileMenuOpen.value = false;
  updateUnderline();
}, { immediate: true }); // *** 确保 immediate: true 存在 ***


const handleLogout = () => {
  authStore.logout();
};

// 打开样式自定义器的方法现在直接调用 store action
const openStyleCustomizer = () => {
  appearanceStore.toggleStyleCustomizer(true);
};

// 关闭样式自定义器的方法现在也调用 store action
const closeStyleCustomizer = () => {
  appearanceStore.toggleStyleCustomizer(false);
};

// +++ 处理 Alt 键按下的事件处理函数，并记录快捷键 +++
const handleAltKeyDown = async (event: KeyboardEvent) => { // +++ 改为 async +++
  if (!isWorkspaceRoute.value) return; // 只在 workspace 路由下执行
  // 只在 Alt 键首次按下时设置状态
  if (event.key === 'Alt' && !event.repeat) {
    isAltPressed.value = true;
    altShortcutKey.value = null;
    // console.log('[App] Alt key pressed down.');
  } else if (isAltPressed.value && !['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) {
    // 如果 Alt 正被按住，且按下了非修饰键 (移除 !shortcutTriggeredInKeyDown 检查)
    let key = event.key;
    if (key.length === 1) key = key.toUpperCase();

    if (/^[a-zA-Z0-9]$/.test(key)) {
        altShortcutKey.value = key; // 记录按键
        const shortcutString = `Alt+${key}`;
        console.log(`[App] KeyDown: Alt+${key} detected. Checking shortcut: ${shortcutString}`);
        const targetId = focusSwitcherStore.getFocusTargetIdByShortcut(shortcutString);

        if (targetId) {
            console.log(`[App] KeyDown: Shortcut match found. Targeting ID: ${targetId}`);
            event.preventDefault(); // 阻止默认行为 (如菜单)
            const success = await focusSwitcherStore.focusTarget(targetId); // +++ 立即尝试聚焦 +++
            if (success) {
                console.log(`[App] KeyDown: Successfully focused ${targetId} via shortcut.`);
                lastFocusedIdBySwitcher.value = targetId;
                // --- 移除设置标志位 ---
            } else {
                console.log(`[App] KeyDown: Failed to focus ${targetId} via shortcut action.`);
                // 聚焦失败，可以选择是否取消 Alt 状态，暂时不处理，让 keyup 重置
            }
        } else {
            console.log(`[App] KeyDown: No configured shortcut found for ${shortcutString}.`);
            // 没有匹配的快捷键，可以选择取消 Alt 状态以允许默认行为，或保持状态等待 keyup
            // isAltPressed.value = false;
            // altShortcutKey.value = null;
        }
    } else {
        // 按下无效键 (非字母数字)，取消 Alt 状态
        isAltPressed.value = false;
        altShortcutKey.value = null;
        // --- 移除重置标志位 ---
        console.log('[App] KeyDown: Alt sequence cancelled by non-alphanumeric key press.');
    }
  } else if (isAltPressed.value && ['Control', 'Shift', 'Meta'].includes(event.key)) {
      // 按下其他修饰键，取消 Alt 状态
      isAltPressed.value = false;
      altShortcutKey.value = null;
      // --- 移除重置标志位 ---
      console.log('[App] KeyDown: Alt sequence cancelled by other modifier key press.');
  }
};

// +++ 全局键盘事件处理函数，监听 keyup，优先处理快捷键 +++
const handleGlobalKeyUp = async (event: KeyboardEvent) => {
  if (!isWorkspaceRoute.value) return; // 只在 workspace 路由下执行
  if (event.key === 'Alt') {
    const altWasPressed = isAltPressed.value;
    const triggeredShortcutKey = altShortcutKey.value; // 记录松开时是否有记录的快捷键

    // 总是重置状态
    isAltPressed.value = false;
    altShortcutKey.value = null;
    // --- 移除重置标志位 ---

    if (altWasPressed && triggeredShortcutKey === null) {
      // 如果 Alt 之前是按下的，并且没有记录到有效的快捷键，则执行顺序切换
      console.log('[App] KeyUp: Alt released without a valid shortcut key captured. Attempting sequential focus switch.');
      event.preventDefault(); // 仅在执行顺序切换时阻止默认行为

      // --- 顺序切换逻辑 (保持不变) ---
      let currentFocusId: string | null = lastFocusedIdBySwitcher.value;
      console.log(`[App] Sequential switch. Last focused by switcher: ${currentFocusId}`);

      if (!currentFocusId) {
          const activeElement = document.activeElement as HTMLElement;
          if (activeElement && activeElement.hasAttribute('data-focus-id')) {
              currentFocusId = activeElement.getAttribute('data-focus-id');
              console.log(`[App] Sequential switch. Found focus ID from activeElement: ${currentFocusId}`);
          } else {
              console.log(`[App] Sequential switch. Could not determine current focus ID.`);
          }
      }

      const order = focusSwitcherStore.sequenceOrder; // ++ 使用新的 sequenceOrder state ++
      if (order.length === 0) { // ++ 检查新的 state ++
        console.log('[App] No focus sequence configured.');
        return;
      }

      let focused = false;
      for (let i = 0; i < order.length; i++) { // ++ Use order.length for loop condition ++
        const nextFocusId = focusSwitcherStore.getNextFocusTargetId(currentFocusId);
        if (!nextFocusId) {
          console.warn('[App] Could not determine next focus target ID in sequence.');
          break;
        }

        console.log(`[App] Sequential switch. Trying to focus target ID: ${nextFocusId}`);
        const success = await focusSwitcherStore.focusTarget(nextFocusId);

        if (success) {
          console.log(`[App] Successfully focused ${nextFocusId} sequentially.`);
          lastFocusedIdBySwitcher.value = nextFocusId;
          focused = true;
          break;
        } else {
          console.log(`[App] Failed to focus ${nextFocusId} sequentially. Trying next...`);
          currentFocusId = nextFocusId;
        }
      }

      if (!focused) {
        console.log('[App] Cycled through sequence, no target could be focused.');
        lastFocusedIdBySwitcher.value = null;
      }
      // --- 顺序切换逻辑结束 ---

    } else if (altWasPressed && triggeredShortcutKey !== null) {
      console.log(`[App] KeyUp: Alt released after capturing key '${triggeredShortcutKey}'. Shortcut logic handled in keydown. No sequential switch.`);
      // 快捷键逻辑已在 keydown 处理，keyup 时无需操作，也不阻止默认行为（除非特定需要）
    } else {
      // Alt 松开，但 isAltPressed 已经是 false (例如被其他键取消了)
      console.log('[App] KeyUp: Alt released, but sequence was already cancelled or not active.');
    }
  }
};

// +++ 辅助函数：检查元素是否可见且可聚焦 +++
const isElementVisibleAndFocusable = (element: HTMLElement): boolean => {
  if (!element) return false;
  // 检查元素是否在 DOM 中，并且没有 display: none
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  // 检查元素或其父元素是否被禁用
  if ((element as HTMLInputElement).disabled) return false;
  let parent = element.parentElement;
  while (parent) {
    if ((parent as HTMLFieldSetElement).disabled) return false;
    parent = parent.parentElement;
  }
  // 检查元素是否足够在视口内（粗略检查）
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};



</script>

<template>
  <div id="app-container" class="min-h-screen bg-background text-foreground" :class="{ 'fd-sidebar-collapsed': sidebarCollapsed }">
    <aside v-if="showDesktopSidebar" class="fd-sidebar fixed inset-y-0 left-0 z-30 hidden lg:flex lg:flex-col">
      <RouterLink to="/" class="fd-brand"><span class="fd-brand-mark">FD</span><span><strong>FleetDeck</strong><small>{{ t('ui.console') }}</small></span></RouterLink>
      <nav class="fd-nav" :aria-label="t('ui.navigation')">
        <RouterLink v-for="item in navigationItems" :key="item.to" :to="item.to" :title="item.label" :aria-label="item.label"><i :class="item.icon" aria-hidden="true"></i><span>{{ item.label }}</span></RouterLink>
      </nav>
      <div class="fd-sidebar-footer">
        <button @click="toggleSidebar" :aria-expanded="!sidebarCollapsed" :title="t(sidebarCollapsed ? 'ui.expandSidebar' : 'ui.collapseSidebar')" :aria-label="t(sidebarCollapsed ? 'ui.expandSidebar' : 'ui.collapseSidebar')"><i :class="[sidebarCollapsed ? 'fas fa-angles-right' : 'fas fa-angles-left', 'mr-2']" aria-hidden="true"></i><span>{{ t(sidebarCollapsed ? 'ui.expandSidebar' : 'ui.collapseSidebar') }}</span></button>
        <button @click="handleLogout" :title="t('nav.logout')" :aria-label="t('nav.logout')"><i class="fa-solid fa-arrow-right-from-bracket mr-2" aria-hidden="true"></i><span>{{ t('nav.logout') }}</span></button>
      </div>
    </aside>
    <header v-if="showAppShell" :class="['fd-topbar sticky top-0 z-20 flex items-center justify-between', { 'fd-offset': showDesktopSidebar }]">
      <div class="flex items-center gap-3">
        <button class="fd-icon-button lg:hidden" :aria-label="t('ui.navigation')" :aria-expanded="mobileMenuOpen" @click="mobileMenuOpen = !mobileMenuOpen"><i class="fa-solid fa-bars" aria-hidden="true"></i></button>
        <div class="fd-breadcrumb"><RouterLink to="/">FleetDeck</RouterLink><span>/</span><strong>{{ currentPageTitle }}</strong></div>
      </div>
      <div class="flex items-center gap-2">
        <button class="fd-icon-button" :title="t('ai.title')" :aria-label="t('ai.title')" :aria-expanded="agent.open" @click="agent.open ? agent.open = false : agent.show()"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i></button>
        <RouterLink to="/settings" class="fd-icon-button" :aria-label="t('nav.settings')" :title="t('nav.settings')"><i class="fa-solid fa-gear" aria-hidden="true"></i></RouterLink>
        <button class="fd-icon-button" :aria-label="t('nav.customizeStyle')" :title="t('nav.customizeStyle')" @click="openStyleCustomizer"><i class="fa-solid fa-palette" aria-hidden="true"></i></button>
        <div class="fd-account"><i class="fa-solid fa-user" aria-hidden="true"></i><span>{{ authStore.loggedInUser }}</span></div>
      </div>
    </header>
    <div v-if="mobileMenuOpen && showDesktopSidebar" class="fixed inset-0 z-40 bg-black/45 lg:hidden" @click.self="mobileMenuOpen = false" @keydown.esc="mobileMenuOpen = false">
      <nav class="fd-sidebar flex h-full flex-col" :aria-label="t('ui.navigation')">
        <div class="flex items-center justify-between mb-6"><strong>FleetDeck</strong><button class="h-9 w-9" :aria-label="t('common.close')" @click="mobileMenuOpen = false"><i class="fa-solid fa-xmark"></i></button></div>
        <div class="fd-nav"><RouterLink v-for="item in navigationItems" :key="item.to" :to="item.to" @click="mobileMenuOpen = false"><i :class="item.icon" aria-hidden="true"></i>{{ item.label }}</RouterLink></div>
        <div class="fd-sidebar-footer"><button @click="handleLogout">{{ t('nav.logout') }}</button></div>
      </nav>
    </div>
    <main :class="['fd-console', { 'fd-main-offset': showDesktopSidebar, 'fd-with-agent': agent.open && route.path !== '/ai' }]" :style="{ '--agent-width': agent.width + 'px' }">
      <ConsolePageHeader v-if="showDesktopSidebar && !isWorkspaceRoute" :title="currentPageTitle" :description="t(`ui.pages.${String(route.name)}`)" />
      <div :class="{ 'fd-page-content': showDesktopSidebar && !isWorkspaceRoute }">
        <RouterView v-slot="{ Component }">
          <KeepAlive :include="['WorkspaceView', 'ConnectionsView']"><component :is="Component" /></KeepAlive>
        </RouterView>
      </div>
      <div v-if="authStore.isAuthenticated && (agent.initialized || route.path === '/ai')" v-show="route.path === '/ai' || agent.open" :class="route.path !== '/ai' ? 'fd-agent-dock' : 'fd-agent-full'" :style="{ '--agent-width': agent.width + 'px' }">
        <div v-if="route.path !== '/ai'" class="fd-agent-resize" role="separator" aria-orientation="vertical" :aria-label="t('ops.resize')" tabindex="0" @pointerdown="resizeAgent" @keydown.left.prevent="agent.width = Math.min(800, agent.width + 20)" @keydown.right.prevent="agent.width = Math.max(360, agent.width - 20)"></div>
        <div v-if="route.path !== '/ai'" class="fd-agent-dock-header"><strong>{{ t('ai.title') }}</strong><button class="fd-icon-button" :aria-label="t('common.close')" @click="agent.open = false">×</button></div>
        <AgentView :key="authStore.user?.id" />
      </div>
    </main>

    <UINotificationDisplay />

    <!-- 根据设置条件渲染全局文件编辑器弹窗 -->
    <FileEditorOverlay v-if="showPopupFileEditorBoolean" :is-mobile="isMobile" />

    <!-- 条件渲染样式自定义器，使用 store 的状态和方法 -->
    <StyleCustomizer v-if="isStyleCustomizerVisible" @close="closeStyleCustomizer" />

    <!-- +++ 条件渲染焦点切换配置器 (使用 v-show 保持实例) +++ -->
    <FocusSwitcherConfigurator
      v-show="isFocusSwitcherVisible"
      :isVisible="isFocusSwitcherVisible"
      @close="focusSwitcherStore.toggleConfigurator(false)"
    />

    <!-- +++ 条件渲染 RDP 模态框 +++ -->
    <RemoteDesktopModal
      v-if="isRdpModalOpen"
      :connection="rdpConnectionInfo"
      @close="sessionStore.closeRdpModal()"
    />

    <!-- +++ 条件渲染 VNC 模态框 +++ -->
    <VncModal
      v-if="isVncModalOpen"
      :connection="vncConnectionInfo"
      @close="sessionStore.closeVncModal()"
    />

    <!-- +++ 全局确认对话框 +++ -->
    <ConfirmDialog
          :visible="dialogState.visible"
          :title="dialogState.title"
          :message="dialogState.message"
          :confirm-text="dialogState.confirmText"
          :cancel-text="dialogState.cancelText"
          :is-loading="dialogState.isLoading"
          @confirm="dialogStore.handleConfirm"
          @cancel="dialogStore.handleCancel"
          @update:visible="(val: boolean) => dialogStore.state.visible = val"
        />

  </div>
</template>

<style scoped>
.fd-topbar>div:first-child{min-width:0;flex:1}.fd-topbar>div:last-child{flex-shrink:0}.fd-breadcrumb{min-width:0;overflow:hidden}.fd-breadcrumb strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(max-width:600px){.fd-breadcrumb>a,.fd-breadcrumb>span{display:none}}
.fd-agent-dock{position:fixed;right:0;top:64px;bottom:0;z-index:40;overflow:auto;padding:14px;box-sizing:border-box;background:var(--fd-subtle);border-left:1px solid var(--fd-line);box-shadow:-8px 0 24px #0001;width:var(--agent-width)}
.fd-agent-full{padding:0 32px 40px}.fd-with-agent{width:calc(100% - var(--agent-width))}
@media(max-width:900px){.fd-agent-dock{width:100vw}.fd-with-agent{width:100%}.fd-agent-full{padding:0 16px 24px}.fd-agent-resize{display:none}}
.fd-agent-resize{position:fixed;top:64px;bottom:0;width:6px;cursor:ew-resize;touch-action:none;margin-left:-17px}
.fd-agent-dock-header{display:flex;align-items:center;justify-content:space-between;margin:-14px -14px 12px;padding:12px 14px;position:sticky;top:-14px;z-index:2;background:var(--fd-surface);border-bottom:1px solid var(--fd-line)}
.fd-agent-dock :deep(.ai-workbench),.fd-agent-dock :deep(.ai-config){grid-template-columns:1fr}
.fd-agent-dock :deep(.ai-context-panel){grid-row:1}
.fd-agent-dock :deep(.ai-card),.fd-agent-dock :deep(.ai-transcript),.fd-agent-dock :deep(.ai-composer-shell){padding:14px}
.fd-agent-dock :deep(.ai-server-list){max-height:140px}
#app-container {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  font-family: var(--font-family-sans-serif); /* 使用字体变量 */
}


main {
  flex-grow: 1;

}

</style>
