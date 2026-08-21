<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from "vue";
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, Globe, Lock, FileCode } from "lucide-vue-next";
import BrowserTabBar from "../components/browser/BrowserTabBar.vue";
import { useBrowserStore, displayUrl } from "../stores/browser";
import { WebviewManager } from "../utils/webviewManager";
import { agentApi } from "../services/agentApi";
import { t } from "../i18n";

const browser = useBrowserStore();

const address = ref("");
const manager = new WebviewManager();
const contentRef = ref<HTMLElement | null>(null);
const initialized = ref(false);

const active = computed(() => browser.activeTab);
const isLocalFile = computed(() => active.value?.url.startsWith("file://") ?? false);

watch(
  () => active.value?.url,
  (url) => {
    address.value = url ? displayUrl(url) : "";
  },
  { immediate: true },
);

/** 同步窗口标题 */
watch(
  () => [active.value?.title, active.value?.url] as const,
  async ([title, url]) => {
    const text = title || (url ? displayUrl(url) : "");
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const suffix = t("browser.title");
      await getCurrentWindow().setTitle(text ? `${text} — ${suffix}` : suffix);
    } catch { /* 忽略 */ }
  },
  { immediate: true },
);

/** 监听 tab 列表变化：为新 tab 创建 webview */
watch(
  () => browser.tabs.map((t) => `${t.id}:${t.webviewLabel}`).join(","),
  async () => {
    if (!initialized.value) return;
    for (const tab of browser.tabs) {
      await manager.createWebview(tab);
    }
  },
);

/** 监听活动 tab 变化 */
watch(
  () => browser.activeId,
  async () => {
    if (!initialized.value) return;
    await nextTick();
    const tab = browser.activeTab;
    if (tab) await manager.setActive(tab.webviewLabel);
  },
);

async function submitAddress() {
  const val = address.value.trim();
  if (!val) return;
  const tab = active.value;
  if (!tab) return;
  const target = new URL(val, "https://placeholder/").toString();
  // 规范化：用 store 的 normalizeUrl（通过 pushHistory 之前的地址）
  const { normalizeUrl } = await import("../stores/browser");
  const normalized = normalizeUrl(val);
  browser.pushHistory(tab.id, normalized);
  browser.updateTab(tab.id, { loading: true, title: "" });
  await manager.navigate(tab.webviewLabel, normalized);
  void target;
}

async function goBack() {
  const tab = active.value;
  if (!tab || !tab.canBack) return;
  browser.moveHistory(tab.id, -1);
  browser.updateTab(tab.id, { loading: true });
  await manager.back(tab.webviewLabel);
}

async function goForward() {
  const tab = active.value;
  if (!tab || !tab.canForward) return;
  browser.moveHistory(tab.id, 1);
  browser.updateTab(tab.id, { loading: true });
  await manager.forward(tab.webviewLabel);
}

async function reload() {
  const tab = active.value;
  if (!tab) return;
  browser.updateTab(tab.id, { loading: true });
  await manager.reload(tab.webviewLabel);
}

async function openInSystem() {
  if (!active.value?.url) return;
  try {
    await agentApi.toolOpenUrl(active.value.url);
  } catch { /* 忽略 */ }
}

async function startDrag(e: MouseEvent) {
  if ((e.target as HTMLElement).closest("button, input, [data-no-drag]")) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().startDragging();
  } catch { /* 忽略 */ }
}

/** 监听 Rust 侧上报的 tab 状态（URL / 标题变化） */
interface TabStatePayload {
  label: string;
  url: string;
  title: string;
  kind: string;
}

let offTabState: (() => void) | undefined;
let offNewTab: (() => void) | undefined;

