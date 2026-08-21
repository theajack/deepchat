<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useAppStore } from "../../stores/app";
import { useBotsStore } from "../../stores/bots";
import { useConversationsStore } from "../../stores/conversations";
import { useMessagesStore } from "../../stores/messages";
import { useModelsStore } from "../../stores/models";
import { MoreVertical, Pencil, Trash2, Users, Cpu } from "lucide-vue-next";
import Avatar from "../common/Avatar.vue";
import HoverTip from "../common/HoverTip.vue";
import GroupAvatar from "../contacts/GroupAvatar.vue";
import BotAgentBadge from "../contacts/BotAgentBadge.vue";
import ConfirmModal from "../common/ConfirmModal.vue";
import Drawer from "../common/Drawer.vue";
import type { Bot } from "../../types";
import { t } from "../../i18n";

const app = useAppStore();
const bots = useBotsStore();
const conversations = useConversationsStore();
const messages = useMessagesStore();
const models = useModelsStore();

const drawerOpen = ref(false);

onMounted(() => {
  if (!models.loaded) void models.load();
});

const currentBot = computed<Bot | null>(() => {
  const c = conv.value;
  if (!c || c.type !== "private") return null;
  return bots.items.find((b) => b.name === c.name) ?? null;
});

/** 当前 AI 好友使用的模型信息：优先模型配置名，回退到实际模型名 */
const modelLabel = computed(() => {
  const b = currentBot.value;
  if (!b) return "";
  if (b.model_id) {
    const m = models.items.find((x) => x.id === b.model_id);
    if (m) return m.name || m.model_name;
  }
  return b.model_name || "";
});

function onEdit() {
  const c = conv.value;
  if (!c) return;
  if (c.type === "group") {
    app.openGroupEditor(c);
  } else if (currentBot.value) {
    app.openBotEditor(currentBot.value);
  }
}

const showClearConfirm = ref(false);

async function onClearMessages() {
  showClearConfirm.value = false;
  const c = conv.value;
  if (!c) return;
  try {
    await conversations.clearMessages(c.id);
    app.toast(t("chat.cleared"));
  } catch (e) {
    app.toast(e instanceof Error ? e.message : String(e));
  }
}

const conv = computed(() => conversations.active);

/** 私聊好友是否已删除（bots 中找不到同名好友）→ 头像灰显 + hover 提示 */
const botDeleted = computed(() => {
  const c = conv.value;
  if (!c || c.type !== "private") return false;
  return !currentBot.value;
});

// 群聊激活时预加载成员，供九宫格头像展示
watch(conv, (c) => {
  if (c?.type === "group") void conversations.loadMembers(c.id);
}, { immediate: true });

const typingNames = computed(() =>
  Object.entries(messages.typing)
    .filter(([key]) => key.startsWith(`${conv.value?.id}:`))
    .map(([, name]) => name),
);
const isTyping = computed(() => typingNames.value.length > 0);
const isGroup = computed(() => conv.value?.type === "group");
const subText = computed(() => {
  if (!conv.value) return "";
  if (isTyping.value) {
    return isGroup.value
      ? t("chat.typingNames", { names: typingNames.value.join(t("common.listSep")) })
      : t("chat.typingOther");
  }
  return isGroup.value ? t("chat.typeGroup") : t("chat.typePrivate");
});
</script>

<template>
  <header
    v-if="conv"
    class="flex h-13 shrink-0 items-center justify-between border-b border-line bg-ink-1/50 px-5"
  >
    <div class="flex min-w-0 items-center gap-3">
      <GroupAvatar v-if="conv.type === 'group'" :members="(conversations.membersMap[conv.id] ?? []).map((b) => ({ name: b.name, avatar: b.avatar, deleted: b.deleted }))" :size="34" />
      <!-- 私聊好友已删除：灰显头像 + hover 提示 -->
      <HoverTip v-else-if="botDeleted" :content="t('chat.botDeleted')" placement="bottom">
        <Avatar :name="conv.name" :src="conv.avatar" :size="34" class="grayscale opacity-50" />
      </HoverTip>
      <Avatar v-else :name="conv.name" :src="(currentBot!.avatar ?? conv.avatar)" :size="34" />
      <div class="min-w-0">
        <div class="flex items-center gap-1.5 text-sm font-semibold leading-none tracking-wide text-hi">
          <span class="leading-none" :class="botDeleted ? 'opacity-50' : ''">{{ conv.name }}</span>
          <span v-if="botDeleted" class="shrink-0 text-[11px] font-normal leading-none text-orange-400">{{ t("chat.botDeleted") }}</span>
          <BotAgentBadge v-if="conv.type === 'private' && currentBot" :agent-enabled="currentBot.agent_enabled" :size="14" />
          <span
            v-if="conv.type === 'private' && currentBot && modelLabel"
            class="flex h-[18px] shrink-0 items-center gap-1 rounded-md bg-ink-2 px-1.5 text-[10.5px] font-normal leading-none text-mid"
          >
            <Cpu :size="11" :stroke-width="2" />
            <span class="font-num">{{ modelLabel }}</span>
          </span>
          <span v-if="conv.type === 'group'" class="flex h-[18px] shrink-0 items-center gap-0.5 text-[11px] font-normal leading-none text-accent">
            <Users :size="12" :stroke-width="2" />
            <span class="font-num">{{ (conversations.membersMap[conv.id]?.length ?? 0) + 1 }}</span>
          </span>
        </div>
        <div class="mt-0.5 flex items-center gap-1.5 text-[11px]" :class="isTyping ? 'text-accent' : 'text-lo'">
          <!-- typing 动效三点 -->
          <span v-if="isTyping" class="flex items-center gap-0.5">
            <span v-for="i in 3" :key="i" class="typing-dot h-1 w-1 rounded-full bg-accent" :style="{ animationDelay: `${i * 0.15}s` }" />
          </span>
          {{ subText }}
        </div>
      </div>
    </div>
    <!-- 操作按钮：好友已删除时除清空对话外全部灰显禁用 -->
    <div class="flex items-center gap-1">
      <button
        class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-mid transition-colors hover:bg-danger/15 hover:text-danger"
        :title="t('chat.clear.title')"
        @click="showClearConfirm = true"
      >
        <Trash2 :size="16" :stroke-width="2" />
      </button>
      <button
        :disabled="botDeleted"
        class="flex h-8 w-8 items-center justify-center rounded-lg text-mid transition-colors hover:bg-ink-3 hover:text-hi disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-mid"
        :title="t('chat.info')"
        @click="onEdit"
      >
        <Pencil :size="16" :stroke-width="2" />
      </button>
      <button
        :disabled="botDeleted"
        class="flex h-8 w-8 items-center justify-center rounded-lg text-mid transition-colors hover:bg-ink-3 hover:text-hi disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-mid"
        :title="t('chat.more')"
        @click="drawerOpen = true"
      >
        <MoreVertical :size="18" :stroke-width="2" />
      </button>
    </div>
    <Drawer :open="drawerOpen" :title="t('chat.more')" @close="drawerOpen = false" />
    <ConfirmModal
      v-if="showClearConfirm"
      :title="t('chat.clear.title')"
      :message="t('chat.clear.message', { name: conv.name })"
      :confirm-text="t('chat.clear.confirm')"
      danger
      @confirm="onClearMessages"
      @close="showClearConfirm = false"
    />
  </header>
</template>
