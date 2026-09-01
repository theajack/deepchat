<script setup lang="ts">
/**
 * Token 消耗弹窗：累计对比 + 近 7 天趋势。
 *
 * 数据只依赖后端一份聚合报表，这里负责展示与模型切换；格式化与图表绘制
 * 分别落在 ../../utils/format 与 ../charts 下，本组件保持薄。
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import { BarChart3, X } from "lucide-vue-next";
import { chatApi, type TokenUsageReport } from "../../services/chatApi";
import TokenBarChart from "../charts/TokenBarChart.vue";
import TokenLineChart from "../charts/TokenLineChart.vue";
import Select from "../common/Select.vue";
import { t } from "../../i18n";

const emit = defineEmits<{ close: [] }>();

const report = ref<TokenUsageReport | null>(null);
const loading = ref(true);
const error = ref("");

/** 折线图查看的模型；ALL 表示所有模型合计 */
const ALL = "__all__";
const selected = ref<string>(ALL);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    report.value = await chatApi.getTokenUsage();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
  window.addEventListener("keydown", onKeydown);
});
onUnmounted(() => window.removeEventListener("keydown", onKeydown));

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}

/** 柱状图数据：各模型累计，按总量降序（后端已排序，这里只取前 8 防过长） */
const barItems = computed(() =>
  (report.value?.models ?? []).slice(0, 8).map((m) => ({
    name: m.modelName || m.modelId,
    value: m.totalTokens,
  })),
);

/** 折线图数据：所选模型（或全部）的每日序列 */
const lineValues = computed(() => {
  const r = report.value;
  if (r === null) return [];
  if (selected.value === ALL) return r.daily.map((d) => d.totalTokens);
  const model = r.models.find((m) => m.modelId === selected.value);
  return (model?.daily ?? []).map((d) => d.totalTokens);
});

const lineName = computed(() => {
  if (selected.value === ALL) return "all";
  return report.value?.models.find((m) => m.modelId === selected.value)?.modelName ?? "model";
});

const grand = computed(() => report.value?.grandTotal ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 });

const hasData = computed(() => (report.value?.models.length ?? 0) > 0);

/** 紧凑数字：1.2k / 3.4M，避免长串数字撑破卡片 */
function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function dayLabel(date: string): string {
  const [, m, d] = date.split("-");
  return `${m}/${d}`;
}

/**
 * 折线图模型下拉选项。
 *
 * hint 放该模型的累计消耗而不是模型 ID：label 已经是「模型名 → ID」的回落
 * 结果，再补 ID 会重复；而这是消耗弹窗，总量既能区分同名条目、又能直接
 * 看出谁是消耗大户。
 */
const modelOptions = computed(() => [
  { label: t("tokenUsage.allModels"), value: ALL, hint: compact(grand.value.totalTokens) },
  ...(report.value?.models ?? []).map((m) => ({
    label: m.modelName || m.modelId,
    value: m.modelId,
    hint: compact(m.totalTokens),
  })),
]);
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-ink-0/70 p-6 backdrop-blur-sm"
    @click.self="emit('close')"
  >
    <div
      class="flex max-h-[85vh] w-150 flex-col overflow-hidden rounded-2xl border border-line-strong/60 bg-ink-1/95 shadow-[0_32px_80px_rgba(0,0,0,0.6)]"
    >
      <!-- 标题栏 -->
      <div class="flex shrink-0 items-center gap-2 border-b border-line px-6 py-4">
        <BarChart3 :size="15" class="text-accent" />
        <h3 class="flex-1 text-sm font-semibold tracking-wide text-hi">
          {{ t("tokenUsage.title") }}
        </h3>
        <button
          class="flex h-7 w-7 items-center justify-center rounded-lg text-lo transition-colors hover:bg-ink-3 hover:text-hi"
          :title="t('common.close')"
          @click="emit('close')"
        >
          <X :size="15" />
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <!-- 加载 / 错误 / 空态 -->
        <p v-if="loading" class="py-10 text-center text-[13px] text-lo">{{ t("common.loading") }}</p>
        <p v-else-if="error !== ''" class="py-10 text-center text-[13px] text-red-400">{{ error }}</p>

        <div v-else-if="!hasData" class="py-10 text-center">
          <p class="text-[13px] text-lo">{{ t("tokenUsage.empty") }}</p>
          <p class="mt-1.5 text-[11px] text-lo/70">{{ t("tokenUsage.emptyHint") }}</p>
        </div>

        <div v-else class="flex flex-col gap-6">
          <!-- 总览 -->
          <section>
            <div class="grid grid-cols-4 gap-2.5">
              <div class="rounded-xl border border-line bg-ink-2/50 px-3 py-2.5">
                <p class="text-[10px] uppercase tracking-wide text-lo">{{ t("tokenUsage.totalTokens") }}</p>
                <p class="mt-1 text-[17px] font-semibold text-accent">{{ compact(grand.totalTokens) }}</p>
              </div>
              <div class="rounded-xl border border-line bg-ink-2/50 px-3 py-2.5">
                <p class="text-[10px] uppercase tracking-wide text-lo">{{ t("tokenUsage.inputTokens") }}</p>
                <p class="mt-1 text-[17px] font-semibold text-hi">{{ compact(grand.inputTokens) }}</p>
              </div>
              <div class="rounded-xl border border-line bg-ink-2/50 px-3 py-2.5">
                <p class="text-[10px] uppercase tracking-wide text-lo">{{ t("tokenUsage.outputTokens") }}</p>
                <p class="mt-1 text-[17px] font-semibold text-hi">{{ compact(grand.outputTokens) }}</p>
              </div>
              <div class="rounded-xl border border-line bg-ink-2/50 px-3 py-2.5">
                <p class="text-[10px] uppercase tracking-wide text-lo">{{ t("tokenUsage.requests") }}</p>
                <p class="mt-1 text-[17px] font-semibold text-hi">{{ compact(grand.requests) }}</p>
              </div>
            </div>
          </section>

          <!-- 各模型累计（柱状图） -->
          <section>
            <h4 class="mb-2.5 text-[12px] font-medium text-mid">{{ t("tokenUsage.byModel") }}</h4>
            <div class="rounded-xl border border-line bg-ink-2/40 px-3.5 py-3">
              <TokenBarChart :items="barItems" />
            </div>
          </section>

          <!-- 近 7 天趋势（折线图） -->
          <section>
            <div class="mb-2.5 flex items-center justify-between gap-3">
              <h4 class="shrink-0 text-[12px] font-medium text-mid">{{ t("tokenUsage.trend7d") }}</h4>
              <Select
                v-model="selected"
                width-class="w-45"
                height-class="h-[30px]"
                text-class="text-[11.5px]"
                :options="modelOptions"
              />
            </div>
            <div class="rounded-xl border border-line bg-ink-2/40 px-3.5 py-3">
              <TokenLineChart
                :labels="(report?.days ?? []).map(dayLabel)"
                :values="lineValues"
                :series-name="lineName"
                :height="130"
              />
            </div>
          </section>

          <p class="text-[10px] leading-relaxed text-lo/70">{{ t("tokenUsage.footnote") }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
