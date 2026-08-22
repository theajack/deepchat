<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Brain, Check, ChevronDown, ChevronRight, Copy } from "lucide-vue-next";
import Avatar from "../common/Avatar.vue";
import HoverTip from "../common/HoverTip.vue";
import ToolCallCard from "./ToolCallCard.vue";
import ContextRing from "../common/ContextRing.vue";
import { showBotDetail, hideBotDetail } from "../../utils/botDetailHover";
import { useMessagesStore } from "../../stores/messages";
import { useBotsStore } from "../../stores/bots";
import { useModelsStore } from "../../stores/models";
import { formatTime } from "../../utils/display";
import { renderMarkdown, renderMarkdownStreamed } from "../../utils/markdown";
import { openUrl } from "../../utils/browser";
import { useAutoScroll } from "../../utils/useAutoScroll";
import { getModelContextDefaults, parseContextTokens } from "../../data/modelContextDefaults";
import { t } from "../../i18n";
import type { StreamSegment, ToolCall } from "../../stores/messages";

export interface BubbleModel {
  key: string;
  isSelf: boolean;
  senderName: string;
  /** 发送者头像 url（私聊/群聊成员） */
  avatar?: string | null;
  /** 自己发送消息时的头像 url */
  selfAvatar?: string | null;
  content: string;
  time: number | null;
  showAvatar: boolean;
  showSender: boolean;
  animate?: boolean;
  streaming?: boolean;
  /** 有序段落（思维链与正文交替），仅流式草稿使用 */
  segments?: StreamSegment[];
  /** 所属会话（用于中止生成） */
  conversationId?: string;
  /** 发送 bot（用于中止生成） */
  botId?: string;
  /** 输入 token 数（0 表示未知） */
  promptTokens?: number;
  /** 输出 token 数（0 表示未知） */
  completionTokens?: number;
  /** 输出总时长（毫秒） */
  durationMs?: number;
  /** 缓存命中 token 数（0 表示未知/无缓存） */
  cachedTokens?: number;
  /** 用户主动终止（显示"已终止"标记） */
  aborted?: boolean;
}

const props = defineProps<{ item: BubbleModel; isGroup: boolean }>();
const messages = useMessagesStore();
const bots = useBotsStore();
const models = useModelsStore();

/** AI 消息头像 hover：显示好友详情浮层（全局单例，群聊/私聊均支持） */
function onAvatarEnter(e: MouseEvent) {
  if (props.item.isSelf || !props.item.botId || senderBotDeleted.value) return;
  showBotDetail(props.item.botId, e.currentTarget as HTMLElement);
}
function onAvatarLeave() {
  hideBotDetail();
}

/** 消息发送者对应的好友是否已删除（头像灰滤镜、不可弹详情） */
const senderBotDeleted = computed(() => {
  if (props.item.isSelf || !props.item.botId) return false;
  return !bots.items.some((b) => b.id === props.item.botId);
});

const bubbleClass = computed(() => {
  if (props.item.isSelf) {
    return "bg-gradient-to-br from-accent-deep to-accent-deep/85 text-on-accent shadow-[0_4px_20px_rgba(42,227,164,0.22)]";
  }
  return "border border-line bg-ink-4/80 text-hi backdrop-blur-sm";
});

const radiusClass = computed(() =>
  props.item.isSelf ? "rounded-[14px_4px_14px_14px]" : "rounded-[4px_14px_14px_14px]",
);

const toolCalls = computed(() => messages.getToolCalls(props.item.key));

/** 原始文本内容 */
const rawContent = computed(() => {
  if (props.item.isSelf) return props.item.content;
  if (props.item.streaming) return props.item.content;
  return props.item.content.replace(/^\s+|\s+$/g, "");
});

