<script setup lang="ts">
import { onMounted, onUnmounted } from "vue";
import { Check, X } from "lucide-vue-next";
import { t } from "../../i18n";

defineProps<{
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}>();
const emit = defineEmits<{ confirm: []; close: [] }>();

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") {
    e.preventDefault();
    emit("confirm");
  } else if (e.key === "Escape") {
    e.preventDefault();
    emit("close");
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-ink-0/70 backdrop-blur-sm" @click.self="emit('close')">
    <div
      class="w-90 overflow-hidden rounded-2xl border border-line-strong/60 bg-ink-1/95 shadow-[0_32px_80px_rgba(0,0,0,0.6),0_0_40px_rgba(42,227,164,0.06)]"
    >
      <div class="px-6 pt-5">
        <h3 class="text-sm font-semibold tracking-wide text-hi">{{ title ?? t("common.confirmTitle") }}</h3>
        <p class="mt-2.5 text-[13px] leading-relaxed text-mid">{{ message }}</p>
      </div>
      <div class="mt-5 flex justify-end gap-2 border-t border-line bg-ink-2/40 px-6 py-3.5">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg border border-line-strong/50 px-4 py-2 text-[13px] text-mid transition-all hover:bg-ink-3 hover:text-hi"
          @click="emit('close')"
        ><X :size="14" /> {{ cancelText ?? t("common.cancel") }}</button>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-semibold transition-all active:scale-95"
          :class="danger
            ? 'bg-danger/90 text-white hover:bg-danger'
            : 'bg-gradient-to-br from-accent to-accent-deep text-on-accent shadow-[0_4px_18px_rgba(42,227,164,0.28)] hover:brightness-110'"
          @click="emit('confirm')"
        ><Check :size="14" /> {{ confirmText ?? t("common.confirm") }}</button>
      </div>
    </div>
  </div>
</template>
