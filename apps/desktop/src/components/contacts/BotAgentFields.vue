<script setup lang="ts">
import { Cpu } from "lucide-vue-next";
import Select from "../common/Select.vue";
import { t } from "../../i18n";

// form 为 BotEditorModal 的响应式对象（引用传递，直接修改可响应）
const props = defineProps<{ form: Record<string, any> }>();
</script>

<template>
  <div class="rounded-xl border border-line bg-ink-1/40 p-3.5">
    <div class="mb-3 flex items-center gap-2">
      <Cpu :size="15" class="text-accent" />
      <span class="text-[13px] font-semibold text-hi">{{ t("agent.title") }}</span>
      <span class="text-[11px] text-lo">{{ t("agent.desc") }}</span>
    </div>

    <label class="mb-3 flex cursor-pointer items-center justify-between">
      <span class="text-[12.5px] text-mid">{{ t("agent.enable") }}</span>
      <input
        type="checkbox"
        v-model="props.form.agent_enabled"
        :true-value="1"
        :false-value="0"
        class="h-4 w-4 accent-accent"
      />
    </label>

    <div v-if="props.form.agent_enabled" class="space-y-3">
      <div class="rounded-lg border border-dashed border-accent/30 bg-accent/5 px-3 py-2">
        <p class="text-[11px] text-lo">
          {{ t("agent.workspace") }}
          <span class="font-mono text-mid">~/chat-agent-workspace/agents/{uuid}</span>
        </p>
        <p class="mt-0.5 text-[10px] text-lo">{{ t("agent.workspaceNote") }}</p>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div>
          <label class="mb-1 block text-[11.5px] text-mid">{{ t("agent.maxTurns") }}</label>
          <input
            type="number"
            min="1"
            max="50"
            v-model.number="props.form.max_turns"
            class="h-9 w-full rounded-lg border border-line bg-ink-2 px-3 text-[12.5px] text-hi outline-none focus:border-accent"
          />
        </div>
        <div>
          <label class="mb-1 block text-[11.5px] text-mid">{{ t("agent.approvalPolicy") }}</label>
          <Select
            v-model="props.form.approval_policy"
            :options="[
              { label: t('agent.ask'), value: 'ask' },
              { label: t('agent.allowAll'), value: 'allow' },
              { label: t('agent.denyAll'), value: 'deny' },
              { label: t('agent.whitelist'), value: 'auto' },
            ]"
          />
        </div>
      </div>

    </div>
  </div>
</template>
