<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

/** 菜单项 */
export interface ContextMenuItem {
  key: string;
  label: string;
  icon?: string;
  disabled?: boolean;
  danger?: boolean;
}

/** 菜单分组（一组带可选标题） */
export interface ContextMenuGroup {
  title?: string;
  items: ContextMenuItem[];
}

export interface ContextMenuState {
  x: number;
  y: number;
  groups: ContextMenuGroup[];
}

const props = defineProps<{ state: ContextMenuState | null }>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "select", key: string): void;
}>();

const menuRef = ref<HTMLElement | null>(null);
const pos = ref({ left: 0, top: 0, ready: false });

/**
 * 菜单打开时定位，防止超出视口。
 * state 为 null 时隐藏。
 */
watch(
  () => props.state,
  async (state) => {
    if (!state) {
      pos.value.ready = false;
      return;
    }
    // 先标记可见，再在 nextTick 后测量菜单尺寸并钳制位置
    pos.value = { left: state.x, top: state.y, ready: true };
    await nextTick();
    const el = menuRef.value;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let left = state.x;
    let top = state.y;
    if (left + rect.width > window.innerWidth) left = window.innerWidth - rect.width - 8;
    if (top + rect.height > window.innerHeight) top = window.innerHeight - rect.height - 8;
    pos.value = { left: Math.max(8, left), top: Math.max(8, top), ready: true };
  },
  { flush: "post" },
);

function onClickItem(item: ContextMenuItem) {
  if (item.disabled) return;
  emit("select", item.key);
  emit("close");
}

function onGlobalMousedown(e: MouseEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    emit("close");
  }
}

onMounted(() => {
  document.addEventListener("mousedown", onGlobalMousedown);
});

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onGlobalMousedown);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="state && pos.ready"
      ref="menuRef"
      class="fixed z-[100] min-w-[160px] rounded-lg border border-line-strong/60 bg-ink-1/95 py-1 shadow-[0_8px_32px_rgba(0,0,0,0.5)] backdrop-blur"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
      @contextmenu.prevent
      @mousedown.stop
    >
      <template v-for="(group, gi) in state.groups" :key="gi">
        <!-- 分组标题 -->
        <div v-if="group.title" class="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-lo">
          {{ group.title }}
        </div>
        <!-- 分组项 -->
        <template v-for="item in group.items" :key="item.key">
          <button
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors"
            :class="[
              item.disabled ? 'cursor-not-allowed text-lo' : item.danger ? 'text-danger hover:bg-danger/10' : 'cursor-pointer text-hi hover:bg-ink-3',
            ]"
            :disabled="item.disabled"
            @click="onClickItem(item)"
          >
            <span v-if="item.icon" class="text-[13px] leading-none">{{ item.icon }}</span>
            <span class="flex-1 truncate">{{ item.label }}</span>
          </button>
        </template>
        <!-- 分组分隔线 -->
        <div v-if="gi < state.groups.length - 1" class="mx-2 my-1 h-px bg-line" />
      </template>
    </div>
  </Teleport>
</template>
