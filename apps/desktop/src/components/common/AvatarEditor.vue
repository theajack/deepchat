<script setup lang="ts">
import { computed, ref } from "vue";
import { Pencil } from "lucide-vue-next";
import AvatarPicker from "./AvatarPicker.vue";
import { dicebearUrl, randomSeed } from "../../utils/avatar";

const props = withDefaults(
  defineProps<{ modelValue: string | null; size?: number }>(),
  { size: 72 },
);

const emit = defineEmits<{ "update:modelValue": [string | null] }>();

const open = ref(false);
// 用于空值时的展示兜底（不写回，仅展示）
const fallbackSeed = randomSeed();
const displayUrl = computed(() => props.modelValue || dicebearUrl("bottts-neutral", fallbackSeed));

const imgLoaded = ref(false);
const imgErrored = ref(false);
function onImgLoad() {
  imgLoaded.value = true;
}
function onImgError() {
  imgErrored.value = true;
}
const showSpinner = computed(() => !imgLoaded.value && !imgErrored.value);
const spinnerStyle = computed(() => {
  const s = Math.max(14, Math.round(props.size * 0.28));
  return { width: `${s}px`, height: `${s}px`, borderWidth: `${Math.max(2, Math.round(s / 8))}px` };
});

const local = computed({
  get: () => props.modelValue,
  set: (v: string | null) => emit("update:modelValue", v),
});
</script>

<template>
  <div class="relative flex flex-col items-center">
    <div class="relative" :style="{ width: `${size}px`, height: `${size}px` }">
      <img
        :src="displayUrl"
        alt="avatar"
        loading="lazy"
        decoding="async"
        class="h-full w-full rounded-2xl bg-ink-2 object-cover ring-1 ring-line-strong"
        @load="onImgLoad"
        @error="onImgError"
      />
      <div v-if="showSpinner" class="absolute inset-0 flex items-center justify-center rounded-2xl bg-ink-3/40">
        <div class="spinner rounded-full border-current border-t-transparent" :style="spinnerStyle" />
      </div>
      <button
        type="button"
        class="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border border-line-strong bg-ink-3 text-mid shadow-md transition-all hover:border-accent/50 hover:text-accent"
        :title="'编辑头像'"
        @click="open = !open"
      >
        <Pencil :size="13" />
      </button>
    </div>
    <Transition name="avatar-picker">
      <AvatarPicker v-if="open" v-model="local" class="w-full" :class="`mt-2`" />
    </Transition>
  </div>
</template>

<style scoped>
.avatar-picker-enter-active,
.avatar-picker-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.avatar-picker-enter-from,
.avatar-picker-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
.spinner {
  animation: avatar-spin 0.7s linear infinite;
}
@keyframes avatar-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
