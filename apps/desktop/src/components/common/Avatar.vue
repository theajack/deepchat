<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { avatarChar, avatarColor } from "../../utils/display";

const props = withDefaults(
  defineProps<{ name: string; size?: number; radius?: number; src?: string | null }>(),
  { size: 40, radius: 10, src: null },
);

const loaded = ref(false);
const errored = ref(false);
watch(
  () => props.src,
  () => {
    loaded.value = false;
    errored.value = false;
  },
  { immediate: true },
);

const showSpinner = computed(() => !!props.src && !loaded.value && !errored.value);
const showImg = computed(() => !!props.src && !errored.value);

const style = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  fontSize: `${Math.round(props.size * 0.34)}px`,
  borderRadius: `${props.radius}px`,
}));

const spinnerStyle = computed(() => {
  const s = Math.max(12, Math.round(props.size * 0.3));
  return { width: `${s}px`, height: `${s}px`, borderWidth: `${Math.max(2, Math.round(s / 8))}px` };
});

const glow = computed(() => {
  const s = Math.round(props.size * 0.22);
  return {
    boxShadow: `0 0 ${s}px rgba(0,0,0,0.45), inset 0 0 8px rgba(255,255,255,0.08)`,
  };
});

const bg = computed(() =>
  showImg.value ? {} : { background: `linear-gradient(145deg, ${avatarColor(props.name)}, ${avatarColor(props.name)}bb)` },
);
</script>

<template>
  <div
    class="relative flex shrink-0 items-center justify-center overflow-hidden font-medium text-white ring-1 ring-white/15"
    :style="{ ...style, ...bg, ...glow }"
  >
    <img
      v-if="showImg"
      :src="src ?? undefined"
      :alt="name"
      loading="lazy"
      decoding="async"
      class="h-full w-full object-cover"
      @load="loaded = true"
      @error="errored = true"
    />
    <span v-else>{{ avatarChar(name) }}</span>
    <div v-if="showSpinner" class="absolute inset-0 flex items-center justify-center bg-ink-3/40">
      <div
        class="spinner rounded-full border-current border-t-transparent"
        :style="spinnerStyle"
      />
    </div>
  </div>
</template>

<style scoped>
.spinner {
  animation: avatar-spin 0.7s linear infinite;
}
@keyframes avatar-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
