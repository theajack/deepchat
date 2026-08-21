<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { MessageCircle, Pencil } from "lucide-vue-next";
import Avatar from "../common/Avatar.vue";
import BotAgentBadge from "./BotAgentBadge.vue";
import { useBotsStore } from "../../stores/bots";
import { useModelsStore } from "../../stores/models";
import { useConversationsStore } from "../../stores/conversations";
import { useAppStore } from "../../stores/app";
import { formatDateTime } from "../../utils/display";
import { botDetailHover, hideBotDetail, keepBotDetail } from "../../utils/botDetailHover";
import { t } from "../../i18n";
import type { Bot } from "../../types";

/**
 * 好友详情 hover 浮层（全局单例，挂载于 App）：
 * 显示在触发元素右侧；触发点 hover 时通过 showBotDetail(botId, el) 更新位置与内容。
 * 浮层自身可 hover（保持显示）并可点击操作按钮。
 */
const bots = useBotsStore();
const models = useModelsStore();
const conversations = useConversationsStore();
const app = useAppStore();

const visible = computed(() => botDetailHover.botId !== null);
const bot = computed<Bot | null>(() =>
  botDetailHover.botId ? bots.items.find((b) => b.id === botDetailHover.botId) ?? null : null,
);

const panelRef = ref<HTMLElement | null>(null);
const pos = ref({ left: 0, top: 0 });

const GAP = 8;
const EDGE = 8;

/** 定位到锚点右侧（垂直对齐锚点顶部），视口钳制；右侧空间不足时贴右边缘 */
async function reposition() {
  const anchor = botDetailHover.anchorEl;
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  const width = 300;
  // 先渲染再测量实际宽度
  await nextTick();
  const el = panelRef.value;
  const w = el?.offsetWidth || width;
  const h = el?.offsetHeight || 320;
  let left = r.right + GAP;
  if (left + w > window.innerWidth - EDGE) left = window.innerWidth - w - EDGE;
  let top = r.top;
  if (top + h > window.innerHeight - EDGE) top = Math.max(EDGE, window.innerHeight - h - EDGE);
  pos.value = { left, top };
}

watch(() => botDetailHover.botId, reposition, { immediate: true });
// 内容变化（人设/技能等）引起高度变化时重定位
watch(bot, reposition);

function onLeave() {
  hideBotDetail();
}

/** 模型显示名（与好友详情页一致） */
function modelName(b: Bot): string {
  if (!b.model_id) return b.model_name || "—";
  const m = models.items.find((x) => x.id === b.model_id);
  return m?.name || b.model_name || "—";
}

/** 与该好友发起私聊 */
async function chatWithBot(b: Bot) {
  const conv = await conversations.createPrivate(b.id);
  app.navigate("chat");
  await conversations.select(conv.id);
  hideBotDetail();
}

function editBot(b: Bot) {
  app.openBotEditor(b);
  hideBotDetail();
}
</script>

<template>
  <Teleport to="body">
    <Transition name="bot-pop">
      <div
        v-if="visible && bot"
        ref="panelRef"
        class="fixed z-[110] w-[300px] overflow-hidden rounded-2xl border border-line-strong/60 bg-ink-1/95 p-5 shadow-[0_12px_48px_rgba(0,0,0,0.55)] backdrop-blur"
        :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
        @mouseenter="keepBotDetail"
        @mouseleave="onLeave"
      >
        <!-- 头像 + 名称 + 模型（与好友详情页一致） -->
        <div class="flex items-start gap-3.5">
          <Avatar :name="bot.name" :src="bot.avatar" :size="56" />
          <div class="min-w-0 flex-1 pt-0.5">
            <div class="flex items-center gap-1.5 text-[16px] font-semibold text-hi">
              <span class="truncate">{{ bot.name }}</span>
              <BotAgentBadge :agent-enabled="bot.agent_enabled" :size="14" />
            </div>
            <div class="mt-0.5 truncate text-[12.5px] text-mid">{{ modelName(bot) }}</div>
            <div class="mt-0.5 truncate font-mono text-[10.5px] text-lo">ID: {{ bot.id }}</div>
          </div>
        </div>

        <!-- 人设 -->
        <section class="mt-4">
          <h3 class="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-lo">{{ t("contacts.persona") }}</h3>
          <div class="max-h-36 overflow-y-auto whitespace-pre-wrap rounded-xl border border-line bg-ink-2/60 p-3 leading-relaxed text-[12.5px] text-mid">
            {{ bot.persona || t("contacts.noPersona") }}
          </div>
        </section>

        <!-- 技能 -->
        <section v-if="bot.skills.length" class="mt-3.5">
          <h3 class="mb-1.5 text-[10px] font-medium uppercase tracking-wider text-lo">{{ t("contacts.skills") }}</h3>
          <div class="flex flex-wrap gap-1.5">
            <span
              v-for="skill in bot.skills"
              :key="skill"
              class="rounded-lg border border-line bg-ink-3/80 px-2.5 py-1 text-[11px] text-mid"
            >{{ skill }}</span>
          </div>
        </section>

        <!-- 创建时间 -->
        <section class="mt-3.5">
          <h3 class="mb-1 text-[10px] font-medium uppercase tracking-wider text-lo">{{ t("contacts.createdAt") }}</h3>
          <div class="font-num text-[12px] text-mid">{{ formatDateTime(bot.created_at) }}</div>
        </section>

        <!-- 操作 -->
        <div class="mt-5 flex gap-2.5">
          <button
            class="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-br from-accent to-accent-deep px-3 py-2 text-[13px] font-semibold text-on-accent shadow-[0_4px_18px_rgba(42,227,164,0.28)] transition-all hover:shadow-[0_4px_24px_var(--color-accent-glow)] hover:brightness-110 active:scale-95"
            @click="chatWithBot(bot)"
          >
            <MessageCircle :size="14" /> {{ t("contacts.sendMessage") }}
          </button>
          <button
            class="flex items-center justify-center rounded-xl border border-line-strong/50 px-3 py-2 text-mid transition-colors hover:border-accent/40 hover:bg-ink-3 hover:text-hi"
            :title="t('common.edit')"
            @click="editBot(bot)"
          >
            <Pencil :size="14" />
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.bot-pop-enter-active,
.bot-pop-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.bot-pop-enter-from,
.bot-pop-leave-to {
  opacity: 0;
  transform: translateX(4px);
}
</style>
