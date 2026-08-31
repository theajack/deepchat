<script setup lang="ts">
import { Pencil, Trash2, Plus, Star, Sparkles, Search, X, BarChart3 } from "lucide-vue-next";
import { computed, onMounted, ref, watch } from "vue";
import { useModelsStore } from "../../stores/models";
import { useAppStore } from "../../stores/app";
import { useSettingsStore } from "../../stores/settings";
import { chatApi, type GeneralModel } from "../../services/chatApi";
import ConfirmDialog from "../../utils/ConfirmDialog.vue";
import HoverTip from "../common/HoverTip.vue";
import TokenUsageModal from "./TokenUsageModal.vue";
import type { ModelConfig } from "../../types";
import { t } from "../../i18n";

const models = useModelsStore();
const app = useAppStore();
const settings = useSettingsStore();

const confirmDialog = ref<InstanceType<typeof ConfirmDialog> | null>(null);
/** Token 消耗弹窗 */
const showUsage = ref(false);

const defaultId = computed(() => settings.values["default_model_id"] ?? "");
/**
 * 通用处理模型：用于生成人设 / 自我介绍 / 群聊介绍这类编辑辅助调用。
 *
 * 存在后端而非 localStorage，所以不能用 settings.values 读，单独拉取。
 * 未显式设置时会依次回落到 AI 好友默认使用模型、列表首个模型，因此区分两个值：
 * id 用于判断点击是「设置」还是「取消」，effectiveId 用于展示标记。
 */
const general = ref<GeneralModel>({ id: "", effectiveId: "" });

async function loadGeneral() {
  try {
    general.value = await chatApi.getGeneralModel();
  } catch {
    general.value = { id: "", effectiveId: "" };
  }
}

/** 生效的通用处理模型（可能来自回落） */
const effectiveGeneralId = computed(() => general.value.effectiveId);
/** 是否显式指定过（决定点击行为） */
const isExplicitGeneral = (m: ModelConfig) => general.value.id !== "" && general.value.id === m.id;

/** 搜索关键词：同时匹配显示名、模型 ID 与供应商模型名 */
const keyword = ref("");
const filteredModels = computed(() => {
  const q = keyword.value.trim().toLowerCase();
  if (q === "") return models.items;
  return models.items.filter(
    (m) =>
      m.name.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q) ||
      m.model_name.toLowerCase().includes(q),
  );
});

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
  await loadGeneral();
});

// 模型增删会改变默认模型归属，刷新设置以同步默认标记
watch(
  () => models.items.length,
  async () => {
    await settings.load();
    await loadGeneral();
  },
);

async function setDefault(m: ModelConfig) {
  try {
    await chatApi.setDefaultModel(m.id);
    await settings.load();
    // 通用处理模型会回落到默认模型，默认模型变了生效值可能跟着变
    await loadGeneral();
    app.toast(t("model.setDefault", { name: m.name }));
  } catch (e) {
    app.toast(e instanceof Error ? e.message : String(e));
  }
}

