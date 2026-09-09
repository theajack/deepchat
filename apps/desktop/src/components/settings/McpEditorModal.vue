<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { Code2, FileInput, Braces } from "lucide-vue-next";
import Modal from "../common/Modal.vue";
import Select from "../common/Select.vue";
import { agentApi, type McpServerInfo } from "../../services/agentApi";
import { t } from "../../i18n";

const props = defineProps<{
  /** 传入则为编辑该服务；null 为新增 */
  server: McpServerInfo | null;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();

const isEdit = computed(() => props.server !== null);
const saving = ref(false);

/** 编辑模式：json（直接编辑 JSON 配置，默认）| form（结构化表单，省事模式） */
const mode = ref<"json" | "form">("json");
const jsonText = ref("");
const jsonError = ref("");

const form = reactive({
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  url: "",
  env: "",
});

/**
 * JSON 编辑框的占位提示：不预填内容，只提示完整字段。
 *
 * 支持两种写法：① 标准 mcpServers 字典（一次可导入多个，key 即服务名，
 * 与 Cursor / Claude Desktop / Cline 通用）；② 单个服务对象。
 * stdio 用 command/args/env，远程用 url/headers（type 可为 http /
 * streamable-http / streamableHttp / sse）；timeout 小于 1000 按秒算。
 */
const JSON_PLACEHOLDER = `{
  "mcpServers": {
    "my-local-server": {
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "env": { "TOKEN": "xxx" },
      "timeout": 60
    },
    "my-remote-server": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer xxx" }
    }
  }
}

// 也可以只写一个服务：
// { "serverName": "my-server", "transport": "stdio", "command": "npx", "args": [] }`;

/** 格式化当前 JSON；解析失败时提示错误而不清空用户输入 */
function formatJson() {
  jsonError.value = "";
  const text = jsonText.value.trim();
  if (!text) {
    jsonError.value = t("mcp.jsonEmpty");
    return;
  }
  try {
    jsonText.value = JSON.stringify(JSON.parse(text), null, 2);
  } catch (e) {
    jsonError.value = `${t("mcp.jsonInvalid")}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 切到表单模式时清掉 JSON 报错，避免残留信息误导 */
function switchToForm() {
  mode.value = "form";
  jsonError.value = "";
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

/** 统一构造提交体：JSON 模式解析文本，表单模式拼字段 */
function buildBody(): Record<string, unknown> | null {
  if (mode.value === "json") return parseJsonDraft();

  if (!form.name.trim()) {
    jsonError.value = t("mcp.nameRequired");
    return null;
  }
  // env 文本框：每行一个 KEY=VALUE
  const env: Record<string, string> = {};
  for (const line of form.env.split("\n")) {
    const raw = line.trim();
    if (!raw) continue;
    const idx = raw.indexOf("=");
    if (idx > 0) env[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
  }
  return {
    name: form.name.trim(),
    transport: form.transport,
    command: form.command || undefined,
    args: form.args ? form.args.split(",").map((s) => s.trim()).filter(Boolean) : [],
    env,
    url: form.url || undefined,
  };
}

/**
 * 预填编辑器。
 *
 * JSON 与表单两种模式都填，方便随时切换微调。编辑态下服务名由后端锁定
 * （决定工具命名空间 mcp__<name>__），这里只用于展示与提交，不可改。
 */
function fill(server: McpServerInfo) {
  const isStdio = server.transport === "stdio";

  // JSON 模式：单个服务对象形式，字段与实际存储一致
  const draft: Record<string, unknown> = {
    serverName: server.serverName ?? server.name,
    transport: isStdio ? "stdio" : "streamable-http",
  };
  if (isStdio) {
    draft.command = server.command ?? "";
    draft.args = server.args ?? [];
    if (server.env !== undefined && Object.keys(server.env).length > 0) draft.env = server.env;
    if (server.cwd !== undefined && server.cwd !== "") draft.cwd = server.cwd;
  } else {
    draft.url = server.url ?? "";
    if (server.headers !== undefined && Object.keys(server.headers).length > 0) draft.headers = server.headers;
  }
  if (server.toolCallTimeoutMs !== undefined) draft.timeout = server.toolCallTimeoutMs;

  // 表单模式
  form.name = server.name;
  form.transport = isStdio ? "stdio" : "http";
  form.command = server.command ?? "";
  form.args = (server.args ?? []).join(",");
  form.url = server.url ?? "";
  form.env = Object.entries(server.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");

  jsonText.value = JSON.stringify(draft, null, 2);
}

onMounted(() => {
  if (props.server !== null) fill(props.server);
});

async function save() {
  if (saving.value) return;
  const body = buildBody();
  if (body === null) return;
  saving.value = true;
  try {
    if (props.server !== null) await agentApi.mcpUpdate(props.server.id, body);
    else await agentApi.mcpAdd(body);
    emit("saved");
  } catch (e) {
    jsonError.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Modal
    :title="isEdit ? t('mcp.editTitle', { name: server!.name }) : t('mcp.addTitle')"
    wide
    @close="emit('close')"
  >
    <div class="flex flex-col gap-3">
      <!-- 编辑态提示：服务名不可改 -->
      <p v-if="isEdit" class="rounded-lg border border-line bg-ink-2/60 p-2.5 text-[11.5px] leading-relaxed text-lo">
        {{ t("mcp.editHint", { name: server!.name }) }}
      </p>

      <!-- 模式切换：JSON（默认） / 表单 -->
      <div class="flex items-center gap-1.5">
        <button @click="mode = 'json'"
          :class="['inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] transition-colors', mode === 'json' ? 'bg-accent/15 text-accent' : 'text-lo hover:text-mid']">
          <Code2 :size="12" /> {{ t("mcp.modeJson") }}
        </button>
        <button @click="switchToForm"
          :class="['inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] transition-colors', mode === 'form' ? 'bg-accent/15 text-accent' : 'text-lo hover:text-mid']">
          <FileInput :size="12" /> {{ t("mcp.modeForm") }}
        </button>
      </div>

      <!-- 结构化表单模式 -->
      <template v-if="mode === 'form'">
        <div class="grid gap-2">
          <label class="text-[11px] text-lo">{{ t("mcp.name") }}</label>
          <input v-model="form.name" :placeholder="t('mcp.name')" :disabled="isEdit"
            class="rounded-lg border border-line bg-ink-2 px-3 py-1.5 text-[12.5px] text-hi outline-none focus:border-accent disabled:opacity-50" />
        </div>
        <div class="grid gap-2">
          <label class="text-[11px] text-lo">{{ t("mcp.transport") }}</label>
          <Select v-model="form.transport" height-class="h-[34px]" :options="[
            { label: 'stdio', value: 'stdio' },
            { label: 'sse', value: 'sse' },
            { label: 'http', value: 'http' },
          ]" />
        </div>
        <div v-if="form.transport === 'stdio'" class="grid gap-2">
          <label class="text-[11px] text-lo">{{ t("mcp.command") }}</label>
          <input v-model="form.command" :placeholder="t('mcp.command')"
            class="rounded-lg border border-line bg-ink-2 px-3 py-1.5 text-[12.5px] text-hi outline-none focus:border-accent" />
        </div>
        <div v-if="form.transport === 'stdio'" class="grid gap-2">
          <label class="text-[11px] text-lo">{{ t("mcp.args") }}</label>
          <input v-model="form.args" :placeholder="t('mcp.args')"
            class="rounded-lg border border-line bg-ink-2 px-3 py-1.5 text-[12.5px] text-hi outline-none focus:border-accent" />
        </div>
        <div v-else class="grid gap-2">
          <label class="text-[11px] text-lo">{{ t("mcp.url") }}</label>
          <input v-model="form.url" :placeholder="t('mcp.url')"
            class="rounded-lg border border-line bg-ink-2 px-3 py-1.5 text-[12.5px] text-hi outline-none focus:border-accent" />
        </div>
        <div class="grid gap-2">
          <label class="text-[11px] text-lo">{{ t("mcp.env") }}</label>
          <textarea v-model="form.env" :placeholder="t('mcp.env')" rows="3"
            class="rounded-lg border border-line bg-ink-2 px-3 py-1.5 font-mono text-[12.5px] text-hi outline-none focus:border-accent"></textarea>
        </div>
      </template>

      <!-- JSON 直接编辑模式（默认） -->
      <template v-else>
        <textarea v-model="jsonText" :placeholder="JSON_PLACEHOLDER" rows="14" spellcheck="false"
          class="w-full rounded-lg border border-line bg-ink-2 px-3 py-2 font-mono text-[12px] leading-relaxed text-hi outline-none placeholder:text-lo/40 focus:border-accent"></textarea>
        <div class="flex items-center justify-between gap-2">
          <span class="font-mono text-[10.5px] text-lo/70">mcpServers 字典（key 即服务名）· 或单个服务对象</span>
          <button @click="formatJson"
            class="ml-auto inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-mid transition-colors hover:border-accent/40 hover:text-accent">
            <Braces :size="11" /> {{ t("mcp.formatJson") }}
          </button>
        </div>
      </template>

      <p v-if="jsonError" class="rounded-lg border border-danger/30 bg-danger/10 p-2 text-[11.5px] leading-relaxed text-danger">{{ jsonError }}</p>
    </div>

    <template #footer>
      <button @click="emit('close')"
        class="rounded-lg border border-line px-4 py-1.5 text-[12.5px] text-mid transition-colors hover:border-accent/40 hover:text-accent">
        {{ t("common.cancel") }}
      </button>
      <button @click="save" :disabled="saving"
        class="rounded-lg bg-accent/90 px-4 py-1.5 text-[12.5px] font-medium text-on-accent transition-opacity disabled:opacity-60">
        {{ saving ? t("common.saving") : t("common.save") }}
      </button>
    </template>
  </Modal>
</template>
