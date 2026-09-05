<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Copy, MessageCircle, Pencil, Plus, Search, Trash2, UserPlus, Users, X, Cpu } from "lucide-vue-next";
import Avatar from "../components/common/Avatar.vue";
import GroupAvatar from "../components/contacts/GroupAvatar.vue";
import BotAgentBadge from "../components/contacts/BotAgentBadge.vue";
import AddGroupMemberModal from "../components/contacts/AddGroupMemberModal.vue";
import ConfirmModal from "../components/common/ConfirmModal.vue";
import ResizeHandle from "../components/common/ResizeHandle.vue";
import { useAppStore } from "../stores/app";
import { useBotsStore } from "../stores/bots";
import { useConversationsStore } from "../stores/conversations";
import { useModelsStore } from "../stores/models";
import { useSelfStore } from "../stores/self";
import { useUiStore } from "../stores/ui";
import { useIncrementalList } from "../composables/useIncrementalList";
import type { Bot } from "../types";
import { formatDateTime } from "../utils/display";
import { showBotDetail, hideBotDetail } from "../utils/botDetailHover";
import HoverTip from "../components/common/HoverTip.vue";
import ContextMenu, { type ContextMenuState } from "../components/common/ContextMenu.vue";
import { t } from "../i18n";

const app = useAppStore();
const bots = useBotsStore();
const conversations = useConversationsStore();
const models = useModelsStore();
const selfStore = useSelfStore();
const ui = useUiStore();

onMounted(() => {
  if (!models.loaded) models.load();
  // 群聊成员改为按需加载（见下方 watch），首屏不再为每个群聊发一次请求
  void conversations.load();
});

/** 群聊成员（供九宫格头像展示），self 由 GroupAvatar 自动追加在末尾 */
function groupMemberAvatars(id: string): { name: string; avatar: string | null }[] {
  return (conversations.membersMap[id] ?? []).map((b) => ({ name: b.name, avatar: b.avatar }));
}

const keyword = ref("");
const selectedBotId = ref<string | null>(null);
const selectedGroupId = ref<string | null>(null);
/** 正在克隆好友（服务端要跑一次会话总结，需要给用户等待反馈） */
const cloning = ref(false);

/** 根据 model_id 查找模型显示名 */
function modelName(bot: Bot): string {
  if (!bot.model_id) return bot.model_name || "—";
  const m = models.items.find((x) => x.id === bot.model_id);
  return m?.name || bot.model_name || "—";
}

interface ContactItem {
  id: string;
  name: string;
  sub: string;
  count?: number;
  kind: "bot" | "group";
  /** 好友头像（群聊为 null，使用九宫格） */
  avatar: string | null;
  /** 好友的 agent 能力（群聊为 0，不展示） */
  agentEnabled?: number;
}

/** 好友列表：AI 好友 + 群聊，按名称搜索 */
const contactItems = computed<ContactItem[]>(() => {
  const kw = keyword.value.trim().toLowerCase();
  const groups: ContactItem[] = conversations.items
    .filter((c) => c.type === "group")
    .map((c) => ({ id: c.id, name: c.name, sub: t("contacts.group"), count: (conversations.membersMap[c.id]?.length ?? 0) + 1, kind: "group" as const, avatar: null }));
  const friends: ContactItem[] = bots.items.map((b) => ({
    id: b.id,
    name: b.name,
    sub: modelName(b),
    kind: "bot" as const,
    avatar: b.avatar ?? null,
    agentEnabled: b.agent_enabled,
  }));
  const all = [...groups, ...friends];
  if (!kw) return all;
  return all.filter((it) => it.name.toLowerCase().includes(kw) || it.sub.toLowerCase().includes(kw));
});

// 增量渲染：首屏 20 项，滚动接近底部时追加 20 项
const list = useIncrementalList(() => contactItems.value, 20);
const visibleContacts = list.visible;
// 搜索关键字变化 → 回到第一页
watch(keyword, () => list.reset());

// 只给可见的群聊加载成员（人数与九宫格按需拉取，避免首屏 N 次请求）
watch(
  () => visibleContacts.value.filter((it) => it.kind === "group").map((it) => it.id),
  (ids) => {
    for (const id of ids) {
      if (!conversations.membersMap[id]) void conversations.loadMembers(id);
    }
  },
  { immediate: true },
);

