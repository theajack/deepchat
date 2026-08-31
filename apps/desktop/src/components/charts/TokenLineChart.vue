<script setup lang="ts">
/**
 * 纯 SVG 折线图（每日 Token 趋势）。
 *
 * 刻意不引第三方图表库：只需要一条折线 + 网格 + 悬浮提示，自己画约 100 行
 * 且完全可控（配色直接吃 tailwind 变量、暗色模式天然适配），比引入一个
 * 几百 KB 的图表库更合适。
 */
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    /** 与 values 等长的日期标签，悬浮时展示 */
    labels: string[];
    values: number[];
    /** 悬浮提示的副标题（如模型名） */
    seriesName?: string;
    height?: number;
  }>(),
  { seriesName: "", height: 120 },
);

/** 图表内边距，给轴标签留出空间 */
const PAD = { top: 10, right: 8, bottom: 18, left: 42 };

const WIDTH = 300;

const max = computed(() => Math.max(1, ...props.values));
const innerW = computed(() => WIDTH - PAD.left - PAD.right);
const innerH = computed(() => props.height - PAD.top - PAD.bottom);

/** 每个数据点的像素坐标 */
const points = computed(() =>
  props.values.map((v, i) => {
    const ratio = props.values.length <= 1 ? 0 : i / (props.values.length - 1);
    return {
      x: PAD.left + ratio * innerW.value,
      y: PAD.top + innerH.value - (v / max.value) * innerH.value,
      value: v,
      label: props.labels[i] ?? "",
    };
  }),
);

const linePath = computed(() =>
  points.value.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "),
);

const areaPath = computed(() => {
  if (points.value.length === 0) return "";
  const first = points.value[0];
  const last = points.value[points.value.length - 1];
  if (first === undefined || last === undefined) return "";
  const baseY = PAD.top + innerH.value;
  return `${linePath.value} L${last.x.toFixed(1)},${baseY} L${first.x.toFixed(1)},${baseY} Z`;
});

/** 横向网格线（4 档） */
const gridLines = computed(() =>
  [0, 0.25, 0.5, 0.75, 1].map((r) => ({
    y: PAD.top + innerH.value * r,
    value: Math.round(max.value * (1 - r)),
  })),
);
</script>

<template>
  <svg
    :viewBox="`0 0 ${WIDTH} ${height}`"
    class="w-full"
    preserveAspectRatio="none"
    role="img"
    aria-label="token trend"
  >
    <defs>
      <linearGradient :id="`area-${seriesName}`" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#2ae3a4" stop-opacity="0.28" />
        <stop offset="100%" stop-color="#2ae3a4" stop-opacity="0" />
      </linearGradient>
    </defs>

    <!-- 网格 + 纵轴刻度 -->
    <g>
      <line
        v-for="g in gridLines"
        :key="`g${g.y}`"
        :x1="PAD.left"
        :x2="WIDTH - PAD.right"
        :y1="g.y"
        :y2="g.y"
        stroke="currentColor"
        stroke-width="0.5"
        class="text-line"
      />
      <text
        v-for="g in gridLines"
        :key="`t${g.y}`"
        :x="PAD.left - 5"
        :y="g.y + 2.5"
        text-anchor="end"
        class="fill-current text-[7px] text-lo"
      >{{ g.value }}</text>
    </g>

    <path v-if="areaPath" :d="areaPath" :fill="`url(#area-${seriesName})`" />
    <path :d="linePath" fill="none" stroke="#2ae3a4" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />

    <!-- 数据点：原生 title 提供悬浮提示，无需 JS 事件 -->
    <g>
      <circle
        v-for="(p, i) in points"
        :key="i"
        :cx="p.x"
        :cy="p.y"
        r="2.4"
        fill="#2ae3a4"
      >
        <title>{{ p.label }} · {{ p.value.toLocaleString() }} tokens</title>
      </circle>
    </g>

    <!-- 横轴：首/尾日期，避免拥挤 -->
    <text
      v-if="points.length > 0"
      :x="PAD.left"
      :y="height - 5"
      class="fill-current text-[7px] text-lo"
    >{{ points[0]?.label?.slice(5) }}</text>
    <text
      v-if="points.length > 1"
      :x="WIDTH - PAD.right"
      :y="height - 5"
      text-anchor="end"
      class="fill-current text-[7px] text-lo"
    >{{ points[points.length - 1]?.label?.slice(5) }}</text>
  </svg>
</template>
