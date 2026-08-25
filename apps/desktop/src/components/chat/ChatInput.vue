<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { FileText, X } from "lucide-vue-next";
import { useAppStore } from "../../stores/app";
import { useBotsStore } from "../../stores/bots";
import { useConversationsStore } from "../../stores/conversations";
import { useMessagesStore } from "../../stores/messages";
import { useModelsStore } from "../../stores/models";
import { agentApi } from "../../services/agentApi";
import { chatApi } from "../../services/chatApi";
import ChatInputToolbar from "./ChatInputToolbar.vue";
import EmojiPicker from "./EmojiPicker.vue";
import ConversationSearchModal from "./ConversationSearchModal.vue";
import Avatar from "../common/Avatar.vue";
import BotAgentBadge from "../contacts/BotAgentBadge.vue";
import type { Bot } from "../../types";
import { t } from "../../i18n";

const app = useAppStore();
const conversations = useConversationsStore();
const messages = useMessagesStore();
const models = useModelsStore();
const bots = useBotsStore();

const draft = ref("");
const boxRef = ref<HTMLTextAreaElement | null>(null);
const footerRef = ref<HTMLElement | null>(null);
const sending = ref(false);
// 表情选择面板开关
const emojiOpen = ref(false);
// 搜索聊天记录弹窗开关
const searchOpen = ref(false);
// 中文输入法组合状态：组合中不响应回车发送
const composing = ref(false);

// ── 附件草稿（图片 / 文件）──────────────────────────────────────────────
interface DraftAttachment {
  id: string;
  kind: "image" | "file";
  name: string;
  mediaType: string;
  size: number;
  /** 本地预览/下载 data URL（图片直接展示，文件用于下载） */
  dataUrl: string;
  /** 图片：纯 base64（不含 data: 前缀），发送给后端走 image 附件 */
  base64: string;
  /** 文本类文件：读取的文本内容，发送时作为文本块附加 */
  textContent?: string;
}
const attachments = ref<DraftAttachment[]>([]);
const imageInputRef = ref<HTMLInputElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);
const MAX_ATTACH_SIZE = 10 * 1024 * 1024;

/** 纯文本类文件扩展名（读取内容作为文本块发送） */
const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "json", "js", "ts", "jsx", "tsx", "mjs", "cjs",
  "py", "java", "go", "rs", "c", "h", "cpp", "hpp", "cs", "rb", "php", "swift",
  "kt", "sh", "bash", "yml", "yaml", "toml", "xml", "html", "css", "scss", "less",
  "vue", "sql", "csv", "log", "ini", "conf", "properties", "gradle", "cmake",
  "makefile", "dockerfile", "gitignore", "env",
]);
function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}
function isImageType(mediaType: string): boolean {
  return mediaType.startsWith("image/");
}
function isTextFile(file: File): boolean {
  if (file.type && (file.type.startsWith("text/") || file.type === "application/json" || file.type.endsWith("xml"))) return true;
  return TEXT_EXTS.has(extOf(file.name));
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") return reject(new Error("read failed"));
      // 去掉 data:<mime>;base64, 前缀，仅保留纯 base64
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function addImageFile(file: File) {
  if (file.size > MAX_ATTACH_SIZE) {
    app.toast(t("attach.tooLarge"));
    return;
  }
  const base64 = await readAsBase64(file);
  const mediaType = file.type || "image/png";
  attachments.value = [
    ...attachments.value,
    { id: crypto.randomUUID(), kind: "image", name: file.name, mediaType, size: file.size, dataUrl: `data:${mediaType};base64,${base64}`, base64 },
  ];
}

async function addFile(file: File) {
  if (file.size > MAX_ATTACH_SIZE) {
    app.toast(t("attach.tooLarge"));
    return;
  }
  if (isImageType(file.type)) return addImageFile(file);
  if (!isTextFile(file)) {
    app.toast(t("attach.unsupported"));
    return;
  }
  const base64 = await readAsBase64(file);
  const mediaType = file.type || "text/plain";
  const textContent = await file.text();
  attachments.value = [
    ...attachments.value,
    { id: crypto.randomUUID(), kind: "file", name: file.name, mediaType, size: file.size, dataUrl: `data:${mediaType};base64,${base64}`, base64, textContent },
  ];
}

function onPickImages(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  void Promise.all(files.map(addImageFile));
}

function onPickFiles(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  void Promise.all(files.map(addFile));
}

function removeAttachment(id: string) {
  attachments.value = attachments.value.filter((a) => a.id !== id);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// footer 总高度（px），默认 165（按钮组 + 输入框 + padding），可通过上边框拖拽调整
const footerHeight = ref(165);
const MIN_HEIGHT = 96;
const MAX_HEIGHT = 300;
let dragging = false;

function onResizeStart(e: MouseEvent) {
  dragging = true;
  e.preventDefault();
  document.addEventListener("mousemove", onResizeMove);
  document.addEventListener("mouseup", onResizeEnd);
  document.body.style.cursor = "ns-resize";
  document.body.style.userSelect = "none";
}

function onResizeMove(e: MouseEvent) {
  if (!dragging || !footerRef.value) return;
  // footer 底边到鼠标的距离 = 新的 footer 总高度（从底部向上拖，鼠标即 footer 上边框位置）
  const rect = footerRef.value.getBoundingClientRect();
  const newHeight = rect.bottom - e.clientY;
  footerHeight.value = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, newHeight));
}

