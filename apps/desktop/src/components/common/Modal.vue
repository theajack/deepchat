<script setup lang="ts">
defineProps<{ title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-ink-0/70 backdrop-blur-sm" @click.self="emit('close')">
    <div
      class="flex max-h-[85vh] flex-col overflow-hidden rounded-2xl border border-line-strong/60 bg-ink-1/95 shadow-[0_32px_80px_rgba(0,0,0,0.6),0_0_40px_rgba(42,227,164,0.06)]"
      :class="wide ? 'w-150' : 'w-105'"
    >
      <div class="sticky top-0 z-10 flex shrink-0 items-center justify-between border-b border-line bg-ink-1/95 px-6 py-4 backdrop-blur">
        <h3 class="text-sm font-semibold tracking-wide text-hi">{{ title }}</h3>
        <button
          class="flex h-7 w-7 items-center justify-center rounded-lg text-lo transition-colors hover:bg-ink-3 hover:text-hi"
          @click="emit('close')"
        >
          ✕
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-6">
        <slot />
      </div>
      <!--
        footer 放在滚动容器之外：天然紧贴弹窗底边（无 padding 缝隙），也不
        随内容滚动。使用方通过 <template #footer> 提供按钮组。
      -->
      <div v-if="$slots.footer" class="flex shrink-0 justify-end gap-2 border-t border-line bg-ink-1 px-6 py-3.5">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>
