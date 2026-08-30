<script setup lang="ts">
/**
 * 居中的旋转指示器。
 *
 * 刻意不用 lucide 的 Loader2：它的图形是一段不完整的圆弧，重心不在
 * viewBox 中心，绕中心旋转时视觉上会「晃动」。这里用一个以 12,12 为圆心
 * 的正圆 + stroke-dasharray 画弧，旋转轴与视觉中心重合，转起来是稳的。
 */
withDefaults(defineProps<{
  /** 边长（px），同时用作 stroke-width 的缩放基准 */
  size?: number
}>(), {
  size: 14,
})
</script>

<template>
  <svg
    class="animate-spin"
    :style="{ width: `${size}px`, height: `${size}px` }"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
  >
    <circle
      cx="12"
      cy="12"
      r="10"
      stroke="currentColor"
      stroke-width="3"
      stroke-dasharray="16 42"
      stroke-linecap="round"
    />
  </svg>
</template>
