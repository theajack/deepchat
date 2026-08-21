<script setup lang="ts">
import { ref, type Component } from "vue";
import { ChevronDown, ChevronRight } from "lucide-vue-next";

const props = withDefaults(
  defineProps<{
    title: string;
    icon?: Component;
    variant?: "default" | "system" | "input" | "reasoning" | "output" | "tool";
    /** 标题右侧的小字（如「123 字」「5 条」） */
    count?: string;
    /** 简单文本内容；复杂内容请使用默认插槽 */
    text?: string;
    defaultOpen?: boolean;
  }>(),
  { variant: "default", defaultOpen: false },
);

const open = ref(props.defaultOpen);

/** 不同区块用略微差异的背景色 + 描边，视觉更清晰 */
const variantClass: Record<string, string> = {
  default: "border-line/60 bg-ink-1/40",
  system: "border-amber-500/25 bg-amber-500/[0.07]",
  input: "border-sky-500/25 bg-sky-500/[0.07]",
  reasoning: "border-violet-500/25 bg-violet-500/[0.07]",
  output: "border-emerald-500/25 bg-emerald-500/[0.07]",
  tool: "border-rose-500/25 bg-rose-500/[0.07]",
};
</script>

<template>
  <div class="mb-2 overflow-hidden rounded-lg border" :class="variantClass[variant]">
    <button class="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left" @click="open = !open">
      <component :is="open ? ChevronDown : ChevronRight" :size="13" class="shrink-0 text-mid" />
      <component v-if="icon" :is="icon" :size="12" class="shrink-0 text-accent" />
      <span class="text-[11px] font-semibold text-hi">{{ title }}</span>
      <span v-if="count" class="rounded bg-ink-1/70 px-1 py-0.5 font-mono text-[9.5px] text-lo">{{ count }}</span>
      <div class="flex-1" />
    </button>
    <div v-if="open" class="px-2.5 pb-2">
      <slot>
        <pre v-if="text" class="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-hi">{{ text }}</pre>
      </slot>
    </div>
  </div>
</template>