/** 统一时间线：思维链 / 正文 / 工具调用 按模型输出原始顺序排列 */
interface TimelineItem {
  kind: "reasoning" | "text" | "tool";
  html?: string;
  durationMs?: number;
  isLastText?: boolean;
  /** 流式中该段是否仍在活跃输出（用于自动展开/折叠） */
  isActive?: boolean;
  toolCall?: ToolCall;
  /** timeline 索引（用于 expandedReasoning 的 key） */
  index?: number;
}

/** 最后一个 text 段在 timeline 中的索引（用于流式光标） */
const lastTextIndex = computed(() => {
  const segs = effectiveSegments.value;
  if (!segs) return -1;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i].type === "text") return i;
  }
  return -1;
});

/** 权威 segments：流式时用 props.item.segments，非流式时从 store 缓存取 */
const effectiveSegments = computed<StreamSegment[]>(() => {
  if (props.item.streaming) return props.item.segments ?? [];
  // 非流式：优先用 props 传入的 segments，否则从 store 取
  return props.item.segments ?? messages.getSegments(props.item.key);
});

/** 流式光标是否应作为独立元素追加到气泡末尾。
 *  当最后一个 segment 不是 text（而是 tool 或 reasoning）时，
 *  原有的 caret（绑定在 lastTextIndex）会停在中间位置，
 *  此时需要额外在气泡底部追加一个独立光标。 */
const trailingCaret = computed(() => {
  if (!props.item.streaming) return false;
  const segs = effectiveSegments.value;
  if (segs.length === 0) return false;
  return segs[segs.length - 1].type !== "text";
});

/** 统一时间线：按 segments 顺序，tool 段关联 toolCalls 详情 */
const timeline = computed<TimelineItem[]>(() => {
  const segs = effectiveSegments.value;
  const tcs = toolCalls.value;
  if (props.item.isSelf) return [];
  const renderer = props.item.streaming ? renderMarkdownStreamed : renderMarkdown;
  const items: TimelineItem[] = [];
  const seenToolIds = new Set<string>();

  if (segs.length > 0) {
    segs.forEach((seg, i) => {
      if (seg.type === "tool") {
        const tc = tcs.find((t) => t.id === seg.toolId);
        if (tc) {
          seenToolIds.add(tc.id);
          // 工具卡片 isActive：流式中且该工具 status === "running"
          items.push({ kind: "tool", toolCall: tc, isActive: props.item.streaming && tc.status === "running", index: i });
        }
      } else if (seg.type === "reasoning") {
        // reasoning 活跃：流式中且这是最后一个 segment
        const isActive = props.item.streaming && i === segs.length - 1;
        items.push({ kind: "reasoning", html: renderer(seg.content), durationMs: seg.durationMs, isActive, index: i });
      } else {
        items.push({ kind: "text", html: renderer(seg.content), isLastText: i === lastTextIndex.value, index: i });
      }
    });
  }

  // 兼容旧数据：segments 中无 tool 段的孤儿 toolCall（历史持久化前），追加到时间线末尾
  for (const tc of tcs) {
    if (!seenToolIds.has(tc.id)) items.push({ kind: "tool", toolCall: tc, index: items.length });
  }

  return items;
});

/** 已展开的思考段索引集合（timeline 索引） */
const expandedReasoning = ref<Set<number>>(new Set());

/** 流式时自动管理思考段展开/折叠：
 *  - 最后一个段是 reasoning 且正在流式 → 自动展开
 *  - reasoning 段已结束（后续有 text/tool） → 自动折叠 */
watch(
  () => timeline.value,
  (items) => {
    for (const item of items) {
      if (item.kind === "reasoning" && item.index !== undefined) {
        if (item.isActive) {
          // 活跃思考段：自动展开
          if (!expandedReasoning.value.has(item.index)) {
            const next = new Set(expandedReasoning.value);
            next.add(item.index);
            expandedReasoning.value = next;
          }
        } else if (props.item.streaming) {
          // 已结束的思考段（后续有内容）：自动折叠
          if (expandedReasoning.value.has(item.index)) {
            const next = new Set(expandedReasoning.value);
            next.delete(item.index);
            expandedReasoning.value = next;
          }
        }
      }
    }
  },
  { deep: true },
);

