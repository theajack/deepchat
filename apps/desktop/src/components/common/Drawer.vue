<script setup lang="ts">
import { t } from "../../i18n";

defineProps<{ open: boolean; title?: string }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="open"
        class="fixed inset-0 z-50 bg-ink-0/60 backdrop-blur-sm"
        @click="emit('close')"
      />
    </Transition>
    <Transition name="slide">
      <aside
        v-if="open"
        class="fixed top-0 right-0 z-50 flex h-full w-80 flex-col border-l border-line-strong/60 bg-ink-1/95 shadow-[0_32px_80px_rgba(0,0,0,0.6)] backdrop-blur"
      >
        <div class="flex shrink-0 items-center justify-between border-b border-line px-5 py-4">
          <h3 class="text-sm font-semibold tracking-wide text-hi">{{ title ?? t("common.menu") }}</h3>
          <button
            class="flex h-7 w-7 items-center justify-center rounded-lg text-lo transition-colors hover:bg-ink-3 hover:text-hi"
            :title="t('common.close')"
            @click="emit('close')"
          >
            ✕
          </button>
        </div>
        <div class="flex-1 overflow-y-auto p-5">
          <slot />
        </div>
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.slide-enter-active,
.slide-leave-active {
  transition: transform 0.25s ease;
}
.slide-enter-from,
.slide-leave-to {
  transform: translateX(100%);
}
</style>
