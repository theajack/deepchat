<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Picker } from "emoji-mart";
// @emoji-mart/data 的 types（index.d.ts）未声明 default export，main 实际指向 sets/15/native.json
// @ts-ignore
import data from "@emoji-mart/data";
import { useThemeStore } from "../../stores/theme";
import { useLocaleStore } from "../../stores/locale";

const themeStore = useThemeStore();
const localeStore = useLocaleStore();

const emit = defineEmits<{
  (e: "select", native: string): void;
  (e: "close"): void;
}>();

const hostRef = ref<HTMLElement | null>(null);
// emoji-mart 的 d.ts 未继承 DOM HTMLElement，运行时实为注册后的自定义元素，需断言为 HTMLElement 以调用 DOM 方法
let picker: HTMLElement | null = null;

/**
 * 适配应用暗色主题：emoji-mart 的样式在 shadow DOM 内，外部 CSS 无法直接覆盖，
 * 但其 CSS 变量（--rgb-background / --rgb-color / --rgb-accent / --rgb-input 等）
 * 通过 :host 继承自 light DOM，可在 picker 实例上直接 setProperty 注入。
 */
function applyThemeStyles() {
  if (!picker) return;
  const isDark = themeStore.effective === "dark";
  // 背景 / 文字 / 强调色（与 style.css 的 dark 主题 token 对齐）
  picker.style.setProperty("--rgb-background", isDark ? "11, 15, 21" : "255, 255, 255");
  picker.style.setProperty("--rgb-color", isDark ? "232, 240, 249" : "27, 35, 50");
  picker.style.setProperty("--rgb-input", isDark ? "14, 19, 27" : "243, 245, 249");
  picker.style.setProperty("--rgb-accent", "42, 227, 164");
  picker.style.setProperty("--color-border", isDark ? "rgba(143, 175, 214, 0.10)" : "rgba(20, 32, 54, 0.05)");
  picker.style.setProperty("--color-border-over", isDark ? "rgba(143, 175, 214, 0.22)" : "rgba(20, 32, 54, 0.18)");
  // 覆盖 :host 上的字体以匹配应用
  picker.style.setProperty("--font-family", `-apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif`);
}

onMounted(() => {
  if (!hostRef.value) return;
  picker = new Picker({
    data,
    // 显式指定主题；emoji-mart 自带 dark/light 主题（shadow DOM 内部 CSS）
    theme: themeStore.effective,
    locale: localeStore.effective,
    // 紧凑化排版，与应用整体风格一致
    emojiButtonSize: 30,
    perLine: 9,
    previewPosition: "bottom",
    navPosition: "top",
    onEmojiSelect: (emoji: { native?: string }) => {
      if (emoji?.native) emit("select", emoji.native);
    },
    onClickOutside: () => {
      emit("close");
    },
  }) as unknown as HTMLElement;
  applyThemeStyles();
  hostRef.value.appendChild(picker);
});
</script>

<template>
  <!--
    Picker 始终挂载：用父组件的 v-show 控制显隐，避免反复销毁/重建导致自定义元素实例状态错乱
    （emoji-mart 的 disconnectedCallback 不会清除内部状态，再次 append 同一元素会导致渲染被跳过）
  -->
  <div ref="hostRef" class="emoji-picker-host inline-block" />
</template>