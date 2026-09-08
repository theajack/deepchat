<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { Server, Plus, Trash2, RefreshCw, CheckCircle2, XCircle, Loader2, Pencil, ChevronRight, ChevronDown } from "lucide-vue-next";
import { agentApi, type McpServerInfo, type McpToolInfo } from "../../services/agentApi";
import FilterInput from "../common/FilterInput.vue";
import ConfirmModal from "../common/ConfirmModal.vue";
import McpEditorModal from "./McpEditorModal.vue";
import { t } from "../../i18n";

const servers = ref<McpServerInfo[]>([]);
const loading = ref(false);
const keyword = ref("");

/**
 * 测试结果按服务 id 分开存。
 *
 * 之前用一个共享数组，渲染条件还是 `testingId !== s.id` —— 测试完
 * testingId 被清空，导致所有卡片都显示同一批工具（互相串台）。
 */
const testResults = ref<Record<string, { tools: McpToolInfo[]; error: string }>>({});
/** 正在测试的服务 id */
const testingId = ref("");
/** 工具列表展开中的服务 id */
const expanded = ref<Record<string, boolean>>({});

/** 编辑器弹窗：open 控制显隐，target 为 null 表示新增 */
const editorOpen = ref(false);
const editingTarget = ref<McpServerInfo | null>(null);

/** 实时过滤：按名称（大小写不敏感） */
const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase();
  if (!q) return servers.value;
  return servers.value.filter((s) => s.name.toLowerCase().includes(q));
});

const healthMeta = computed<Record<string, { label: string; cls: string; icon: any }>>(() => ({
  connected: { label: t("mcp.connected"), cls: "text-emerald-400", icon: CheckCircle2 },
  connecting: { label: t("mcp.connecting"), cls: "text-amber-300", icon: Loader2 },
  error: { label: t("mcp.error"), cls: "text-red-400", icon: XCircle },
  disconnected: { label: t("mcp.disconnected"), cls: "text-lo", icon: Server },
}));

async function load(silent = false) {
  if (!silent) loading.value = true;
  try {
    servers.value = await agentApi.mcpList();
    // 丢掉指向已删除服务的旧结果/展开态，但保留仍存在的（否则轮询刷新会
    // 把用户刚展开的工具列表清掉）
    const ids = new Set(servers.value.map((s) => s.id));
    testResults.value = pickKeys(testResults.value, ids);
    expanded.value = pickKeys(expanded.value, ids);
  } catch {
    if (!silent) servers.value = [];
  } finally {
    if (!silent) loading.value = false;
    schedulePollIfConnecting();
  }
}

function pickKeys<T>(source: Record<string, T>, keep: ReadonlySet<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(source).filter(([id]) => keep.has(id)));
}

// ── 连接中轮询 ───────────────────────────────────────────────────────────

/**
 * 有服务处于 connecting 时定时刷新，让状态能从"连接中"变成"已连接"。
 *
 * 连接是宿主侧异步完成的（握手 + 拉工具），没有事件推给前端，只能轮询；
 * 全部连上或超过次数上限就停，不留常驻定时器。
 */
let pollTimer: ReturnType<typeof setInterval> | null = null;

function schedulePollIfConnecting() {
  if (pollTimer !== null) return;
  if (!servers.value.some((s) => s.health === "connecting")) return;
  let tries = 0;
  pollTimer = setInterval(async () => {
    tries += 1;
    if (!servers.value.some((s) => s.health === "connecting") || tries >= 30) {
      stopPoll();
      return;
    }
    await load(true);
  }, 2000);
}

