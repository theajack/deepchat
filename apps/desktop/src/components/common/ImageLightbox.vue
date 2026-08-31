<script setup lang="ts">
/**
 * 图片预览浮层（点击缩略图放大查看）。
 *
 * 用 teleport 挂到 body：气泡里有 overflow/transform 等层叠上下文，
 * 直接内联渲染会被裁切或压在下面。
 */
import { onMounted, onUnmounted } from "vue";
import { Download, X } from "lucide-vue-next";
import { t } from "../../i18n";

const props = defineProps<{
  src: string;
  /** 下载时使用的文件名 */
  name?: string;
}>();

const emit = defineEmits<{ close: [] }>();

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));

/** 下载：走 a[download]，同源 URL 可直接保存 */
function download() {
  const a = document.createElement("a");
  a.href = props.src;
  a.download = props.name || "image";
  a.click();
}
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-[100] flex items-center justify-center bg-ink-0/85 p-10 backdrop-blur-sm"
      @click.self="emit('close')"
    >
      <!-- 关闭/下载：浮层右上角 -->
      <div class="absolute right-5 top-5 flex items-center gap-2">
        <button
          class="flex h-8 w-8 items-center justify-center rounded-lg bg-ink-2/80 text-mid transition-colors hover:text-accent"
          :title="t('common.download')"
          @click="download"
        >
          <Download :size="15" />
        </button>
        <button
          class="flex h-8 w-8 items-center justify-center rounded-lg bg-ink-2/80 text-mid transition-colors hover:text-hi"
          :title="t('common.close')"
          @click="emit('close')"
        >
          <X :size="16" />
        </button>
      </div>

      <img
        :src="src"
        :alt="name || 'image'"
        class="max-h-full max-w-full rounded-lg object-contain shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
      />
    </div>
  </Teleport>
</template>
