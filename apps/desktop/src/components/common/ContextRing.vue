<script setup lang="ts">
import { computed } from "vue";
import HoverTip from "./HoverTip.vue";
import { t } from "../../i18n";

/**
 * 模型上下文窗口占用圆环：
 * - 弧度表示占用百分比（≥85% 红 / ≥60% 黄 / 其余绿）
 * - hover 显示详情（模型名、窗口大小、已用、剩余）
 */
const props = withDefaults(
  defineProps<{
    /** 已用 token */
    used: number;
    /** 上下文窗口总 token */
    total: number;
    /** 模型名（hover 详情标题） */
    modelName?: string;
    /** 圆环尺寸（px） */
    size?: number;
  }>(),
  { modelName: "", size: 16 },
);

const R = 15.5;
const C = 2 * Math.PI * R;

const pct = computed(() => {
  if (!props.total) return 0;
  return Math.min(100, (props.used / props.total) * 100);
});

const dash = computed(() => `${(pct.value / 100) * C} ${C}`);

const colorClass = computed(() => {
  if (pct.value >= 85) return "text-red-400";
  if (pct.value >= 60) return "text-amber-400";
  return "text-accent";
});

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** hover 详情（HTML） */
const tipHtml = computed(() => {
  const p = pct.value.toFixed(1);
  const free = Math.max(0, props.total - props.used);
  const row = "display:flex;justify-content:space-between;gap:18px;min-width:150px";
  const num = "font-variant-numeric:tabular-nums";
  return `
    <div style="font-weight:600;margin-bottom:5px">${props.modelName || "Context"}</div>
    <div style="${row}"><span>${t("chat.ctxWindow")}</span><span style="${num}">${fmt(props.total)}</span></div>
    <div style="${row}"><span>${t("chat.ctxUsed")}</span><span style="${num}">${fmt(props.used)} (${p}%)</span></div>
    <div style="${row}"><span>${t("chat.ctxFree")}</span><span style="${num}">${fmt(free)}</span></div>
  `;
});
</script>

<template>
  <HoverTip :html="true" :content="tipHtml" placement="top" :delay="150">
    <svg :width="size" :height="size" viewBox="0 0 36 36" class="block shrink-0" role="img">
      <circle cx="18" cy="18" :r="R" fill="none" stroke="currentColor" stroke-width="4" class="text-lo/30" />
      <circle
        cx="18"
        cy="18"
        :r="R"
        fill="none"
        stroke="currentColor"
        stroke-width="4"
        :stroke-dasharray="dash"
        stroke-linecap="round"
        :class="colorClass"
        transform="rotate(-90 18 18)"
      />
    </svg>
  </HoverTip>
</template>
