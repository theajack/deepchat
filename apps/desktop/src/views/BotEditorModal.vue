<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { BookOpen, Brain, FolderOpen, Loader2, Save, Server, Sparkles, Wrench, UserPlus, Users } from "lucide-vue-next";
import Modal from "../components/common/Modal.vue";
import ModelEditorModal from "../components/settings/ModelEditorModal.vue";
import GroupForm from "../components/contacts/GroupForm.vue";
import BotAgentFields from "../components/contacts/BotAgentFields.vue";
import ToolSelector from "../components/selectors/ToolSelector.vue";
import SkillSelector from "../components/selectors/SkillSelector.vue";
import McpSelector from "../components/selectors/McpSelector.vue";
import BotAvatar from "../components/common/BotAvatar.vue";
import Select from "../components/common/Select.vue";
import { chatApi } from "../services/chatApi";
import { agentApi } from "../services/agentApi";
import { dicebearUrl, randomSeed } from "../utils/avatar";
import { useAppStore } from "../stores/app";
import { useBotsStore } from "../stores/bots";
import { useConversationsStore } from "../stores/conversations";
import { useModelsStore } from "../stores/models";
import { useSettingsStore } from "../stores/settings";
import type { BotMemory, ModelConfig, ModelProvider } from "../types";
import { t } from "../i18n";

const app = useAppStore();
const bots = useBotsStore();
const conversations = useConversationsStore();
const models = useModelsStore();
const settings = useSettingsStore();
const generating = ref(false);

const showModelEditor = ref(false);
const tab = ref<"bot" | "group">("bot");
const agentTab = ref<"tools" | "skills" | "mcp">("tools");
const agentTabs = computed(() => [
  { value: "tools", label: t("settings.tools"), icon: Wrench },
  { value: "skills", label: t("settings.skills"), icon: BookOpen },
  { value: "mcp", label: t("settings.mcp"), icon: Server },
] as const);

/**
 * 主动发言的空闲窗口默认落在 5–10 分钟。
 * 随机化是为了让多个开启主动发言的好友错开节奏，不至于同时开口。
 */
function randomIdleMinutes(): number {
  return 5 + Math.floor(Math.random() * 6)
}

const form = reactive({
  name: "",
  avatar: null as string | null,
  persona: "",
  model_id: "" as string,
  // 群聊触发：默认不主动开口，勾选后按空闲窗口发言
  auto_speak: false,
  idle_trigger_minutes: randomIdleMinutes(),
  // 工作目录：留空 = 沿用后端默认目录
  workspace_dir: "" as string,
  // Agent 能力
  agent_enabled: 1,
  max_turns: 50,
  approval_policy: "allow",
  enabled_tools: [] as string[],
  enabled_skills: [] as string[],
  enabled_mcp_servers: [] as string[],
});

const isNew = computed(() => app.editingBot === "new");
const title = computed(() => (isNew.value ? t("bot.new") : t("bot.edit")));

async function ensureModels() {
  if (!models.loaded) await models.load();
  if (!settings.loaded) await settings.load();
}

watch(
  () => app.editingBot,
  async (target) => {
    tab.value = "bot";
    if (target && target !== "new") {
      form.name = target.name;
      form.avatar = target.avatar ?? null;
      form.persona = target.persona;
      form.model_id = target.model_id ?? "";
      form.auto_speak = target.trigger_config.auto_speak === true;
      form.idle_trigger_minutes = target.trigger_config.idle_trigger_minutes ?? randomIdleMinutes();
      form.workspace_dir = target.workspace_dir ?? "";
      form.agent_enabled = target.agent_enabled ?? 0;
      form.max_turns = target.max_turns ?? 50;
      form.approval_policy = target.approval_policy ?? "allow";
      form.enabled_tools = [...(target.enabled_tools ?? [])];
      form.enabled_skills = [...(target.enabled_skills ?? [])];
      form.enabled_mcp_servers = [...(target.enabled_mcp_servers ?? [])];
    } else {
      form.name = "";
      // 弹窗打开时随机生成 ID，作为默认头像
      form.avatar = dicebearUrl("bottts-neutral", randomSeed());
      form.persona = "";
      form.model_id = "";
      form.auto_speak = false;
      form.idle_trigger_minutes = randomIdleMinutes();
      form.workspace_dir = "";
      form.agent_enabled = 1;
      form.max_turns = 50;
      form.approval_policy = "allow";
      form.enabled_tools = [];
      form.enabled_skills = [];
      form.enabled_mcp_servers = [];
    }
    memory.value = null;
    memoryDraft.value = "";
    memoryLoading.value = false;
    await ensureModels();
    if (!isNew.value) void loadMemory();
    // 新建时默认选中模型列表中的默认模型
    if (isNew.value && !form.model_id) {
      const defaultId = settings.values["default_model_id"];
      if (defaultId && models.items.some((m) => m.id === defaultId)) {
        form.model_id = defaultId;
      }
    }
  },
  { immediate: true },
);

