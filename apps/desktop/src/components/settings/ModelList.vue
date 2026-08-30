<script setup lang="ts">
import { Pencil, Trash2, Plus, Star, MessagesSquare } from "lucide-vue-next";
import { computed, onMounted, ref, watch } from "vue";
import { useModelsStore } from "../../stores/models";
import { useAppStore } from "../../stores/app";
import { useSettingsStore } from "../../stores/settings";
import { chatApi, type GroupJudgeModel } from "../../services/chatApi";
import ConfirmDialog from "../../utils/ConfirmDialog.vue";
import type { ModelConfig } from "../../types";
import { t } from "../../i18n";

const models = useModelsStore();
const app = useAppStore();
const settings = useSettingsStore();

const confirmDialog = ref<InstanceType<typeof ConfirmDialog> | null>(null);

const defaultId = computed(() => settings.values["default_model_id"] ?? "");
/**
 * 群聊调度模型：决定群里轮到谁发言。
 *
 * 存在后端而非 localStorage，所以不能用 settings.values 读，单独拉取。
 * 未显式设置时会依次回落到默认模型、列表首个模型，因此区分两个值：
 * explicitId 用于判断点击是「设置」还是「取消」，effectiveId 用于展示标记。
 */
const groupJudge = ref<GroupJudgeModel>({ id: "", effectiveId: "" });

async function loadGroupJudge() {
  try {
    groupJudge.value = await chatApi.getGroupJudgeModel();
  } catch {
    groupJudge.value = { id: "", effectiveId: "" };
  }
}

/** 生效的调度模型（可能来自回落） */
const effectiveJudgeId = computed(() => groupJudge.value.effectiveId);
/** 是否显式指定过（决定点击行为） */
const isExplicitJudge = (m: ModelConfig) => groupJudge.value.id !== "" && groupJudge.value.id === m.id;

defineProps<{ editingId: string | null }>();
const emit = defineEmits<{ (e: "add"): void; (e: "edit", id: string): void }>();

const PROVIDER_LABELS = computed<Record<string, string>>(() => ({
  custom: t("provider.custom"),
  openai: "OpenAI",
  deepseek: "DeepSeek",
  moonshot: "Moonshot",
  qwen: t("provider.qwen"),
  zhipu: t("provider.zhipu"),
  doubao: t("provider.doubao"),
  hunyuan: t("provider.hunyuan"),
  minimax: "MiniMax",
  siliconflow: t("provider.siliconflow"),
  agnes: "Agnes",
  openrouter: "OpenRouter",
  groq: "Groq",
  together: "Together",
  ollama: "Ollama",
  lmstudio: "LM Studio",
}));

function providerLabel(m: ModelConfig): string {
  return PROVIDER_LABELS.value[m.provider] ?? m.provider;
}

onMounted(async () => {
  if (!models.loaded) await models.load();
  await settings.load();
  await loadGroupJudge();
});

// 模型增删会改变默认模型归属，刷新设置以同步默认标记
watch(
  () => models.items.length,
  async () => {
    await settings.load();
    await loadGroupJudge();
  },
);

async function setDefault(m: ModelConfig) {
  try {
    await chatApi.setDefaultModel(m.id);
    await settings.load();
    // 群聊调度会回落到默认模型，默认模型变了生效值可能跟着变
    await loadGroupJudge();
    app.toast(t("model.setDefault", { name: m.name }));
  } catch (e) {
    app.toast(e instanceof Error ? e.message : String(e));
  }
}

async function setGroupJudge(m: ModelConfig) {
  try {
    // 只在已显式指定该模型时才是「取消」，否则是「设置」
    await chatApi.setGroupJudgeModel(isExplicitJudge(m) ? null : m.id);
    await loadGroupJudge();
    app.toast(isExplicitJudge(m) ? t("model.clearedGroupJudge") : t("model.setGroupJudge", { name: m.name }));
  } catch (e) {
    app.toast(e instanceof Error ? e.message : String(e));
  }
}

