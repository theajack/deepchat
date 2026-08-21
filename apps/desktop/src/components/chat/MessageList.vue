<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useConversationsStore } from "../../stores/conversations";
import { useMessagesStore } from "../../stores/messages";
import { useBotsStore } from "../../stores/bots";
import { useSelfStore } from "../../stores/self";
import { formatSeparator } from "../../utils/display";
import MessageBubble, { type BubbleModel } from "./MessageBubble.vue";
import ContextMenu, { type ContextMenuState } from "../common/ContextMenu.vue";
import { t } from "../../i18n";

const TIME_GAP = 5 * 60 * 1000;

type Row = { type: "time"; key: string; text: string } | { type: "msg"; key: string; model: BubbleModel };

const conversations = useConversationsStore();
const messages = useMessagesStore();
const bots = useBotsStore();
const selfStore = useSelfStore();
const bodyRef = ref<HTMLElement | null>(null);

// 是否"贴底"：用户上翻时暂停自动滚动，回到底部时恢复
const stickToBottom = ref(true);
const STICK_THRESHOLD = 24; // px：距底部小于此值视为"在底部"

function onScroll() {
  const el = bodyRef.value;
  if (!el) return;
  const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  stickToBottom.value = distFromBottom < STICK_THRESHOLD;
}

onMounted(() => {
  bodyRef.value?.addEventListener("scroll", onScroll, { passive: true });
});

onBeforeUnmount(() => {
  bodyRef.value?.removeEventListener("scroll", onScroll);
});

// 右键菜单状态
const menuState = ref<ContextMenuState | null>(null);

function onContextMenu(e: MouseEvent, row: Row) {
  if (row.type !== "msg") return;
  e.preventDefault();
  menuState.value = {
    x: e.clientX,
    y: e.clientY,
    groups: [
      {
        items: [
          { key: "test", label: t("menu.test") },
          { key: "test-disabled", label: t("menu.disabled"), disabled: true },
        ],
      },
      {
        title: t("menu.more"),
        items: [
          { key: "danger", label: t("menu.danger"), danger: true },
        ],
      },
    ],
  };
}

function onMenuSelect(key: string) {
  // TODO: 根据 key 分发具体操作
  void key;
}

const conv = computed(() => conversations.active);

/** 解析某条消息发送者的头像 url（依赖 bots.items / membersMap 以响应头像变更） */
function avatarOf(senderId: string): string | null {
  if (!conv.value) return null;
  const convId = conv.value.id;
  const bot = bots.items.find((b) => b.id === senderId);
  if (bot?.avatar) return bot.avatar;
  const members = conversations.membersMap[convId] ?? [];
  return members.find((b) => b.id === senderId)?.avatar ?? null;
}

const rows = computed<Row[]>(() => {
  if (!conv.value) return [];
  const convId = conv.value.id;
  const list = messages.byConv[convId] ?? [];
  const result: Row[] = [];

  list.forEach((msg, i) => {
    const prev = list[i - 1];
    if (!prev || msg.created_at - prev.created_at > TIME_GAP) {
      result.push({ type: "time", key: `t-${msg.id}`, text: formatSeparator(msg.created_at) });
    }
    const samePrev = prev && prev.sender_id === msg.sender_id && msg.created_at - prev.created_at <= TIME_GAP;
    result.push({
      type: "msg",
      key: msg.id,
      model: {
        key: msg.id,
        isSelf: msg.is_self === 1,
        senderName: msg.sender_name,
        avatar: msg.is_self === 1 ? null : avatarOf(msg.sender_id),
        selfAvatar: msg.is_self === 1 ? selfStore.avatar : null,
        content: msg.content,
        segments: msg.segments,
        time: msg.created_at,
        showAvatar: !samePrev,
        showSender: !samePrev,
        animate: i === list.length - 1,
        promptTokens: msg.prompt_tokens ?? 0,
        completionTokens: msg.completion_tokens ?? 0,
        durationMs: msg.duration_ms ?? 0,
        cachedTokens: msg.cached_tokens ?? 0,
        aborted: msg.stop_reason === "aborted",
        conversationId: msg.conversation_id,
        botId: msg.is_self === 1 ? undefined : msg.sender_id,
      },
    });
  });

  // 流式草稿
  for (const draft of Object.values(messages.streams)) {
    if (draft.conversationId !== convId) continue;
    const bot = bots.items.find((b) => b.id === draft.botId);
    result.push({
      type: "msg",
      key: draft.draftId,
      model: {
        key: draft.draftId,
        isSelf: false,
        senderName: bot?.name ?? "",
        avatar: bot?.avatar ?? null,
        content: draft.content,
        segments: draft.segments,
        time: null,
        showAvatar: true,
        showSender: false,
        streaming: true,
        conversationId: draft.conversationId,
        botId: draft.botId,
      },
    });
  }

  // typing 指示（无流式草稿时）
  const typingEntries = Object.entries(messages.typing).filter(([key]) => key.startsWith(`${convId}:`));
  const typingNames = typingEntries.map(([, name]) => name);
  const hasStream = Object.values(messages.streams).some((s) => s.conversationId === convId);
  if (typingNames.length > 0 && !hasStream) {
    const isGroup = conv.value?.type === "group";
    const typingBotId = typingEntries[0][0].split(":").slice(1).join(":");
    const typingAvatar = bots.items.find((b) => b.id === typingBotId)?.avatar ?? null;
    result.push({ type: "msg", key: "typing", model: { key: "typing", isSelf: false, senderName: typingNames[0], avatar: typingAvatar, content: "", time: null, showAvatar: true, showSender: isGroup, streaming: true } });
  }

  return result;
});

async function scrollBottom(force = false) {
  await nextTick();
  // 用户上翻时（不贴底）不自动滚动；force 用于切换会话时强制到底
  if (!force && !stickToBottom.value) return;
  bodyRef.value?.scrollTo({ top: bodyRef.value.scrollHeight });
}

watch(rows, () => scrollBottom(), { flush: "post" });
// 切换会话时强制滚动到底部，并重置贴底状态
watch(
  () => conv.value?.id,
  () => {
    stickToBottom.value = true;
    scrollBottom(true);
  },
  { flush: "post" },
);
</script>

<template>
  <div ref="bodyRef" class="flex flex-1 flex-col overflow-y-auto py-2.5 pb-5">
    <template v-for="row in rows" :key="row.key">
      <div v-if="row.type === 'time'" class="my-2 flex items-center justify-center gap-3">
        <span class="h-px w-10 bg-gradient-to-r from-transparent to-line-strong" />
        <span class="font-num text-[10px] tracking-widest text-lo">{{ row.text }}</span>
        <span class="h-px w-10 bg-gradient-to-l from-transparent to-line-strong" />
      </div>
      <MessageBubble
        v-else
        :item="row.model"
        :is-group="conv?.type === 'group'"
        class="my-1"
        @contextmenu="onContextMenu($event, row)"
      />
    </template>

    <ContextMenu :state="menuState" @close="menuState = null" @select="onMenuSelect" />
  </div>
</template>
