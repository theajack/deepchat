<script setup lang="ts">
/**
 * 纯 SVG 横向柱状图（各模型累计 Token 对比）。
 *
 * 用横向条而非纵向柱：模型名可能很长（"DeepSeek-V3 官方"），横条可以把名字
 * 完整放在左侧，纵向柱只能截断或斜排，可读性差。
 */
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    items: { name: string; value: number }[];
    /** 单行高度（px） */
    rowHeight?: number;
  }>(),
  { rowHeight: 26 },
);

const LABEL_WIDTH = 96;
const VALUE_WIDTH = 62;
const GAP = 6;

const max = computed(() => Math.max(1, ...props.items.map((i) => i.value)));

/** 条形容器的可用宽度；右侧给数值留固定空间 */
const barArea = computed(() => 300 - LABEL_WIDTH - VALUE_WIDTH);

const height = computed(() => Math.max(1, props.items.length) * props.rowHeight);

const rows = computed(() =>
  props.items.map((item, i) => ({
    ...item,
    rowHeight: props.rowHeight,
    y: i * props.rowHeight,
    width: Math.max(2, (item.value / max.value) * barArea.value),
  })),
);
</script>

<template>
  <svg
    :viewBox="`0 0 300 ${height}`"
    class="w-full"
    :style="{ height: `${height}px` }"
    role="img"
    aria-label="token by model"
  >
    <g v-for="(row, i) in rows" :key="row.name + i">
      <!-- 模型名 -->
      <text
        :x="0"
        :y="row.y + row.rowHeight / 2 + 3"
        class="fill-current text-[8px] text-mid"
      >{{ row.name.length > 13 ? `${row.name.slice(0, 12)}…` : row.name }}</text>

      <!-- 轨道 -->
      <rect
        :x="LABEL_WIDTH"
        :y="row.y + GAP"
        :width="barArea"
        :height="rowHeight - GAP * 2"
        rx="2"
        class="fill-current text-ink-3/50"
      />
      <!-- 实际用量 -->
      <rect
        :x="LABEL_WIDTH"
        :y="row.y + GAP"
        :width="row.width"
        :height="rowHeight - GAP * 2"
        rx="2"
        fill="#2ae3a4"
        fill-opacity="0.75"
      >
        <title>{{ row.name }} · {{ row.value.toLocaleString() }} tokens</title>
      </rect>

      <!-- 数值 -->
      <text
        :x="300"
        :y="row.y + row.rowHeight / 2 + 3"
        text-anchor="end"
        class="fill-current text-[8px] text-lo"
      >{{ row.value.toLocaleString() }}</text>
    </g>

    <text
      v-if="items.length === 0"
      x="150"
      y="20"
      text-anchor="middle"
      class="fill-current text-[9px] text-lo"
    >暂无数据</text>
  </svg>
</template>
