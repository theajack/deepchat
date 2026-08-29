<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { BookOpen, Brain, Loader2, Save, Server, Sparkles, Wrench, UserPlus, Users } from "lucide-vue-next";
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
import { dicebearUrl, randomSeed } from "../utils/avatar";
import { useAppStore } from "../stores/app";
import { useBotsStore } from "../stores/bots";
import { useConversationsStore } from "../stores/conversations";
import { useModelsStore } from "../stores/models";
import { useSettingsStore } from "../stores/settings";
import type { BotMemory, ModelConfig } from "../types";
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

const form = reactive({
  name: "",
  avatar: null as string | null,
  persona: "",
  skills: "",
  model_id: "" as string,
  active_rate: 0.3,
  keywords: "",
  cooldown_seconds: 60,
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
      form.skills = target.skills.join(", ");
      form.model_id = target.model_id ?? "";
      form.active_rate = target.trigger_config.active_rate;
      form.keywords = target.trigger_config.keywords.join(", ");
      form.cooldown_seconds = target.trigger_config.cooldown_seconds;
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
      form.skills = "";
      form.model_id = "";
      form.active_rate = 0.3;
      form.keywords = "";
      form.cooldown_seconds = 60;
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
    // 使用全局默认模型生成人设
    const defaultModelId = settings.values["default_model_id"];
    const model = defaultModelId ? models.items.find((m) => m.id === defaultModelId) : undefined;
    await chatApi.generatePersona(
      {
        name,
        partial: "", // 已通过 form.persona 清空，不再传旧内容
        model_id: model?.id ?? null,
        model_provider: model ? undefined : "mock",
        model_name: model?.model_name ?? "mock-1",
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

async function save() {
  const name = form.name.trim();
  if (!name) {
    app.toast(t("bot.fillNameFirst"));
    return;
  }
  const model = selectedModel();
  if (!model) {
    app.toast(t("bot.chooseModel"));
    return;
  }
  const input = {
    name,
    avatar: form.avatar,
    persona: form.persona.trim(),
    skills: form.skills.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    model_id: model.id,
    model_provider: model.route_id || model.provider,
    model_name: model.model_name,
    trigger_config: {
      active_rate: Number(form.active_rate),
      keywords: form.keywords.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      cooldown_seconds: Number(form.cooldown_seconds),
    },
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
        <label class="mb-1.5 block text-xs text-mid">{{ t("bot.skills") }}</label>
        <input v-model="form.skills" type="text" :placeholder="t('bot.skillsPlaceholder')"
          class="w-full rounded-lg border border-line bg-ink-2/70 px-3 py-2 text-[13px] text-hi outline-none transition-all placeholder:text-lo focus:border-accent/45 focus:shadow-[0_0_0_3px_var(--color-accent-soft)]" />
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
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="mb-1.5 block text-xs text-lo">{{ t("bot.activeRate") }}</label>
            <input v-model.number="form.active_rate" type="number" min="0" max="1" step="0.1"
              class="w-full rounded-lg border border-line bg-ink-2/70 px-3 py-2 text-[13px] text-hi outline-none transition-all focus:border-accent/45" />
          </div>
          <div>
            <label class="mb-1.5 block text-xs text-lo">{{ t("bot.cooldown") }}</label>
            <input v-model.number="form.cooldown_seconds" type="number" min="0" step="1"
              class="w-full rounded-lg border border-line bg-ink-2/70 px-3 py-2 text-[13px] text-hi outline-none transition-all focus:border-accent/45" />
          </div>
        </div>
        <div class="mt-3">
          <label class="mb-1.5 block text-xs text-lo">{{ t("bot.keywords") }}</label>
          <input v-model="form.keywords" type="text" :placeholder="t('bot.keywordsPlaceholder')"
            class="w-full rounded-lg border border-line bg-ink-2/70 px-3 py-2 text-[13px] text-hi outline-none transition-all placeholder:text-lo focus:border-accent/45" />
        </div>
      </div>
      <div class="flex justify-end gap-2 pt-1">
        <button class="rounded-lg border border-line-strong/50 px-4 py-2 text-[13px] text-mid transition-all hover:bg-ink-3 hover:text-hi"
          @click="app.closeBotEditor()">{{ t("common.cancel") }}</button>
        <button class="rounded-lg bg-gradient-to-br from-accent to-accent-deep px-4 py-2 text-[13px] font-semibold text-on-accent shadow-[0_4px_18px_rgba(42,227,164,0.28)] transition-all hover:shadow-[0_4px_24px_var(--color-accent-glow)] hover:brightness-110 active:scale-95"
          @click="save">{{ t("common.save") }}</button>
      </div>
    </div>
  </Modal>

  <ModelEditorModal v-if="showModelEditor" :editing-id="null" @close="showModelEditor = false"
    @saved="(m) => { form.model_id = m.id; showModelEditor = false; }" />
</template>