function onResizeEnd() {
  dragging = false;
  document.removeEventListener("mousemove", onResizeMove);
  document.removeEventListener("mouseup", onResizeEnd);
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

// @ 提及面板状态
const mentionOpen = ref(false);
const mentionQuery = ref("");
const mentionStart = ref(0);
const activeIndex = ref(0);
const listRef = ref<HTMLElement | null>(null);

const conv = computed(() => conversations.active);

/** 私聊好友已删除（bots 中找不到该 id 好友）→ 禁止输入 */
const botDeleted = computed(() => {
  const c = conv.value;
  if (!c || c.type !== "private") return false;
  const botId = c.id.startsWith("private:") ? c.id.slice("private:".length) : "";
  return !bots.items.some((b) => b.id === botId);
});

const placeholder = computed(() => {
  if (botDeleted.value) return t("chat.botDeleted");
  return conv.value?.type === "group" ? t("chat.input.placeholder.group") : t("chat.input.placeholder");
});

// 当前群聊成员（实时反映成员变动）
const members = computed<Bot[]>(() => {
  const id = conversations.activeId;
  return id ? (conversations.membersMap[id] ?? []) : [];
});
const mentionMembers = computed(() =>
  members.value.filter((m) => m.name.toLowerCase().includes(mentionQuery.value.toLowerCase())),
);

function modelName(bot: Bot): string {
  const m = bot.model_id ? models.items.find((x) => x.id === bot.model_id) : undefined;
  return m?.name ?? t("chat.noModel");
}



// 进入群聊时加载成员，确保实时反映增删
watch(
  () => conversations.activeId,
  (id) => {
    closeMention();
    const c = conversations.active;
    if (id && c && c.type === "group") void conversations.loadMembers(id);
  },
  { immediate: true },
);

// 键盘切换高亮项时滚动到可见
watch(activeIndex, () => {
  nextTick(() => {
    const el = listRef.value?.querySelector<HTMLElement>(`[data-index="${activeIndex.value}"]`);
    el?.scrollIntoView({ block: "nearest" });
  });
});

function detectMention() {
  const el = boxRef.value;
  if (!el || !conv.value || conv.value.type !== "group") return closeMention();
  const caret = el.selectionStart ?? el.value.length;
  const before = el.value.slice(0, caret);
  const m = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (m) {
    mentionStart.value = caret - m[0].length + m[0].lastIndexOf("@");
    mentionQuery.value = m[1];
    activeIndex.value = 0;
    mentionOpen.value = true;
  } else {
    closeMention();
  }
}

function onInput() {
  detectMention();
}

/** 当前 AI 好友（Agent）的工作目录：workspace/agents/{botId} */
async function resolveBotWorkspaceDir(): Promise<string | null> {
  const conv = conversations.active;
  if (!conv || conv.type !== "private") return null;
  const botId = conv.id.startsWith("private:") ? conv.id.slice("private:".length) : "";
  const bot = bots.items.find((b) => b.id === botId);
  if (!bot) return null;
  if (bot.workspace_dir) return bot.workspace_dir;
  // 默认：~/chat-agent-workspace/agents/{botId}
  try {
    const base = await chatApi.getDefaultWorkspaceDir();
    return `${base}/agents/${bot.id}`;
  } catch {
    return null;
  }
}

/** 按钮组动作分发 */
async function onToolbarAction(key: string) {
  if (key === "emoji") {
    emojiOpen.value = !emojiOpen.value;
    return;
  }
  if (key === "image") {
    imageInputRef.value?.click();
    return;
  }
  if (key === "file") {
    fileInputRef.value?.click();
    return;
  }
  if (key === "search") {
    searchOpen.value = true;
    return;
  }
  if (key === "workspace") {
    const dir = await resolveBotWorkspaceDir();
    if (!dir) {
      app.toast(t("toolbar.workspaceNotFound"));
      return;
    }
    try {
      await agentApi.toolOpenDir(dir);
    } catch {
      app.toast(t("toolbar.workspaceOpenFailed"));
    }
  }
}

/** 将表情插入到光标处（不关闭面板，允许连续选择） */
function insertEmoji(native: string) {
  const el = boxRef.value;
  const start = el?.selectionStart ?? draft.value.length;
  const end = el?.selectionEnd ?? draft.value.length;
  draft.value = draft.value.slice(0, start) + native + draft.value.slice(end);
  nextTick(() => {
    if (!el) return;
    el.focus();
    const pos = start + native.length;
    el.selectionStart = el.selectionEnd = pos;
  });
}

function closeMention() {
  mentionOpen.value = false;
  mentionQuery.value = "";
  activeIndex.value = 0;
}

function moveActive(dir: number) {
  const len = mentionMembers.value.length;
  if (!len) return;
  // 跳过已删除成员（灰显不可选）
  let next = activeIndex.value;
  for (let step = 0; step < len; step++) {
    next = (next + dir + len) % len;
    if (!mentionMembers.value[next].deleted) break;
  }
  activeIndex.value = next;
}

function applyMention(member: Bot) {
  if (member.deleted) return;
  const el = boxRef.value;
  const text = el ? el.value : draft.value;
  const caret = el?.selectionStart ?? text.length;
  const before = text.slice(0, mentionStart.value);
  const after = text.slice(caret);
  const insert = `@${member.name} `;
  draft.value = before + insert + after;
  mentionOpen.value = false;
  nextTick(() => {
    const pos = (before + insert).length;
    if (el) {
      el.focus();
      el.selectionStart = el.selectionEnd = pos;
    }
  });
}

async function send() {
  const text = draft.value.trim();
  const hasAttach = attachments.value.length > 0;
  if ((!text && !hasAttach) || !conv.value || sending.value) return;

  // 文本类文件：内容拼接到正文（markdown 代码块包裹）
  let content = text;
  for (const att of attachments.value) {
    if (att.kind === "file" && att.textContent) {
      content += (content ? "\n\n" : "") + `[文件 ${att.name}]\n\`\`\`\n${att.textContent}\n\`\`\``;
    }
  }

  // 图片走后端 image 附件
  const images = attachments.value
    .filter((a) => a.kind === "image")
    .map((a) => ({ mediaType: a.mediaType, data: a.base64, name: a.name, size: a.size }));

  // 本地气泡展示用附件（图片 dataUrl + 文件 dataUrl，历史消息无字节）
  const messageAttachments = attachments.value.map((a) => ({
    kind: a.kind,
    name: a.name,
    mediaType: a.mediaType,
    size: a.size,
    dataUrl: a.dataUrl,
  }));

  sending.value = true;
  try {
    await messages.send(conv.value.id, content, images, messageAttachments);
    draft.value = "";
    attachments.value = [];
    closeMention();
  } catch (e) {
    app.toast(e instanceof Error ? e.message : String(e));
  } finally {
    sending.value = false;
  }
}

function onKeydown(e: KeyboardEvent) {
  // 中文等输入法组合期间（含确认候选词的回车）不发送
  if (e.isComposing || e.keyCode === 229) {
    composing.value = e.isComposing;
    return;
  }
  if (mentionOpen.value) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (mentionMembers.value.length) applyMention(mentionMembers.value[activeIndex.value]);
      else closeMention();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      if (mentionMembers.value.length) applyMention(mentionMembers.value[activeIndex.value]);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeMention();
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey && !composing.value) {
    e.preventDefault();
    void send();
  }
}
</script>

