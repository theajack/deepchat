<script setup lang="ts">
import { computed, ref } from "vue";
import { CornerDownRight, Search, X } from "lucide-vue-next";
import { useConversationsStore } from "../../stores/conversations";
import { useMessagesStore } from "../../stores/messages";
import { useBotsStore } from "../../stores/bots";
import { useSelfStore } from "../../stores/self";
import MessageBubble, { type BubbleModel } from "./MessageBubble.vue";
import type { Message } from "../../types";
import { t } from "../../i18n";

const emit = defineEmits<{ (e: "close"): void }>();

const conversations = useConversationsStore();
const messages = useMessagesStore();
const bots = useBotsStore();
const selfStore = useSelfStore();

const query = ref("");

const convId = computed(() => conversations.activeId);
const list = computed<Message[]>(() => (convId.value ? (messages.byConv[convId.value] ?? []) : []));

/** 按输入过滤命中的消息（仅匹配文本内容） */
const filtered = computed<Message[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return list.value;
  return list.value.filter((m) => m.content.toLowerCase().includes(q));
});

function avatarOf(senderId: string): string | null {
  return bots.items.find((b) => b.id === senderId)?.avatar ?? null;
}

/** 复用 MessageList 的气泡构造，segments 置空以走纯文本/markdown 渲染（不含工具卡片） */
function bubbleOf(m: Message): BubbleModel {
  return {
    key: m.id,
    isSelf: m.is_self === 1,
    senderName: m.sender_name,
    avatar: m.is_self === 1 ? null : avatarOf(m.sender_id),
    selfAvatar: m.is_self === 1 ? selfStore.avatar : null,
    content: m.content,
    segments: [],
    time: m.created_at,
    showAvatar: true,
    showSender: true,
    conversationId: m.conversation_id,
    botId: m.is_self === 1 ? undefined : m.sender_id,
  };
}

/** 定位：关闭弹窗并让主消息列表滚动到该消息 */
function locate(m: Message) {
  if (!convId.value) return;
  messages.requestLocate(convId.value, m.id);
  emit("close");
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm" @click.self="emit('close')">
    <div class="flex h-[78vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line-strong/60 bg-ink-1 shadow-[0_24px_70px_rgba(0,0,0,0.55)]">
      <header class="flex shrink-0 items-center justify-between border-b border-line px-5 py-4">
        <h3 class="text-[15px] font-semibold text-hi">{{ t("search.title") }}</h3>
        <button class="flex h-8 w-8 items-center justify-center rounded-lg text-mid transition-colors hover:bg-ink-3 hover:text-hi" @click="emit('close')">
          <X :size="17" />
        </button>
      </header>

      <div class="shrink-0 px-5 pt-4 pb-2">
        <div class="flex items-center gap-2 rounded-xl border border-line bg-ink-2/70 px-3 py-2 focus-within:border-accent/45">
          <Search :size="15" class="shrink-0 text-lo" />
          <input
            v-model="query"
            type="text"
            :placeholder="t('search.placeholder')"
            class="w-full bg-transparent text-[13px] text-hi outline-none placeholder:text-lo"
          />
          <span v-if="query" class="shrink-0 font-num text-[11px] text-lo">{{ t("search.count", { count: filtered.length }) }}</span>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2">
        <template v-if="filtered.length">
          <button
            v-for="m in filtered"
            :key="m.id"
            type="button"
            class="group/locate relative mb-1.5 block w-full rounded-xl text-left transition-colors hover:bg-ink-3/40"
            @click="locate(m)"
          >
            <MessageBubble :item="bubbleOf(m)" :is-group="conversations.active?.type === 'group'" />
            <!-- 定位按钮：hover 显示，点击定位 -->
            <span
              class="absolute top-2 right-3 z-10 flex items-center gap-1 rounded-lg border border-line-strong/60 bg-ink-1/95 px-2 py-1 text-[11px] text-mid opacity-0 shadow-sm transition-opacity group-hover/locate:opacity-100"
            >
              <CornerDownRight :size="12" />
              {{ t("search.locate") }}
            </span>
          </button>
        </template>
        <div v-else class="px-2 py-12 text-center text-sm text-lo">
          {{ list.length ? t("search.noMatch") : t("search.empty") }}
        </div>
      </div>
    </div>
  </div>
</template>