onMounted(async () => {
  console.log("[BrowserWindowView] onMounted, hash=", window.location.hash);
  const hash = window.location.hash;
  const qIndex = hash.indexOf("?");
  if (qIndex >= 0) {
    const params = new URLSearchParams(hash.slice(qIndex + 1));
    const initial = params.get("url");
    if (initial) browser.addTab(decodeURIComponent(initial));
  }
  if (!browser.tabs.length) browser.addTab("");

  await nextTick();
  if (contentRef.value) {
    await manager.init(contentRef.value);
    initialized.value = true;
    for (const tab of browser.tabs) {
      if (tab.url) await manager.createWebview(tab);
    }
    if (browser.activeTab) await manager.setActive(browser.activeTab.webviewLabel);
  }

  try {
    const { listen } = await import("@tauri-apps/api/event");
    offNewTab = await listen<{ url: string }>("browser:new-tab", (e) => {
      if (e.payload?.url) browser.addTab(e.payload.url);
    });
    // Tab webview 状态上报（URL/标题/导航）
    offTabState = await listen<TabStatePayload>("browser:tab-state", (e) => {
      const payload = e.payload;
      if (!payload?.label) return;
      const tab = browser.tabs.find((t) => t.webviewLabel === payload.label);
      if (!tab) return;
      // 同步 URL（跨 asset 协议的 http/https 直接使用）
      if (payload.url && !payload.url.startsWith("about:")) {
        browser.syncUrl(tab.id, payload.url);
      }
      if (payload.title) {
        browser.updateTab(tab.id, { title: payload.title });
      }
      // 页面 load 事件视为加载完成
      if (payload.kind === "load" || payload.kind === "DOMContentLoaded") {
        browser.updateTab(tab.id, { loading: false });
      }
    });
  } catch (e) {
    console.error("[BrowserWindowView] listen 失败", e);
  }
});

onBeforeUnmount(() => {
  offNewTab?.();
  offTabState?.();
  manager.destroy();
});

/** tab 关闭时销毁对应 webview */
watch(
  () => browser.tabs.map((t) => t.webviewLabel),
  (newLabels, oldLabels) => {
    if (!oldLabels) return;
    const removed = oldLabels.filter((l) => !newLabels.includes(l));
    for (const label of removed) manager.closeWebview(label);
  },
);

/** 无 tab 时关闭窗口 */
watch(
  () => browser.tabs.length,
  async (n) => {
    if (n === 0) {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().close();
      } catch { /* 忽略 */ }
    }
  },
);
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden bg-ink-0">
    <div @mousedown="startDrag">
      <BrowserTabBar />
    </div>

    <div class="flex shrink-0 items-center gap-2 border-b border-line bg-ink-1/60 px-3 py-2">
      <div class="flex items-center gap-0.5" data-no-drag>
        <button
          class="flex h-7 w-7 items-center justify-center rounded-lg transition-colors"
          :class="active?.canBack ? 'text-mid hover:bg-ink-3 hover:text-hi' : 'cursor-not-allowed text-lo/40'"
          :disabled="!active?.canBack"
          :title="t('browser.back')"
          @click="goBack"
        >
          <ArrowLeft :size="16" :stroke-width="2" />
        </button>
        <button
          class="flex h-7 w-7 items-center justify-center rounded-lg transition-colors"
          :class="active?.canForward ? 'text-mid hover:bg-ink-3 hover:text-hi' : 'cursor-not-allowed text-lo/40'"
          :disabled="!active?.canForward"
          :title="t('browser.forward')"
          @click="goForward"
        >
          <ArrowRight :size="16" :stroke-width="2" />
        </button>
        <button
          class="flex h-7 w-7 items-center justify-center rounded-lg text-mid transition-colors hover:bg-ink-3 hover:text-hi"
          :title="t('browser.reload')"
          :disabled="!active?.url"
          @click="reload"
        >
          <RotateCw :size="15" :stroke-width="2" :class="{ 'animate-spin': active?.loading }" />
        </button>
      </div>

      <div
        class="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-line bg-ink-2 px-3 py-1.5 transition-colors"
        data-no-drag
      >
        <FileCode v-if="isLocalFile" :size="12" :stroke-width="2" class="shrink-0 text-info" />
        <Lock v-else :size="12" :stroke-width="2" class="shrink-0 text-accent" />
        <input
          v-model="address"
          type="text"
          class="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-hi outline-none"
          :placeholder="t('browser.addressPlaceholder')"
          spellcheck="false"
          @keydown.enter="submitAddress"
        />
      </div>

      <button
        class="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-ink-2 px-2.5 text-[11.5px] text-mid transition-colors hover:bg-ink-3 hover:text-hi"
        :title="t('browser.openInSystem')"
        data-no-drag
        :disabled="!active?.url"
        @click="openInSystem"
      >
        <ExternalLink :size="13" :stroke-width="2" />
        {{ t("browser.openInSystemShort") }}
      </button>
    </div>

    <div ref="contentRef" class="relative min-h-0 flex-1 bg-white">
      <div
        v-if="!active?.url"
        class="flex h-full flex-col items-center justify-center gap-3 bg-ink-1"
      >
        <Globe :size="44" :stroke-width="1.2" class="text-accent/30" />
        <p class="text-[13px] text-lo">{{ t("browser.emptyHint") }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
input::placeholder {
  color: var(--c-lo);
}
[data-no-drag]:focus-within {
  border-color: rgba(42, 227, 164, 0.5);
}
</style>
