<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Cpu, Search, Sparkles, X } from "lucide-vue-next";
import Avatar from "../common/Avatar.vue";
import BotAgentBadge from "./BotAgentBadge.vue";
import { useAppStore } from "../../stores/app";
import { useBotsStore } from "../../stores/bots";
import { useConversationsStore } from "../../stores/conversations";
import { useModelsStore } from "../../stores/models";
import { useSelfStore } from "../../stores/self";
import { chatApi } from "../../services/chatApi";
import type { Conversation, Bot } from "../../types";
import { t } from "../../i18n";

const props = defineProps<{ group?: Conversation | null; presetIds?: string[] | null }>();
const emit = defineEmits<{ cancel: []; created: [convId: string]; saved: [] }>();

const app = useAppStore();
const bots = useBotsStore();
const conversations = useConversationsStore();
const models = useModelsStore();
const selfStore = useSelfStore();

const isEdit = computed(() => props.group != null);

const name = ref("");
const intro = ref("");
const selected = ref<Set<string>>(new Set());
/** 生成群聊介绍进行中（流式填充期间禁用输入框） */
const generating = ref(false);
/** 好友搜索关键字（按名称/模型名过滤；已选中的始终显示） */
const keyword = ref("");

/** 过滤后的好友列表：匹配名称或模型名；已选中成员不被过滤（保证编辑时可见可取消） */
const filteredBots = computed<Bot[]>(() => {
  const kw = keyword.value.trim().toLowerCase();
  if (!kw) return bots.items;
  return bots.items.filter((b) => {
    if (selected.value.has(b.id)) return true;
    const model = b.model_id ? models.items.find((m) => m.id === b.model_id) : undefined;
    return (
      b.name.toLowerCase().includes(kw) ||
      (model?.name.toLowerCase().includes(kw) ?? false) ||
      (b.model_name?.toLowerCase().includes(kw) ?? false)
    );
  });
});

// 自己始终在群聊中（不可取消），只需至少选择 1 位 AI 好友
const canSubmit = computed(() => name.value.trim().length > 0 && selected.value.size >= 1);

// 编辑模式：回填名称、简介与当前成员；新建模式：默认勾选 presetIds
watch(
  () => props.group,
  async (g) => {
    name.value = g?.name ?? "";
    intro.value = g?.introduction ?? "";
    selected.value = new Set();
    if (g) {
      const members = conversations.membersMap[g.id]?.map((b) => b.id) ?? [];
      if (members.length) {
        selected.value = new Set(members);
      } else {
        // 成员缓存未就绪，主动拉取后回填
        const loaded = await conversations.loadMembers(g.id);
        selected.value = new Set(loaded.map((b) => b.id));
      }
    } else if (props.presetIds?.length) {
      selected.value = new Set(props.presetIds);
    }
  },
  { immediate: true },
);