function toggleReasoning(i: number) {
  const next = new Set(expandedReasoning.value);
  if (next.has(i)) next.delete(i);
  else next.add(i);
  expandedReasoning.value = next;
}

/** 思考耗时展示文案："Xs"（秒），流式中未结算则显示"…" */
function reasoningDuration(item: TimelineItem): string {
  if (item.durationMs && item.durationMs > 0) {
    return `${(item.durationMs / 1000).toFixed(1)}s`;
  }
  return props.item.streaming ? "…" : "<1s";
}

/** 非流式消息的 Markdown HTML */
const mdHtml = computed(() => {
  if (props.item.isSelf || !rawContent.value) return null;
  if (props.item.streaming) return null; // 流式走 segments
  if (effectiveSegments.value.length > 0) return null; // 有 segments 时也走 timeline
  return renderMarkdown(rawContent.value);
});

/** 思维链滚动容器 ref 数组（v-for 内 ref） */
const reasoningRefs = ref<HTMLElement[]>([]);
/** 每个 reasoning 块的 autoScroll 实例（key = DOM element） */
const reasoningScrollers = new WeakMap<HTMLElement, ReturnType<typeof useAutoScroll>>();

/** 获取或创建某个 reasoning 块的 autoScroll 实例 */
function reasoningScrollerFor(el: HTMLElement | null) {
  if (!el) return null;
  let scroller = reasoningScrollers.get(el);
  if (!scroller) {
    const elRef = ref<HTMLElement | null>(el);
    scroller = useAutoScroll(elRef);
    reasoningScrollers.set(el, scroller);
  }
  return scroller;
}

/** reasoning 块 scroll 事件 */
function onReasoningScroll(e: Event) {
  const el = e.target as HTMLElement;
  const scroller = reasoningScrollerFor(el);
  if (scroller) scroller.onScroll();
}

watch(
  () => effectiveSegments.value,
  () => {
    if (!props.item.streaming) return;
    nextTick(() => {
      for (const el of reasoningRefs.value) {
        const scroller = reasoningScrollerFor(el);
        if (scroller) scroller.maybeScrollToBottom();
      }
    });
  },
  { deep: true },
);

/** 拦截 Markdown 渲染区域内的链接点击，使用全局浏览器设置打开 */
function onMdClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  const anchor = target.closest("a");
  if (!anchor) return;
  const href = anchor.getAttribute("href");
  if (!href) return;
  if (/^https?:\/\//i.test(href)) {
    e.preventDefault();
    e.stopPropagation();
    openUrl(href);
  }
}

/** 复制内容（带回退：优先 clipboard API） */
const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;
async function onCopy() {
  const text = rawContent.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* ignore */
    }
    document.body.removeChild(ta);
  }
  copied.value = true;
  if (copyTimer) clearTimeout(copyTimer);
  copyTimer = setTimeout(() => (copied.value = false), 1500);
}

/** token 数缩写：1000 → 1k */
function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/** 时长格式化：毫秒 → "3.2s" / "<1s" */
function formatDuration(ms: number): string {
  if (ms <= 0) return "";
  if (ms < 1000) return "<1s";
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
}

/** 缓存命中率（0~100），无缓存数据时返回 null */
const cacheHitRate = computed(() => {
  const p = props.item.promptTokens ?? 0;
  const cached = props.item.cachedTokens ?? 0;
  if (!p || !cached) return null;
  return Math.round((cached / p) * 100);
});

/** AI 是否已输出内容（正文/思维链/工具调用任一），控制底部操作按钮组显示 */
const hasOutput = computed(() => Boolean(rawContent.value || timeline.value.length));

