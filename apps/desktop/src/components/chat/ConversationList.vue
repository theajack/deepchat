<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Loader2, Pin, Plus, Search, UserX, Users } from "lucide-vue-next";
import { useAppStore } from "../../stores/app";
import { useBotsStore } from "../../stores/bots";
import { useConversationsStore } from "../../stores/conversations";
import { useUiStore } from "../../stores/ui";
import { formatListTime } from "../../utils/display";
import Avatar from "../common/Avatar.vue";
import ConfirmModal from "../common/ConfirmModal.vue";
import ContextMenu, { type ContextMenuState } from "../common/ContextMenu.vue";
import GroupAvatar from "../contacts/GroupAvatar.vue";
import BotAgentBadge from "../contacts/BotAgentBadge.vue";
import ResizeHandle from "../common/ResizeHandle.vue";
import { showBotDetail, hideBotDetail } from "../../utils/botDetailHover";
import HoverTip from "../common/HoverTip.vue";
import type { Conversation } from "../../types";
import { t } from "../../i18n";

const app = useAppStore();
const bots = useBotsStore();
const conversations = useConversationsStore();
const ui = useUiStore();

// 右键菜单状态
const menuState = ref<ContextMenuState | null>(null);
const menuConv = ref<Conversation | null>(null);

function onContextMenu(e: MouseEvent, conv: Conversation) {
  e.preventDefault();
  e.stopPropagation();
  menuConv.value = conv;
  const isGroup = conv.type === "group";
  menuState.value = {
    x: e.clientX,
    y: e.clientY,
    groups: [
      {
        items: [
          { key: "pin", label: conversations.isPinnedTop(conv.id) ? t("conv.menu.unpin") : t("conv.menu.pin") },
        ],
      },
      {
        items: [
          { key: "rename", label: isGroup ? t("conv.menu.renameGroup") : t("conv.menu.renameBot") },
        ],
      },
      {
        items: [
          { key: "deleteSession", label: t("conv.menu.deleteSession"), danger: true },
          { key: "delete", label: isGroup ? t("conv.menu.deleteGroup") : t("conv.menu.deleteBot"), danger: true },
        ],
      },
    ],
  };
}

// 二次确认弹框
interface ConfirmState {
  title: string;
  message: string;
  confirmText: string;
  action: () => Promise<void> | void;
}
const confirmState = ref<ConfirmState | null>(null);
function requestConfirm(state: ConfirmState) {
  confirmState.value = state;
}
async function onConfirm() {
  const state = confirmState.value;
  confirmState.value = null;
  if (state) await state.action();
}

function onMenuSelect(key: string) {
  const conv = menuConv.value;
  if (!conv) return;
  switch (key) {
    case "pin":
      conversations.togglePinTop(conv.id);
      app.toast(conversations.isPinnedTop(conv.id) ? t("conv.menu.pinned") : t("conv.menu.unpinned"));
      break;
    case "rename":
      if (conv.type === "group") {
        app.openGroupEditor(conv);
      } else {
        const bot = botOf(conv);
        if (bot) app.openBotEditor(bot);
      }
      break;
    case "deleteSession":
      requestConfirm({
        title: t("conv.deleteSession.title"),
        message: t("conv.deleteSession.message", { name: conv.name }),
        confirmText: t("conv.deleteSession.confirm"),
        action: async () => {
          await conversations.deleteSession(conv.id);
          app.toast(t("conv.deleteSession.done"));
        },
      });
      break;
    case "delete":
      if (conv.type === "group") {
        requestConfirm({
          title: t("contacts.deleteGroup.title"),
          message: t("contacts.deleteGroup.message", { name: conv.name }),
          confirmText: t("common.delete"),
          action: async () => {
            await conversations.remove(conv.id);
            app.toast(t("contacts.deletedGroup"));
          },
        });
      } else {
        const botId = conv.id.startsWith("private:") ? conv.id.slice("private:".length) : "";
        requestConfirm({
          title: t("contacts.deleteBot.title"),
          message: t("contacts.deleteBot.message", { name: conv.name }),
          confirmText: t("common.delete"),
          action: async () => {
            await bots.remove(botId);
            app.toast(t("contacts.deletedBot", { name: conv.name }));
          },
        });
      }
      break;
  }
}

/** 私聊会话对应的 bot（以会话 id 中的 botId 为唯一键反查），用于展示 agent 能力图标 */
function botOf(conv: { type: string; id: string }) {
  if (conv.type !== "private") return null;
  const botId = conv.id.startsWith("private:") ? conv.id.slice("private:".length) : "";
  return bots.items.find((b) => b.id === botId) ?? null;
}

/** 会话项 hover：私聊 AI 好友显示详情浮层（全局单例） */
function onConvEnter(conv: Conversation, e: MouseEvent) {
  if (conv.type !== "private") return;
  const bot = botOf(conv);
  if (bot) showBotDetail(bot.id, e.currentTarget as HTMLElement);
}
function onConvLeave() {
  hideBotDetail();
}
const keyword = ref("");

// 监听群聊列表变化，自动加载缺失的成员（首次渲染即显示人数与九宫格，
// 而非等首次点击 select 才加载）
watch(
  () => conversations.chatList.filter((c) => c.type === "group").map((c) => c.id),
  (ids) => {
    for (const id of ids) {
      if (!conversations.membersMap[id]) void conversations.loadMembers(id);
    }
  },
  { immediate: true },
);

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  const base = conversations.chatList;
  if (!kw) return base;
  return base.filter(
    (c) => c.name.toLowerCase().includes(kw) || (c.last_message_preview ?? "").toLowerCase().includes(kw),
  );
});
</script>