function toggle(id: string) {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

/** 用通用处理模型流式生成群聊介绍（群名 + 已选成员作为素材） */
async function generateIntro() {
  const n = name.value.trim();
  if (n === "") {
    app.toast(t("group.fillNameFirst"));
    return;
  }
  if (generating.value) return;
  generating.value = true;
  intro.value = "";
  try {
    const { effectiveId } = await chatApi.getGeneralModel();
    const memberNames = [
      selfStore.displayName,
      ...bots.items.filter((b) => selected.value.has(b.id)).map((b) => b.name),
    ];
    await chatApi.generateGroupIntro(
      { name: n, partial: "", memberNames, model_id: effectiveId === "" ? null : effectiveId },
      (delta) => {
        intro.value = (intro.value + delta).trim();
      },
    );
  } catch (e) {
    app.toast(t("group.generateIntroFailed", { msg: e instanceof Error ? e.message : String(e) }));
  } finally {
    generating.value = false;
  }
}

/** 获取 AI 好友使用的模型名 */
function modelLabel(bot: Bot): string {
  if (bot.model_id) {
    const m = models.items.find((x) => x.id === bot.model_id);
    if (m) return m.name || m.model_name;
  }
  return bot.model_name || "";
}

async function create() {
  if (!canSubmit.value) {
    app.toast(t("group.needAtLeast2"));
    return;
  }
  try {
    const conv = await conversations.createGroup(name.value.trim(), [...selected.value], intro.value.trim());
    name.value = "";
    intro.value = "";
    selected.value = new Set();
    emit("created", conv.id);
  } catch (e) {
    app.toast(e instanceof Error ? e.message : String(e));
  }
}

async function save() {
  if (!canSubmit.value) {
    app.toast(t("group.needAtLeast2"));
    return;
  }
  const g = props.group;
  if (!g) return;
  try {
    await conversations.updateGroup(g.id, { name: name.value.trim(), introduction: intro.value.trim() });
    // 同步成员：新增与移除
    const current = new Set((conversations.membersMap[g.id] ?? []).map((b) => b.id));
    const next = selected.value;
    for (const id of next) if (!current.has(id)) await conversations.addMember(g.id, id);
    for (const id of current) if (!next.has(id)) await conversations.removeMember(g.id, id);
    emit("saved");
    app.toast(t("common.saved"));
  } catch (e) {
    app.toast(e instanceof Error ? e.message : String(e));
  }
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div>
      <label class="mb-1.5 block text-xs text-mid">{{ t("group.name") }}</label>
      <input v-model="name" type="text" :placeholder="t('group.namePlaceholder')"
        class="w-full rounded-lg border border-line bg-ink-2/70 px-3 py-2 text-[13px] text-hi outline-none transition-all placeholder:text-lo focus:border-accent/45 focus:shadow-[0_0_0_3px_var(--color-accent-soft)]" />
    </div>
    <div>
      <div class="mb-1.5 flex items-center justify-between">
        <label class="text-xs text-mid">{{ t("group.desc") }}</label>
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-md border border-line-strong/50 bg-ink-2/70 px-2.5 py-1 text-[11px] text-mid transition-all hover:border-accent/40 hover:bg-ink-3 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="generating || !name.trim()"
          :title="name.trim() ? t('group.generateIntroTitle') : t('group.fillNameFirst')"
          @click="generateIntro"
        >
          <svg v-if="generating" class="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2.5" stroke-dasharray="16 42" stroke-linecap="round"/></svg>
          <Sparkles v-else :size="12" />
          {{ generating ? t("group.generatingIntro") : t("group.generateIntro") }}
        </button>
      </div>
      <textarea v-model="intro" rows="3" :placeholder="t('contacts.introPlaceholder')" :disabled="generating"
        class="w-full resize-none rounded-lg border border-line bg-ink-2/70 px-3 py-2 text-[13px] leading-relaxed text-hi outline-none transition-all placeholder:text-lo focus:border-accent/45 focus:shadow-[0_0_0_3px_var(--color-accent-soft)] disabled:opacity-50"></textarea>
    </div>
    <div>
      <label class="mb-1.5 block text-xs text-mid">{{ t("group.selectMembers") }}</label>
      <div v-if="bots.items.length < 1" class="rounded-lg border border-line bg-ink-2/40 px-3 py-4 text-center text-xs text-lo">
        {{ t("group.notEnough") }}
      </div>
      <template v-else>
        <!-- 好友搜索过滤（与添加群成员/群详情的搜索样式一致） -->
        <div class="mb-2 flex items-center gap-2 rounded-lg border border-line bg-ink-2/70 px-3 py-1.5 focus-within:border-accent/45">
          <Search :size="14" class="shrink-0 text-lo" />
          <input
            v-model="keyword"
            type="text"
            :placeholder="t('group.addMember.search')"
            class="w-full bg-transparent text-[12.5px] text-hi outline-none placeholder:text-lo"
          />
          <button
            v-if="keyword"
            class="shrink-0 cursor-pointer text-lo transition-colors hover:text-hi"
            @click="keyword = ''"
          >
            <X :size="13" />
          </button>
        </div>
        <div v-if="!filteredBots.length" class="rounded-lg border border-line bg-ink-2/40 px-3 py-4 text-center text-xs text-lo">
          {{ t("contacts.noMemberMatch") }}
        </div>
        <div v-else class="flex max-h-60 flex-col gap-1 overflow-y-auto pr-1">
        <!-- 自己（默认勾选，不可取消） -->
        <div class="flex items-center gap-2.5 rounded-lg px-2 py-2 bg-accent-soft/60">
          <span
            class="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-md border border-accent bg-accent text-[10px] font-bold text-on-accent shadow-[0_0_8px_var(--color-accent-glow)]"
          >✓</span>
          <Avatar :name="selfStore.displayName" :src="selfStore.avatar" :size="28" />
          <span class="truncate text-[13px] text-hi">{{ selfStore.displayName }}</span>
          <span class="ml-auto text-[10px] text-accent">{{ t("group.self") }}</span>
        </div>
        <button
          v-for="bot in filteredBots"
          :key="bot.id"
          class="flex items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-all"
          :class="selected.has(bot.id) ? 'bg-accent-soft/60' : 'hover:bg-ink-3'"
          @click="toggle(bot.id)"
        >
          <span
            class="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-md border text-[10px] font-bold transition-all"
            :class="selected.has(bot.id) ? 'border-accent bg-accent text-on-accent shadow-[0_0_8px_var(--color-accent-glow)]' : 'border-line-strong'"
          >{{ selected.has(bot.id) ? "✓" : "" }}</span>
          <Avatar :name="bot.name" :src="bot.avatar" :size="28" />
          <span class="truncate text-[13px] text-hi">{{ bot.name }}</span>
          <BotAgentBadge :agent-enabled="bot.agent_enabled" :size="13" />
          <span
            v-if="modelLabel(bot)"
            class="flex shrink-0 items-center gap-1 rounded-md bg-ink-2 px-1.5 py-0.5 text-[10px] font-normal text-mid"
          >
            <Cpu :size="10" :stroke-width="2" />
            <span class="truncate font-num">{{ modelLabel(bot) }}</span>
          </span>
        </button>
        </div>
      </template>
    </div>
    <div class="flex justify-end gap-2">
      <button class="rounded-lg border border-line-strong/50 px-4 py-2 text-[13px] text-mid transition-all hover:bg-ink-3 hover:text-hi"
        @click="emit('cancel')">{{ t("common.cancel") }}</button>
      <button v-if="isEdit" class="rounded-lg bg-gradient-to-br from-accent to-accent-deep px-4 py-2 text-[13px] font-semibold text-on-accent shadow-[0_4px_18px_rgba(42,227,164,0.28)] transition-all hover:shadow-[0_4px_24px_var(--color-accent-glow)] hover:brightness-110 active:scale-95 disabled:opacity-40 disabled:shadow-none"
        :disabled="!canSubmit" @click="save">{{ t("common.save") }}</button>
      <button v-else class="rounded-lg bg-gradient-to-br from-accent to-accent-deep px-4 py-2 text-[13px] font-semibold text-on-accent shadow-[0_4px_18px_rgba(42,227,164,0.28)] transition-all hover:shadow-[0_4px_24px_var(--color-accent-glow)] hover:brightness-110 active:scale-95 disabled:opacity-40 disabled:shadow-none"
        :disabled="!canSubmit" @click="create">{{ t("group.create") }}</button>
    </div>
  </div>
</template>
