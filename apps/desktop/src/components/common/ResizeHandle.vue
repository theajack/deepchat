<script setup lang="ts">
import { onBeforeUnmount } from "vue";
import { useUiStore } from "../../stores/ui";

const ui = useUiStore();

function startResize(e: MouseEvent) {
  e.preventDefault();
  const startX = e.clientX;
  const startWidth = ui.sidebarWidth;

  function onMove(ev: MouseEvent) {
    ui.setSidebarWidth(startWidth + (ev.clientX - startX));
  }
  function onUp() {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}

onBeforeUnmount(() => {
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});
</script>

<template>
  <div
    class="absolute inset-y-0 -right-[3px] z-20 w-[6px] cursor-col-resize bg-transparent"
    @mousedown.prevent="startResize"
  />
</template>