<template>
  <footer
    v-if="conv"
    ref="footerRef"
    class="relative flex shrink-0 flex-col border-t border-line bg-ink-2 p-1.5"
    :style="{ height: `${footerHeight}px` }"
  >
    <!-- 上边框拖拽条 -->
    <div
      class="absolute inset-x-0 -top-1 z-20 h-2 cursor-ns-resize"
      @mousedown="onResizeStart"
    />
    <!-- @ 提及面板 -->
    <div
      v-if="mentionOpen"
      class="absolute bottom-full left-4 right-4 z-20 mb-2 overflow-hidden rounded-xl border border-line-strong/60 bg-ink-2/95 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur-md"
    >
      <div class="flex items-center justify-between px-3 py-2 text-xs text-lo">
        <span>{{ t("chat.mention.members", { count: mentionMembers.length }) }}</span>
        <span class="hidden sm:inline">{{ t("chat.mention.hint") }}</span>
      </div>
      <div v-if="mentionMembers.length" ref="listRef" class="max-h-[220px] overflow-y-auto overscroll-contain px-1.5 pb-1.5">
        <button
          v-for="(member, i) in mentionMembers"
          :key="member.id"
          :data-index="i"
          type="button"
          class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors"
          :class="[
            member.deleted
              ? 'cursor-not-allowed opacity-40'
              : i === activeIndex
                ? 'bg-ink-4/70'
                : 'hover:bg-ink-3/50',
          ]"
          @mousemove="!member.deleted && (activeIndex = i)"
          @mousedown.prevent="!member.deleted && applyMention(member)"
        >
          <div
            class="flex h-7 w-7 shrink-0 items-center justify-center"
            :class="member.deleted ? 'opacity-40 grayscale' : ''"
          >
            <Avatar :name="member.name" :src="member.avatar ?? null" :size="28" :radius="8" />
          </div>
          <span class="min-w-0 flex-1">
            <span class="flex items-center gap-1">
              <span class="truncate text-[13px] font-medium text-hi" :class="member.deleted ? 'line-through decoration-lo/60' : ''">{{ member.name }}</span>
              <BotAgentBadge v-if="member.agent_enabled === 1 && !member.deleted" :agent-enabled="1" :size="12" class="shrink-0" />
            </span>
            <span class="block truncate text-[11px] text-mid">{{ member.deleted ? t("chat.botDeleted") : modelName(member) }}</span>
          </span>
          <span
            v-if="!member.deleted && i === activeIndex"
            class="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent"
          >@</span>
        </button>
      </div>
      <div v-else class="px-3 py-4 text-center text-xs text-lo">{{ t("chat.mention.empty") }}</div>
    </div>

    <!-- 表情选择面板：位于输入框上方，点击面板外部自动关闭 -->
    <!-- 永远挂载：用 v-show 控制显隐，避免反复销毁/重建 emoji-mart 自定义元素实例导致状态错乱 -->
    <div
      v-show="emojiOpen"
      class="absolute bottom-full left-4 z-20 mb-2 overflow-hidden rounded-xl border border-line-strong/60 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur-md"
    >
      <EmojiPicker @select="insertEmoji" @close="emojiOpen = false" />
    </div>

    <!-- 顶部按钮组：占位布局，位于输入框上方 -->
    <ChatInputToolbar @action="onToolbarAction" />

    <!-- 附件预览：已选图片缩略图 / 文件卡片 -->
    <div v-if="attachments.length" class="flex flex-wrap items-center gap-2 px-1 pb-1">
      <div
        v-for="att in attachments"
        :key="att.id"
        class="relative flex max-w-56 items-center gap-2 rounded-lg border border-line bg-ink-3/40 py-1.5 pr-2 pl-1.5"
      >
        <img
          v-if="att.kind === 'image'"
          :src="att.dataUrl"
          :alt="att.name"
          class="h-9 w-9 shrink-0 rounded-md object-cover"
        />
        <div v-else class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-ink-2">
          <FileText :size="17" class="text-mid" />
        </div>
        <div class="flex min-w-0 flex-col">
          <span class="truncate text-xs text-hi">{{ att.name }}</span>
          <span class="font-num text-[10px] text-lo">{{ formatSize(att.size) }}</span>
        </div>
        <button
          type="button"
          :title="t('attach.remove')"
          class="absolute -top-1.5 -right-1.5 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full bg-ink-0 text-lo transition-colors hover:text-hi"
          @click="removeAttachment(att.id)"
        >
          <X :size="10" />
        </button>
      </div>
    </div>

    <!-- 输入框（无边框，flex-1 填满剩余高度）；好友已删除时禁止输入 -->
    <textarea
      ref="boxRef"
      v-model="draft"
      rows="1"
      :disabled="botDeleted"
      :placeholder="placeholder"
      class="w-full flex-1 resize-none rounded-lg bg-transparent px-2 py-2 text-[13px] leading-relaxed text-hi outline-none transition-all placeholder:text-lo"
      @input="onInput"
      @keydown="onKeydown"
      @compositionstart="composing = true"
      @compositionend="composing = false"
      @blur="closeMention"
    />

    <!-- 隐藏文件选择框：图片 / 任意文件 -->
    <input ref="imageInputRef" type="file" accept="image/*" multiple class="hidden" @change="onPickImages" />
    <input ref="fileInputRef" type="file" multiple class="hidden" @change="onPickFiles" />

    <!-- 搜索聊天记录弹窗 -->
    <ConversationSearchModal v-if="searchOpen" @close="searchOpen = false" />
  </footer>
</template>
