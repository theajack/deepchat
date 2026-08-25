<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Globe, Play, Loader2, CheckCircle2, XCircle, ExternalLink, MessageSquareText, Bug, ScrollText, FolderOpen, RefreshCw } from "lucide-vue-next";
import { openUrl, openUrlBuiltin, openUrlSystem, type BrowserPref } from "../../utils/browser";
import { openLlmTraceWindow } from "../../utils/llmTrace";
import { useSettingsStore } from "../../stores/settings";
import { chatApi } from "../../services/chatApi";
import { agentApi } from "../../services/agentApi";
import { t } from "../../i18n";

const settings = useSettingsStore();

/** openUrl 调试 */
const urlInput = ref("https://www.bing.com");
const calling = ref(false);
const result = ref<{ ok: boolean; message: string; mode?: string } | null>(null);

const currentPref = (): BrowserPref => {
  const v = settings.values["default_browser"];
  return v === "builtin" ? "builtin" : "system";
};

async function runOpenUrl(mode: "auto" | "builtin" | "system") {
  const url = urlInput.value.trim();
  if (!url) {
    result.value = { ok: false, message: t("debug.enterUrl") };
    return;
  }
  calling.value = true;
  result.value = null;
  try {
    const pref = mode === "auto" ? undefined : (mode as BrowserPref);
    await openUrl(url, pref);
    const used = mode === "auto" ? currentPref() : mode;
    result.value = { ok: true, message: t("debug.opened"), mode: used };
  } catch (e) {
    result.value = { ok: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    calling.value = false;
  }
}

async function runBuiltin() {
  const url = urlInput.value.trim();
  if (!url) return;
  calling.value = true;
  result.value = null;
  try {
    await openUrlBuiltin(url);
    result.value = { ok: true, message: t("debug.openedBuiltin"), mode: "builtin" };
  } catch (e) {
    result.value = { ok: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    calling.value = false;
  }
}

async function runSystem() {
  const url = urlInput.value.trim();
  if (!url) return;
  calling.value = true;
  result.value = null;
  try {
    await openUrlSystem(url);
    result.value = { ok: true, message: t("debug.openedSystem"), mode: "system" };
  } catch (e) {
    result.value = { ok: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    calling.value = false;
  }
}

/** 打开当前窗口的开发者工具（Tauri Rust command） */
async function openDevtools() {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_devtools");
  } catch (e) {
    console.error("[debug] 打开开发者工具失败", e);
  }
}

/** 快速填充示例 */
const examples = computed(() => [
  { label: t("debug.example.web"), url: "https://www.bing.com" },
  { label: t("debug.example.localHtml"), url: "/Users/tackchen/chat-agent-workspace/agents/c84afed5-1bf1-4465-bad9-770553277701/snake.html" },
  { label: t("debug.example.file"), url: "file:///Users/tackchen/chat-agent-workspace/agents/c84afed5-1bf1-4465-bad9-770553277701/snake.html" },
]);

/** 本地日志开关（持久化到 settings，宿主端写入 dsh-home/logs/debug.log） */
const debugLogEnabled = computed({
  get: () => settings.values["debug_log_enabled"] === "true",
  set: (v: boolean) => {
    settings.set("debug_log_enabled", v ? "true" : "false");
    if (v) void refreshLogInfo();
  },
});

/** 宿主侧日志状态（路径 + 尾部预览） */
const logPath = ref("");
const logTail = ref("");
const logLoading = ref(false);

async function refreshLogInfo() {
  logLoading.value = true;
  try {
    const info = await chatApi.debugLog(debugLogEnabled.value);
    logPath.value = info.path;
    if (debugLogEnabled.value) {
      const res = await chatApi.debugLogTail(100);
      logTail.value = res.tail;
    } else {
      logTail.value = "";
    }
  } catch { /* 宿主未就绪时忽略 */ } finally {
    logLoading.value = false;
  }
}

async function openLogDir() {
  const info = await chatApi.debugLog();
  const dir = info.path.replace(/\/[^/]*$/, "");
  try {
    await agentApi.toolOpenDir(dir);
  } catch {
    window.alert(`日志目录：${dir}`);
  }
}

onMounted(() => {
  if (debugLogEnabled.value) void refreshLogInfo();
});
</script>

<template>
  <section class="rounded-xl border border-line bg-ink-2/40 p-5">
    <div class="flex items-center gap-2">
      <Globe :size="15" class="text-accent" />
      <h3 class="text-[13px] font-semibold tracking-wide text-hi">{{ t("debug.title") }}</h3>
    </div>
    <p class="mt-1 text-xs text-lo">
      {{ t("debug.desc") }}
      <span class="font-mono text-accent">{{ currentPref() }}</span>
    </p>

    <!-- URL 输入 -->
    <div class="mt-3 flex gap-2">
      <input
        v-model="urlInput"
        type="text"
        spellcheck="false"
        class="min-w-0 flex-1 rounded-lg border border-line bg-ink-1/60 px-3 py-2 font-mono text-[12px] text-hi outline-none transition-colors"
        :placeholder="t('debug.urlPlaceholder')"
        @keydown.enter="runOpenUrl('auto')"
      />
    </div>

    <!-- 示例快捷填充 -->
    <div class="mt-2 flex flex-wrap gap-1.5">
      <button
        v-for="ex in examples"
        :key="ex.url"
        class="rounded-md border border-line bg-ink-1/40 px-2 py-1 text-[10.5px] text-lo transition-colors hover:bg-ink-3 hover:text-hi"
        @click="urlInput = ex.url"
      >
        {{ ex.label }}
      </button>
    </div>

    <!-- 操作按钮 -->
    <div class="mt-3 flex flex-wrap gap-2">
      <button
        class="flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-accent to-accent-deep px-4 py-2 text-[12.5px] font-medium text-on-accent transition-opacity hover:opacity-90 disabled:opacity-50"
        :disabled="calling"
        @click="runOpenUrl('auto')"
      >
        <Loader2 v-if="calling" :size="14" class="animate-spin" />
        <Play v-else :size="14" :stroke-width="2" />
        {{ t("debug.openDefault") }}
      </button>
      <button
        class="flex items-center gap-1.5 rounded-lg border border-line bg-ink-2 px-3.5 py-2 text-[12.5px] text-mid transition-colors hover:bg-ink-3 hover:text-hi disabled:opacity-50"
        :disabled="calling"
        @click="runBuiltin"
      >
        <ExternalLink :size="13" :stroke-width="2" />
        {{ t("browser.builtin") }}
      </button>
      <button
        class="flex items-center gap-1.5 rounded-lg border border-line bg-ink-2 px-3.5 py-2 text-[12.5px] text-mid transition-colors hover:bg-ink-3 hover:text-hi disabled:opacity-50"
        :disabled="calling"
        @click="runSystem"
      >
        <Globe :size="13" :stroke-width="2" />
        {{ t("browser.system") }}
      </button>
    </div>

    <!-- 结果 -->
    <div v-if="result" class="mt-3 flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px]" :class="result.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-red-500/30 bg-red-500/10 text-red-400'">
      <CheckCircle2 v-if="result.ok" :size="14" />
      <XCircle v-else :size="14" />
      <span>{{ result.message }}</span>
      <span v-if="result.mode" class="ml-auto rounded bg-ink-1/60 px-1.5 py-0.5 font-mono text-[10.5px] text-lo">{{ result.mode }}</span>
    </div>
  </section>

  <!-- 对话信息 -->
  <section class="rounded-xl border border-line bg-ink-2/40 p-5">
    <div class="flex items-center gap-2">
      <MessageSquareText :size="15" class="text-accent" />
      <h3 class="text-[13px] font-semibold tracking-wide text-hi">{{ t("debug.llmTraceTitle") }}</h3>
    </div>
    <p class="mt-1 text-xs text-lo">{{ t("debug.llmTraceDesc") }}</p>
    <button
      class="mt-3 flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-accent to-accent-deep px-4 py-2 text-[12.5px] font-medium text-on-accent transition-opacity hover:opacity-90"
      @click="openLlmTraceWindow"
    >
      <MessageSquareText :size="14" :stroke-width="2" />
      {{ t("debug.llmTraceOpen") }}
    </button>
  </section>

  <!-- 开发者工具 -->
  <section class="rounded-xl border border-line bg-ink-2/40 p-5">
    <div class="flex items-center gap-2">
      <Bug :size="15" class="text-accent" />
      <h3 class="text-[13px] font-semibold tracking-wide text-hi">{{ t("debug.devToolsTitle") }}</h3>
    </div>
    <p class="mt-1 text-xs text-lo">{{ t("debug.devToolsDesc") }}</p>
    <button
      class="mt-3 flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-accent to-accent-deep px-4 py-2 text-[12.5px] font-medium text-on-accent transition-opacity hover:opacity-90"
      @click="openDevtools"
    >
      <Bug :size="14" :stroke-width="2" />
      {{ t("debug.devToolsOpen") }}
    </button>
  </section>

  <!-- 本地日志 -->
  <section class="rounded-xl border border-line bg-ink-2/40 p-5">
    <div class="flex items-center gap-2">
      <ScrollText :size="15" class="text-accent" />
      <h3 class="text-[13px] font-semibold tracking-wide text-hi">{{ t("debug.localLogTitle") }}</h3>
    </div>
    <p class="mt-1 text-xs text-lo">{{ t("debug.localLogDesc") }}</p>
    <label class="mt-3 flex cursor-pointer items-center justify-between">
      <span class="text-[12.5px] text-mid">{{ t("debug.localLogEnable") }}</span>
      <input
        type="checkbox"
        v-model="debugLogEnabled"
        class="h-4 w-4 accent-accent"
      />
    </label>

    <template v-if="debugLogEnabled">
      <div class="mt-3 flex items-center gap-2">
        <button
          class="flex items-center gap-1.5 rounded-lg border border-line bg-ink-2 px-3 py-1.5 text-[12px] text-mid transition-colors hover:text-accent"
          @click="openLogDir"
        >
          <FolderOpen :size="13" />
          {{ t("debug.localLogOpenDir") }}
        </button>
        <button
          class="flex items-center gap-1.5 rounded-lg border border-line bg-ink-2 px-3 py-1.5 text-[12px] text-mid transition-colors hover:text-accent"
          @click="refreshLogInfo"
        >
          <RefreshCw :size="13" :class="logLoading ? 'animate-spin' : ''" />
          {{ t("debug.localLogRefresh") }}
        </button>
      </div>
      <p v-if="logPath" class="mt-2 break-all font-mono text-[11px] text-lo">{{ logPath }}</p>
      <pre v-if="logTail" class="mt-2 max-h-48 overflow-auto rounded-lg border border-line bg-ink-1/60 p-2.5 font-mono text-[11px] leading-relaxed text-mid">{{ logTail }}</pre>
    </template>
  </section>
</template>
