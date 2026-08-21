<script setup lang="ts" generic="T extends string | number">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Check, ChevronDown } from "lucide-vue-next";

export interface SelectOption<T = string> {
  label: string;
  value: T;
  disabled?: boolean;
  /** 右侧辅助描述（如模型名、传输方式） */
  hint?: string;
}

const props = withDefaults(
  defineProps<{
    modelValue: T;
    options: SelectOption<T>[];
    placeholder?: string;
    disabled?: boolean;
    /** 整体宽度类名，默认 w-full */
    widthClass?: string;
    /** 高度类名，默认 h-9 */
    heightClass?: string;
    /** 字体大小类名，默认 text-[12.5px] */
    textClass?: string;
  }>(),
  {
    placeholder: "请选择",
    disabled: false,
    widthClass: "w-full",
    heightClass: "h-9",
    textClass: "text-[12.5px]",
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: T];
  change: [value: T];
}>();

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);

const selected = computed(() => props.options.find((o) => o.value === props.modelValue));

const displayLabel = computed(() => selected.value?.label ?? (props.modelValue ? String(props.modelValue) : props.placeholder));

function pick(opt: SelectOption<T>) {
  if (opt.disabled) return;
  emit("update:modelValue", opt.value);
  emit("change", opt.value);
  open.value = false;
}

function onDocClick(e: MouseEvent) {
  if (!rootRef.value) return;
  if (!rootRef.value.contains(e.target as Node)) open.value = false;
}

function onKeydown(e: KeyboardEvent) {
  if (!open.value) return;
  if (e.key === "Escape") {
    open.value = false;
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const idx = props.options.findIndex((o) => o.value === props.modelValue);
    const step = e.key === "ArrowDown" ? 1 : -1;
    for (let i = idx + step; i >= 0 && i < props.options.length; i += step) {
      if (!props.options[i].disabled) {
        pick(props.options[i]);
        break;
      }
    }
  }
}

onMounted(() => {
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onKeydown);
});

// 外部 options 变化时，若当前值不在列表中且无 placeholder，自动选第一个可用项
watch(
  () => props.options,
  (opts) => {
    if (!opts.some((o) => o.value === props.modelValue) && !opts.some((o) => o.value === "" as T)) {
      const first = opts.find((o) => !o.disabled);
      if (first && props.modelValue === ("" as T)) return; // 保留 placeholder
    }
  },
);
</script>

<template>
  <div ref="rootRef" class="relative" :class="widthClass">
    <!-- 触发器 -->
    <button
      type="button"
      :disabled="disabled"
      class="flex w-full items-center gap-2 rounded-lg border border-line bg-ink-2 px-3 outline-none transition-all focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-soft)] disabled:opacity-50"
      :class="[heightClass, textClass, open ? 'border-accent/50' : '']"
      @click="open = !open"
    >
      <span class="min-w-0 flex-1 truncate text-left" :class="selected ? 'text-hi' : 'text-lo'">{{ displayLabel }}</span>
      <ChevronDown
        :size="14"
        class="shrink-0 text-lo transition-transform duration-200"
        :class="open ? 'rotate-180' : ''"
      />
    </button>

    <!-- 下拉面板 -->
    <Transition
      enter-active-class="transition duration-100 ease-out"
      enter-from-class="opacity-0 -translate-y-1"
      enter-to-class="opacity-100 translate-y-0"
      leave-active-class="transition duration-75 ease-in"
      leave-from-class="opacity-100 translate-y-0"
      leave-to-class="opacity-0 -translate-y-1"
    >
      <div
        v-if="open"
        class="absolute left-0 right-0 top-full z-50 mt-1 max-h-60 overflow-y-auto rounded-lg border border-line bg-ink-1 py-1 shadow-[0_8px_30px_rgba(0,0,0,0.4)]"
      >
        <button
          v-for="opt in options"
          :key="String(opt.value)"
          type="button"
          :disabled="opt.disabled"
          class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          :class="[
            textClass,
            opt.value === modelValue
              ? 'bg-accent/10 text-accent'
              : 'text-hi hover:bg-ink-2',
          ]"
          @click="pick(opt)"
        >
          <Check v-if="opt.value === modelValue" :size="13" class="shrink-0" />
          <span v-else class="w-[13px] shrink-0" />
          <span class="min-w-0 flex-1 truncate">{{ opt.label }}</span>
          <span v-if="opt.hint" class="shrink-0 font-mono text-[10px] text-lo">{{ opt.hint }}</span>
        </button>
      </div>
    </Transition>
  </div>
</template>