const selectedBot = computed(() => bots.items.find((b) => b.id === selectedBotId.value) ?? null);
const selectedGroup = computed(() => conversations.items.find((c) => c.id === selectedGroupId.value) ?? null);

/** 群聊成员（本地 ref，直接来自 loadMembers 返回，保证计数准确） */
const groupMembers = ref<Bot[]>([]);
/** 群成员过滤关键字（复用添加群成员的搜索逻辑：名称/模型名匹配） */
const memberKeyword = ref("");

/** 过滤后的群成员列表 */
const filteredGroupMembers = computed<Bot[]>(() => {
  const kw = memberKeyword.value.trim().toLowerCase();
  if (!kw) return groupMembers.value;
  return groupMembers.value.filter((b) => {
    const model = b.model_id ? models.items.find((m) => m.id === b.model_id) : undefined;
    return (
      b.name.toLowerCase().includes(kw) ||
      (model?.name.toLowerCase().includes(kw) ?? false) ||
      (b.model_name?.toLowerCase().includes(kw) ?? false)
    );
  });
});

/** 群成员头像 hover：显示好友详情浮层（全局单例） */
function onMemberEnter(botId: string, e: MouseEvent) {
  showBotDetail(botId, e.currentTarget as HTMLElement);
}
function onMemberLeave() {
  hideBotDetail();
}

// 群聊介绍编辑态
const editingIntro = ref(false);
const introDraft = ref("");
// 添加成员弹窗
const showAddModal = ref(false);
// 二次确认弹框
interface ConfirmState {
  title: string;
  message: string;
  confirmText: string;
  action: () => Promise<void> | void;
}
const confirmState = ref<ConfirmState | null>(null);
function requestConfirm(state: ConfirmState) {
  confirmState.value = state;
}
async function onConfirm() {
  const state = confirmState.value;
  confirmState.value = null;
  if (state) await state.action();
}

function onMembersAdded() {
  if (selectedGroupId.value) {
    void conversations.loadMembers(selectedGroupId.value).then((m) => (groupMembers.value = m));
  }
}

watch(selectedGroupId, async (id) => {
  memberKeyword.value = "";
  if (!id) {
    groupMembers.value = [];
    return;
  }
  editingIntro.value = false;
  showAddModal.value = false;
  groupMembers.value = await conversations.loadMembers(id);
  introDraft.value = selectedGroup.value?.introduction ?? "";
});

// 群成员变更（含群聊编辑弹窗保存）后同步详情页成员列表
watch(
  () => {
    const id = selectedGroupId.value;
    return id ? conversations.membersMap[id] : undefined;
  },
  (list) => {
    if (selectedGroupId.value) groupMembers.value = list ? [...list] : [];
  },
  { deep: true },
);

function selectItem(it: ContactItem) {
  if (it.kind === "bot") {
    selectedBotId.value = it.id;
    selectedGroupId.value = null;
  } else {
    selectedGroupId.value = it.id;
    selectedBotId.value = null;
  }
}

function isActive(it: ContactItem): boolean {
  return it.kind === "bot" ? it.id === selectedBotId.value : it.id === selectedGroupId.value;
}

async function chatWithBot(bot: Bot) {
  const conv = await conversations.createPrivate(bot.id);
  app.navigate("chat");
  await conversations.select(conv.id);
}

async function chatWithGroup(groupId: string) {
  app.navigate("chat");
  await conversations.select(groupId);
}

async function removeBot(bot: Bot) {
  requestConfirm({
    title: t("contacts.deleteBot.title"),
    message: t("contacts.deleteBot.message", { name: bot.name }),
    confirmText: t("common.delete"),
    action: async () => {
      if (selectedBotId.value === bot.id) selectedBotId.value = null;
      await bots.remove(bot.id);
      app.toast(t("contacts.deletedBot", { name: bot.name }));
    },
  });
}

/**
 * 克隆好友：复制配置与长期记忆；历史会话不复制，但服务端会立刻把它总结
 * 进克隆体的记忆文件。总结是一次 LLM 调用，所以需要等待反馈。
 */
