<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { Server, Plus, Trash2, RefreshCw, CheckCircle2, XCircle, Loader2 } from "lucide-vue-next";
import { agentApi, type McpServerInfo, type McpToolInfo } from "../../services/agentApi";
import Select from "../common/Select.vue";
import { t } from "../../i18n";

const servers = ref<McpServerInfo[]>([]);
const loading = ref(false);
const showAdd = ref(false);
const newTools = ref<McpToolInfo[]>([]);
const testingId = ref("");

const form = reactive({
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  url: "",
  env: "",
});

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

async function add() {
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
  showAdd.value = false;
  form.name = form.command = form.args = form.url = form.env = "";
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

    <div v-if="showAdd" class="grid gap-2 rounded-xl border border-line bg-ink-3/40 p-3">
      <input v-model="form.name" :placeholder="t('mcp.name')"
        class="rounded-lg border border-line bg-ink-2 px-3 py-1.5 text-[12.5px] text-hi outline-none focus:border-accent" />
      <Select
        v-model="form.transport"
        height-class="h-[34px]"
        :options="[
          { label: 'stdio', value: 'stdio' },
          { label: 'sse', value: 'sse' },
          { label: 'http', value: 'http' },
        ]"
      />
      <input v-model="form.command" :placeholder="t('mcp.command')"
        class="rounded-lg border border-line bg-ink-2 px-3 py-1.5 text-[12.5px] text-hi outline-none focus:border-accent" />
      <input v-model="form.args" :placeholder="t('mcp.args')"
        class="rounded-lg border border-line bg-ink-2 px-3 py-1.5 text-[12.5px] text-hi outline-none focus:border-accent" />
      <input v-model="form.url" :placeholder="t('mcp.url')"
        class="rounded-lg border border-line bg-ink-2 px-3 py-1.5 text-[12.5px] text-hi outline-none focus:border-accent" />
      <textarea v-model="form.env" :placeholder="t('mcp.env')" rows="3"
        class="rounded-lg border border-line bg-ink-2 px-3 py-1.5 text-[12.5px] text-hi outline-none focus:border-accent font-mono"></textarea>
      <button @click="add" class="rounded-lg bg-accent/90 px-3 py-1.5 text-[12.5px] font-medium text-on-accent">{{ t("common.save") }}</button>
    </div>

    <div v-if="loading" class="text-[12px] text-lo">{{ t("common.loading") }}</div>
    <div v-for="s in servers" :key="s.id" class="rounded-xl border border-line bg-ink-3/40 p-3">
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