/** 群聊：该 AI 成员模型的上下文占用（圆环显示在 token 统计后，成员各自模型不同） */
const ctxUsage = computed(() => {
  if (!props.isGroup || props.item.isSelf || !props.item.botId) return null;
  const bot = bots.items.find((b) => b.id === props.item.botId);
  if (!bot) return null;
  const model = bot.model_id ? models.items.find((m) => m.id === bot.model_id) : null;
  const modelName = model?.model_name ?? "";
  const ctxStr = model?.input_ctx || getModelContextDefaults(modelName)?.inputCtx || "";
  const total = parseContextTokens(ctxStr);
  if (!total) return null;
  // 占用：本条消息的 prompt+completion（该次请求携带的上下文）；
  // 流式中的消息尚无 usage，回退取同会话同 bot 最近一条已结算消息
  let used = (props.item.promptTokens ?? 0) + (props.item.completionTokens ?? 0);
  if (used <= 0) {
    const list = props.item.conversationId ? messages.byConv[props.item.conversationId] ?? [] : [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.sender_type === "ai_bot" && m.sender_id === props.item.botId) {
        used = (m.prompt_tokens ?? 0) + (m.completion_tokens ?? 0);
        if (used > 0) break;
      }
    }
  }
  return { used, total, modelName };
});

/** 输出结束后是否展开思考/工具详情（默认收起，仅显示概要行） */
const showDetails = ref(false);

/** 是否显示时间线中的 thinking / tool 段：流式时始终显示，结束后由按钮控制 */
const detailsShown = computed(() => props.item.streaming || showDetails.value);

/** 完成后的概要信息：思考 n 次(总时长) + 执行工具 n 次；无思考/工具时为 null */
const collapseSummary = computed(() => {
  if (props.item.isSelf || props.item.streaming) return null;
  const items = timeline.value;
  const reasoning = items.filter((x) => x.kind === "reasoning");
  const tools = items.filter((x) => x.kind === "tool");
  if (reasoning.length === 0 && tools.length === 0) return null;
  const ms = reasoning.reduce((sum, x) => sum + (x.durationMs ?? 0), 0);
  const dur = formatDuration(ms);
  return {
    reasoningCount: reasoning.length,
    reasoningDur: dur ? `(${dur})` : "",
    toolCount: tools.length,
  };
});

/** 统计信息文本：终止时显示"已终止 · 时长"；正常时显示输入/输出 token + 时长 + 缓存命中率 */
const usageText = computed(() => {
  if (props.item.isSelf || props.item.streaming) return "";
  const d = props.item.durationMs ?? 0;
  const dur = formatDuration(d);
  const p = props.item.promptTokens ?? 0;
  const c = props.item.completionTokens ?? 0;
  if (props.item.aborted) {
    // 终止：本次请求的 usage 拿不到，但多轮 agent 前几轮已结算的 token 仍可展示
    const parts: string[] = [];
    if (p || c) {
      parts.push(`↑ ${formatTokens(p)}`);
      parts.push(`↓ ${formatTokens(c)}`);
    }
    parts.push(t("msg.aborted"));
    if (dur) parts.push(dur);
    return parts.join(" · ");
  }
  const cache = cacheHitRate.value;
  if (!p && !c && !d && cache == null) return "";
  const parts: string[] = [];
  parts.push(`↑ ${formatTokens(p)}`);
  parts.push(`↓ ${formatTokens(c)}`);
  if (dur) parts.push(dur);
  if (cache != null) parts.push(t("chat.cacheHit", { rate: cache }));
  return parts.join(" · ");
});
</script>