// ── 长期记忆：跨会话持久，清空对话不丢失 ──────────────────────────────────
const memory = ref<BotMemory | null>(null);
const memoryDraft = ref("");
const memoryLoading = ref(false);
const memorySaving = ref(false);

async function loadMemory() {
  const target = app.editingBot;
  if (!target || target === "new") return;
  memoryLoading.value = true;
  try {
    const loaded = await chatApi.getBotMemory(target.id);
    memory.value = loaded;
    memoryDraft.value = loaded.text;
  } catch (e) {
    app.toast(e instanceof Error ? e.message : String(e));
  } finally {
    memoryLoading.value = false;
  }
}

async function saveMemory() {
  const target = app.editingBot;
  if (!target || target === "new" || memorySaving.value) return;
  memorySaving.value = true;
  try {
    const saved = await chatApi.setBotMemory(target.id, memoryDraft.value);
    memory.value = saved;
    memoryDraft.value = saved.text;
  } catch (e) {
    app.toast(e instanceof Error ? e.message : String(e));
  } finally {
    memorySaving.value = false;
  }
}

function formatMemoryTime(ms: number | null): string {
  if (ms === null) return t("bot.memoryNever");
  return new Date(ms).toLocaleString();
}

async function onGroupCreated(convId: string) {
  app.closeBotEditor();
  app.navigate("chat");
  await conversations.select(convId);
}

function selectedModel(): ModelConfig | undefined {
  return form.model_id ? models.items.find((m) => m.id === form.model_id) : undefined;
}

async function generatePersona() {
  const name = form.name.trim();
  if (!name) {
    app.toast(t("bot.fillNameFirst"));
    return;
  }
  if (generating.value) return;
  generating.value = true;
  // 立即清空旧人设，流式输出新内容
  form.persona = "";
  try {
    // 使用通用处理模型生成人设（未显式设置时后端回落到 AI 好友默认使用模型）
    const { effectiveId } = await chatApi.getGeneralModel();
    await chatApi.generatePersona(
      {
        name,
        partial: "", // 已通过 form.persona 清空，不再传旧内容
        model_id: effectiveId === "" ? null : effectiveId,
      },
      (delta) => {
        form.persona = (form.persona + delta).trim();
      },
    );
  } catch (e) {
    app.toast(t("bot.generateFailed", { msg: e instanceof Error ? e.message : String(e) }));
  } finally {
    generating.value = false;
  }
}

/**
 * 工作目录只能在新建时指定：好友落库后，agent 会话的 cwd、文件工具沙箱与
 * 长期记忆都已绑定到该目录，中途改指向会让既有记忆与文件凭空"消失"。
 */
/** 用系统默认程序打开该好友的工作目录 */
async function openWorkspaceDir() {
  const dir = form.workspace_dir.trim()
  if (dir === "") return
  try {
    await agentApi.toolOpenDir(dir)
  } catch {
    app.toast(t("dataDir.openFailed"))
  }
}

async function pickWorkspaceDir() {
  if (!isNew.value) return
  try {
    // 从当前值出发，未填时从默认目录出发
    const start =
      form.workspace_dir.trim() !== ""
        ? form.workspace_dir
        : await chatApi.getDefaultWorkspaceDir().catch(() => undefined);
    const picked = await agentApi.pickDir(start);
    if (picked) form.workspace_dir = picked;
  } catch (e) {
    // 非 Tauri 环境（浏览器开发）不支持原生对话框
    app.toast(e instanceof Error ? e.message : String(e));
  }
}

/** 六位随机小写字母：默认名后缀（好友Xyabzc），避免重名 */
function randomSuffix(): string {
  return Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
}

