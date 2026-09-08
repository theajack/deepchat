<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { RotateCw, Trash2, ChevronDown, ChevronRight, Wrench, MessageSquare, Cpu, Terminal, Brain, FileText, Upload, Image as ImageIcon } from "lucide-vue-next";
import SectionBlock from "../components/debug/SectionBlock.vue";
import { agentApi, type LlmTraceEntry, type UploadTraceEntry } from "../services/agentApi";
import { t } from "../i18n";

// 平台判定必须同步完成，否则首帧会先闪出另一平台的布局
const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);

const traces = ref<LlmTraceEntry[]>([]);
const uploads = ref<UploadTraceEntry[]>([]);
/** 上传记录区块是否展开 */
const uploadsOpen = ref(false);
const loading = ref(false);
const error = ref("");
/** 展开的条目 id 集合 */
const expanded = ref<Set<string>>(new Set());

let refreshTimer: ReturnType<typeof setInterval> | undefined;
let offRefresh: (() => void) | undefined;

async function refresh() {
  if (loading.value) return;
  loading.value = true;
  error.value = "";
  try {
    const snap = await agentApi.llmTraceList();
    traces.value = snap?.entries ?? [];
    uploads.value = snap?.uploads ?? [];
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function clearAll() {
  try {
    await agentApi.llmTraceClear();
    traces.value = [];
    uploads.value = [];
    expanded.value = new Set();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/** 人类可读的字节数 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 归一化节省的百分比；未压缩时返回 null */
function savedPercent(sourceBytes: number, bytes: number): number | null {
  if (sourceBytes <= 0 || bytes >= sourceBytes) return null;
  return Math.round((1 - bytes / sourceBytes) * 100);
}

/** 图片尺寸描述：有压缩时展示 原始 → 实际 */
function dimLabel(u: UploadTraceEntry): string {
  if (u.width === undefined || u.height === undefined) return "";
  const after = `${u.width}×${u.height}`;
  if (u.originalWidth === undefined || u.originalHeight === undefined) return after;
  return `${u.originalWidth}×${u.originalHeight} → ${after}`;
}

function toggle(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

async function startDrag(e: MouseEvent) {
  if ((e.target as HTMLElement).closest("button, input, [data-no-drag]")) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().startDragging();
  } catch { /* 忽略 */ }
}

onMounted(async () => {
  await refresh();
  // 窗口常驻时周期刷新，捕获新的模型调用
  refreshTimer = setInterval(() => void refresh(), 2000);
  try {
    const { listen } = await import("@tauri-apps/api/event");
    offRefresh = await listen("llm-trace:refresh", () => void refresh());
  } catch { /* 忽略 */ }
});

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer);
  offRefresh?.();
});
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-ink-0">
    <!-- 顶栏（可拖拽移动窗口） -->
    <div
      class="flex shrink-0 cursor-move select-none items-center gap-2 border-b border-line bg-ink-1/60 py-2.5 pl-3 pr-4"
      data-tauri-drag-region
      @mousedown="startDrag"
    >
      <!-- macOS 红绿灯占位，避免标题被遮挡；Windows 自绘按钮在右侧，左侧无需留白 -->
      <div v-if="isMac" class="w-16 shrink-0" data-tauri-drag-region />
      <Cpu :size="15" class="text-accent" />
      <h2 class="text-[13px] font-semibold text-hi">{{ t("debug.llmTraceTitle") }}</h2>
      <span class="rounded bg-ink-2 px-1.5 py-0.5 font-mono text-[11px] text-lo">{{ traces.length }}</span>
      <div class="flex-1" />
      <button
        class="inline-flex items-center gap-1.5 rounded-lg border border-line bg-ink-2 px-2.5 py-1.5 text-[12px] text-mid transition-colors hover:text-accent"
        data-tauri-drag-region="false"
        @click="clearAll"
      >
        <Trash2 :size="13" /> {{ t("common.delete") }}
      </button>
      <button
        class="inline-flex items-center gap-1.5 rounded-lg border border-line bg-ink-2 px-2.5 py-1.5 text-[12px] text-mid transition-colors hover:text-accent"
        data-tauri-drag-region="false"
        @click="refresh"
      >
        <RotateCw :size="13" :class="{ 'animate-spin': loading }" />
      </button>
    </div>

    <!-- 内容 -->
    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <p v-if="error" class="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-400">{{ error }}</p>

      <!-- 上传记录（图片 / 文件） -->
      <div v-if="uploads.length" class="mb-3 overflow-hidden rounded-xl border border-line bg-ink-2/40">
        <button class="flex w-full items-center gap-1.5 px-3 py-2 text-left" @click="uploadsOpen = !uploadsOpen">
          <component :is="uploadsOpen ? ChevronDown : ChevronRight" :size="14" class="shrink-0 text-mid" />
          <Upload :size="13" class="shrink-0 text-accent" />
          <span class="text-[12px] font-semibold text-hi">{{ t("debug.uploadsTitle") }}</span>
          <span class="rounded bg-ink-1 px-1.5 py-0.5 font-mono text-[10px] text-lo">{{ uploads.length }}</span>
        </button>
        <div v-if="uploadsOpen" class="flex flex-col gap-1 border-t border-line px-3 py-2">
          <div
            v-for="u in uploads"
            :key="u.id"
            class="rounded-md bg-ink-1/50 px-2 py-1.5"
          >
            <div class="flex items-center gap-1.5">
              <component :is="u.kind === 'image' ? ImageIcon : FileText" :size="12" class="shrink-0 text-accent" />
              <span class="truncate text-[11.5px] font-medium text-hi">{{ u.name }}</span>
              <span class="shrink-0 rounded bg-ink-2 px-1 py-0.5 font-mono text-[9.5px] text-lo">{{ u.kind === "image" ? t("debug.kindImage") : t("debug.kindFile") }}</span>
              <div class="flex-1" />
              <span v-if="u.error" class="shrink-0 rounded bg-danger/15 px-1.5 py-0.5 text-[10px] text-danger">error</span>
              <span class="shrink-0 font-mono text-[10.5px] text-lo">{{ fmtTime(u.ts) }}</span>
            </div>
            <div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10.5px] text-lo">
              <!-- 图片：类型 / 尺寸（压缩前后）/ 大小（压缩前后） -->
              <template v-if="u.kind === 'image'">
                <span>{{ u.mediaType }}</span>
                <span v-if="dimLabel(u)">{{ dimLabel(u) }}</span>
                <span>
                  {{ formatBytes(u.sourceBytes) }}<template v-if="u.bytes !== u.sourceBytes"> → {{ formatBytes(u.bytes) }}</template>
                </span>
                <span v-if="savedPercent(u.sourceBytes, u.bytes) !== null" class="text-emerald-400">
                  -{{ savedPercent(u.sourceBytes, u.bytes) }}%
                </span>
              </template>
              <!-- 文件：大小 / 落盘路径 -->
              <template v-else>
                <span>{{ formatBytes(u.bytes) }}</span>
                <span v-if="u.path" class="truncate">→ {{ u.path }}</span>
              </template>
              <span v-if="u.botName" class="text-mid">{{ u.botName }}</span>
            </div>
            <p v-if="u.error" class="mt-0.5 font-mono text-[10.5px] text-red-400">{{ u.error }}</p>
          </div>
        </div>
      </div>

      <div v-if="!traces.length && !loading && !uploads.length" class="flex h-full flex-col items-center justify-center gap-2 text-lo">
        <MessageSquare :size="36" :stroke-width="1.2" class="text-accent/30" />
        <p class="text-[13px]">{{ t("debug.llmTraceEmpty") }}</p>
      </div>

      <div v-else class="flex flex-col gap-2">
        <div
          v-for="e in traces"
          :key="e.id"
          class="overflow-hidden rounded-xl border border-line bg-ink-2/40"
        >
          <!-- 条目头 -->
          <button class="flex w-full items-center gap-2 px-3 py-2 text-left" @click="toggle(e.id)">
            <component :is="expanded.has(e.id) ? ChevronDown : ChevronRight" :size="14" class="shrink-0 text-mid" />
            <span class="shrink-0 rounded bg-ink-1 px-1.5 py-0.5 font-mono text-[10px] text-lo">{{ e.kind === "stream" ? "agent" : "chat" }}</span>
            <span class="truncate text-[12.5px] font-medium text-hi">{{ e.botName ?? e.provider }}</span>
            <span class="shrink-0 font-mono text-[11px] text-lo">{{ e.model }}</span>
            <span v-if="e.error" class="shrink-0 rounded bg-danger/15 px-1.5 py-0.5 text-[10px] text-danger">error</span>
            <span v-if="e.usage?.promptTokens || e.usage?.completionTokens" class="shrink-0 font-mono text-[10px] text-lo">
              {{ e.usage.promptTokens ?? 0 }}/{{ e.usage.completionTokens ?? 0 }} tok
            </span>
            <div class="flex-1" />
            <span class="shrink-0 font-mono text-[11px] text-lo">{{ fmtTime(e.ts) }}</span>
          </button>

          <!-- 详情 -->
          <div v-if="expanded.has(e.id)" class="border-t border-line px-3 py-2.5">
            <!-- 错误 -->
            <div v-if="e.error" class="mb-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 font-mono text-[11px] text-red-400">{{ e.error }}</div>

            <!-- System -->
            <SectionBlock title="系统提示" :icon="Terminal" variant="system" :count="`${e.system.length} 字`" :text="e.system" />

            <!-- 输入 -->
            <SectionBlock title="输入消息" :icon="MessageSquare" variant="input" :count="`${e.input.length} 条`">
              <div class="flex flex-col gap-1">
                <div v-for="(m, i) in e.input" :key="i" class="rounded-md bg-ink-1/50 px-2 py-1.5">
                  <span class="mr-1.5 inline-block rounded bg-ink-2 px-1 py-0.5 font-mono text-[9.5px] text-lo">{{ m.role }}</span>
                  <pre class="mt-1 whitespace-pre-wrap break-words font-sans text-[11.5px] leading-relaxed text-hi">{{ m.content }}</pre>
                </div>
              </div>
            </SectionBlock>

            <!-- 本次调用携带的图片（模型实际收到的尺寸 / 字节） -->
            <SectionBlock
              v-if="e.attachments?.length"
              :title="t('debug.imagesTitle')"
              :icon="ImageIcon"
              variant="input"
              :count="`${e.attachments.length} 张`"
            >
              <div class="flex flex-col gap-1">
                <p class="mb-0.5 text-[10px] leading-relaxed text-lo/70">{{ t("debug.imagesNote") }}</p>
                <div v-for="(img, i) in e.attachments" :key="i" class="rounded-md bg-ink-1/50 px-2 py-1.5">
                  <div class="flex items-center gap-1.5">
                    <ImageIcon :size="12" class="shrink-0 text-accent" />
                    <span class="truncate text-[11.5px] text-hi">{{ img.name ?? img.mediaType }}</span>
                    <span class="shrink-0 rounded bg-ink-2 px-1 py-0.5 font-mono text-[9.5px] text-lo">{{ img.mediaType }}</span>
                    <span
                      v-if="img.originalWidth !== undefined"
                      class="shrink-0 rounded bg-amber-500/15 px-1 py-0.5 text-[9.5px] text-amber-300"
                    >{{ t("debug.normalized") }}</span>
                  </div>
                  <div class="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[10.5px] text-lo">
                    <span>
                      {{ img.originalWidth !== undefined ? `${img.originalWidth}×${img.originalHeight} → ` : "" }}{{ img.width }}×{{ img.height }}
                    </span>
                    <span>{{ formatBytes(img.bytes) }}</span>
                  </div>
                  <p class="mt-0.5 truncate font-mono text-[10px] text-lo/70">id: {{ img.attachmentId }}</p>
                </div>
              </div>
            </SectionBlock>

            <!-- 工具调用 -->
            <SectionBlock v-if="e.toolCalls.length" title="工具调用" :icon="Wrench" variant="tool" :count="`${e.toolCalls.length} 次`">
              <div class="flex flex-col gap-1">
                <div v-for="(tc, i) in e.toolCalls" :key="i" class="rounded-md bg-ink-1/50 px-2 py-1.5">
                  <span class="font-mono text-[11.5px] text-accent">{{ tc.name }}</span>
                  <pre v-if="tc.args" class="mt-0.5 whitespace-pre-wrap break-all font-mono text-[10.5px] text-lo">{{ JSON.stringify(tc.args, null, 2) }}</pre>
                </div>
              </div>
            </SectionBlock>

            <!-- 思维链 -->
            <SectionBlock v-if="e.reasoning" title="思维链" :icon="Brain" variant="reasoning" :count="`${e.reasoning.length} 字`" :text="e.reasoning" />

            <!-- 输出 -->
            <SectionBlock title="输出" :icon="FileText" variant="output" :count="`${e.output.length} 字`" :text="e.output" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
