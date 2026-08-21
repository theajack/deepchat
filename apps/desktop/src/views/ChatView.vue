<script setup lang="ts">
import ConversationList from "../components/chat/ConversationList.vue";
import ChatHeader from "../components/chat/ChatHeader.vue";
import MessageList from "../components/chat/MessageList.vue";
import ChatInput from "../components/chat/ChatInput.vue";
import { useConversationsStore } from "../stores/conversations";
import { t } from "../i18n";

const conversations = useConversationsStore();
</script>

<template>
  <div class="flex min-w-0 flex-1">
    <!-- 左侧消息列表 -->
    <ConversationList />

    <!-- 右侧聊天区 -->
    <main class="flex min-w-0 flex-1 flex-col bg-chat">
      <template v-if="conversations.active">
        <ChatHeader />
        <MessageList />
        <ChatInput />
      </template>
      <div v-else class="flex flex-1 flex-col items-center justify-center gap-4 text-lo">
        <div class="flex h-20 w-20 items-center justify-center rounded-2xl border border-line bg-ink-2/70 text-accent/60">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </div>
        <p class="text-sm text-mid">{{ t("chat.empty.title") }}</p>
        <p class="-mt-2 text-xs">{{ t("chat.empty.subtitle") }}</p>
      </div>
    </main>
  </div>
</template>