async function save() {
  // 名称非必填：留空时生成「好友+六位随机字母」
  const name = form.name.trim() || `${t("bot.defaultNamePrefix")}${randomSuffix()}`;
  const model = selectedModel();
  if (!model) {
    app.toast(t("bot.chooseModel"));
    return;
  }
  const input = {
    name,
    avatar: form.avatar,
    persona: form.persona.trim(),
    model_id: model.id,
    // 后端 provider 字段实际存的是模型路由 id（按路由解析真实供应商），
    // 与 ModelProvider 的字面量联合不对应，按后端契约断言。
    model_provider: (model.route_id || model.provider) as ModelProvider,
    model_name: model.model_name,
    trigger_config: {
      auto_speak: form.auto_speak,
      idle_trigger_minutes: Number(form.idle_trigger_minutes),
    },
    // 工作目录只在新建时下发。编辑时后端已有值，传 null 会被当成"清空"，
    // 所以整字段不传（后端 update 只改显式给出的字段）。
    ...(isNew.value ? { workspace_dir: form.workspace_dir.trim() || null } : {}),
    agent_enabled: Number(form.agent_enabled),
    max_turns: Number(form.max_turns),
    approval_policy: form.approval_policy,
    enabled_tools: form.enabled_tools,
    enabled_skills: form.enabled_skills,
    enabled_mcp_servers: form.enabled_mcp_servers,
  };
  try {
    if (isNew.value) {
      const bot = await bots.create(input);
      const conv = await conversations.createPrivate(bot.id);
      app.closeBotEditor();
      app.navigate("chat");
      await conversations.select(conv.id);
    } else if (app.editingBot && app.editingBot !== "new") {
      await bots.update(app.editingBot.id, input);
      app.closeBotEditor();
      app.toast(t("common.saved"));
    }
  } catch (e) {
    app.toast(e instanceof Error ? e.message : String(e));
  }
}
</script>

