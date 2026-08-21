<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";

/** 气泡出现方位 */
type Placement = "top" | "bottom" | "left" | "right";

const props = withDefaults(
  defineProps<{
    /** 气泡内容（纯文本；html=true 时作为 HTML 渲染） */
    content?: string;
    /** 是否将 content 作为 HTML 渲染（默认 false，纯文本自动转义防注入） */
    html?: boolean;
    /** 气泡出现方位，空间不足时自动翻转到对侧 */
    placement?: Placement;
    /** 显示延迟（ms），避免快速扫过时闪烁 */
    delay?: number;
    /** 气泡最大宽度 */
    maxWidth?: string;
    /** 触发区是否占满整行（默认 inline-block） */
    block?: boolean;
    /** 禁用时完全不显示气泡 */
    disabled?: boolean;
  }>(),
  {
    content: "",
    html: false,
    placement: "top",
    delay: 0,
    maxWidth: "260px",
    block: false,
    disabled: false,
  },
);

const triggerRef = ref<HTMLElement | null>(null);
const tipRef = ref<HTMLElement | null>(null);

const visible = ref(false);
const pos = ref({ left: 0, top: 0, ready: false });

let showTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;

const GAP = 8;
const EDGE = 8;

function clearTimers() {
  if (showTimer) clearTimeout(showTimer);
  if (hideTimer) clearTimeout(hideTimer);
  showTimer = undefined;
  hideTimer = undefined;
}

/** 根据触发区与气泡尺寸计算最终位置，含视口钳制与空间不足自动翻转 */
function computePos(trigger: DOMRect, tip: DOMRect, placement: Placement) {
  let left = 0;
  let top = 0;

  const fitsTop = trigger.top - tip.height - GAP >= EDGE;
  const fitsBottom = trigger.bottom + tip.height + GAP <= window.innerHeight - EDGE;
  const fitsLeft = trigger.left - tip.width - GAP >= EDGE;
  const fitsRight = trigger.right + tip.width + GAP <= window.innerWidth - EDGE;

  // 翻转：优先按用户指定方位，空间不足时取对侧
  let effective = placement;
  if (placement === "top" && !fitsTop && fitsBottom) effective = "bottom";
  else if (placement === "bottom" && !fitsBottom && fitsTop) effective = "top";
  else if (placement === "left" && !fitsLeft && fitsRight) effective = "right";
  else if (placement === "right" && !fitsRight && fitsLeft) effective = "left";

  if (effective === "top") {
    left = trigger.left + trigger.width / 2 - tip.width / 2;
    top = trigger.top - tip.height - GAP;
  } else if (effective === "bottom") {
    left = trigger.left + trigger.width / 2 - tip.width / 2;
    top = trigger.bottom + GAP;
  } else if (effective === "left") {
    left = trigger.left - tip.width - GAP;
    top = trigger.top + trigger.height / 2 - tip.height / 2;
  } else {
    left = trigger.right + GAP;
    top = trigger.top + trigger.height / 2 - tip.height / 2;
  }

  // 视口钳制
  left = Math.min(Math.max(EDGE, left), window.innerWidth - tip.width - EDGE);
  top = Math.min(Math.max(EDGE, top), window.innerHeight - tip.height - EDGE);

  return { left, top };
}

async function show() {
  if (props.disabled || !props.content) return;
  clearTimers();
  showTimer = setTimeout(async () => {
    const el = triggerRef.value;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // 先渲染（ready=false，透明），用于测量尺寸
    visible.value = true;
    pos.value = { left: rect.left, top: rect.top, ready: false };
    await nextTick();
    const tip = tipRef.value;
    if (!tip) return;
    const tRect = tip.getBoundingClientRect();
    pos.value = { ...computePos(rect, tRect, props.placement), ready: true };
  }, props.delay);
}

function hide() {
  clearTimers();
  hideTimer = setTimeout(() => {
    visible.value = false;
    pos.value = { ...pos.value, ready: false };
  }, 0);
}

/** 滚动或窗口尺寸变化时直接隐藏，避免气泡错位 */
function onViewportChange() {
  hide();
}

onMounted(() => {
  window.addEventListener("scroll", onViewportChange, true);
  window.addEventListener("resize", onViewportChange);
});

onBeforeUnmount(() => {
  clearTimers();
  window.removeEventListener("scroll", onViewportChange, true);
  window.removeEventListener("resize", onViewportChange);
});
</script>

<template>
  <span
    ref="triggerRef"
    class="hover-tip-trigger"
    :class="block ? 'block' : 'inline-block'"
    @mouseenter="show"
    @mouseleave="hide"
  >
    <slot />
  </span>

  <Teleport to="body">
    <Transition name="hover-tip">
      <div
        v-if="visible && content"
        ref="tipRef"
        role="tooltip"
        class="pointer-events-none fixed z-[120] rounded-lg border border-line-strong/60 bg-ink-1/95 px-3 py-2 text-[12px] leading-relaxed text-hi shadow-[0_8px_32px_rgba(0,0,0,0.5)] backdrop-blur transition-opacity duration-100"
        :class="pos.ready ? 'opacity-100' : 'opacity-0'"
        :style="{ left: `${pos.left}px`, top: `${pos.top}px`, maxWidth }"
      >
        <span v-if="!html">{{ content }}</span>
        <div v-else v-html="content" />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.hover-tip-enter-active,
.hover-tip-leave-active {
  transition: opacity 0.1s ease;
}
.hover-tip-enter-from,
.hover-tip-leave-to {
  opacity: 0;
}
</style>
