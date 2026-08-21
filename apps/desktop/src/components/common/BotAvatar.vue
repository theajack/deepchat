<script setup lang="ts">
/**
 * @deprecated 请直接使用 `common/AvatarEditor.vue`。
 * 本文件仅为向后兼容保留，将 BotAvatar 逻辑委托给 AvatarEditor。
 */
import AvatarEditor from "./AvatarEditor.vue";

defineProps<{ modelValue: string | null; size?: number }>();
defineEmits<{ "update:modelValue": [string | null] }>();
</script>

<template>
  <AvatarEditor v-bind="$attrs" :model-value="modelValue" @update:modelValue="$emit('update:modelValue', $event)" />
</template>
