<script setup lang="ts">
import { computed, ref } from "vue";
import { Pencil, ImagePlus } from "lucide-vue-next";
import AvatarPicker from "./AvatarPicker.vue";
import { dicebearUrl, randomSeed } from "../../utils/avatar";

const props = withDefaults(
  defineProps<{ modelValue: string | null; size?: number }>(),
  { size: 72 },
);

const emit = defineEmits<{ "update:modelValue": [string | null] }>();

const open = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
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

/** 选择本地图片：读为 dataURL 写到 form.avatar；后端保存时识别 data:image/* 前缀自动写入 bot 目录 */
async function pickImage() {
  fileInput.value?.click();
}

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ""
  if (!file) return
  if (!file.type.startsWith("image/")) return
  if (file.size > 8 * 1024 * 1024) return
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
  emit("update:modelValue", dataUrl)
}
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
      <!-- 左下角：选择本地图片作为头像 -->
      <button
        type="button"
        class="absolute -bottom-1 -left-1 flex h-7 w-7 items-center justify-center rounded-full border border-line-strong bg-ink-3 text-mid shadow-md transition-all hover:border-accent/50 hover:text-accent"
        title="选择本地图片"
        @click="pickImage"
      >
        <ImagePlus :size="13" />
      </button>
      <!-- 右下角：编辑头像（dicebear 选择器） -->
      <button
        type="button"
        class="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full border border-line-strong bg-ink-3 text-mid shadow-md transition-all hover:border-accent/50 hover:text-accent"
        title="编辑头像"
        @click="open = !open"
      >
        <Pencil :size="13" />
      </button>
      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        class="hidden"
        @change="onFileChange"
      />
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
