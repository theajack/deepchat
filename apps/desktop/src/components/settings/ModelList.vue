<script setup lang="ts">
import { Pencil, Trash2, Plus, Star } from "lucide-vue-next";
import { computed, onMounted, watch } from "vue";
import { useModelsStore } from "../../stores/models";
import { useAppStore } from "../../stores/app";
import { useSettingsStore } from "../../stores/settings";
import { chatApi } from "../../services/chatApi";
import type { ModelConfig } from "../../types";
import { t } from "../../i18n";

const models = useModelsStore();
const app = useAppStore();
const settings = useSettingsStore();

const defaultId = computed(() => settings.values["default_model_id"] ?? "");

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
});

// 模型增删会改变默认模型归属，刷新设置以同步默认标记
watch(
  () => models.items.length,
  async () => {
    await settings.load();
  },
);

async function setDefault(m: ModelConfig) {
  try {
    await chatApi.setDefaultModel(m.id);
    await settings.load();
    app.toast(t("model.setDefault", { name: m.name }));
  } catch (e) {
    app.toast(e instanceof Error ? e.message : String(e));
  }
}

async function remove(m: ModelConfig) {
  if (!confirm(t("model.confirmDelete", { name: m.name }))) return;
  try {
    const wasDefault = defaultId.value === m.id;
    await models.remove(m.id);
    if (wasDefault) await settings.load();
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
  </div>
</template>
