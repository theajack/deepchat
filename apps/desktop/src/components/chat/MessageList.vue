<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useConversationsStore } from "../../stores/conversations";
import { useMessagesStore, type StreamSegment } from "../../stores/messages";
import { useBotsStore } from "../../stores/bots";
import { useSelfStore } from "../../stores/self";
import { formatSeparator } from "../../utils/display";
import { t } from "../../i18n";
import MessageBubble, { type BubbleModel } from "./MessageBubble.vue";
import Spinner from "../common/Spinner.vue";
// import ContextMenu, { type ContextMenuState } from "../common/ContextMenu.vue";
// import { t } from "../../i18n";

const TIME_GAP = 5 * 60 * 1000;
/** 距顶部小于此值即触发向上翻页（px） */
const PRELOAD_OFFSET = 120;
/**
 * loading 占位气泡的最长存活时间。
 *
 * 正常流程下占位会在首个 delta 到达时被接管并删除；这个 TTL 只是兜底——
 * 长会话分页会让前端估算的 promptSeq 与服务端错位，占位等不到接管，
 * 没有 TTL 就会一直转圈。
 */
const PLACEHOLDER_TTL_MS = 60_000;

type Row =
  | { type: "time"; key: string; text: string }
  | { type: "msg"; key: string; model: BubbleModel }
  /** 群聊正在决策由哪个成员发言 */
  | { type: "scheduling"; key: string };

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
  // 划到顶部：加载更早的一页历史
  if (el.scrollTop < PRELOAD_OFFSET) void loadOlder();
}

/** 向上翻页：加载更早的 50 条并锚定滚动位置，避免视口跳动 */
async function loadOlder() {
  if (!conv.value) return;
  const convId = conv.value.id;
  if (messages.loadingMore || messages.hasMoreByConv[convId] !== true) return;
  const el = bodyRef.value;
  if (!el) return;
  const prevHeight = el.scrollHeight;
  const prevTop = el.scrollTop;
  const added = await messages.loadMore(convId);
  if (added === 0) return;
  // 等 DOM 更新后按新增高度补偿 scrollTop，保持当前可视内容不动
  await nextTick();
  el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
}

onMounted(() => {
  bodyRef.value?.addEventListener("scroll", onScroll, { passive: true });
});

onBeforeUnmount(() => {
  bodyRef.value?.removeEventListener("scroll", onScroll);
});

// 右键菜单暂时停用：恢复系统默认右键能力（复制 / 选中等）
// const menuState = ref<ContextMenuState | null>(null);

// function onContextMenu(e: MouseEvent, row: Row) {
//   if (row.type !== "msg") return;
//   e.preventDefault();
//   menuState.value = {
//     x: e.clientX,
//     y: e.clientY,
//     groups: [
//       {
//         items: [
//           { key: "test", label: t("menu.test") },
//           { key: "test-disabled", label: t("menu.disabled"), disabled: true },
//         ],
//       },
//       {
//         title: t("menu.more"),
//         items: [
//           { key: "danger", label: t("menu.danger"), danger: true },
//         ],
//       },
//     ],
//   };
// }