async function remove(m: ModelConfig) {
  // Tauri webview 禁用原生 window.confirm，必须走应用内确认弹窗
  const ok = await confirmDialog.value?.ask({
    title: t("model.confirmDeleteTitle", { name: m.name }),
    message: t("model.confirmDelete", { name: m.name }),
    confirmText: t("common.delete"),
    danger: true,
  });
  if (!ok) return;
  try {
    const wasDefault = defaultId.value === m.id;
    const wasJudge = groupJudge.value.id !== "" || groupJudge.value.effectiveId !== "";
    await models.remove(m.id);
    if (wasDefault) await settings.load();
    // 删模型会改变回落链的落点
    if (wasJudge) await loadGroupJudge();
    app.toast(t("model.deleted"));
  } catch (e) {
    app.toast(e instanceof Error ? e.message : String(e));
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex items-center justify-between">
      <span class="text-[12px] text-lo">
        {{ t("model.count", { count: models.items.length }) }}
      </span>
      <button
        class="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-accent to-accent-deep px-3 py-1.5 text-[12.5px] font-medium text-on-accent"
        @click="emit('add')"
      >
        <Plus :size="13" /> {{ t("common.add") }}
      </button>
    </div>

    <div v-if="models.items.length === 0" class="rounded-xl border border-dashed border-line bg-ink-2/40 py-12 text-center">
      <p class="text-sm text-lo">{{ t("model.empty") }}</p>
      <button class="mt-2 text-[13px] text-accent hover:underline" @click="emit('add')">{{ t("model.addFirst") }}</button>
    </div>

    <div v-else class="flex flex-col gap-2.5">
      <div
        v-for="m in models.items"
        :key="m.id"
        class="group flex items-center justify-between rounded-xl border bg-ink-2/50 px-4 py-3.5 transition-all hover:bg-ink-3/40"
        :class="defaultId === m.id ? 'border-accent/50' : 'border-line hover:border-accent/40'"
      >
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="truncate text-[13px] font-medium text-hi">{{ m.name }}</span>
            <span class="shrink-0 rounded-md bg-ink-1/80 px-1.5 py-0.5 text-[10px] text-mid">{{ providerLabel(m) }}</span>
            <span v-if="defaultId === m.id" class="shrink-0 rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">{{ t("model.default") }}</span>
            <!-- 生效的调度模型（可能来自回落）；显式设置时加边框区分 -->
            <span
              v-if="effectiveJudgeId === m.id"
              class="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium"
              :class="isExplicitJudge(m) ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40' : 'bg-emerald-500/10 text-emerald-400/80'"
            >{{ t("model.groupJudge") }}</span>
          </div>
          <p class="mt-0.5 truncate text-xs text-lo">{{ m.model_name || m.base_url || t("model.noModelName") }}</p>
        </div>
        <div class="flex shrink-0 items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
          <button
            class="flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
            :class="defaultId === m.id ? 'text-accent' : 'text-lo hover:bg-ink-1 hover:text-accent'"
            :title="defaultId === m.id ? t('model.isDefault') : t('model.setAsDefault')"
            @click="setDefault(m)"
          >
            <Star :size="15" :fill="defaultId === m.id ? 'currentColor' : 'none'" />
          </button>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
            :class="isExplicitJudge(m) ? 'text-emerald-400' : 'text-lo hover:bg-ink-1 hover:text-emerald-400'"
            :title="isExplicitJudge(m)
              ? t('model.clearGroupJudge')
              : (effectiveJudgeId === m.id ? t('model.setAsGroupJudgeOnly') : t('model.setAsGroupJudge'))"
            @click="setGroupJudge(m)"
          >
            <MessagesSquare
              :size="15"
              :fill="isExplicitJudge(m) ? 'currentColor' : (effectiveJudgeId === m.id ? 'currentColor' : 'none')"
              :class="!isExplicitJudge(m) && effectiveJudgeId === m.id ? 'opacity-40' : ''"
            />
          </button>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-lg text-lo transition-colors hover:bg-ink-1 hover:text-accent"
            :title="t('common.edit')"
            @click="emit('edit', m.id)"
          >
            <Pencil :size="15" />
          </button>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-lg text-lo transition-colors hover:bg-red-500/15 hover:text-red-400"
            :title="t('common.delete')"
            @click="remove(m)"
          >
            <Trash2 :size="15" />
          </button>
        </div>
      </div>
    </div>
    <!-- 删除二次确认（Tauri webview 禁用原生 confirm） -->
    <ConfirmDialog ref="confirmDialog" />
  </div>
</template>
