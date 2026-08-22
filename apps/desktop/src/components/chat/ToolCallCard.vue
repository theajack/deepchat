<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Wrench, ChevronDown, CheckCircle2, XCircle, Loader2 } from "lucide-vue-next";
import { t } from "../../i18n";
import { renderMarkdownStreamed } from "../../utils/markdown";
import { useAutoScroll } from "../../utils/useAutoScroll";

const props = defineProps<{
  name: string;
  args?: unknown;
  /** 模型流式输出工具参数时的累积 JSON 字符串 */
  argsStr?: string;
  status: "running" | "success" | "error";
  result?: { content?: { type: string; text?: string }[]; isError?: boolean; details?: unknown };
  /** 工具执行耗时（毫秒） */
  durationMs?: number;
  expandable?: boolean;
  /** 外部控制自动展开（执行期间自动展开，完成后自动折叠）。
   *  用户手动 toggle 后不再受 autoExpand 控制。 */
  autoExpand?: boolean;
}>();

const open = ref(false);
const userToggled = ref(false);

// 调试：工具名丢失定位（仅当 window.__TOOL_DEBUG__ 时输出）
if (typeof window !== 'undefined' && (window as unknown as { __TOOL_DEBUG__?: boolean }).__TOOL_DEBUG__) {
  watch(
    () => [props.name, props.id, props.status, props.result],
    ([name, id, status, result]) => {
      console.log('[ToolCallCard]', { name, id, status, hasResult: result !== undefined && result !== null })
    },
    { immediate: true },
  )
}

/** 自动展开/折叠：autoExpand 变化时同步 open，除非用户手动操作过 */
watch(
  () => props.autoExpand,
  (auto) => {
    if (userToggled.value) return;
    open.value = !!auto;
  },
  { immediate: true },
);

function onToggle() {
  userToggled.value = true;
  open.value = !open.value;
}

/** 格式化耗时：毫秒 → "0.3s" / "<0.1s" */
function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return "";
  if (ms < 100) return "<0.1s";
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 工具执行耗时文本（完成后才显示） */
const durationText = computed(() => {
  if (props.status === "running") return "";
  return formatDuration(props.durationMs);
});

const argsText = computed(() => (props.args ? JSON.stringify(props.args, null, 2) : ""));
const resultText = computed(() => {
  const c = props.result?.content ?? [];
  return c
    .map((p) => (p.type === "text" ? p.text ?? "" : p.type === "image" ? t("tool.image") : `[${p.type}]`))
    .join("\n")
    .trim();
});

/** 反转义 JSON 字符串字面量 */
function unescapeJson(s: string): string {
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

/** 模型正在流式输出 write 工具的参数（content 尚未生成完） */
/** 从（可能未闭合的）JSON 字符串中提取字段值，容错处理流式中的半截 JSON */
function extractPartialField(json: string, field: string): string {
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"?`);
  const m = json.match(re);
  return m ? unescapeJson(m[1]) : "";
}

/** 根据文件扩展名映射代码语言 */
const LANG_BY_EXT: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "tsx", jsx: "jsx",
  py: "python", go: "go", rs: "rust", java: "java",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp",
  html: "html", htm: "html", css: "css", scss: "scss", less: "less",
  json: "json", yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini",
  md: "markdown", txt: "text", sh: "bash", bash: "bash", zsh: "bash",
  sql: "sql", vue: "vue", xml: "xml", svg: "xml", kt: "kotlin", swift: "swift",
  rb: "ruby", php: "php", lua: "lua", dart: "dart",
};

function langFromPath(path: string): string {
  const m = path.match(/\.([^./\\]+)$/);
  if (!m) return "";
  return LANG_BY_EXT[m[1].toLowerCase()] ?? "";
}

/** 从流式参数中提取 path 与 content */
const writeStream = computed(() => {
  const s = props.argsStr ?? "";
  return {
    path: extractPartialField(s, "path"),
    content: extractPartialField(s, "content"),
  };
});