function stopPoll() {
  if (pollTimer === null) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

onUnmounted(stopPoll);

/** 打开新增弹窗 */
function startAdd() {
  editingTarget.value = null;
  editorOpen.value = true;
}

/** 打开编辑弹窗：传入该服务，弹窗内部负责预填 */
function startEdit(server: McpServerInfo) {
  if (server.builtin) return; // 内置服务不可编辑
  editingTarget.value = server;
  editorOpen.value = true;
}

/** 弹窗保存成功：关闭并刷新列表 */
function onSaved() {
  editorOpen.value = false;
  editingTarget.value = null;
  void load();
}

/** 删除前的二次确认状态 */
const confirmRemove = ref<{ id: string; name: string } | null>(null);

function requestRemove(server: McpServerInfo) {
  if (server.builtin) return; // 内置服务不可删除
  confirmRemove.value = { id: server.id, name: server.name };
}

async function doRemove() {
  const target = confirmRemove.value;
  confirmRemove.value = null;
  if (!target) return;
  await agentApi.mcpRemove(target.id);
  await load();
}

/**
 * 工具按钮：一个按钮管两件事。
 * 已展开 → 收起（不再请求）；未展开 → 查一次已注册工具再展开。
 * 每次展开都重新查，保证看到的是最新工具列表。
 */
async function toggleTools(server: McpServerInfo) {
  if (expanded.value[server.id]) {
    const { [server.id]: _omit, ...rest } = expanded.value;
    expanded.value = rest;
    return;
  }
  if (testingId.value === server.id) return;
  testingId.value = server.id;
  try {
    const r: any = await agentApi.mcpTest(server.id);
    // 后端返回的 error 要展示出来：否则工具为空时界面一片空白，
    // 用户分不清是"还没连上"还是"这个服务真没有工具"。
    testResults.value = { ...testResults.value, [server.id]: { tools: r.tools ?? [], error: r.error ?? "" } };
    expanded.value = { ...expanded.value, [server.id]: true };
  } catch (e) {
    testResults.value = {
      ...testResults.value,
      [server.id]: { tools: [], error: e instanceof Error ? e.message : String(e) },
    };
    expanded.value = { ...expanded.value, [server.id]: true };
  } finally {
    testingId.value = "";
  }
}

onMounted(load);
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex items-center justify-between">
      <span class="text-[12px] text-lo">
        {{ t("mcp.count", { count: servers.length }) }}
      </span>
      <div class="flex items-center gap-2">
        <button @click="startAdd"
          class="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-accent to-accent-deep px-3 py-1.5 text-[12.5px] font-medium text-on-accent">
          <Plus :size="13" /> {{ t("common.add") }}
        </button>
        <button @click="() => load()"
          class="inline-flex items-center gap-1 rounded-lg border border-line bg-ink-2 px-2.5 py-1.5 text-[12px] text-mid transition-colors hover:text-accent">
          <RefreshCw :size="13" :class="loading ? 'animate-spin' : ''" />
        </button>
      </div>
    </div>

    <FilterInput v-model="keyword" />

    <div v-if="loading" class="text-[12px] text-lo">{{ t("common.loading") }}</div>
    <p v-else-if="!filtered.length && servers.length" class="text-[12px] text-lo">{{ t("common.noMatch") }}</p>
    <div v-for="s in filtered" :key="s.id" class="rounded-xl border border-line bg-ink-3/40 p-3">
      <div class="flex items-center gap-2">
        <Server :size="14" class="text-accent" />
        <span class="text-[13px] font-medium text-hi">{{ s.name }}</span>
        <span v-if="s.builtin" class="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">{{ t("common.builtin") }}</span>
        <component :is="healthMeta[s.health]?.icon" :size="13" :class="['shrink-0', healthMeta[s.health]?.cls, s.health === 'connecting' ? 'animate-spin' : '']" />
        <span :class="['text-[11px]', healthMeta[s.health]?.cls]">{{ healthMeta[s.health]?.label }}</span>
        <div class="ml-auto flex gap-1.5">
          <button @click="toggleTools(s)" :disabled="testingId === s.id"
            class="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-mid transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-60">
            <Loader2 v-if="testingId === s.id" :size="11" class="animate-spin" />
            <ChevronDown v-else-if="expanded[s.id]" :size="11" />
            <ChevronRight v-else :size="11" />
            {{ expanded[s.id] ? t("mcp.hideTools") : t("mcp.showTools") }}
          </button>
          <button v-if="!s.builtin" @click="startEdit(s)" class="rounded-md border border-line px-2 py-1 text-[11px] text-mid hover:text-accent">
            <Pencil :size="12" />
          </button>
          <button v-if="!s.builtin" @click="requestRemove(s)" class="rounded-md border border-red-500/30 px-2 py-1 text-[11px] text-red-400 hover:bg-red-500/10">
            <Trash2 :size="12" />
          </button>
        </div>
      </div>
      <p class="mt-1.5 text-[11px] text-lo">{{ t("mcp.toolsCount", { transport: s.transport, count: s.toolCount }) }}<span v-if="s.error" class="text-red-400"> · {{ s.error }}</span></p>
      <!-- 工具列表：只属于这一个服务，由同一个按钮展开/收起 -->
      <div v-if="testingId === s.id" class="mt-2 text-[11px] text-lo">{{ t("mcp.testing") }}</div>
      <template v-else-if="expanded[s.id] && testResults[s.id]">
        <div v-if="testResults[s.id].tools.length" class="mt-2 flex flex-wrap gap-1.5">
          <span v-for="tool in testResults[s.id].tools" :key="tool.name" class="rounded bg-ink-1 px-1.5 py-0.5 font-mono text-[10.5px] text-mid">{{ tool.name }}</span>
        </div>
        <p v-else-if="testResults[s.id].error" class="mt-2 text-[11px] leading-relaxed text-amber-400">{{ testResults[s.id].error }}</p>
        <p v-else class="mt-2 text-[11px] leading-relaxed text-lo">{{ t("mcp.testNoTools") }}</p>
      </template>
    </div>
    <p v-if="!loading && !servers.length" class="text-[12px] text-lo">{{ t("mcp.empty") }}</p>

    <!-- 新增 / 编辑弹窗 -->
    <McpEditorModal
      v-if="editorOpen"
      :server="editingTarget"
      @saved="onSaved"
      @close="editorOpen = false"
    />

    <!-- 删除二次确认 -->
    <ConfirmModal
      v-if="confirmRemove"
      :title="t('mcp.delete.title')"
      :message="t('mcp.delete.message', { name: confirmRemove.name })"
      :confirm-text="t('common.delete')"
      danger
      @confirm="doRemove"
      @close="confirmRemove = null"
    />
  </div>
</template>
