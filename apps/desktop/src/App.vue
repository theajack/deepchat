<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import NavSidebar from "./components/layout/NavSidebar.vue";
import TitleBar from "./components/layout/TitleBar.vue";
import WindowControls from "./components/layout/WindowControls.vue";
import Toast from "./components/common/Toast.vue";
import ApprovalModal from "./components/chat/ApprovalModal.vue";
import BotEditorModal from "./views/BotEditorModal.vue";
import BotDetailPopover from "./components/contacts/BotDetailPopover.vue";
import BrowserWindowView from "./views/BrowserWindowView.vue";
import LlmTraceView from "./views/LlmTraceView.vue";
import ChatView from "./views/ChatView.vue";
import ContactsView from "./views/ContactsView.vue";
import GroupEditorModal from "./views/GroupEditorModal.vue";
import SettingsView from "./views/SettingsView.vue";
import { useAppStore } from "./stores/app";
import { useBotsStore } from "./stores/bots";
import { useConversationsStore } from "./stores/conversations";
import { useMessagesStore } from "./stores/messages";
import { useSettingsStore } from "./stores/settings";
import { useSelfStore } from "./stores/self";
import { useThemeStore } from "./stores/theme";
import { useLocaleStore } from "./stores/locale";
import { t } from "./i18n";

const app = useAppStore();
const theme = useThemeStore();
const locale = useLocaleStore();
const self = useSelfStore();
const conversations = useConversationsStore();

/** ChatHeader 是否可见：可见时窗口按钮由它承载，否则由顶层兜底渲染 */
const chatHeaderVisible = computed(
  () => app.view === "chat" && Boolean(conversations.active),
);

/** 独立浏览器窗口模式：URL hash 以 #/browser 开头 */
const isBrowserWindow = ref(window.location.hash.startsWith("#/browser"));
/** 独立「对话信息」调试窗口：URL hash 以 #/llm-trace 开头 */
const isLlmTraceWindow = ref(window.location.hash.startsWith("#/llm-trace"));

/** 后端（dsh 宿主）冷启动等待中：期间所有请求都会以 "Load failed" 失败 */
const booting = ref(false);

/**
 * 端口被别的后端（多为上一版残留的 dsh 宿主）占着：此时前端能连上端口，
 * 但对面是旧版本的接口，请求会以 404 / 405 乱报。这种情况直接拦下来，
 * 而不是让用户对着一堆莫名其妙的报错。
 */
const hostConflict = ref("");

/**
 * 等待后端就绪。打包版宿主要加载 200+ 依赖包与全套插件，全新机器上冷启动
 * 可达 1~2 分钟——不等它的话首屏数据请求全部失败（"Load failed"），用户在
 * 这期间创建的好友/模型也会因请求被拒而丢失。
 */
async function waitForBackend(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await invoke<boolean>("dsh_ready")) return true;
      // 端口冲突（多为旧版 DeepChat 残留宿主占着 3180）：立即停下来提示，
      // 不要等满 3 分钟，也不要让请求打到旧后端上。
      const conflict = await invoke<string | null>("dsh_conflict");
      if (conflict !== null) {
        hostConflict.value = conflict;
        return false;
      }
    } catch {
      // 非 Tauri 环境（纯浏览器调试）没有这个命令：直接放行
      return true;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

onMounted(async () => {
  theme.init();
  locale.init();
  // 独立窗口（浏览器 / 对话信息）只需主题，无需加载业务数据与事件订阅
  if (isBrowserWindow.value || isLlmTraceWindow.value) return;

  const messages = useMessagesStore();
  const bots = useBotsStore();
  const settings = useSettingsStore();

  messages.bindEvents();
  // Rust 侧抢占端口失败 / 端口上是别的宿主时推这个事件
  try {
    const { listen } = await import("@tauri-apps/api/event");
    await listen<{ detail?: string }>("dsh.conflict", (event) => {
      hostConflict.value = event.payload?.detail ?? "";
      booting.value = false;
    });
  } catch {
    // 非 Tauri 环境没有事件系统
  }
  booting.value = true;
  const ready = await waitForBackend(180_000);
  booting.value = false;
  if (hostConflict.value !== "") return;
  if (!ready) {
    app.toast(t("app.backendTimeout"));
    return;
  }
  try {
    await Promise.all([bots.load(), settings.load(), self.load()]);
    await conversations.load();
  } catch (e) {
    app.toast(e instanceof Error ? e.message : String(e));
  }
});
</script>

<template>
  <!-- 独立浏览器窗口 -->
  <BrowserWindowView v-if="isBrowserWindow" />

  <!-- 独立「对话信息」调试窗口 -->
  <LlmTraceView v-else-if="isLlmTraceWindow" />

  <!-- 主窗口 -->
  <!-- overscroll-behavior: contain 阻止 macOS 弹性滚动穿透到外层（避免 UI 被拽出边界） -->
  <div v-else class="overscroll-contain flex h-full flex-col overflow-hidden">
    <!-- 后端冷启动等待层：全屏遮罩，避免用户在服务未就绪时操作导致请求失败 -->
    <div v-if="booting" class="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-ink-1">
      <span class="h-9 w-9 animate-spin rounded-full border-2 border-line border-t-accent"></span>
      <span class="text-[13px] text-mid">{{ t("app.booting") }}</span>
    </div>
    <!-- 后端端口被旧版残留进程占用：直接说明原因，避免用户对着一堆 404/405 -->
    <div
      v-else-if="hostConflict !== ''"
      class="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-ink-1 px-10 text-center"
    >
      <span class="text-[15px] font-medium text-hi">{{ t("app.hostConflict") }}</span>
      <span class="max-w-[560px] text-[12px] leading-relaxed text-mid">{{ t("app.hostConflictHint") }}</span>
      <span class="max-w-[560px] font-mono text-[11px] leading-relaxed break-all text-lo">{{ hostConflict }}</span>
    </div>
    <TitleBar />
    <!-- 无会话（ChatHeader 不渲染）时，Windows 窗口按钮由此兜底显示。
         内边距（pr-5）与透明下边框（border-b）都对齐 ChatHeader，保证按钮在
         有/无会话之间切换时不产生偏移。macOS 组件内自行隐藏。 -->
    <div
      v-if="!chatHeaderVisible"
      class="pointer-events-none fixed top-0 right-0 z-40 flex h-13 items-center border-b border-transparent pr-5"
    >
      <div class="pointer-events-auto">
        <WindowControls />
      </div>
    </div>
    <div class="flex min-h-0 flex-1">
      <NavSidebar />
      <ChatView v-show="app.view === 'chat'" class="flex min-w-0 flex-1" />
      <ContactsView v-if="app.view === 'contacts'" class="flex min-w-0 flex-1" />
      <SettingsView v-if="app.view === 'settings'" class="flex min-w-0 flex-1" />
    </div>
    <BotEditorModal />
    <GroupEditorModal />
    <ApprovalModal />
    <BotDetailPopover />
    <Toast />
  </div>
</template>
