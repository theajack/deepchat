<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { Server, Plus, Trash2, RefreshCw, CheckCircle2, XCircle, Loader2, Code2, FileInput } from "lucide-vue-next";
import { agentApi, type McpServerInfo, type McpToolInfo } from "../../services/agentApi";
import Select from "../common/Select.vue";
import FilterInput from "../common/FilterInput.vue";
import { t } from "../../i18n";

const servers = ref<McpServerInfo[]>([]);
const loading = ref(false);
const showAdd = ref(false);
const newTools = ref<McpToolInfo[]>([]);
const testingId = ref("");
const keyword = ref("");

/** 添加模式：form（结构化表单）| json（直接编辑 JSON 配置） */
const addMode = ref<"form" | "json">("form");
const jsonText = ref("");
const jsonError = ref("");

/** JSON 模式的示例（一键填充用） */
const JSON_EXAMPLE = `{
  "transport": "stdio",
  "serverName": "filesystem",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
}`;

/** 实时过滤：按名称（大小写不敏感） */
const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase();
  if (!q) return servers.value;
  return servers.value.filter((s) => s.name.toLowerCase().includes(q));
});

const form = reactive({
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  url: "",
  env: "",
});

/** 切到 JSON 模式时预填：把当前表单内容序列化成 JSON，方便微调 */
function switchToJson() {
  addMode.value = "json";
  jsonError.value = "";
  if (jsonText.value.trim() === "") {
    const env: Record<string, string> = {};
    if (form.env.trim()) {
      for (const line of form.env.split("\n")) {
        const raw = line.trim();
        if (!raw) continue;
        const idx = raw.indexOf("=");
        if (idx > 0) env[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
      }
    }
    const draft: Record<string, unknown> = {
      transport: form.transport === "http" || form.transport === "sse" ? "streamable-http" : form.transport,
      serverName: form.name.trim() || "my-server",
    };
    if (form.command.trim()) {
      draft.command = form.command.trim();
      draft.args = form.args ? form.args.split(",").map((s) => s.trim()).filter(Boolean) : [];
      if (Object.keys(env).length > 0) draft.env = env;
    } else if (form.url.trim()) {
      draft.url = form.url.trim();
    }
    jsonText.value = JSON.stringify(draft, null, 2);
  }
}

const healthMeta = computed<Record<string, { label: string; cls: string; icon: any }>>(() => ({
  connected: { label: t("mcp.connected"), cls: "text-emerald-400", icon: CheckCircle2 },
  connecting: { label: t("mcp.connecting"), cls: "text-amber-300", icon: Loader2 },
  error: { label: t("mcp.error"), cls: "text-red-400", icon: XCircle },
  disconnected: { label: t("mcp.disconnected"), cls: "text-lo", icon: Server },
}));

async function load() {
  loading.value = true;
  try {
    servers.value = await agentApi.mcpList();
  } catch {
    servers.value = [];
  } finally {
    loading.value = false;
  }
}

/** 从 JSON 文本解析出提交体；解析失败返回 null 并记录错误 */
function parseJsonDraft(): Record<string, unknown> | null {
  jsonError.value = "";
  const text = jsonText.value.trim();
  if (!text) {
    jsonError.value = t("mcp.jsonEmpty");
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    jsonError.value = `${t("mcp.jsonInvalid")}: ${e instanceof Error ? e.message : String(e)}`;
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    jsonError.value = t("mcp.jsonNotObject");
    return null;
  }
  return parsed as Record<string, unknown>;
}

async function add() {
  if (addMode.value === "json") {
    const body = parseJsonDraft();
    if (body === null) return;
    try {
      await agentApi.mcpAdd(body);
    } catch (e) {
      jsonError.value = e instanceof Error ? e.message : String(e);
      return;
    }
  } else {
    if (!form.name.trim()) return;
    // env 文本框：每行一个 KEY=VALUE
    const env: Record<string, string> = {};
    if (form.env.trim()) {
      for (const line of form.env.split("\n")) {
        const raw = line.trim();
        if (!raw) continue;
        const idx = raw.indexOf("=");
        if (idx > 0) env[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
      }
    }
    await agentApi.mcpAdd({
      name: form.name.trim(),
      transport: form.transport,
      command: form.command || undefined,
      args: form.args ? form.args.split(",").map((s) => s.trim()).filter(Boolean) : [],
      env,
      url: form.url || undefined,
    });
  }
  showAdd.value = false;
  form.name = form.command = form.args = form.url = form.env = "";
  jsonText.value = "";
  await load();
}

async function remove(id: string, builtin?: boolean) {
  if (builtin) return; // 内置服务不可删除
  await agentApi.mcpRemove(id);
  await load();
}

async function test(id: string) {
  testingId.value = id;
  newTools.value = [];
  try {
    const r: any = await agentApi.mcpTest(id);
    newTools.value = r.tools ?? [];
  } catch (e) {
    newTools.value = [];
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
        <button @click="showAdd = !showAdd"
          class="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-accent to-accent-deep px-3 py-1.5 text-[12.5px] font-medium text-on-accent">
          <Plus :size="13" /> {{ t("common.add") }}
        </button>
        <button @click="load"
          class="inline-flex items-center gap-1 rounded-lg border border-line bg-ink-2 px-2.5 py-1.5 text-[12px] text-mid transition-colors hover:text-accent">
          <RefreshCw :size="13" :class="loading ? 'animate-spin' : ''" />
        </button>
      </div>
    </div>

    <FilterInput v-model="keyword" />

    <div v-if="showAdd" class="grid gap-2 rounded-xl border border-line bg-ink-3/40 p-3">
      <!-- 模式切换：表单 / JSON -->
      <div class="flex items-center gap-1.5">
        <button @click="addMode = 'form'"
          :class="['inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] transition-colors', addMode === 'form' ? 'bg-accent/15 text-accent' : 'text-lo hover:text-mid']">
          <FileInput :size="12" /> {{ t("mcp.modeForm") }}
        </button>
        <button @click="switchToJson"
          :class="['inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] transition-colors', addMode === 'json' ? 'bg-accent/15 text-accent' : 'text-lo hover:text-mid']">
          <Code2 :size="12" /> {{ t("mcp.modeJson") }}
        </button>
      </div>

      <!-- 结构化表单模式 -->
      <template v-if="addMode === 'form'">
        <input v-model="form.name" :placeholder="t('mcp.name')"
          class="rounded-lg border border-line bg-ink-2 px-3 py-1.5 text-[12.5px] text-hi outline-none focus:border-accent" />
        <Select v-model="form.transport" height-class="h-[34px]" :options="[
          { label: 'stdio', value: 'stdio' },
          { label: 'sse', value: 'sse' },
          { label: 'http', value: 'http' },
        ]" />
        <input v-if="form.transport === 'stdio'" v-model="form.command" :placeholder="t('mcp.command')"
          class="rounded-lg border border-line bg-ink-2 px-3 py-1.5 text-[12.5px] text-hi outline-none focus:border-accent" />
        <input v-if="form.transport === 'stdio'" v-model="form.args" :placeholder="t('mcp.args')"
          class="rounded-lg border border-line bg-ink-2 px-3 py-1.5 text-[12.5px] text-hi outline-none focus:border-accent" />
        <input v-else v-model="form.url" :placeholder="t('mcp.url')"
          class="rounded-lg border border-line bg-ink-2 px-3 py-1.5 text-[12.5px] text-hi outline-none focus:border-accent" />
        <textarea v-model="form.env" :placeholder="t('mcp.env')" rows="3"
          class="rounded-lg border border-line bg-ink-2 px-3 py-1.5 font-mono text-[12.5px] text-hi outline-none focus:border-accent"></textarea>
      </template>

      <!-- JSON 直接编辑模式 -->
      <template v-else>
        <div class="relative">
          <textarea v-model="jsonText" :placeholder="JSON_EXAMPLE" rows="10" spellcheck="false"
            class="w-full rounded-lg border border-line bg-ink-2 px-3 py-2 font-mono text-[12px] leading-relaxed text-hi outline-none focus:border-accent"></textarea>
        </div>
        <div class="flex items-center justify-between">
          <button @click="jsonText = JSON_EXAMPLE"
            class="text-[11px] text-lo transition-colors hover:text-accent">{{ t("mcp.jsonFillExample") }}</button>
          <span class="font-mono text-[10.5px] text-lo/70">transport · serverName · command/url</span>
        </div>
        <p v-if="jsonError" class="rounded-lg border border-danger/30 bg-danger/10 p-2 text-[11.5px] leading-relaxed text-danger">{{ jsonError }}</p>
      </template>

      <button @click="add" class="rounded-lg bg-accent/90 px-3 py-1.5 text-[12.5px] font-medium text-on-accent">{{ t("common.save") }}</button>
    </div>

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
          <button @click="test(s.id)" class="rounded-md border border-line px-2 py-1 text-[11px] text-mid hover:text-accent">{{ t("common.test") }}</button>
          <button v-if="!s.builtin" @click="remove(s.id, s.builtin)" class="rounded-md border border-red-500/30 px-2 py-1 text-[11px] text-red-400 hover:bg-red-500/10">
            <Trash2 :size="12" />
          </button>
        </div>
      </div>
      <p class="mt-1.5 text-[11px] text-lo">{{ t("mcp.toolsCount", { transport: s.transport, count: s.toolCount }) }}<span v-if="s.error" class="text-red-400"> · {{ s.error }}</span></p>
      <div v-if="testingId === s.id" class="mt-2 text-[11px] text-lo">{{ t("mcp.testing") }}</div>
      <div v-else-if="newTools.length && testingId !== s.id" class="mt-2 flex flex-wrap gap-1.5">
        <span v-for="t in newTools" :key="t.name" class="rounded bg-ink-1 px-1.5 py-0.5 font-mono text-[10.5px] text-mid">{{ t.name }}</span>
      </div>
    </div>
    <p v-if="!loading && !servers.length" class="text-[12px] text-lo">{{ t("mcp.empty") }}</p>
  </div>
</template>
