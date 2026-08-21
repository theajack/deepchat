<script setup lang="ts">
import { ref } from "vue";
import { X, Plus, Globe, Loader2 } from "lucide-vue-next";
import { useBrowserStore, displayUrl } from "../../stores/browser";
import { t } from "../../i18n";

const browser = useBrowserStore();

/** 拖拽中的标签索引 */
const dragIndex = ref<number | null>(null);
/** 当前悬停的目标索引（用于显示插入指示） */
const overIndex = ref<number | null>(null);

function onDragStart(e: DragEvent, index: number) {
  dragIndex.value = index;
  overIndex.value = index;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    // Firefox 需要设置数据才能启动拖拽
    e.dataTransfer.setData("text/plain", String(index));
  }
}

function onDragOver(e: DragEvent, index: number) {
  e.preventDefault();
  if (dragIndex.value === null) return;
  overIndex.value = index;
}

function onDrop(e: DragEvent, index: number) {
  e.preventDefault();
  if (dragIndex.value !== null && dragIndex.value !== index) {
    browser.moveTab(dragIndex.value, index);
  }
  dragIndex.value = null;
  overIndex.value = null;
}

function onDragEnd() {
  dragIndex.value = null;
  overIndex.value = null;
}

function tabLabel(title: string, url: string): string {
  if (title) return title;
  if (!url) return t("browser.newTab");
  const shown = displayUrl(url);
  // 本地文件取文件名
  if (url.startsWith("file://")) {
    const parts = shown.split("/");
    return parts[parts.length - 1] || shown;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return shown;
  }
}
</script>

<template>
  <!-- 标签栏：本身可拖拽移动窗口，标签项拦截拖拽用于排序 -->
  <div
    class="flex h-9 shrink-0 items-end gap-1 border-b border-line bg-ink-1/80 px-2 pt-1.5"
    data-tauri-drag-region
  >
    <!-- macOS 红绿灯占位 -->
    <div class="w-16 shrink-0" data-tauri-drag-region />

    <div class="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto">
      <div
        v-for="(tab, i) in browser.tabs"
        :key="tab.id"
        draggable="true"
        data-tauri-drag-region="false"
        data-no-drag
        class="group relative flex h-7 min-w-0 max-w-44 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-lg border border-b-0 px-2.5 transition-all"
        :class="[
          tab.id === browser.activeId
            ? 'border-line bg-ink-2 text-hi'
            : 'border-transparent bg-ink-1/40 text-mid hover:bg-ink-3/60',
          dragIndex === i ? 'opacity-40' : '',
          overIndex === i && dragIndex !== null && dragIndex !== i ? 'ring-1 ring-accent/60' : '',
        ]"
        @click="browser.activateTab(tab.id)"
        @mousedown.stop
        @dragstart="onDragStart($event, i)"
        @dragover="onDragOver($event, i)"
        @drop="onDrop($event, i)"
        @dragend="onDragEnd"
      >
        <Loader2 v-if="tab.loading" :size="11" class="shrink-0 animate-spin text-accent" />
        <Globe v-else :size="11" :stroke-width="2" class="shrink-0 text-lo" />
        <span class="truncate text-[11.5px]">{{ tabLabel(tab.title, tab.url) }}</span>
        <button
          class="flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 transition-all group-hover:opacity-100 hover:bg-ink-5 hover:text-hi"
          :title="t('browser.closeTab')"
          @click.stop="browser.closeTab(tab.id)"
        >
          <X :size="10" :stroke-width="2.5" />
        </button>
      </div>

      <!-- 新建标签 -->
      <button
        class="mb-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-lo transition-colors hover:bg-ink-3 hover:text-hi"
        :title="t('browser.newTab')"
        @click="browser.addTab('')"
      >
        <Plus :size="13" :stroke-width="2" />
      </button>
    </div>
  </div>
</template>
