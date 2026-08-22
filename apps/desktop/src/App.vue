<script setup lang="ts">
import { onMounted, ref } from "vue";
import NavSidebar from "./components/layout/NavSidebar.vue";
import TitleBar from "./components/layout/TitleBar.vue";
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

const app = useAppStore();
const theme = useThemeStore();
const locale = useLocaleStore();
const self = useSelfStore();

/** 独立浏览器窗口模式：URL hash 以 #/browser 开头 */
const isBrowserWindow = ref(window.location.hash.startsWith("#/browser"));
/** 独立「对话信息」调试窗口：URL hash 以 #/llm-trace 开头 */
const isLlmTraceWindow = ref(window.location.hash.startsWith("#/llm-trace"));

onMounted(async () => {
  theme.init();
  locale.init();
  // 独立窗口（浏览器 / 对话信息）只需主题，无需加载业务数据与事件订阅
  if (isBrowserWindow.value || isLlmTraceWindow.value) return;

  const messages = useMessagesStore();
  const bots = useBotsStore();
  const conversations = useConversationsStore();
  const settings = useSettingsStore();

  messages.bindEvents();
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
    <TitleBar />
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
