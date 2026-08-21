<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Minus, Square, X } from "lucide-vue-next";
import { t } from "../../i18n";

const isMac = ref(false);

onMounted(async () => {
  // UA 嗅探用于前端条件渲染
  isMac.value = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
});

async function startDrag() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startDragging();
}

async function win(action: "minimize" | "toggleMaximize" | "close") {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const w = getCurrentWindow();
  if (action === "minimize") await w.minimize();
  else if (action === "toggleMaximize") await w.toggleMaximize();
  else await w.close();
}
</script>

<template>
  <!-- 透明可拖拽顶栏 -->
  <div
    class="fixed top-0 right-0 left-0 z-30 flex h-3 cursor-move select-none items-center bg-transparent"
    data-tauri-drag-region
    @mousedown="startDrag"
  >
    <!-- 左侧留给 Mac 红绿灯（系统原生渲染） -->
    <div class="w-15 shrink-0" :data-tauri-drag-region="true" />
    <!-- 标题占位（透明可拖拽） -->
    <div class="flex-1" :data-tauri-drag-region="true" />
    <!-- Windows 关闭/最小化/最大化在右上 -->
    <div v-if="!isMac" class="flex h-full items-center">
      <button
        class="flex h-full w-11 items-center justify-center text-mid transition-colors hover:bg-ink-3 hover:text-hi"
        :title="t('titlebar.minimize')"
        @click="win('minimize')"
      >
        <Minus :size="14" :stroke-width="2" />
      </button>
      <button
        class="flex h-full w-11 items-center justify-center text-mid transition-colors hover:bg-ink-3 hover:text-hi"
        :title="t('titlebar.maximize')"
        @click="win('toggleMaximize')"
      >
        <Square :size="11" :stroke-width="2" />
      </button>
      <button
        class="flex h-full w-11 items-center justify-center text-mid transition-colors hover:bg-danger hover:text-white"
        :title="t('titlebar.close')"
        @click="win('close')"
      >
        <X :size="14" :stroke-width="2" />
      </button>
    </div>
  </div>
</template>
