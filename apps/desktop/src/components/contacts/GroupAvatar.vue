<script setup lang="ts">
import { computed } from "vue";
import Avatar from "../common/Avatar.vue";
import { useSelfStore } from "../../stores/self";

interface MemberAvatar {
  name: string;
  avatar: string | null;
  /** 好友已删除（灰滤镜显示） */
  deleted?: boolean;
}

const props = withDefaults(defineProps<{ members: MemberAvatar[]; size?: number }>(), { size: 40 });

const selfStore = useSelfStore();

// 群成员九宫格：自己始终排在好友列表最后，最多展示前 9 个
const display = computed<MemberAvatar[]>(
  () => [...props.members, { name: selfStore.displayName, avatar: selfStore.avatar }].slice(0, 9),
);

const cols = computed(() => {
  const n = display.value.length;
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  return 3;
});

const gap = computed(() => Math.max(1, Math.round(props.size / 22)));

const cell = computed(() => Math.floor((props.size - gap.value * (cols.value - 1)) / cols.value));

// 圆角随尺寸等比缩放，保证列表小头像与详情大头像视觉协调
const radius = computed(() => Math.max(3, Math.round(props.size / 10)));

const gridStyle = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
  gridTemplateColumns: `repeat(${cols.value}, 1fr)`,
  gridTemplateRows: `repeat(${cols.value}, 1fr)`,
  gap: `${gap.value}px`,
  borderRadius: `${radius.value}px`,
}));
</script>

<template>
  <div class="grid overflow-hidden bg-ink-4" :style="gridStyle">
    <Avatar v-for="(m, i) in display" :key="i" :name="m.name" :src="m.avatar" :size="cell" :radius="radius" :class="m.deleted ? 'grayscale opacity-50' : ''" />
  </div>
</template>
