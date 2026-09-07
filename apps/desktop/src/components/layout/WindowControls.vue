<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Copy, Minus, Square, X } from "lucide-vue-next";
import { t } from "../../i18n";

// 平台判定必须同步完成，否则首帧会先闪出另一平台的按钮
const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
/** 窗口是否已最大化：决定中间按钮显示「最大化」还是「还原」 */
const maximized = ref(false);

async function appWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

onMounted(async () => {
  // macOS 由系统原生红绿灯负责，无需自绘按钮
  if (isMac) return;
  maximized.value = await (await appWindow()).isMaximized();
});

async function win(action: "minimize" | "toggleMaximize" | "close") {
  const w = await appWindow();
  if (action === "minimize") await w.minimize();
  else if (action === "toggleMaximize") {
    await w.toggleMaximize();
    maximized.value = await w.isMaximized();
  } else await w.close();
}
</script>

<template>
  <!-- macOS 保留系统原生红绿灯，这里不渲染任何按钮 -->
  <div
    v-if="!isMac"
    class="ml-1 flex items-center gap-0.5"
    @mousedown.stop
  >
    <button
      class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-mid transition-colors hover:bg-ink-3 hover:text-hi"
      :title="t('titlebar.minimize')"
      @click="win('minimize')"
    >
      <Minus :size="16" :stroke-width="2" />
    </button>
    <button
      class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-mid transition-colors hover:bg-ink-3 hover:text-hi"
      :title="maximized ? t('titlebar.restore') : t('titlebar.maximize')"
      @click="win('toggleMaximize')"
    >
      <Square v-if="!maximized" :size="13" :stroke-width="2" />
      <Copy v-else :size="13" :stroke-width="2" />
    </button>
    <button
      class="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-mid transition-colors hover:bg-danger hover:text-white"
      :title="t('titlebar.close')"
      @click="win('close')"
    >
      <X :size="16" :stroke-width="2" />
    </button>
  </div>
</template>