<template>
  <div
    class="group flex items-start gap-0 px-5 py-0.5"
    :class="[item.isSelf ? 'flex-row-reverse' : 'flex-row mb-3', { 'msg-in': item.animate }]"
  >
    <!-- 已删除好友：灰显头像 + hover 提示「好友已删除」 -->
    <HoverTip
      v-if="!item.isSelf && item.showAvatar && senderBotDeleted"
      :content="t('chat.botDeleted')"
      placement="top"
      class="mr-2"
    >
      <Avatar :name="item.senderName" :src="item.avatar" :size="30" class="grayscale opacity-50" />
    </HoverTip>
    <Avatar
      v-else-if="!item.isSelf && item.showAvatar"
      :name="item.senderName"
      :src="item.avatar"
      :size="30"
      class="mr-2"
      :class="item.botId ? 'cursor-pointer transition-transform hover:scale-105' : ''"
      @mouseenter="onAvatarEnter"
      @mouseleave="onAvatarLeave"
    />
    <Avatar v-else-if="item.isSelf && item.showAvatar" :name="t('group.self')" :src="item.selfAvatar" :size="30" class="ml-2" />
    <div v-else class="w-7.5 shrink-0" />
    <div class="relative max-w-[68%]" :class="item.isSelf ? 'flex flex-col items-end' : ''">
      <div v-if="isGroup && !item.isSelf && item.showSender" class="mb-1 text-[11px] text-lo">
        {{ item.senderName }}
      </div>
      <!-- 操作按钮组：移至气泡底部（见下方统计行），仅 AI 输出内容时显示 -->
      <div
        class="min-h-[30px] px-3.5 py-2.5 text-[13px] leading-relaxed break-words"
        :class="[radiusClass, bubbleClass, (rawContent || timeline.length) ? 'block' : 'flex items-center']"
      >
        <!-- 统一时间线：工具调用 / 思维链 / 正文 按模型输出原始顺序排列 -->
        <template v-if="timeline.length">
          <!-- 输出结束后的概要行：隐藏全部思考/工具调用，仅显示统计与详情切换 -->
          <div
            v-if="collapseSummary"
            class="mb-2 flex items-center gap-2 border-b border-line/60 pb-1.5 text-[11px] text-lo"
          >
            <Brain :size="12" class="shrink-0" />
            <span class="font-num whitespace-nowrap">
              <template v-if="collapseSummary.reasoningCount">
                {{ t("chat.summaryThinking", { n: collapseSummary.reasoningCount }) }}{{ collapseSummary.reasoningDur }}
              </template>
              <template v-if="collapseSummary.reasoningCount && collapseSummary.toolCount"> · </template>
              <template v-if="collapseSummary.toolCount">
                {{ t("chat.summaryTools", { n: collapseSummary.toolCount }) }}
              </template>
            </span>
            <button
              type="button"
              class="ml-auto flex shrink-0 cursor-pointer items-center gap-0.5 text-[11px] text-lo transition-colors hover:text-hi"
              @click="showDetails = !showDetails"
            >
              {{ showDetails ? t("chat.detailHide") : t("chat.detailShow") }}
              <ChevronDown v-if="showDetails" :size="12" />
              <ChevronRight v-else :size="12" />
            </button>
          </div>
          <template v-for="(item, i) in timeline" :key="i">
            <!-- 工具调用：执行期间自动展开，完成后随详情开关显示 -->
            <ToolCallCard
              v-if="item.kind === 'tool' && item.toolCall && detailsShown"
              :key="item.toolCall.id"
              :name="item.toolCall.name"
              :args="item.toolCall.args"
              :args-str="item.toolCall.argsStr"
              :status="item.toolCall.status"
              :result="item.toolCall.result"
              :duration-ms="item.toolCall.durationMs"
              :expandable="true"
              :auto-expand="item.isActive"
            />
            <!-- 思维链：流式中自动展开，结束后随详情开关显示 -->
            <div
              v-else-if="item.kind === 'reasoning' && detailsShown"
              class="reasoning-block min-w-0"
            >
              <button
                class="flex w-full cursor-pointer items-center gap-1 text-[12px] text-lo transition-colors hover:text-hi"
                type="button"
                @click="toggleReasoning(i)"
              >
                <ChevronRight v-if="!expandedReasoning.has(i)" :size="13" class="shrink-0" />
                <ChevronDown v-else :size="13" class="shrink-0" />
                <span class="shrink-0">{{ t("chat.thinking") }}</span>
                <span class="font-num shrink-0 text-[11px]">{{ reasoningDuration(item) }}</span>
              </button>
              <!-- 展开的思考内容 -->
              <div
                v-if="expandedReasoning.has(i)"
                ref="reasoningRefs"
                class="bubble-md mt-1.5 min-w-0"
                @scroll="onReasoningScroll"
              >
                <div v-html="item.html" class="min-w-0" />
              </div>
            </div>
            <!-- 正文 -->
            <div
              v-else-if="item.kind === 'text'"
              class="bubble-md w-full min-w-0"
              :class="{ caret: item.isLastText && props.item.streaming && !trailingCaret }"
            >
              <div v-html="item.html" class="min-w-0" @click="onMdClick" />
            </div>
          </template>
        </template>

        <!-- 流式尾部光标：最后一个段是工具调用或思考时，光标停在中间文本末尾，
             需额外在气泡底部追加独立光标，确保始终贴底显示 -->
        <span v-if="trailingCaret" class="caret inline-block" />

        <!-- 非流式 AI 回复（无 segments）：Markdown 渲染 -->
        <div
          v-else-if="mdHtml"
          class="bubble-md w-full min-w-0"
        >
          <div v-html="mdHtml" class="min-w-0" @click="onMdClick" />
        </div>

        <!-- 自己发送的消息：纯文本 -->
        <pre v-else-if="item.isSelf && rawContent" class="m-0 overflow-hidden bg-transparent p-0 font-sans whitespace-pre-wrap break-words">{{ rawContent }}</pre>

        <!-- loading：无内容且无段落（无工具调用） -->
        <template v-if="!item.isSelf && item.streaming && !rawContent && !timeline.length">
          <span class="flex items-center gap-0.5">
            <span v-for="i in 3" :key="i" class="typing-dot h-1 w-1 rounded-full bg-accent" :style="{ animationDelay: `${i * 0.15}s` }" />
          </span>
        </template>

      </div>

      <!-- 底部操作与统计行：复制按钮 + token 消耗信息（按钮在前），absolute 悬浮于气泡下方，
           仅 AI 输出内容时显示，流式时常显，结束后 hover 显示 -->
      <div
        v-if="!item.isSelf && hasOutput"
        class="absolute -bottom-5 left-1 z-10 flex items-center gap-1.5 transition-opacity duration-150"
        :class="item.streaming ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto'"
      >
        <button
          class="cursor-pointer rounded p-0.5 text-lo transition-colors hover:bg-ink-3 hover:text-hi"
          :title="copied ? t('msg.copied') : t('msg.copy')"
          @click="onCopy"
        >
          <Check v-if="copied" class="h-3 w-3 text-accent" />
          <Copy v-else class="h-3 w-3" />
        </button>
        <span
          v-if="usageText"
          class="font-num text-[10px] text-lo whitespace-nowrap"
          :title="item.aborted ? t('msg.aborted') : `↑ ${item.promptTokens ?? 0} tokens · ↓ ${item.completionTokens ?? 0} tokens · ${formatDuration(item.durationMs ?? 0) || '—'}`"
        >
          {{ usageText }}
        </span>
        <!-- 群聊：该成员模型上下文占用圆环（各成员模型/加入时间不同） -->
        <ContextRing
          v-if="ctxUsage"
          :used="ctxUsage.used"
          :total="ctxUsage.total"
          :model-name="ctxUsage.modelName"
          :size="13"
        />
      </div>
    </div>
    <span v-if="item.time" class="font-num shrink-0 text-[10px] text-lo" :class="item.isSelf ? 'mr-1.5' : 'ml-1.5'">{{ formatTime(item.time) }}</span>
  </div>
</template>