/** 是否展示 write 工具的内容预览：仅在执行中（流式）展示，
 *  完成后随 autoExpand 折叠，由用户手动展开查看 */
const showWriteContent = computed(() => {
  if (props.name !== "write") return false;
  if (props.status !== "running") return false;
  return !!writeStream.value.content;
});

/** write 预览内容（Markdown 代码块），语言按 path 扩展名推断 */
const writePreview = computed(() => {
  if (props.status !== "running") return { label: "", html: "" };
  const { path, content } = writeStream.value;
  if (!content) return { label: "", html: "" };
  const lang = langFromPath(path);
  return {
    label: path || t("tool.writing"),
    html: renderMarkdownStreamed(`\`\`\`${lang}\n${content}\n\`\`\``),
  };
});

/** write 内容预览区域的滚动容器 ref */
const writeScrollEl = ref<HTMLElement | null>(null);
const { onScroll: onWriteScroll, maybeScrollToBottom: maybeScrollWriteToBottom } = useAutoScroll(writeScrollEl);

/** write 内容更新时自动滚到底部（若用户未上滑干预） */
watch(
  () => writeStream.value.content,
  () => {
    if (props.status === "running") maybeScrollWriteToBottom();
  },
);
</script>

<template>
  <div
    class="my-1.5 overflow-hidden rounded-xl border border-line bg-ink-3/50 backdrop-blur-sm transition-all"
    :class="status === 'error' ? 'border-red-500/40' : status === 'running' ? 'border-accent/40' : ''"
  >
    <button
      type="button"
      class="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-ink-3/80"
      @click="onToggle"
    >
      <Wrench :size="14" class="shrink-0 text-accent" :stroke-width="2" />
      <span class="text-[12.5px] font-medium text-hi">{{ name || t("tool.unknown") }}</span>
      <span class="font-num text-[10px] text-lo">
        {{ status === "running" ? t("tool.running") : status === "error" ? t("tool.failed") : t("tool.done") }}
      </span>
      <span v-if="durationText" class="font-num text-[10px] text-lo/70">· {{ durationText }}</span>
      <span v-if="status === 'running'" class="text-accent"><Loader2 :size="13" class="animate-spin" /></span>
      <CheckCircle2 v-else-if="status === 'success'" :size="13" class="text-emerald-400" />
      <XCircle v-else-if="status === 'error'" :size="13" class="text-red-400" />
      <ChevronDown
        v-if="expandable"
        :size="13"
        class="ml-auto text-lo transition-transform"
        :class="{ 'rotate-180': open }"
      />
    </button>

    <!-- write 工具：执行中实时展示流式内容；完成后展示生成的文件内容 -->
    <div v-if="showWriteContent" class="border-t border-line bg-ink-1/40 px-3 py-2">
      <div class="mb-1.5 flex items-center gap-1.5 text-[10px] text-lo">
        <Loader2 :size="11" class="animate-spin text-accent" />
        <span class="truncate">{{ writePreview.label || t("tool.writing") }}</span>
      </div>
      <div
        ref="writeScrollEl"
        class="bubble-md max-h-64 overflow-auto"
        @scroll="onWriteScroll"
        v-html="writePreview.html"
      />
    </div>

    <!-- 完成后：参数 + 结果 -->
    <div
      v-else-if="open && (argsText || resultText)"
      class="border-t border-line bg-ink-1/40 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-mid"
    >
      <div v-if="argsText" class="mb-2">
        <span class="mb-1 block text-[10px] uppercase tracking-wider text-lo">{{ t("tool.args") }}</span>
        <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words text-accent/90">{{ argsText }}</pre>
      </div>
      <div v-if="resultText">
        <span class="mb-1 block text-[10px] uppercase tracking-wider text-lo">{{ t("tool.result") }}</span>
        <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words">{{ resultText }}</pre>
      </div>
    </div>
  </div>
</template>
