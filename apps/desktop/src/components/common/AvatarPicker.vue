<script setup lang="ts">
import { ref } from "vue";
import { Shuffle } from "lucide-vue-next";
import { DICEBEAR_STYLES, type DicebearStyle, dicebearUrl, randomSeed } from "../../utils/avatar";

const props = defineProps<{ modelValue: string | null }>();
const emit = defineEmits<{ "update:modelValue": [string | null] }>();

// 4 组的前 9 个随机值相同：固定 hard-code，避免每次弹窗变化
const presetSeeds = ["k7f3a2b1", "m9x2q4w8", "p5t7r1z6", "d4j2h2k5", "d4j9h2k5", "s6l1m8r3", "f7a9b2c4", "e5t3w8x1", "g2h6j4n7"];
// 每行最后一个“随机样式”头像当前展示的 seed
const randomSeedByStyle = ref<Record<string, string>>(
  Object.fromEntries(DICEBEAR_STYLES.map((s) => [s.key, randomSeed()])) as Record<string, string>,
);

// 头像加载状态：key = `${style}:${seed}`
const loaded = ref<Record<string, boolean>>({});
function tileKey(style: DicebearStyle, seed: string) {
  return `${style}:${seed}`;
}
function onTileLoad(style: DicebearStyle, seed: string) {
  loaded.value = { ...loaded.value, [tileKey(style, seed)]: true };
}
function tileLoaded(style: DicebearStyle, seed: string) {
  return loaded.value[tileKey(style, seed)] === true;
}

function select(style: DicebearStyle, seed: string) {
  emit("update:modelValue", dicebearUrl(style, seed));
}

function randomPick(style: DicebearStyle) {
  const seed = randomSeed();
  randomSeedByStyle.value = { ...randomSeedByStyle.value, [style]: seed };
  emit("update:modelValue", dicebearUrl(style, seed));
}

function isActive(style: DicebearStyle, seed: string) {
  return props.modelValue === dicebearUrl(style, seed);
}
</script>

<template>
  <div class="mt-2 w-full rounded-xl border border-line bg-ink-1/85 p-3 shadow-xl backdrop-blur-sm">
    <div v-for="s in DICEBEAR_STYLES" :key="s.key" class="mb-2 last:mb-0">
      <div class="grid grid-cols-10 gap-1.5">
        <button
          v-for="(seed, i) in presetSeeds"
          :key="i"
          type="button"
          class="relative aspect-square w-full overflow-hidden rounded-md ring-1 transition-all"
          :class="isActive(s.key, seed) ? 'ring-2 ring-accent' : 'ring-line hover:ring-accent/50'"
          @click="select(s.key, seed)"
        >
          <img
            :src="dicebearUrl(s.key, seed)"
            :alt="s.label"
            loading="lazy"
            decoding="async"
            class="h-full w-full bg-ink-2 object-cover"
            @load="onTileLoad(s.key, seed)"
            @error="onTileLoad(s.key, seed)"
          />
          <div v-if="!tileLoaded(s.key, seed)" class="absolute inset-0 flex items-center justify-center bg-ink-3/50">
            <div class="spinner h-3 w-3 rounded-full border-2 border-current border-t-transparent" />
          </div>
        </button>
        <button
          type="button"
          class="group relative aspect-square w-full overflow-hidden rounded-md border border-dashed border-line-strong transition-all hover:border-accent/60"
          :class="isActive(s.key, randomSeedByStyle[s.key]) ? 'border-2 border-accent' : ''"
          @click="randomPick(s.key)"
        >
          <img
            :src="dicebearUrl(s.key, randomSeedByStyle[s.key])"
            :alt="s.label"
            loading="lazy"
            decoding="async"
            class="h-full w-full bg-ink-2 object-cover opacity-80"
            @load="onTileLoad(s.key, randomSeedByStyle[s.key])"
            @error="onTileLoad(s.key, randomSeedByStyle[s.key])"
          />
          <span
            v-if="tileLoaded(s.key, randomSeedByStyle[s.key])"
            class="absolute inset-0 flex items-center justify-center bg-ink-0/45 text-mid transition-colors group-hover:text-accent"
          >
            <Shuffle :size="14" />
          </span>
          <div v-else class="absolute inset-0 flex items-center justify-center bg-ink-3/50">
            <div class="spinner h-3 w-3 rounded-full border-2 border-current border-t-transparent" />
          </div>
        </button>
      </div>
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
