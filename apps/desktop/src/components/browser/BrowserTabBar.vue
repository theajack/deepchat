<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { X, Plus, Globe, Loader2 } from "lucide-vue-next";
import { useBrowserStore, displayUrl } from "../../stores/browser";
import { t } from "../../i18n";

const browser = useBrowserStore();

/** 标签列表容器 */
const listRef = ref<HTMLElement | null>(null);
/** 拖拽中的标签索引 */
const dragIndex = ref<number | null>(null);
/** 当前悬停的目标索引（用于显示插入指示） */
const overIndex = ref<number | null>(null);

/** 鼠标拖拽排序（HTML5 DnD 在 macOS WKWebView 中不可靠） */
const DRAG_THRESHOLD = 4;
let pendingIndex: number | null = null;
let startX = 0;
let startY = 0;
let dragging = false;

/** 拖拽会话（真正开始拖拽后有效） */
let tabNodes: HTMLElement[] = [];
let tabRects: DOMRect[] = [];
let dragNode: HTMLElement | null = null;
let dragRect: DOMRect | null = null;
/** 单个标签占位宽度（宽度 + 间距） */
let slot = 0;

function clearNodeStyle(node: HTMLElement) {
  node.style.transition = "";
  node.style.transform = "";
  node.style.zIndex = "";
  node.style.cursor = "";
  node.style.boxShadow = "";
}

function measureGap(): number {
  if (tabRects.length < 2) return 0;
  return Math.max(0, tabRects[1].left - (tabRects[0].left + tabRects[0].width));
}

/** 拖拽开始：捕获静态布局，提升被拖拽标签 */
function beginDrag() {
  const el = listRef.value;
  if (!el || dragIndex.value === null) return;
  tabNodes = Array.from(el.querySelectorAll<HTMLElement>("[data-tab]"));
  tabRects = tabNodes.map((n) => n.getBoundingClientRect());
  dragNode = tabNodes[dragIndex.value] ?? null;
  dragRect = dragNode?.getBoundingClientRect() ?? null;
  slot = dragRect ? dragRect.width + measureGap() : 0;
  if (dragNode) {
    dragNode.style.zIndex = "10";
    dragNode.style.cursor = "grabbing";
    dragNode.style.boxShadow = "0 6px 16px rgba(0, 0, 0, 0.4)";
  }
}

/** 根据鼠标 x 坐标（对照拖拽前的静态中点）计算目标插入位置 */
function hitTest(x: number): number {
  if (!tabRects.length) return 0;
  for (let i = 0; i < tabRects.length; i++) {
    if (x < tabRects[i].left + tabRects[i].width / 2) return i;
  }
  return tabRects.length - 1;
}

/** 拖拽标签跟随鼠标 + 其余标签实时让位 */
function applyDragTransforms(x: number) {
  if (!dragNode || !dragRect || dragIndex.value === null) return;
  const el = listRef.value;
  if (!el) return;

  // 跟随鼠标（限制在标签栏范围内）
  const listRect = el.getBoundingClientRect();
  const dx = Math.min(
    Math.max(x - startX, listRect.left - dragRect.left),
    listRect.right - dragRect.right,
  );
  dragNode.style.transition = "none";
  dragNode.style.transform = `translateX(${dx}px)`;

  // 其余标签让位：插入点方向的标签整体平移一个槽位
  const from = dragIndex.value;
  const to = hitTest(x);
  for (let i = 0; i < tabNodes.length; i++) {
    if (i === from) continue;
    const node = tabNodes[i];
    let shift = 0;
    if (from < to && i > from && i <= to) shift = -slot;
    else if (from > to && i >= to && i < from) shift = slot;
    node.style.transition = "transform 160ms ease";
    node.style.transform = shift ? `translateX(${shift}px)` : "";
  }
}

function onTabMouseDown(e: MouseEvent, index: number) {
  if (e.button !== 0) return;
  // 关闭按钮等交互元素不参与拖拽
  if ((e.target as HTMLElement).closest("button")) return;
  pendingIndex = index;
  startX = e.clientX;
  startY = e.clientY;
  dragging = false;
  document.addEventListener("mousemove", onDocMouseMove);
  document.addEventListener("mouseup", onDocMouseUp);
}

function onDocMouseMove(e: MouseEvent) {
  if (pendingIndex === null) return;
  if (!dragging) {
    // 超过阈值才真正开始拖拽，避免误杀点击
    if (Math.abs(e.clientX - startX) < DRAG_THRESHOLD && Math.abs(e.clientY - startY) < DRAG_THRESHOLD) {
      return;
    }
    dragging = true;
    dragIndex.value = pendingIndex;
    beginDrag();
    document.body.style.userSelect = "none";
  }
  e.preventDefault();
  overIndex.value = hitTest(e.clientX);
  applyDragTransforms(e.clientX);
}

function onDocMouseUp() {
  document.removeEventListener("mousemove", onDocMouseMove);
  document.removeEventListener("mouseup", onDocMouseUp);

  if (dragging) {
    const from = dragIndex.value;
    const to = overIndex.value;
    // 清除行内样式后直接落位（无 FLIP 收尾动画）：
    // 其余标签的让位平移终点与重排后位置一致，视觉无跳变
    for (const node of tabNodes) clearNodeStyle(node);
    if (from !== null && to !== null && from !== to) {
      browser.moveTab(from, to);
    }
  }

  pendingIndex = null;
  dragging = false;
  dragIndex.value = null;
  overIndex.value = null;
  dragNode = null;
  dragRect = null;
  tabNodes = [];
  tabRects = [];
  document.body.style.userSelect = "";
}

onBeforeUnmount(() => {
  document.removeEventListener("mousemove", onDocMouseMove);
  document.removeEventListener("mouseup", onDocMouseUp);
  document.body.style.userSelect = "";
});

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
  <!-- 标签栏：本身可拖拽移动窗口，标签项拦截拖拽用于排序；select-none 禁止标签文字被选中 -->
  <div
    class="flex h-9 shrink-0 items-end gap-1 border-b border-line bg-ink-1/80 px-2 pt-1.5 select-none"
    data-tauri-drag-region
  >
    <!-- macOS 红绿灯占位 -->
    <div class="w-16 shrink-0" data-tauri-drag-region />

    <div ref="listRef" class="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto">
      <div
        v-for="(tab, i) in browser.tabs"
        :key="tab.id"
        data-tab
        :data-tab-id="tab.id"
        data-tauri-drag-region="false"
        data-no-drag
        class="group relative flex h-7 min-w-0 max-w-44 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-lg border border-b-0 px-2.5 transition-all"
        :class="[
          tab.id === browser.activeId
            ? 'border-line bg-ink-2 text-hi'
            : 'border-transparent bg-ink-1/40 text-mid hover:bg-ink-3/60',
        ]"
        @click="browser.activateTab(tab.id)"
        @mousedown.stop.prevent="onTabMouseDown($event, i)"
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