async function setGeneral(m: ModelConfig) {
  try {
    // 只在已显式指定该模型时才是「取消」，否则是「设置」
    await chatApi.setGeneralModel(isExplicitGeneral(m) ? null : m.id);
    await loadGeneral();
    app.toast(isExplicitGeneral(m) ? t("model.clearedGeneral") : t("model.setGeneral", { name: m.name }));
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
    const wasGeneral = general.value.id !== "" || general.value.effectiveId !== "";
    await models.remove(m.id);
    if (wasDefault) await settings.load();
    // 删模型会改变回落链的落点
    if (wasGeneral) await loadGeneral();
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
        {{ t("model.count", { count: filteredModels.length }) }}
      </span>
      <div class="flex items-center gap-2">
        <button
          class="inline-flex items-center gap-1.5 rounded-lg border border-line-strong/50 px-3 py-1.5 text-[12.5px] text-mid transition-colors hover:bg-ink-3 hover:text-accent"
          :title="t('model.tokenUsage')"
          @click="showUsage = true"
        >
          <BarChart3 :size="13" /> {{ t("model.tokenUsage") }}
        </button>
        <button
          class="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-accent to-accent-deep px-3 py-1.5 text-[12.5px] font-medium text-on-accent"
          @click="emit('add')"
        >
          <Plus :size="13" /> {{ t("common.add") }}
        </button>
      </div>
    </div>

    <div v-if="models.items.length === 0" class="rounded-xl border border-dashed border-line bg-ink-2/40 py-12 text-center">
      <p class="text-sm text-lo">{{ t("model.empty") }}</p>
      <button class="mt-2 text-[13px] text-accent hover:underline" @click="emit('add')">{{ t("model.addFirst") }}</button>
    </div>

    <template v-else>
      <!-- 搜索：匹配模型名称 / ID / 供应商模型名 -->
      <div class="relative">
        <Search :size="13" class="absolute top-1/2 left-3 -translate-y-1/2 text-lo" />
        <input
          v-model="keyword"
          type="text"
          :placeholder="t('model.search')"
          class="w-full rounded-lg border border-line bg-ink-1/80 py-1.5 pr-8 pl-8 text-xs text-hi outline-none transition-colors placeholder:text-lo focus:border-accent/40"
        />
        <button
          v-if="keyword !== ''"
          class="absolute top-1/2 right-2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-lo transition-colors hover:bg-ink-3 hover:text-hi"
          :title="t('model.clearSearch')"
          @click="keyword = ''"
        >
          <X :size="12" />
        </button>
      </div>

      <div v-if="filteredModels.length === 0" class="rounded-xl border border-dashed border-line bg-ink-2/40 py-10 text-center">
        <p class="text-sm text-lo">{{ t("model.noMatch") }}</p>
      </div>

      <div v-else class="flex flex-col gap-2.5">
        <div
          v-for="m in filteredModels"
          :key="m.id"
          class="group flex items-center justify-between rounded-xl border bg-ink-2/50 px-4 py-3.5 transition-all hover:bg-ink-3/40"
          :class="defaultId === m.id ? 'border-accent/50' : 'border-line hover:border-accent/40'"
        >
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="truncate text-[13px] font-medium text-hi">{{ m.name }}</span>
              <span class="shrink-0 rounded-md bg-ink-1/80 px-1.5 py-0.5 text-[10px] text-mid">{{ providerLabel(m) }}</span>
              <span v-if="defaultId === m.id" class="shrink-0 rounded-md bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">{{ t("model.default") }}</span>
              <!-- 生效的通用处理模型（可能来自回落）；显式设置时加边框区分 -->
              <span
                v-if="effectiveGeneralId === m.id"
                class="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium"
                :class="isExplicitGeneral(m) ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40' : 'bg-emerald-500/10 text-emerald-400/80'"
              >{{ t("model.general") }}</span>
            </div>
            <p class="mt-0.5 truncate text-xs text-lo">{{ m.model_name || m.base_url || t("model.noModelName") }}</p>
          </div>
          <div class="flex shrink-0 items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
            <HoverTip
              :content="defaultId === m.id ? t('model.isDefault') : t('model.setAsDefault')"
              placement="top"
              :delay="200"
            >
              <button
                class="flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
                :class="defaultId === m.id ? 'text-accent' : 'text-lo hover:bg-ink-1 hover:text-accent'"
                @click="setDefault(m)"
              >
                <Star :size="15" :fill="defaultId === m.id ? 'currentColor' : 'none'" />
              </button>
            </HoverTip>
            <HoverTip
              :content="isExplicitGeneral(m)
                ? t('model.clearGeneral')
                : (effectiveGeneralId === m.id ? t('model.setAsGeneralOnly') : t('model.setAsGeneral'))"
              placement="top"
              :delay="200"
            >
              <button
                class="flex h-8 w-8 items-center justify-center rounded-lg transition-colors"
                :class="isExplicitGeneral(m) ? 'text-emerald-400' : 'text-lo hover:bg-ink-1 hover:text-emerald-400'"
                @click="setGeneral(m)"
              >
                <Sparkles
                  :size="15"
                  :fill="isExplicitGeneral(m) ? 'currentColor' : (effectiveGeneralId === m.id ? 'currentColor' : 'none')"
                  :class="!isExplicitGeneral(m) && effectiveGeneralId === m.id ? 'opacity-40' : ''"
                />
              </button>
            </HoverTip>
            <HoverTip :content="t('common.edit')" placement="top" :delay="200">
              <button
                class="flex h-8 w-8 items-center justify-center rounded-lg text-lo transition-colors hover:bg-ink-1 hover:text-accent"
                @click="emit('edit', m.id)"
              >
                <Pencil :size="15" />
              </button>
            </HoverTip>
            <HoverTip :content="t('common.delete')" placement="top" :delay="200">
              <button
                class="flex h-8 w-8 items-center justify-center rounded-lg text-lo transition-colors hover:bg-red-500/15 hover:text-red-400"
                @click="remove(m)"
              >
                <Trash2 :size="15" />
              </button>
            </HoverTip>
          </div>
        </div>
      </div>
    </template>
    <!-- 删除二次确认（Tauri webview 禁用原生 confirm） -->
    <ConfirmDialog ref="confirmDialog" />
    <!-- Token 消耗统计 -->
    <TokenUsageModal v-if="showUsage" @close="showUsage = false" />
  </div>
</template>
