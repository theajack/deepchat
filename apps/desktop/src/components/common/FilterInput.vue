<script setup lang="ts">
import { Search, X } from "lucide-vue-next";
import { t } from "../../i18n";

/** 实时过滤输入框：工具/技能/MCP 列表共用（v-model 绑定关键字） */
const keyword = defineModel<string>({ default: "" });
</script>

<template>
  <div class="relative">
    <Search :size="13" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-lo" />
    <input
      v-model="keyword"
      type="text"
      :placeholder="t('common.searchPlaceholder')"
      class="w-full rounded-lg border border-line bg-ink-2 py-1.5 pl-7.5 pr-7 text-[12px] text-hi outline-none transition-colors placeholder:text-lo focus:border-accent"
    />
    <button
      v-if="keyword"
      type="button"
      class="absolute right-2 top-1/2 -translate-y-1/2 text-lo transition-colors hover:text-hi"
      @click="keyword = ''"
    >
      <X :size="12" />
    </button>
  </div>
</template>
