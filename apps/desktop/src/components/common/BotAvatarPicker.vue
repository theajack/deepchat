<script setup lang="ts">
/**
 * @deprecated 请直接使用 `common/AvatarPicker.vue`。
 * 本文件仅为向后兼容保留。
 */
import AvatarPicker from "./AvatarPicker.vue";

defineProps<{ modelValue: string | null }>();
defineEmits<{ "update:modelValue": [string | null] }>();
</script>

<template>
  <AvatarPicker :model-value="modelValue" @update:modelValue="$emit('update:modelValue', $event)" />
</template>
