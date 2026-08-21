<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { RotateCw, Trash2, ChevronDown, ChevronRight, Wrench, MessageSquare, Cpu, Terminal, Brain, FileText } from "lucide-vue-next";
import SectionBlock from "../components/debug/SectionBlock.vue";
import { agentApi, type LlmTraceEntry } from "../services/agentApi";
import { t } from "../i18n";

const traces = ref<LlmTraceEntry[]>([]);
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
    traces.value = await agentApi.llmTraceList();
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
    expanded.value = new Set();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
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
      <!-- macOS 红绿灯占位，避免标题被遮挡 -->
      <div class="w-16 shrink-0" data-tauri-drag-region />
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

      <div v-if="!traces.length && !loading" class="flex h-full flex-col items-center justify-center gap-2 text-lo">
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
