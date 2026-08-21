<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { agentApi, type ToolMeta } from "../../services/agentApi";
import { t } from "../../i18n";

const props = withDefaults(
  defineProps<{ modelValue: string[]; preselectBuiltin?: boolean }>(),
  { preselectBuiltin: false },
);
const emit = defineEmits<{ "update:modelValue": [value: string[]] }>();

const tools = ref<ToolMeta[]>([]);
const loading = ref(true);

const selected = computed(() => new Set(props.modelValue));

const sourceLabel = (source: string) => (source === "builtin" ? t("common.builtin") : source === "mcp" ? t("settings.mcp") : source);

function toggle(name: string) {
  const next = new Set(props.modelValue);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  emit("update:modelValue", [...next]);
}

onMounted(async () => {
  try {
    tools.value = await agentApi.toolListAll();
    // 新建时默认全选内置工具，并附带勾选 web-search 与 skill
    if (props.preselectBuiltin && props.modelValue.length === 0 && tools.value.length > 0) {
      const defaults = tools.value
        .filter((t) => t.source === "builtin" || t.name === "web-search" || t.name === "skill")
        .map((t) => t.name);
      emit("update:modelValue", defaults);
    }
  } catch {
    tools.value = [];
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div>
    <p class="mb-2 text-[11px] text-lo">{{ t("selector.tools") }}</p>
    <div v-if="loading" class="text-[12px] text-lo">{{ t("selector.loadingTools") }}</div>
    <div v-else-if="!tools.length" class="text-[12px] text-lo">{{ t("selector.noTools") }}</div>
    <div v-else class="max-h-56 overflow-y-auto pr-1">
      <label
        v-for="t in tools"
        :key="`${t.source}-${t.name}`"
        class="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-ink-2/60"
      >
        <input
          type="checkbox"
          :checked="selected.has(t.name)"
          @change="toggle(t.name)"
          class="h-3.5 w-3.5 shrink-0 accent-accent"
        />
        <span class="shrink-0 font-mono text-[12px] text-hi">{{ t.name }}</span>
        <span class="shrink-0 rounded bg-ink-1 px-1 py-0.5 text-[9.5px] text-lo">{{ sourceLabel(t.source) }}</span>
        <span class="truncate text-[11px] text-lo">{{ t.label !== t.name ? t.label : t.description.slice(0, 40) }}</span>
      </label>
    </div>
  </div>
</template>
