<script setup lang="ts">
import { useAppStore } from "../../stores/app";

const app = useAppStore();
</script>

<template>
  <div
    class="pointer-events-none fixed bottom-8 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-line-strong/50 bg-ink-2/95 px-5 py-2.5 text-[13px] text-hi shadow-[0_8px_32px_rgba(0,0,0,0.5),0_0_20px_rgba(42,227,164,0.08)] backdrop-blur transition-all duration-200"
    :class="app.toastText ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'"
  >
    {{ app.toastText }}
  </div>
</template>
