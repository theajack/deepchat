<script setup lang="ts">
import type { Component } from "vue";
import { useUiStore } from "../../stores/ui";
import ResizeHandle from "../common/ResizeHandle.vue";
import { t } from "../../i18n";

const ui = useUiStore();

export interface SettingsSection {
  id: string;
  label: string;
  icon: Component;
  desc: string;
}

defineProps<{
  sections: SettingsSection[];
  active: string;
}>();

defineEmits<{ (e: "select", id: string): void }>();
</script>

<template>
  <nav class="relative flex shrink-0 flex-col gap-1 border-r border-line bg-ink-1/40 p-3" :style="{ width: `${ui.sidebarWidth}px` }">
    <ResizeHandle />
    <h2 class="px-2 py-2 text-sm font-semibold tracking-wide text-hi">{{ t("settings.title") }}</h2>
    <button
      v-for="s in sections"
      :key="s.id"
      class="group flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-all duration-150"
      :class="
        active === s.id
          ? '!bg-accent-soft text-accent'
          : 'text-mid hover:bg-ink-3 hover:text-hi'
      "
      @click="$emit('select', s.id)"
    >
      <component :is="s.icon" :size="16" :stroke-width="1.8" />
      <span class="text-[13px] font-medium">{{ s.label }}</span>
    </button>
  </nav>
</template>
