<script setup lang="ts">
import { Bot as BotIcon, MessageCircle } from "lucide-vue-next";

defineProps<{
  /** 1 表示启用 agent 能力 */
  agentEnabled: number;
  size?: number;
}>();
</script>

<template>
  <BotIcon
    v-if="agentEnabled"
    class="inline-block shrink-0 align-middle text-accent"
    :size="size ?? 13"
    :stroke-width="2"
  />
  <MessageCircle
    v-else
    class="inline-block shrink-0 align-middle text-accent"
    :size="size ?? 13"
    :stroke-width="2"
  />
</template>