async function cloneBot(bot: Bot) {
  if (cloning.value) return;
  cloning.value = true;
  try {
    const created = await bots.clone(bot.id);
    // 选中克隆体，方便立刻查看它继承了什么
    selectedBotId.value = created.id;
    selectedGroupId.value = null;
    // 列表可能正被搜索关键字过滤，克隆体的名字未必命中当前关键字。
    // 清空关键字，否则会出现"克隆成功但列表没反应"。
    if (keyword.value.trim() !== "") keyword.value = "";
    // 成功提示由 bots.clone() 统一发出（会话列表入口也走同一路径）

    // 与新建好友一致：立刻建立会话并跳转，让克隆体可以马上开聊
    const conv = await conversations.createPrivate(created.id);
    app.navigate("chat");
    await conversations.select(conv.id);
  } catch (e) {
    app.toast(e instanceof Error ? e.message : String(e));
  } finally {
    cloning.value = false;
  }
}

async function removeGroup(group: { id: string; name: string }) {
  requestConfirm({
    title: t("contacts.deleteGroup.title"),
    message: t("contacts.deleteGroup.message", { name: group.name }),
    confirmText: t("common.disband"),
    action: async () => {
      if (selectedGroupId.value === group.id) selectedGroupId.value = null;
      await conversations.remove(group.id);
      app.toast(t("contacts.deletedGroup"));
    },
  });
}

// ---------- 列表右键菜单 ----------
const menuState = ref<ContextMenuState | null>(null);
const menuTarget = ref<ContactItem | null>(null);

/**
 * 列表项右键菜单。好友与群聊的可用操作不同，故按 kind 分别构造。
 * 删除/解散动作本身已内置二次确认（见 removeBot / removeGroup），
 * 这里直接转发即可，不重复弹窗。
 */
function onContextMenu(e: MouseEvent, item: ContactItem) {
  e.preventDefault();
  e.stopPropagation();
  menuTarget.value = item;
  menuState.value = {
    x: e.clientX,
    y: e.clientY,
    groups: [
      {
        items:
          item.kind === "bot"
            ? [
              { key: "clone", label: t("contacts.menu.cloneBot") },
              { key: "delete", label: t("contacts.menu.deleteBot"), danger: true },
            ]
            : [{ key: "disband", label: t("contacts.menu.disbandGroup"), danger: true }],
      },
    ],
  };
}

function onMenuSelect(key: string) {
  const item = menuTarget.value;
  if (!item) return;
  if (item.kind === "group") {
    if (key === "disband") removeGroup({ id: item.id, name: item.name });
    return;
  }
  // 列表项只携带 id，克隆/删除需要完整的 Bot 对象
  const bot = bots.items.find((b) => b.id === item.id);
  if (!bot) return;
  if (key === "clone") void cloneBot(bot);
  else if (key === "delete") removeBot(bot);
}

// ---------- 群聊成员与介绍管理 ----------
function startEditIntro() {
  introDraft.value = selectedGroup.value?.introduction ?? "";
  editingIntro.value = true;
}

function cancelEditIntro() {
  editingIntro.value = false;
  introDraft.value = selectedGroup.value?.introduction ?? "";
}

async function saveIntro() {
  if (!selectedGroup.value) return;
  const value = introDraft.value.trim();
  await conversations.updateGroup(selectedGroup.value.id, { introduction: value });
  editingIntro.value = false;
  app.toast(t("contacts.savedIntro"));
}

async function removeMember(bot: Bot) {
  if (!selectedGroupId.value || !selectedGroup.value) return;
  const groupName = selectedGroup.value.name;
  requestConfirm({
    title: t("contacts.removeMember.title"),
    message: t("contacts.removeMember.message", { name: bot.name, group: groupName }),
    confirmText: t("contacts.removeMember.confirm"),
    action: async () => {
      if (!selectedGroupId.value) return;
      await conversations.removeMember(selectedGroupId.value, bot.id);
      groupMembers.value = await conversations.loadMembers(selectedGroupId.value);
    },
  });
}
</script>