// function onMenuSelect(key: string) {
//   // TODO: 根据 key 分发具体操作
//   void key;
// }

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
  // 把持久化消息与流式草稿合并，按 createdAt 统一排序后再渲染。
  // 用户连续发多条消息、模型在两条之间才回复时，草稿需要插在两条消息中间
  // 而不是堆到底部。
  type StreamRow = {
    kind: "stream"
    draftId: string
    conversationId: string
    botId: string
    content: string
    segments: StreamSegment[]
    /** 该草稿对应的 user message 序号（1-based）；渲染按此把草稿紧跟用户消息 */
    promptIndex: number
    createdAt: number
  }
  type PersistedRow = {
    kind: "msg"
    msg: typeof list[number]
  }
  type Source = StreamRow | PersistedRow

  // 草稿按"prompt 序号"配对到对应的 user msg：后端 message.stream 帧携带
  // promptSeq（与 session 内 user message 数严格对应），渲染时把草稿
  // 紧跟到 byConv 里第 promptSeq 个用户消息之后——不再依赖 id 命名空间
  // 匹配（前端占位用 crypto.randomUUID、后端 stream 用 m-p{N}，两侧根本
  // 没共享 id 体系）。
  const draftsByIndex = new Map<number, StreamRow[]>()
  const orphanDrafts: StreamRow[] = []
  for (const draft of Object.values(messages.streams)) {
    if (draft.conversationId !== convId) continue
    // 兜底：loading 占位迟迟等不到真实 delta 来接管（长会话分页会让前端
    // 估算的 promptSeq 与服务端错位），超时的占位直接不渲染，免得永久转圈。
    if (draft.placeholder === true && Date.now() - draft.createdAt > PLACEHOLDER_TTL_MS) continue
    // 优先用后端显式携带的 promptSeq；缺省时回退到 draftId 'm-p{N}' 解析
    let idx: number | undefined = draft.promptSeq
    if (idx === undefined || Number.isNaN(idx)) {
      const m = /^m-p(\d+)$/.exec(draft.draftId)
      if (m !== null) idx = Number(m[1])
    }
    if (idx === undefined || Number.isNaN(idx)) {
      // 历史/群聊等没有标准命名的草稿 → 放最后（不丢）
      orphanDrafts.push({
        kind: "stream",
        draftId: draft.draftId,
        conversationId: draft.conversationId,
        botId: draft.botId,
        content: draft.content,
        segments: draft.segments,
        promptIndex: Number.MAX_SAFE_INTEGER,
        createdAt: draft.createdAt,
      })
      continue
    }
    const row: StreamRow = {
      kind: "stream",
      draftId: draft.draftId,
      conversationId: draft.conversationId,
      botId: draft.botId,
      content: draft.content,
      segments: draft.segments,
      promptIndex: idx,
      createdAt: draft.createdAt,
    }
    const bucket = draftsByIndex.get(idx)
    if (bucket === undefined) draftsByIndex.set(idx, [row])
    else bucket.push(row)
  }

  // 给 byConv 里每条 is_self=1 消息算 prompt 序号（1-based，与后端同步）
  const sources: Source[] = []
  let userIdx = 0
  for (const m of list) {
    sources.push({ kind: "msg", msg: m })
    if (m.is_self === 1) {
      userIdx += 1
      for (const d of draftsByIndex.get(userIdx) ?? []) sources.push(d)
    }
  }
  for (const d of orphanDrafts) sources.push(d)

  // 顺序已由上方构造保证（用户消息 → 它的草稿 → 下一条用户消息 → ...），
  // 无需再排序。保留显式 push 确保 ES2019+ 的稳定顺序在跨分支合并时也成立。
  void sources

  const result: Row[] = []
  let lastRenderedTime: number | null = null
  let lastRenderedSender: string | null = null
  let lastRenderedIsUser: boolean | null = null

  for (const src of sources) {
    const time = src.kind === "msg" ? src.msg.created_at : src.createdAt
    const isUserMsg = src.kind === "msg" ? src.msg.is_self === 1 : false
    const senderId = src.kind === "msg" ? src.msg.sender_id : src.botId
    const samePrev =
      lastRenderedTime !== null
      && time - lastRenderedTime <= TIME_GAP
      && lastRenderedSender === senderId
      && lastRenderedIsUser === isUserMsg
    // 时间分隔：跨超过 5 分钟的相邻消息显示一段对话时间。
    if (lastRenderedTime === null || time - lastRenderedTime > TIME_GAP) {
      result.push({ type: "time", key: `t-${src.kind === "msg" ? src.msg.id : src.draftId}`, text: formatSeparator(time) });
    }
    // AI 输出（不管是不是 stream 也不管相邻是不是同一 bot）始终显示头像：
    // 头像的省略本意是节省纵向，但实际造成气泡对不齐/没头像让人分不清谁在说话。
    // 用户消息按现有规则处理。
    const showAvatar = isUserMsg ? true : true
    const showSender = isUserMsg ? false : !samePrev

    if (src.kind === "msg") {
      const msg = src.msg
      result.push({
        type: "msg",
        key: msg.id,
        model: {
          key: msg.id,
          isSelf: isUserMsg,
          senderName: msg.sender_name,
          avatar: isUserMsg ? null : avatarOf(msg.sender_id),
          selfAvatar: isUserMsg ? selfStore.avatar : null,
          content: msg.content,
          segments: msg.segments,
          time: msg.created_at,
          showAvatar,
          showSender: isUserMsg ? true : showSender,
          animate: false,
          promptTokens: msg.prompt_tokens ?? 0,
          completionTokens: msg.completion_tokens ?? 0,
          durationMs: msg.duration_ms ?? 0,
          cachedTokens: msg.cached_tokens ?? 0,
          aborted: msg.stop_reason === "aborted",
          conversationId: msg.conversation_id,
          botId: msg.is_self === 1 ? undefined : msg.sender_id,
          attachments: msg.attachments,
        },
      })
    } else {
      const draft = src
      const bot = bots.items.find((b) => b.id === draft.botId)
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
          showSender: !samePrev,
          streaming: true,
          conversationId: draft.conversationId,
          botId: draft.botId,
        },
      })
    }
    lastRenderedTime = time
    lastRenderedSender = senderId
    lastRenderedIsUser = isUserMsg
  }

  // typing 指示（无流式草稿时）
  const typingEntries = Object.entries(messages.typing).filter(([key]) => key.startsWith(`${convId}:`));
  const typingNames = typingEntries.map(([, name]) => name);
  const hasStream = Object.values(messages.streams).some((s) => s.conversationId === convId);
  if (typingNames.length > 0 && !hasStream) {
    const isGroup = conv.value?.type === "group";
    const typingBotId = typingEntries[0][0].split(":").pop() ?? "";
    const typingAvatar = bots.items.find((b) => b.id === typingBotId)?.avatar ?? null;
    result.push({ type: "msg", key: "typing", model: { key: "typing", isSelf: false, senderName: typingNames[0], avatar: typingAvatar, content: "", time: null, showAvatar: true, showSender: isGroup, streaming: true } });
  }

  // 群聊决策中：还没有任何成员开口前，显示"成员正在思考"
  if (messages.scheduling[convId]) {
    result.push({ type: "scheduling", key: "scheduling" });
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
// 搜索定位：搜索弹窗点击「定位」后，滚动到指定消息
watch(
  () => messages.locate,
  (loc) => {
    if (!loc || loc.conversationId !== conv.value?.id) return;
    nextTick(() => {
      const el = bodyRef.value?.querySelector<HTMLElement>(`[data-msg-id="${loc.messageId}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  },
);
</script>

<template>
  <div ref="bodyRef" class="overscroll-contain flex flex-1 flex-col overflow-y-auto py-2.5 pb-5">
    <!-- 向上翻页：加载更早的 50 条历史 -->
    <div v-if="messages.loadingMore" class="flex items-center justify-center gap-2 py-2 text-[11px] text-lo">
      <Spinner :size="13" class="text-accent" /> {{ t("common.loading") }}
    </div>
    <div v-else-if="conv && messages.hasMoreByConv[conv.id]" class="py-2 text-center text-[11px] text-lo/70">
      {{ t("chat.scrollUpForMore") }}
    </div>

    <!-- 清空会话后的记忆总结：顶部居中灰色小字 loading，结束后消失 -->
    <div
      v-if="conv && messages.consolidating[conv.id]"
      class="sticky top-0 z-10 flex items-center justify-center gap-2 bg-ink-1/80 py-2 text-[11px] text-lo/60 backdrop-blur-sm"
    >
      <Spinner :size="12" class="text-lo/40" />
      <span>{{ t("chat.summarizing") }}</span>
    </div>

    <template v-for="row in rows" :key="row.key">
      <div v-if="row.type === 'time'" class="my-2 flex items-center justify-center gap-3">
        <span class="h-px w-10 bg-gradient-to-r from-transparent to-line-strong" />
        <span class="font-num text-[10px] tracking-widest text-lo">{{ row.text }}</span>
        <span class="h-px w-10 bg-gradient-to-l from-transparent to-line-strong" />
      </div>
      <!-- 群聊决策中：居中浅色提示 -->
      <div
        v-else-if="row.type === 'scheduling'"
        class="flex items-center justify-center gap-2 py-3 text-[11px] text-lo/60"
      >
        <Spinner :size="12" class="text-lo/50" />
        <span>{{ t("chat.groupScheduling") }}</span>
      </div>
      <MessageBubble
        v-else-if="row.type === 'msg'"
        :item="row.model"
        :is-group="conv?.type === 'group'"
        class="my-1"
      />
    </template>

    <!-- <ContextMenu :state="menuState" @close="menuState = null" @select="onMenuSelect" /> -->
  </div>
</template>
