<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { agentApi, type McpServerInfo } from "../../services/agentApi";
import { t } from "../../i18n";

const props = defineProps<{ modelValue: string[] }>();
const emit = defineEmits<{ "update:modelValue": [value: string[]] }>();

const servers = ref<McpServerInfo[]>([]);
const loading = ref(true);

const selected = computed(() => new Set(props.modelValue));

function toggle(id: string) {
  const next = new Set(props.modelValue);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  emit("update:modelValue", [...next]);
}

onMounted(async () => {
  try {
    servers.value = await agentApi.mcpList();
  } catch {
    servers.value = [];
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div>
    <p class="mb-2 text-[11px] text-lo">{{ t("selector.mcpEmpty") }}</p>
    <div v-if="loading" class="text-[12px] text-lo">{{ t("selector.loadingMcp") }}</div>
    <div v-else-if="!servers.length" class="text-[12px] text-lo">{{ t("mcp.empty") }}</div>
    <div v-else class="max-h-56 overflow-y-auto pr-1">
      <label
        v-for="s in servers"
        :key="s.id"
        class="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-ink-2/60"
      >
        <input
          type="checkbox"
          :checked="selected.has(s.id)"
          @change="toggle(s.id)"
          class="h-3.5 w-3.5 shrink-0 accent-accent"
        />
        <span class="shrink-0 text-[12px] text-hi">{{ s.name }}</span>
        <span v-if="s.builtin" class="shrink-0 rounded bg-accent/15 px-1 py-0.5 text-[9.5px] text-accent">{{ t("common.builtin") }}</span>
        <span class="truncate text-[11px] text-lo">{{ t("mcp.toolsCount", { transport: s.transport, count: s.toolCount }) }}</span>
      </label>
    </div>
  </div>
</template>
