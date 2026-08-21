<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Wrench as ToolIcon, CheckCircle, XCircle, RefreshCw } from "lucide-vue-next";
import { agentApi, type ToolMeta } from "../../services/agentApi";
import { t as tr } from "../../i18n";

const tools = ref<ToolMeta[]>([]);
const loading = ref(false);
const error = ref("");

const sourceLabel = computed<Record<string, string>>(() => ({
  builtin: tr("common.builtin"),
  skill: tr("settings.skills"),
  mcp: tr("settings.mcp"),
}));
const sourceClass: Record<string, string> = {
  builtin: "bg-accent/15 text-accent",
  skill: "bg-purple-500/15 text-purple-400",
  mcp: "bg-blue-500/15 text-blue-400",
};

async function load() {
  loading.value = true;
  error.value = "";
  try {
    tools.value = await agentApi.toolListAll();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    tools.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  load();
});
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex items-center justify-between">
      <span class="text-[12px] text-lo">
        {{ tr("tools.count", { count: tools.length }) }}
      </span>
      <button @click="load"
        class="inline-flex items-center gap-1 rounded-lg border border-line bg-ink-2 px-2.5 py-1.5 text-[12px] text-mid transition-colors hover:text-accent">
        <RefreshCw :size="13" :class="loading ? 'animate-spin' : ''" />
      </button>
    </div>

    <div v-if="error" class="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[12px] text-red-400">
      {{ error }}
    </div>

    <div v-if="loading" class="text-[12px] text-lo">{{ tr("common.loading") }}</div>
    <div v-else class="grid gap-2">
      <div v-for="t in tools" :key="`${t.source}-${t.name}`"
        class="flex items-start gap-2.5 rounded-xl border border-line bg-ink-3/40 p-2.5">
        <ToolIcon :size="14" class="mt-0.5 shrink-0 text-accent" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="font-mono text-[12.5px] font-medium text-hi">{{ t.name }}</span>
            <span class="rounded px-1.5 py-0.5 text-[10px]" :class="sourceClass[t.source] ?? 'bg-ink-1 text-lo'">
              {{ sourceLabel[t.source] ?? t.source }}
            </span>
            <span v-if="t.server" class="text-[10px] text-lo">{{ t.server }}</span>
            <span v-if="t.available" class="flex items-center gap-0.5 text-[10px] text-emerald-400">
              <CheckCircle :size="10" />
            </span>
            <span v-else class="flex items-center gap-0.5 text-[10px] text-red-400">
              <XCircle :size="10" /> {{ tr("common.offline") }}
            </span>
          </div>
          <p class="mt-0.5 line-clamp-2 text-[11.5px] text-mid">{{ t.description }}</p>
          <p v-if="t.label && t.label !== t.name" class="mt-0.5 text-[10.5px] text-lo">{{ t.label }}</p>
        </div>
      </div>
      <p v-if="!tools.length && !loading" class="text-[12px] text-lo">{{ tr("tools.empty") }}</p>
    </div>
  </div>
</template>
