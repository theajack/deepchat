<script setup lang="ts">
import { computed, onMounted } from "vue";
import { MessageSquare, Settings, User } from "lucide-vue-next";
import { useAppStore, type ViewName } from "../../stores/app";
import { useConversationsStore } from "../../stores/conversations";
import { useSelfStore } from "../../stores/self";
import { t } from "../../i18n";

const app = useAppStore();
const conversations = useConversationsStore();
const selfStore = useSelfStore();

const navItems = computed<{ view: ViewName; title: string; icon: typeof MessageSquare }[]>(() => [
  { view: "chat", title: t("nav.chat"), icon: MessageSquare },
  { view: "contacts", title: t("nav.contacts"), icon: User },
]);

const hasUnread = computed(() => conversations.totalUnread > 0);

// 同步判定：与 TitleBar 保持一致，避免首帧多/少一段红绿灯占位
const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
onMounted(() => {
  if (!selfStore.loaded) void selfStore.load();
});
</script>

<template>
  <aside class="flex w-15 shrink-0 flex-col items-center border-r border-line bg-ink-2/60">
    <!-- Mac 原生红绿灯由系统 titleBarStyle: Overlay 自动渲染，此处仅保留占位高度。
         Windows 无原生标题栏，自绘标题栏在上方独占一行，这里不需要占位。 -->
    <div v-if="isMac" class="h-9 w-full" data-tauri-drag-region />

    <!-- 用户头像 + 导航项 -->
    <div class="flex flex-1 flex-col items-center gap-1.5 py-4">
      <div class="mb-3 cursor-pointer" :title="selfStore.displayName" @click="app.navigateToSettings('me')">
        <img
          :src="selfStore.avatar || ''"
          :alt="selfStore.displayName"
          class="h-9 w-9 rounded-xl object-cover ring-1 ring-line-strong"
        />
      </div>

      <button
        v-for="item in navItems"
        :key="item.view"
        class="group relative flex h-10 w-10 items-center justify-center rounded-xl text-lo transition-all duration-200 hover:bg-ink-3 hover:text-hi"
        :class="{ '!bg-accent-soft !text-accent': app.view === item.view }"
        :title="item.title"
        @click="app.navigate(item.view)"
      >
        <component :is="item.icon" :size="19" :stroke-width="1.7" />
        <span
          v-if="app.view === item.view"
          class="absolute -left-3 h-4.5 w-[3px] rounded-r-full bg-accent shadow-[0_0_8px_var(--color-accent)]"
        />
        <span
          v-if="item.view === 'chat' && hasUnread && app.view !== 'chat'"
          class="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-danger shadow-[0_0_6px_rgba(255,92,108,0.8)]"
        />
      </button>

      <div class="flex-1" />

      <button
        class="flex h-10 w-10 items-center justify-center rounded-xl text-lo transition-all duration-200 hover:bg-ink-3 hover:text-hi"
        :class="{ '!bg-accent-soft !text-accent': app.view === 'settings' }"
        :title="t('nav.settings')"
        @click="app.navigateToSettings(app.settingsSection)"
      >
        <Settings :size="19" :stroke-width="1.7" />
      </button>
    </div>
  </aside>
</template>
