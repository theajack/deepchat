<script setup lang="ts">
import { computed, ref } from "vue";
import { Check, Cpu, Plus, Search, X } from "lucide-vue-next";
import Avatar from "../common/Avatar.vue";
import BotAgentBadge from "./BotAgentBadge.vue";
import { useBotsStore } from "../../stores/bots";
import { useConversationsStore } from "../../stores/conversations";
import { useModelsStore } from "../../stores/models";
import type { Bot } from "../../types";
import { t } from "../../i18n";

const props = defineProps<{ groupId: string; existingIds: string[] }>();
const emit = defineEmits<{ close: []; added: [] }>();

const bots = useBotsStore();
const conversations = useConversationsStore();
const models = useModelsStore();

const keyword = ref("");
const selected = ref<Set<string>>(new Set());
const submitting = ref(false);

const candidates = computed<Bot[]>(() => {
  const kw = keyword.value.trim().toLowerCase();
  return bots.items.filter((b) => {
    if (props.existingIds.includes(b.id)) return false;
    if (!kw) return true;
    const model = b.model_id ? models.items.find((m) => m.id === b.model_id) : undefined;
    return (
      b.name.toLowerCase().includes(kw) ||
      (model?.name.toLowerCase().includes(kw) ?? false) ||
      (b.model_name?.toLowerCase().includes(kw) ?? false)
    );
  });
});

function modelName(bot: Bot): string {
  if (!bot.model_id) return bot.model_name || "—";
  return models.items.find((m) => m.id === bot.model_id)?.name || bot.model_name || "—";
}

function toggle(bot: Bot) {
  const next = new Set(selected.value);
  if (next.has(bot.id)) next.delete(bot.id);
  else next.add(bot.id);
  selected.value = next;
}

async function confirm() {
  if (!selected.value.size || submitting.value) return;
  submitting.value = true;
  try {
    for (const id of selected.value) await conversations.addMember(props.groupId, id);
    emit("added");
    emit("close");
  } catch (e) {
    // 忽略单条失败，继续添加其余好友
    console.error(e);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm" @click.self="emit('close')">
    <div class="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-line-strong/60 bg-ink-1 shadow-[0_24px_70px_rgba(0,0,0,0.55)]">
      <header class="flex shrink-0 items-center justify-between border-b border-line px-5 py-4">
        <h3 class="text-[15px] font-semibold text-hi">{{ t("group.addMember.title") }}</h3>
        <button class="flex h-8 w-8 items-center justify-center rounded-lg text-mid transition-colors hover:bg-ink-3 hover:text-hi" @click="emit('close')">
          <X :size="17" />
        </button>
      </header>

      <div class="shrink-0 px-5 pt-4">
        <div class="flex items-center gap-2 rounded-xl border border-line bg-ink-2/70 px-3 py-2 focus-within:border-accent/45">
          <Search :size="15" class="shrink-0 text-lo" />
          <input
            v-model="keyword"
            type="text"
            :placeholder="t('group.addMember.search')"
            class="w-full bg-transparent text-[13px] text-hi outline-none placeholder:text-lo"
          />
        </div>
        <p class="mt-2 text-xs text-lo">{{ t("group.addMember.selected", { count: selected.size }) }}</p>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
        <template v-if="candidates.length">
          <button
            v-for="bot in candidates"
            :key="bot.id"
            type="button"
            class="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors"
            :class="selected.has(bot.id) ? 'bg-ink-4/70' : 'hover:bg-ink-3/50'"
            @click="toggle(bot)"
          >
            <Avatar :name="bot.name" :src="bot.avatar" :size="38" />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="truncate text-[13px] font-medium text-hi">{{ bot.name }}</span>
                <BotAgentBadge :agent-enabled="bot.agent_enabled" :size="12" />
                <span
                  v-if="modelName(bot) !== '—'"
                  class="flex shrink-0 items-center gap-1 rounded-md bg-ink-2 px-1.5 py-0.5 text-[10px] font-normal text-mid"
                >
                  <Cpu :size="10" :stroke-width="2" />
                  <span class="truncate font-num">{{ modelName(bot) }}</span>
                </span>
              </div>
            </div>
            <span
              class="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors"
              :class="selected.has(bot.id) ? 'border-accent bg-accent text-on-accent' : 'border-line-strong/70 text-transparent'"
            >
              <Check :size="13" :stroke-width="3" />
            </span>
          </button>
        </template>
        <div v-else class="px-2 py-10 text-center text-sm text-lo">
          {{ keyword ? t("group.addMember.noMatch") : t("group.addMember.noneLeft") }}
        </div>
      </div>

      <footer class="flex shrink-0 items-center justify-end gap-3 border-t border-line px-5 py-4">
        <button
          class="rounded-xl border border-line-strong/60 px-4 py-2 text-[13px] text-mid transition-colors hover:bg-ink-3 hover:text-hi"
          @click="emit('close')"
        >{{ t("common.cancel") }}</button>
        <button
          class="flex items-center gap-1.5 rounded-xl bg-gradient-to-br from-accent to-accent-deep px-4 py-2 text-[13px] font-semibold text-on-accent shadow-[0_4px_18px_rgba(42,227,164,0.28)] transition-all hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="!selected.size || submitting"
          @click="confirm"
        >
          <Plus :size="14" /> {{ t("group.addMember.confirm") }}
        </button>
      </footer>
    </div>
  </div>
</template>
