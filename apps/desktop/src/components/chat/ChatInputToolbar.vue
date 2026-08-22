<script setup lang="ts">
import { computed, onMounted } from "vue";
import {
  FilePlus2,
  FolderOpen,
  ImagePlus,
  Mic,
  Search,
  SmilePlus,
  Square,
} from "lucide-vue-next";
import ContextRing from "../common/ContextRing.vue";
import { useConversationsStore } from "../../stores/conversations";
import { useMessagesStore } from "../../stores/messages";
import { useBotsStore } from "../../stores/bots";
import { useModelsStore } from "../../stores/models";
import { getModelContextDefaults, parseContextTokens } from "../../data/modelContextDefaults";
import { t } from "../../i18n";

interface ToolbarAction {
  key: string;
  title: string;
  icon: typeof Mic;
  /** 是否可用（默认 true），暂时都未实现功能 */
  disabled?: boolean;
}

/** 当前私聊对应的 bot（以会话 id 中的 botId 为唯一键反查） */
const currentBot = computed(() => {
  const c = conversations.active;
  if (!c || c.type !== "private") return null;
  const botId = c.id.startsWith("private:") ? c.id.slice("private:".length) : "";
  return bots.items.find((b) => b.id === botId) ?? null;
});

const actions = computed<ToolbarAction[]>(() => {
  // 禁用 Agent 能力的好友没有本地文件操作权限，不显示工作区按钮
  const showWorkspace = currentBot.value?.agent_enabled !== 0;
  return [
    { key: "voice", title: t("toolbar.voice"), icon: Mic },
    { key: "emoji", title: t("toolbar.emoji"), icon: SmilePlus },
    ...(showWorkspace ? [{ key: "workspace", title: t("toolbar.workspace"), icon: FolderOpen }] : []),
    { key: "image", title: t("toolbar.image"), icon: ImagePlus },
    { key: "file", title: t("toolbar.file"), icon: FilePlus2 },
    { key: "search", title: t("toolbar.search"), icon: Search },
  ];
});

const conversations = useConversationsStore();
const messages = useMessagesStore();
const bots = useBotsStore();
const models = useModelsStore();

onMounted(() => {
  if (!models.loaded) void models.load();
});

/** 私聊会话 id（private:{botId}）→ botId */
function botIdOf(c: { id: string }): string {
  return c.id.startsWith("private:") ? c.id.slice("private:".length) : "";
}

/** 私聊好友已删除（bots 中找不到该 id 好友）→ 所有按钮灰显禁用 */
const botDeleted = computed(() => {
  const c = conversations.active;
  if (!c || c.type !== "private") return false;
  return !bots.items.some((b) => b.id === botIdOf(c));
});

/** 私聊：当前 AI 好友模型的上下文占用（圆环显示在终止按钮前） */
const ctxUsage = computed(() => {
  const c = conversations.active;
  if (!c || c.type !== "private") return null;
  const bot = bots.items.find((b) => b.id === botIdOf(c));
  if (!bot) return null;
  const model = bot.model_id ? models.items.find((m) => m.id === bot.model_id) : null;
  const modelName = model?.model_name ?? "";
  const ctxStr = model?.input_ctx || getModelContextDefaults(modelName)?.inputCtx || "";
  const total = parseContextTokens(ctxStr);
  if (!total) return null;
  // 占用：当前会话最近一条 AI 消息的 prompt+completion（每次请求携带全部历史，近似当前上下文占用）
  const list = conversations.activeId ? messages.byConv[conversations.activeId] ?? [] : [];
  let used = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.sender_type === "ai_bot") {
      used = (m.prompt_tokens ?? 0) + (m.completion_tokens ?? 0);
      if (used > 0) break;
    }
  }
  return { used, total, modelName };
});

/** 当前会话是否有 AI 正在输出内容（流式生成中），决定终止按钮显隐 */
const generating = computed(() => {
  const id = conversations.activeId;
  if (!id) return false;
  return Object.values(messages.streams).some((s) => s.conversationId === id);
});

/** 终止当前会话所有正在生成的 AI 回复 */
async function onStop() {
  const id = conversations.activeId;
  if (!id) return;
  try {
    await messages.stopGeneration(id);
  } catch {
    // 终止失败时静默（CLI 侧流可能已结束）
  }
}

const emit = defineEmits<{
  (e: "action", key: string): void;
}>();

/** 好友已删除时仍可用的按钮（历史消息仍存在，搜索有意义） */
const ALWAYS_ENABLED_KEYS = new Set(["search"]);

function onClick(key: string) {
  // 好友已删除：除搜索聊天记录外的按钮禁用
  if (botDeleted.value && !ALWAYS_ENABLED_KEYS.has(key)) return;
  // 功能待补充，先仅向上层透传
  emit("action", key);
}
</script>

<template>
  <div class="flex items-center gap-1">
    <button
      v-for="action in actions"
      :key="action.key"
      :disabled="botDeleted && !ALWAYS_ENABLED_KEYS.has(action.key)"
      class="rounded-lg p-2 text-mid transition-colors hover:bg-ink-3 hover:text-hi disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-mid"
      :title="action.title"
      type="button"
      @click="onClick(action.key)"
    >
      <component :is="action.icon" :size="17" :stroke-width="2" />
    </button>
    <!-- 上下文占用圆环：私聊且模型窗口已知时显示（终止按钮前）。
         p-2 与按钮 padding 一致，保证与左右按钮垂直居中、左右间距统一 -->
    <div v-if="ctxUsage" class="flex items-center p-2">
      <ContextRing
        :used="ctxUsage.used"
        :total="ctxUsage.total"
        :model-name="ctxUsage.modelName"
        :size="15"
      />
    </div>
    <!-- 终止对话：仅 AI 输出内容时显示 -->
    <button
      v-if="generating"
      class="flex cursor-pointer items-center gap-1.5 rounded-lg p-2 text-danger transition-colors hover:bg-danger/15"
      :title="t('toolbar.stop')"
      type="button"
      @click="onStop"
    >
      <Square :size="17" :stroke-width="2" />
    </button>
  </div>
</template>