<template>
  <Modal v-if="app.editingBot" :title="tab === 'bot' ? title : t('contacts.startGroup')" wide @close="app.closeBotEditor()">
    <!-- 顶部 Tab 切换（仅新建时显示，编辑时隐藏） -->
    <div v-if="isNew" class="mb-5 inline-flex w-full rounded-xl border border-line bg-ink-1/60 p-1">
      <button
        type="button"
        class="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-all"
        :class="tab === 'bot' ? 'border border-accent/50 bg-accent-soft text-accent shadow-[0_3px_14px_rgba(42,227,164,0.12)]' : 'text-mid hover:bg-ink-3 hover:text-hi'"
        @click="tab = 'bot'"
      ><UserPlus :size="15" :stroke-width="1.8" />{{ t("bot.newFriend") }}</button>
      <button
        type="button"
        class="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-all"
        :class="tab === 'group' ? 'border border-accent/50 bg-accent-soft text-accent shadow-[0_3px_14px_rgba(42,227,164,0.12)]' : 'text-mid hover:bg-ink-3 hover:text-hi'"
        @click="tab = 'group'"
      ><Users :size="15" :stroke-width="1.8" />{{ t("contacts.startGroup") }}</button>
    </div>

    <GroupForm
      v-if="tab === 'group'"
      @cancel="app.closeBotEditor()"
      @created="onGroupCreated"
    />

    <div v-else class="flex flex-col gap-4">
      <div class="flex flex-col items-center">
        <BotAvatar v-model="form.avatar" :size="76" />
      </div>
      <div>
        <label class="mb-1.5 block text-xs text-mid">{{ t("bot.name") }}</label>
        <input v-model="form.name" type="text" :placeholder="t('bot.namePlaceholder')"
          class="w-full rounded-lg border border-line bg-ink-2/70 px-3 py-2 text-[13px] text-hi outline-none transition-all placeholder:text-lo focus:border-accent/45 focus:shadow-[0_0_0_3px_var(--color-accent-soft)]" />
      </div>
      <div>
        <div class="mb-1.5 flex items-center justify-between">
          <label class="text-xs text-mid">{{ t("bot.persona") }}</label>
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-md border border-line-strong/50 bg-ink-2/70 px-2.5 py-1 text-[11px] text-mid transition-all hover:border-accent/40 hover:bg-ink-3 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="generating || !form.name.trim()"
            :title="form.name.trim() ? t('bot.generatePersonaTitle') : t('bot.fillNameFirst')"
            @click="generatePersona"
          >
            <svg v-if="generating" class="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2.5" stroke-dasharray="16 42" stroke-linecap="round"/></svg>
            <Sparkles v-else :size="12" />
            {{ generating ? t("bot.generating") : t("bot.generatePersona") }}
          </button>
        </div>
        <textarea v-model="form.persona" rows="3" :placeholder="t('bot.personaPlaceholder')"
          :disabled="generating"
          class="w-full resize-none rounded-lg border border-line bg-ink-2/70 px-3 py-2 text-[13px] text-hi outline-none transition-all placeholder:text-lo focus:border-accent/45 focus:shadow-[0_0_0_3px_var(--color-accent-soft)] disabled:opacity-50" />
      </div>

      <!-- 长期记忆：清空对话时自动沉淀，不会随聊天记录丢失 -->
      <div v-if="!isNew">
        <div class="mb-1.5 flex items-center justify-between">
          <label class="flex items-center gap-1.5 text-xs text-mid">
            <Brain :size="12" class="text-accent" />
            {{ t("bot.memory") }}
          </label>
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-md border border-line-strong/50 bg-ink-2/70 px-2.5 py-1 text-[11px] text-mid transition-all hover:border-accent/40 hover:bg-ink-3 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="memoryLoading || memorySaving"
            @click="saveMemory"
          >
            <Loader2 v-if="memorySaving" :size="12" class="animate-spin" />
            <Save v-else :size="12" />
            {{ memorySaving ? t("common.saving") : t("bot.saveMemory") }}
          </button>
        </div>
        <div v-if="memoryLoading" class="flex items-center justify-center gap-2 py-6 text-[11px] text-lo">
          <Loader2 :size="13" class="animate-spin text-accent" /> {{ t("common.loading") }}
        </div>
        <template v-else>
          <textarea v-model="memoryDraft" rows="7" :placeholder="t('bot.memoryPlaceholder')"
            class="w-full resize-none rounded-lg border border-line bg-ink-2/70 px-3 py-2 font-mono text-[12px] leading-relaxed text-hi outline-none transition-all placeholder:text-lo focus:border-accent/45 focus:shadow-[0_0_0_3px_var(--color-accent-soft)]" />
          <p class="mt-1.5 text-[11px] leading-relaxed text-lo">
            {{ t("bot.memoryHint") }}
            <span class="text-mid">{{ t("bot.memoryUpdatedAt", { time: formatMemoryTime(memory?.updatedAt ?? null) }) }}</span>
          </p>
        </template>
      </div>

      <div>
        <label class="mb-1.5 block text-xs text-mid">{{ t("bot.model") }}</label>
        <div class="flex gap-2">
          <Select
            v-model="form.model_id"
            width-class="min-w-0 flex-1"
            height-class="h-[38px]"
            text-class="text-[13px]"
            :placeholder="t('bot.chooseModel')"
            :options="models.items.map((m) => ({ label: m.name, value: m.id, hint: m.model_name }))"
          />
          <button type="button"
            class="shrink-0 rounded-lg border border-line-strong/50 bg-ink-2/70 px-3 py-2 text-[13px] text-mid transition-all hover:border-accent/40 hover:bg-ink-3 hover:text-accent"
            @click="showModelEditor = true">{{ t("bot.newModel") }}</button>
        </div>
        <p v-if="models.items.length === 0" class="mt-1.5 text-[11px] text-lo">
          {{ t("bot.noModel") }}
        </p>
      </div>
      <BotAgentFields :form="form" />

      <!-- 工具 / 技能 / MCP 选择（Agent 启用时显示） -->
      <div v-if="form.agent_enabled" class="rounded-xl border border-line bg-ink-1/40 p-3.5">
        <div class="mb-3 inline-flex w-full rounded-xl border border-line bg-ink-1/60 p-1">
          <button
            v-for="opt in agentTabs"
            :key="opt.value"
            type="button"
            class="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-all"
            :class="
              agentTab === opt.value
                ? 'border border-accent/50 bg-accent-soft text-accent shadow-[0_3px_14px_rgba(42,227,164,0.12)]'
                : 'text-mid hover:bg-ink-3 hover:text-hi'
            "
            @click="agentTab = opt.value"
          >
            <component :is="opt.icon" :size="15" :stroke-width="1.8" />
            {{ opt.label }}
          </button>
        </div>
        <ToolSelector v-if="agentTab === 'tools'" v-model="form.enabled_tools" :preselect-builtin="isNew" />
        <SkillSelector v-else-if="agentTab === 'skills'" v-model="form.enabled_skills" />
        <McpSelector v-else v-model="form.enabled_mcp_servers" />
      </div>

      <div class="rounded-xl border border-line bg-ink-2/40 p-4">
        <p class="mb-3 flex items-center gap-1.5 text-xs font-medium text-mid">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
          </svg>
          {{ t("bot.groupTrigger") }}
        </p>
        <label class="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-ink-1/40 px-3 py-2.5 transition-colors hover:bg-ink-1/70">
          <input v-model="form.auto_speak" type="checkbox"
            class="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-accent" />
          <span class="min-w-0">
            <span class="block text-[12px] text-mid">{{ t("bot.autoSpeak") }}</span>
            <span class="mt-0.5 block text-[11px] leading-relaxed text-lo">{{ t("bot.autoSpeakHint") }}</span>
          </span>
        </label>
        <!-- 触发时间只在允许主动发言时才有意义，未勾选时不占据视线 -->
        <div v-if="form.auto_speak" class="mt-3">
          <label class="mb-1.5 block text-xs text-lo">{{ t("bot.idleTriggerMinutes") }}</label>
          <input v-model.number="form.idle_trigger_minutes" type="number" min="1" max="1440" step="1"
            class="w-full rounded-lg border border-line bg-ink-2/70 px-3 py-2 text-[13px] text-hi outline-none transition-all focus:border-accent/45" />
          <p class="mt-1.5 text-[11px] leading-relaxed text-lo">{{ t("bot.idleTriggerHint") }}</p>
        </div>
      </div>

      <!-- 工作目录：仅新建时可指定（点击选择系统目录）；编辑时只读展示 -->
      <div>
        <label class="mb-1.5 flex items-center gap-1.5 text-xs text-mid">
          {{ t("bot.workspaceDir") }}
          <span v-if="!isNew" class="rounded border border-line px-1 py-px text-[10px] text-lo">{{ t("common.readOnly") }}</span>
        </label>
        <div class="flex items-center gap-2">
          <input
            :value="form.workspace_dir"
            type="text"
            readonly
            :placeholder="t('bot.workspaceDirPlaceholder')"
            :class="isNew ? 'cursor-pointer hover:border-accent/45' : 'cursor-not-allowed opacity-60'"
            class="min-w-0 flex-1 truncate rounded-lg border border-line bg-ink-2/70 px-3 py-2 font-mono text-[12px] text-hi outline-none transition-all placeholder:text-lo focus:border-accent/45"
            @click="pickWorkspaceDir"
          />
          <button
            v-if="isNew"
            type="button"
            class="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-ink-2 px-3 py-2 text-[12px] text-mid transition-colors hover:border-accent/45 hover:text-accent"
            @click="pickWorkspaceDir"
          >
            <FolderOpen :size="13" />
            {{ t("bot.workspaceDirBrowse") }}
          </button>
          <button
            v-if="isNew && form.workspace_dir"
            type="button"
            class="shrink-0 cursor-pointer rounded-lg border border-line px-2.5 py-2 text-[12px] text-lo transition-colors hover:text-hi"
            :title="t('bot.workspaceDirClear')"
            @click="form.workspace_dir = ''"
          >
            ×
          </button>
          <!-- 已存在的好友：目录已落盘，提供"打开"便于直接查看/管理 -->
          <button
            v-if="!isNew"
            type="button"
            class="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-ink-2 px-3 py-2 text-[12px] text-mid transition-colors hover:border-accent/45 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="!form.workspace_dir.trim()"
            :title="t('bot.workspaceDirOpen')"
            @click="openWorkspaceDir"
          >
            <FolderOpen :size="13" />
            {{ t("bot.workspaceDirOpen") }}
          </button>
        </div>
        <p class="mt-1.5 text-[11px] leading-relaxed text-lo">
          {{ isNew ? t("bot.workspaceDirHint") : t("bot.workspaceDirLockedHint") }}
        </p>
      </div>
    </div>

    <!-- 群聊 tab 由 GroupForm 自带的 Modal 接管（自带 footer），此处不重复显示 -->
    <template v-if="tab !== 'group'" #footer>
      <button class="rounded-lg border border-line-strong/50 px-4 py-2 text-[13px] text-mid transition-all hover:bg-ink-3 hover:text-hi"
        @click="app.closeBotEditor()">{{ t("common.cancel") }}</button>
      <button class="rounded-lg bg-gradient-to-br from-accent to-accent-deep px-4 py-2 text-[13px] font-semibold text-on-accent shadow-[0_4px_18px_rgba(42,227,164,0.28)] transition-all hover:shadow-[0_4px_24px_var(--color-accent-glow)] hover:brightness-110 active:scale-95"
        @click="save">{{ t("common.save") }}</button>
    </template>
  </Modal>

  <ModelEditorModal v-if="showModelEditor" :editing-id="null" @close="showModelEditor = false"
    @saved="(m) => { form.model_id = m.id; showModelEditor = false; }" />
</template>
