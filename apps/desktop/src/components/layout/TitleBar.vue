<script setup lang="ts">
// 平台判定必须同步完成，否则首帧会先闪出另一平台的标题栏
const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);

async function startDrag(e: MouseEvent) {
  // 按钮等交互元素不参与窗口拖拽
  if ((e.target as HTMLElement).closest("button")) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startDragging();
}
</script>

<template>
  <!-- macOS：系统 titleBarStyle: Overlay 原生渲染红绿灯，这里只留一条透明可拖拽带 -->
  <div
    v-if="isMac"
    class="fixed top-0 right-0 left-0 z-30 flex h-3 cursor-move select-none items-center bg-transparent"
    data-tauri-drag-region
    @mousedown="startDrag"
  >
    <!-- 左侧留给 Mac 红绿灯（系统原生渲染） -->
    <div class="w-15 shrink-0" :data-tauri-drag-region="true" />
    <!-- 标题占位（透明可拖拽） -->
    <div class="flex-1" :data-tauri-drag-region="true" />
  </div>

  <!-- Windows：窗口按钮已移入 ChatHeader（见 WindowControls.vue），
       顶部只保留一条更矮的透明拖拽带用于移动窗口 -->
  <div
    v-else
    class="fixed top-0 right-0 left-0 z-30 h-2 cursor-move select-none bg-transparent"
    data-tauri-drag-region
    @mousedown="startDrag"
  />
</template>