<template>
  <div class="flex min-w-0 flex-1">
    <!-- 左侧好友列表 -->
    <aside class="relative flex shrink-0 flex-col border-r border-line bg-ink-2/40" :style="{ width: `${ui.sidebarWidth}px` }">
      <ResizeHandle />
      <!-- 搜索栏 + 新建 -->
      <div class="flex items-center gap-2 px-3.5 pt-4 pb-2.5">
        <div class="relative min-w-0 flex-1">
          <Search :size="13" class="absolute top-1/2 left-3 -translate-y-1/2 text-lo" />
          <input
            v-model="keyword"
            type="text"
            :placeholder="t('contacts.search')"
            class="w-full rounded-lg border border-line bg-ink-1/80 py-1.5 pr-3 pl-8 text-xs text-hi outline-none transition-colors placeholder:text-lo focus:border-accent/40"
          />
        </div>
        <button
          class="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border border-line-strong/50 bg-ink-2/70 text-mid transition-all hover:border-accent/40 hover:bg-ink-3 hover:text-accent active:scale-95"
          :title="t('conv.newFriend')"
          @click="app.openBotEditor()"
        >
          <Plus :size="15" />
        </button>
      </div>

      <!-- 列表 -->
      <div class="flex-1 overflow-y-auto pb-2.5" @scroll="list.onScroll">
        <template v-if="contactItems.length === 0">
          <div class="px-4 py-10 text-center text-xs text-lo">
            {{ bots.items.length === 0 && !conversations.items.some((c) => c.type === "group") ? t("contacts.empty") : t("contacts.noMatch") }}
          </div>
        </template>
        <div
          v-for="it in visibleContacts"
          :key="it.kind + ':' + it.id"
          class="group relative mx-2 mb-0.5 flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2.5 transition-all duration-150 hover:bg-ink-3/70"
          :class="{ '!bg-ink-4': isActive(it) }"
          @click="selectItem(it)"
          @contextmenu="onContextMenu($event, it)"
        >
          <span
            v-if="isActive(it)"
            class="absolute -left-2 h-5 w-[3px] rounded-r-full bg-accent shadow-[0_0_8px_var(--color-accent)]"
          />
          <GroupAvatar v-if="it.kind === 'group'" :members="groupMemberAvatars(it.id)" :size="40" />
          <Avatar v-else :name="it.name" :src="it.avatar" :size="40" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5 text-[13px] font-medium text-hi">
              <span class="truncate">{{ it.name }}</span>
              <BotAgentBadge v-if="it.kind === 'bot'" :agent-enabled="it.agentEnabled ?? 0" :size="13" />
              <span v-if="it.kind === 'group'" class="flex shrink-0 items-center gap-0.5 text-[10px] font-normal text-accent">
                <Users :size="11" :stroke-width="2" />
                <span class="font-num">{{ it.count ?? 0 }}</span>
              </span>
            </div>
            <div class="mt-0.5 truncate text-[11px] text-mid">{{ it.sub }}</div>
          </div>
        </div>
      </div>
    </aside>

    <!-- 右侧详情区 -->
    <main class="flex min-w-0 flex-1 flex-col bg-chat">
      <!-- AI 好友详情 -->
      <template v-if="selectedBot">
        <header class="flex h-13 shrink-0 items-center justify-between border-b border-line bg-ink-1/50 px-6">
          <h2 class="text-sm font-semibold tracking-wide text-hi">{{ t("contacts.botDetail") }}</h2>
          <div class="flex gap-2">
            <button
              class="flex items-center gap-1.5 rounded-lg border border-line-strong/60 px-3 py-1.5 text-xs text-mid transition-all hover:border-accent/40 hover:bg-ink-3 hover:text-hi"
              @click="app.openGroupEditor(undefined, selectedBot ? [selectedBot.id] : undefined)"
            >
              <Users :size="14" /> {{ t("contacts.startGroup") }}
            </button>
          </div>
        </header>

        <div class="flex-1 overflow-y-auto p-6">
          <div class="mx-auto max-w-lg">
            <div class="flex items-start gap-4">
              <Avatar :name="selectedBot.name" :src="selectedBot.avatar" :size="72" />
              <div class="min-w-0 flex-1 pt-1">
                <div class="flex items-center gap-2 text-[18px] font-semibold text-hi">
                  <span>{{ selectedBot.name }}</span>
                  <BotAgentBadge :agent-enabled="selectedBot.agent_enabled" :size="16" />
                </div>
                <div class="mt-1 text-[13px] text-mid">{{ modelName(selectedBot) }}</div>
                <div class="mt-0.5 font-mono text-[11px] text-lo">ID: {{ selectedBot.id }}</div>
              </div>
            </div>

            <section class="mt-6">
              <h3 class="mb-2 text-xs font-medium uppercase tracking-wider text-lo">{{ t("contacts.persona") }}</h3>
              <div class="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-xl border border-line bg-ink-2/60 p-4 leading-relaxed text-[13px] text-mid">
                {{ selectedBot.persona || t("contacts.noPersona") }}
              </div>
            </section>

            <section class="mt-5">
              <h3 class="mb-2 text-xs font-medium uppercase tracking-wider text-lo">{{ t("contacts.createdAt") }}</h3>
              <div class="font-num text-[13px] text-mid">{{ formatDateTime(selectedBot.created_at) }}</div>
            </section>

            <div class="mt-8 flex gap-3">
              <button
                class="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-br from-accent to-accent-deep px-4 py-2.5 text-sm font-semibold text-on-accent shadow-[0_4px_18px_rgba(42,227,164,0.28)] transition-all hover:shadow-[0_4px_24px_var(--color-accent-glow)] hover:brightness-110 active:scale-95"
                @click="chatWithBot(selectedBot)"
              >
                <MessageCircle :size="16" /> {{ t("contacts.sendMessage") }}
              </button>
              <button
                class="flex items-center justify-center rounded-xl border border-line-strong/50 px-4 py-2.5 text-mid transition-colors hover:border-accent/40 hover:bg-ink-3 hover:text-hi"
                :title="t('common.edit')"
                @click="app.openBotEditor(selectedBot)"
              >
                <Pencil :size="16" />
              </button>
              <button
                class="flex items-center justify-center rounded-xl border border-line-strong/50 px-4 py-2.5 text-mid transition-colors hover:border-accent/40 hover:bg-ink-3 hover:text-hi disabled:cursor-not-allowed disabled:opacity-50"
                :title="t('contacts.cloneBot')"
                :disabled="cloning"
                @click="cloneBot(selectedBot)"
              >
                <Copy :size="16" />
              </button>
              <button
                class="flex items-center justify-center rounded-xl border border-line-strong/50 px-4 py-2.5 text-mid transition-colors hover:border-danger/50 hover:bg-danger/10 hover:text-danger"
                :title="t('common.delete')"
                @click="removeBot(selectedBot)"
              >
                <Trash2 :size="16" />
              </button>
            </div>
          </div>
        </div>
      </template>

      <!-- 群聊详情 -->
      <template v-else-if="selectedGroup">
        <header class="flex h-13 shrink-0 items-center border-b border-line bg-ink-1/50 px-6">
          <h2 class="text-sm font-semibold tracking-wide text-hi">{{ t("contacts.groupDetail") }}</h2>
        </header>

        <div class="flex-1 overflow-y-auto p-6">
          <div class="mx-auto max-w-lg">
            <div class="flex items-start gap-4">
              <GroupAvatar :members="groupMembers.map((b) => ({ name: b.name, avatar: b.avatar }))" :size="72" />
              <div class="min-w-0 flex-1 pt-1">
                <div class="flex items-center gap-2 text-[18px] font-semibold text-hi">
                  <span>{{ selectedGroup.name }}</span>
                  <span class="flex shrink-0 items-center gap-0.5 text-[12px] font-normal text-accent">
                    <Users :size="13" :stroke-width="2" />
                    <span class="font-num">{{ groupMembers.length + 1 }}</span>
                  </span>
                </div>
                <div class="mt-1 text-[13px] text-mid">{{ t("contacts.groupMembers", { count: groupMembers.length + 1 }) }}</div>
                <div class="mt-0.5 font-mono text-[11px] text-lo">ID: {{ selectedGroup.id }}</div>
              </div>
            </div>

            <!-- 群聊介绍 -->
            <section class="mt-6">
              <div class="mb-2 flex items-center justify-between">
                <h3 class="text-xs font-medium uppercase tracking-wider text-lo">{{ t("contacts.groupIntro") }}</h3>
                <button
                  v-if="!editingIntro"
                  class="flex items-center gap-1 text-xs text-mid transition-colors hover:text-accent"
                  @click="startEditIntro"
                >
                  <Pencil :size="12" /> {{ t("common.edit") }}
                </button>
              </div>
              <div
                v-if="!editingIntro"
                class="max-h-60 min-h-[64px] overflow-y-auto whitespace-pre-wrap rounded-xl border border-line bg-ink-2/60 p-4 leading-relaxed text-[13px] text-mid"
              >
                {{ selectedGroup.introduction || t("contacts.noGroupIntro") }}
              </div>
              <div v-else class="rounded-xl border border-accent/40 bg-ink-2/60 p-3">
                <textarea
                  v-model="introDraft"
                  rows="3"
                  :placeholder="t('contacts.introPlaceholder')"
                  class="w-full resize-none bg-transparent text-[13px] leading-relaxed text-hi outline-none placeholder:text-lo"
                />
                <div class="mt-2 flex justify-end gap-2">
                  <button
                    class="rounded-lg border border-line-strong/60 px-3 py-1.5 text-xs text-mid transition-colors hover:bg-ink-3 hover:text-hi"
                    @click="cancelEditIntro"
                  >{{ t("common.cancel") }}</button>
                  <button
                    class="rounded-lg bg-gradient-to-br from-accent to-accent-deep px-3 py-1.5 text-xs font-semibold text-on-accent transition-all hover:brightness-110 active:scale-95"
                    @click="saveIntro"
                  >{{ t("common.save") }}</button>
                </div>
              </div>
            </section>

            <!-- 创建时间 -->
            <section class="mt-6">
              <h3 class="mb-2 text-xs font-medium uppercase tracking-wider text-lo">{{ t("contacts.createdAt") }}</h3>
              <div class="font-num text-[13px] text-mid">{{ formatDateTime(selectedGroup.created_at) }}</div>
            </section>

            <!-- 群成员 -->
            <section class="mt-6">
              <div class="mb-2 flex items-center justify-between">
                <h3 class="text-xs font-medium uppercase tracking-wider text-lo">{{ t("contacts.groupMembersTitle", { count: groupMembers.length + 1 }) }}</h3>
                <button
                  class="flex items-center gap-1 text-xs text-mid transition-colors hover:text-accent"
                  @click="showAddModal = true"
                >
                  <UserPlus :size="13" /> {{ t("contacts.addFriend") }}
                </button>
              </div>

              <!-- 成员列表 -->
              <div class="rounded-xl border border-line bg-ink-2/60 p-2">
                <!-- 成员过滤搜索框（复用添加群成员的搜索样式与匹配逻辑） -->
                <div class="mb-2 flex items-center gap-2 rounded-lg border border-line bg-ink-2/70 px-3 py-1.5 focus-within:border-accent/45">
                  <Search :size="14" class="shrink-0 text-lo" />
                  <input
                    v-model="memberKeyword"
                    type="text"
                    :placeholder="t('group.addMember.search')"
                    class="w-full bg-transparent text-[12.5px] text-hi outline-none placeholder:text-lo"
                  />
                  <button
                    v-if="memberKeyword"
                    class="shrink-0 cursor-pointer text-lo transition-colors hover:text-hi"
                    @click="memberKeyword = ''"
                  >
                    <X :size="13" />
                  </button>
                </div>
                <!-- 自己（群主，不可移除；有关键字时隐藏） -->
                <div
                  v-if="!memberKeyword.trim()"
                  class="group flex items-center gap-3 rounded-lg px-2 py-2"
                >
                  <Avatar :name="selfStore.displayName" :src="selfStore.avatar" :size="40" />
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-[13px] font-medium text-hi">{{ selfStore.displayName }}</div>
                    <div class="truncate text-[11px] text-accent">{{ t("group.self") }}</div>
                  </div>
                </div>
                <template v-if="filteredGroupMembers.length">
                  <div
                    v-for="member in filteredGroupMembers"
                    :key="member.id"
                    class="group flex items-center gap-3 rounded-lg px-2 py-2"
                  >
                    <!-- 已删除成员：灰显 + hover 提示；正常成员：hover 弹详情浮层 -->
                    <HoverTip
                      v-if="member.deleted"
                      :content="t('chat.botDeleted')"
                      placement="right"
                    >
                      <Avatar :name="member.name" :src="member.avatar" :size="40" class="grayscale opacity-50" />
                    </HoverTip>
                    <Avatar
                      v-else
                      :name="member.name"
                      :src="member.avatar"
                      :size="40"
                      class="cursor-pointer transition-transform hover:scale-105"
                      @mouseenter="onMemberEnter(member.id, $event)"
                      @mouseleave="onMemberLeave"
                    />
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-1.5">
                        <span class="truncate text-[13px] font-medium text-hi" :class="member.deleted ? 'opacity-50' : ''">{{ member.name }}</span>
                        <span v-if="member.deleted" class="shrink-0 text-[10px] text-orange-400">{{ t("chat.botDeleted") }}</span>
                        <BotAgentBadge v-else :agent-enabled="member.agent_enabled" :size="12" />
                        <span
                          v-if="modelName(member) !== '—'"
                          class="flex shrink-0 items-center gap-1 rounded-md bg-ink-2 px-1.5 py-0.5 text-[10px] font-normal text-mid"
                        >
                          <Cpu :size="10" :stroke-width="2" />
                          <span class="truncate font-num">{{ modelName(member) }}</span>
                        </span>
                      </div>
                    </div>
                    <button
                      class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-mid opacity-0 transition-all hover:bg-danger/15 hover:text-danger group-hover:opacity-100"
                      :title="t('contacts.removeMember.title')"
                      @click="removeMember(member)"
                    >
                      <X :size="15" />
                    </button>
                  </div>
                </template>
                <div v-else class="px-2 py-4 text-center text-xs text-lo">
                  {{ memberKeyword.trim() ? t("contacts.noMemberMatch") : t("contacts.noMembers") }}
                </div>
              </div>
            </section>

            <div class="mt-8 flex gap-3">
              <button
                class="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-br from-accent to-accent-deep px-4 py-2.5 text-sm font-semibold text-on-accent shadow-[0_4px_18px_rgba(42,227,164,0.28)] transition-all hover:shadow-[0_4px_24px_var(--color-accent-glow)] hover:brightness-110 active:scale-95"
                @click="chatWithGroup(selectedGroup.id)"
              >
                <MessageCircle :size="16" /> {{ t("contacts.sendMessage") }}
              </button>
              <button
                class="flex items-center justify-center rounded-xl border border-line-strong/50 px-4 py-2.5 text-mid transition-colors hover:border-accent/40 hover:bg-ink-3 hover:text-hi"
                :title="t('contacts.editGroup')"
                @click="app.openGroupEditor(selectedGroup)"
              >
                <Pencil :size="16" />
              </button>
              <button
                class="flex items-center justify-center rounded-xl border border-line-strong/50 px-4 py-2.5 text-mid transition-colors hover:border-danger/50 hover:bg-danger/10 hover:text-danger"
                :title="t('contacts.deleteGroup.title')"
                @click="removeGroup(selectedGroup)"
              >
                <Trash2 :size="16" />
              </button>
            </div>
          </div>
        </div>
      </template>

      <!-- 空状态 -->
      <div v-else class="flex flex-1 flex-col items-center justify-center gap-4 text-lo">
        <div class="flex h-20 w-20 items-center justify-center rounded-2xl border border-line bg-ink-2/70 text-accent/60">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </div>
        <p class="text-sm text-mid">{{ t("contacts.emptyDetail") }}</p>
        <p class="-mt-2 text-xs">{{ t("contacts.emptyDetailSub") }}</p>
      </div>
    </main>

    <AddGroupMemberModal
      v-if="showAddModal && selectedGroup"
      :group-id="selectedGroup.id"
      :existing-ids="groupMembers.map((m) => m.id)"
      @added="onMembersAdded"
      @close="showAddModal = false"
    />

    <ConfirmModal
      v-if="confirmState"
      :title="confirmState.title"
      :message="confirmState.message"
      :confirm-text="confirmState.confirmText"
      danger
      @confirm="onConfirm"
      @close="confirmState = null"
    />

    <!-- 列表右键菜单（好友：复制/删除；群聊：解散） -->
    <ContextMenu :state="menuState" @close="menuState = null" @select="onMenuSelect" />
  </div>
</template>
