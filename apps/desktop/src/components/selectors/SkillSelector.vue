<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { agentApi, type SkillInfo } from "../../services/agentApi";
import { t } from "../../i18n";
import FilterInput from "../common/FilterInput.vue";

const props = defineProps<{ modelValue: string[] }>();
const emit = defineEmits<{ "update:modelValue": [value: string[]] }>();

const skills = ref<SkillInfo[]>([]);
const loading = ref(true);
const keyword = ref("");

const selected = computed(() => new Set(props.modelValue));

/** 实时过滤：按名称 / 描述（大小写不敏感） */
const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase();
  if (!q) return skills.value;
  return skills.value.filter(
    (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q),
  );
});

function toggle(name: string) {
  const next = new Set(props.modelValue);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  emit("update:modelValue", [...next]);
}

onMounted(async () => {
  try {
    const res = await agentApi.skillList();
    skills.value = res.skills;
  } catch {
    skills.value = [];
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div>
    <p class="mb-2 text-[11px] text-lo">{{ t("selector.skillsEmpty") }}</p>
    <FilterInput v-model="keyword" class="mb-2" />
    <div v-if="loading" class="text-[12px] text-lo">{{ t("selector.loadingSkills") }}</div>
    <div v-else-if="!skills.length" class="text-[12px] text-lo">{{ t("skills.empty") }}</div>
    <div v-else-if="!filtered.length" class="text-[12px] text-lo">{{ t("common.noMatch") }}</div>
    <div v-else class="max-h-56 overflow-y-auto pr-1">
      <label
        v-for="s in filtered"
        :key="s.name"
        class="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-ink-2/60"
      >
        <input
          type="checkbox"
          :checked="selected.has(s.name)"
          @change="toggle(s.name)"
          class="h-3.5 w-3.5 shrink-0 accent-accent"
        />
        <span class="shrink-0 font-mono text-[12px] text-hi">{{ s.name }}</span>
        <span v-if="s.builtin" class="shrink-0 rounded bg-accent/15 px-1 py-0.5 text-[9.5px] text-accent">{{ t("common.builtin") }}</span>
        <span class="truncate text-[11px] text-lo">{{ s.description }}</span>
      </label>
    </div>
  </div>
</template>