<template>
  <aside class="relative flex shrink-0 flex-col border-r border-line bg-ink-2/40" :style="{ width: `${ui.sidebarWidth}px` }">
    <ResizeHandle />
    <div class="flex items-center gap-2 px-3.5 pt-4 pb-2.5">
      <div class="relative min-w-0 flex-1">
        <Search :size="13" class="absolute top-1/2 left-3 -translate-y-1/2 text-lo" />
        <input
          v-model="keyword"
          type="text"
          :placeholder="t('conv.search')"
          class="w-full rounded-lg border border-line bg-ink-1/80 py-1.5 pr-3 pl-8 text-xs text-hi outline-none transition-colors placeholder:text-lo focus:border-accent/40"
        />
      </div>
      <button
        class="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-line-strong/50 bg-ink-2/70 text-mid transition-all hover:border-accent/40 hover:bg-ink-3 hover:text-accent active:scale-95"
        :title="t('conv.newFriend')"
        @click="app.openBotEditor()"
      >
        <Plus :size="15" />
      </button>
    </div>
    <div class="overscroll-contain flex-1 overflow-y-auto pb-2.5">
      <!-- 会话列表加载中 -->
      <div v-if="conversations.loading" class="flex items-center justify-center gap-2 py-10 text-xs text-lo">
        <Loader2 :size="14" class="animate-spin text-accent" /> {{ t("common.loading") }}
      </div>
      <div v-else-if="filtered.length === 0" class="px-4 py-10 text-center text-xs text-lo">
        {{ conversations.chatList.length === 0 ? t("conv.empty") : t("conv.noMatch") }}
      </div>
      <div
        v-for="conv in filtered"
        :key="conv.id"
        class="group relative mx-2 mb-0.5 flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2.5 transition-all duration-150 hover:bg-ink-3/70"
        :class="{
          '!bg-ink-4': conv.id === conversations.activeId,
          'bg-ink-3/40': conversations.isPinnedTop(conv.id) && conv.id !== conversations.activeId,
        }"
        @click="conversations.select(conv.id)"
        @contextmenu="onContextMenu($event, conv)"
        @mouseenter="onConvEnter(conv, $event)"
        @mouseleave="onConvLeave"
      >
        <!-- 激活左侧光条 -->
        <span
          v-if="conv.id === conversations.activeId"
          class="absolute -left-2 h-5 w-[3px] rounded-r-full bg-accent shadow-[0_0_8px_var(--color-accent)]"
        />
        <GroupAvatar v-if="conv.type === 'group'" :members="(conversations.membersMap[conv.id] ?? []).map((b) => ({ name: b.name, avatar: b.avatar, deleted: b.deleted }))" :size="40" />
        <!-- 私聊：好友已删除 → 头像灰滤镜 + 橙色"不存在"角标，hover 提示「好友已删除」 -->
        <HoverTip v-else-if="!botOf(conv)" :content="t('conv.botDeleted')" placement="right">
          <div class="relative shrink-0">
            <Avatar :name="conv.name" :src="conv.avatar" :size="40" class="grayscale opacity-50" />
            <span
              class="absolute -right-0.5 -bottom-0.5 flex h-[15px] w-[15px] items-center justify-center rounded-full border border-ink-1 bg-ink-1 text-orange-400"
            >
              <UserX :size="10" :stroke-width="2.5" />
            </span>
          </div>
        </HoverTip>
        <Avatar v-else :name="conv.name" :src="(botOf(conv)!.avatar ?? conv.avatar)" :size="40" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center justify-between">
            <span class="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-hi">
              <Pin v-if="conversations.isPinnedTop(conv.id)" :size="11" :stroke-width="2.5" class="shrink-0 text-accent" />
              <span class="truncate">{{ conv.name }}</span>
              <BotAgentBadge v-if="conv.type === 'private' && botOf(conv)" :agent-enabled="botOf(conv)!.agent_enabled" :size="13" />
              <span v-if="conv.type === 'group'" class="flex shrink-0 items-center gap-0.5 text-[10px] font-normal text-accent">
                <Users :size="11" :stroke-width="2" />
                <span class="font-num">{{ (conversations.membersMap[conv.id]?.length ?? 0) + 1 }}</span>
              </span>
            </span>
            <span class="font-num shrink-0 text-[10px] text-lo">{{ formatListTime(conv.last_message_at) }}</span>
          </div>
          <div class="mt-1 flex items-center justify-between">
            <span class="truncate text-xs text-mid">{{ conv.last_message_preview ?? " " }}</span>
            <span
              v-if="conv.unread_count > 0"
              class="font-num ml-1.5 flex h-[17px] min-w-[17px] shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-semibold text-on-accent shadow-[0_0_10px_var(--color-accent-glow)]"
            >
              {{ conv.unread_count > 99 ? "99+" : conv.unread_count }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <ContextMenu :state="menuState" @close="menuState = null" @select="onMenuSelect" />
    <ConfirmModal
      v-if="confirmState"
      :title="confirmState.title"
      :message="confirmState.message"
      :confirm-text="confirmState.confirmText"
      danger
      @confirm="onConfirm"
      @close="confirmState = null"
    />
  </aside>
</template>
