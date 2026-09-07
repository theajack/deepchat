<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { Eye, EyeOff } from "lucide-vue-next";
import Modal from "../common/Modal.vue";
import Select from "../common/Select.vue";
import { useModelsStore } from "../../stores/models";
import { useAppStore } from "../../stores/app";
import { getModelContextDefaults, normalizeContextInput } from "../../data/modelContextDefaults";
import type { ModelConfig } from "../../types";
import { t } from "../../i18n";

const models = useModelsStore();
const app = useAppStore();

const props = defineProps<{ editingId: string | null }>();
const emit = defineEmits<{ close: []; saved: [model: ModelConfig] }>();

interface Provider {
  id: string;
  label: string;
  base_url: string;
}
const PROVIDERS = computed<Provider[]>(() => [
  { id: "custom", label: t("provider.customFull"), base_url: "" },
  { id: "openai", label: "OpenAI", base_url: "https://api.openai.com/v1" },
  { id: "deepseek", label: "DeepSeek", base_url: "https://api.deepseek.com" },
  { id: "moonshot", label: "Moonshot (Kimi)", base_url: "https://api.moonshot.cn/v1" },
  { id: "qwen", label: t("provider.qwenFull"), base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "zhipu", label: t("provider.zhipuFull"), base_url: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "doubao", label: t("provider.doubaoFull"), base_url: "https://ark.cn-beijing.volces.com/api/v3" },
  { id: "hunyuan", label: t("provider.hunyuanFull"), base_url: "https://api.hunyuan.cloud.tencent.com/v1" },
  { id: "minimax", label: "MiniMax", base_url: "https://api.minimax.chat/v1" },
  { id: "siliconflow", label: t("provider.siliconflowFull"), base_url: "https://api.siliconflow.cn/v1" },
  { id: "agnes", label: "Agnes", base_url: "https://apihub.agnes-ai.com/v1" },
  { id: "openrouter", label: "OpenRouter", base_url: "https://openrouter.ai/api/v1" },
  { id: "groq", label: "Groq", base_url: "https://api.groq.com/openai/v1" },
  { id: "together", label: "Together AI", base_url: "https://api.together.xyz/v1" },
  { id: "ollama", label: t("provider.ollama"), base_url: "http://localhost:11434/v1" },
  { id: "lmstudio", label: t("provider.lmstudio"), base_url: "http://localhost:1234/v1" },
]);

const INPUT_CTX_OPTIONS = ["128K", "256K", "512K", "1M"];
const OUTPUT_CTX_OPTIONS = ["32K", "64K", "128K", "256K"];

const isEdit = computed(() => props.editingId !== null);
const title = computed(() => (isEdit.value ? t("model.edit") : t("model.addTitle")));

const form = reactive({
  name: "",
  provider: "custom",
  base_url: "",
  api_key: "",
  model_name: "",
  tool_use: true,
  image_input: false,
  reasoning_mode: false,
  custom_protocol: false,
  input_ctx: "",
  output_ctx: "",
});
const saving = ref(false);
const showKey = ref(false);

/** 用户是否手动修改过上下文输入（手动改过则不再自动填充默认值） */
const ctxTouched = reactive({ input: false, output: false, image: false });

/** 当前模型 ID 对应的默认上下文 */
const ctxDefaults = computed(() => getModelContextDefaults(form.model_name));

/** 模型 ID 变化时，未手动修改过的字段自动填充默认值（查不到则留空） */
watch(
  () => form.model_name,
  () => {
    const d = ctxDefaults.value;
    if (!d) return;
    if (!ctxTouched.input && !form.input_ctx) form.input_ctx = d.inputCtx;
    if (!ctxTouched.output && !form.output_ctx) form.output_ctx = d.outputCtx;
    if (!ctxTouched.image) form.image_input = d.imageInput;
  },
);

/** 输入框占位符：空时提示将使用的默认值 */
const inputCtxPlaceholder = computed(() =>
  ctxDefaults.value ? ctxDefaults.value.inputCtx : t("model.ctxDefault"),
);
const outputCtxPlaceholder = computed(() =>
  ctxDefaults.value ? ctxDefaults.value.outputCtx : t("model.ctxDefault"),
);

/** 展示名称占位符：已填模型 ID 时直接显示它，直观表达「留空即用这个值」 */
const namePlaceholder = computed(() =>
  form.model_name.trim() ? form.model_name.trim() : t("model.namePlaceholder"),
);

function onProviderChange() {
  const p = PROVIDERS.value.find((x) => x.id === form.provider);
  if (p && p.base_url) form.base_url = p.base_url;
}

onMounted(async () => {
  if (props.editingId) {
    const m = models.items.find((x) => x.id === props.editingId);
    if (m) {
      form.name = m.name;
      form.provider = m.provider;
      form.base_url = m.base_url;
      form.api_key = m.api_key;
      form.model_name = m.model_name;
      form.tool_use = !!m.tool_use;
      form.image_input = !!m.image_input;
      form.reasoning_mode = !!m.reasoning_mode;
      form.custom_protocol = !!m.custom_protocol;
      form.input_ctx = m.input_ctx;
      form.output_ctx = m.output_ctx;
      // 编辑模式：已加载保存值，标记为已触碰，避免 watch 触发默认值覆盖
      ctxTouched.input = true;
      ctxTouched.output = true;
      ctxTouched.image = true;
    }
  }
});

async function save() {
  // 全部字段可选；展示名称留空时回退为模型 ID
  const modelId = form.model_name.trim();
  const name = form.name.trim() || modelId;
  saving.value = true;
  try {
    const payload = {
      name,
      provider: form.provider,
      base_url: form.base_url.trim(),
      api_key: form.api_key.trim(),
      model_name: modelId,
      tool_use: form.tool_use,
      image_input: form.image_input,
      reasoning_mode: form.reasoning_mode,
      custom_protocol: form.custom_protocol,
      // 归一化：支持末尾大小写 k/m（如 "128k" → "128K"，"1m" → "1M"）
      input_ctx: normalizeContextInput(form.input_ctx),
      output_ctx: normalizeContextInput(form.output_ctx),
    };
    let savedModel: ModelConfig;
    if (isEdit.value && props.editingId) {
      savedModel = await models.update(props.editingId, payload);
      app.toast(t("common.saved"));
    } else {
      savedModel = await models.create(payload);
      // 展示名称与模型 ID 都留空时，退化成不带名称的提示
      app.toast(name ? t("model.added", { name }) : t("common.saved"));
    }
    emit("saved", savedModel);
    emit("close");
  } catch (e) {
    app.toast(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Modal :title="title" wide @close="emit('close')">
    <div class="flex flex-col gap-4">
      <!-- 供应商 -->
      <div>
        <label class="mb-1.5 block text-xs font-medium text-mid">{{ t("model.provider") }}</label>
        <div class="relative">
          <Select
            v-model="form.provider"
            height-class="h-[42px]"
            text-class="text-[13px]"
            :options="PROVIDERS.map((p) => ({ label: p.label, value: p.id }))"
            @change="onProviderChange"
          />
        </div>
      </div>

      <!-- 接口地址 -->
      <div>
        <label class="mb-1.5 block text-xs font-medium text-mid">{{ t("model.baseUrl") }}</label>
        <input
          v-model="form.base_url"
          type="text"
          placeholder="https://api.example.com/v1"
          class="w-full rounded-lg border border-line bg-ink-2/70 px-3 py-2.5 text-[13px] text-hi outline-none transition-all placeholder:text-lo focus:border-accent/45 focus:shadow-[0_0_0_3px_var(--color-accent-soft)]"
        />
      </div>

      <!-- API Key -->
      <div>
        <label class="mb-1.5 block text-xs font-medium text-mid">API Key</label>
        <div class="relative">
          <input
            v-model="form.api_key"
            :type="showKey ? 'text' : 'password'"
            :placeholder="t('model.apiKeyPlaceholder')"
            class="w-full rounded-lg border border-line bg-ink-2/70 py-2.5 pl-3 pr-10 text-[13px] text-hi outline-none transition-all placeholder:text-lo focus:border-accent/45 focus:shadow-[0_0_0_3px_var(--color-accent-soft)]"
          />
          <button
            type="button"
            class="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-lo transition-colors hover:text-mid"
            @click="showKey = !showKey"
          >
            <Eye v-if="!showKey" :size="15" />
            <EyeOff v-else :size="15" />
          </button>
        </div>
      </div>

      <!-- 模型 ID（发送给供应商的参数，可选） -->
      <div>
        <label class="mb-1.5 block text-xs font-medium text-mid">{{ t("model.modelName") }}</label>
        <input
          v-model="form.model_name"
          type="text"
          :placeholder="t('model.modelNamePlaceholder')"
          class="w-full rounded-lg border border-line bg-ink-2/70 px-3 py-2.5 text-[13px] text-hi outline-none transition-all placeholder:text-lo focus:border-accent/45 focus:shadow-[0_0_0_3px_var(--color-accent-soft)]"
        />
      </div>

      <!-- 展示名称（可选）：留空时回退为模型 ID -->
      <div>
        <label class="mb-1.5 block text-xs font-medium text-mid">{{ t("model.name") }}</label>
        <input
          v-model="form.name"
          type="text"
          :placeholder="namePlaceholder"
          class="w-full rounded-lg border border-line bg-ink-2/70 px-3 py-2.5 text-[13px] text-hi outline-none transition-all placeholder:text-lo focus:border-accent/45 focus:shadow-[0_0_0_3px_var(--color-accent-soft)]"
        />
      </div>

      <!-- 高级配置 -->
      <div>
        <label class="mb-2.5 block text-xs font-medium text-mid">{{ t("model.advanced") }}</label>
        <div class="grid grid-cols-2 gap-x-6 gap-y-2.5">
          <label class="flex cursor-pointer items-center gap-2 text-[13px] text-hi">
            <input v-model="form.tool_use" type="checkbox" class="h-3.5 w-3.5 rounded border-line accent-accent" /> {{ t("model.toolUse") }}
          </label>
          <label class="flex cursor-pointer items-center gap-2 text-[13px] text-hi">
            <input v-model="form.image_input" type="checkbox" class="h-3.5 w-3.5 rounded border-line accent-accent" @change="ctxTouched.image = true" /> {{ t("model.imageInput") }}
          </label>
          <label class="flex cursor-pointer items-center gap-2 text-[13px] text-hi">
            <input v-model="form.reasoning_mode" type="checkbox" class="h-3.5 w-3.5 rounded border-line accent-accent" /> {{ t("model.reasoning") }}
          </label>
          <label class="group relative flex cursor-pointer items-center gap-2 text-[13px] text-hi">
            <input v-model="form.custom_protocol" type="checkbox" class="h-3.5 w-3.5 rounded border-line accent-accent" /> {{ t("model.customProtocol") }}
            <span class="pointer-events-none absolute left-0 top-full z-10 mt-1.5 w-72 rounded-lg border border-line bg-ink-0 p-2.5 text-xs leading-relaxed text-mid opacity-0 shadow-lg transition-opacity duration-200 group-hover:opacity-100">
              {{ t("model.customProtocolHint") }}
            </span>
          </label>
        </div>
      </div>

      <!-- 上下文 -->
      <div class="grid grid-cols-2 gap-6">
        <div>
          <label class="mb-1.5 block text-xs font-medium text-mid">{{ t("model.inputCtx") }}</label>
          <input
            v-model="form.input_ctx"
            type="text"
            :placeholder="inputCtxPlaceholder"
            class="w-full rounded-lg border border-line bg-ink-2/70 px-3 py-2.5 text-[13px] text-hi outline-none transition-all placeholder:text-lo focus:border-accent/45 focus:shadow-[0_0_0_3px_var(--color-accent-soft)]"
            @input="ctxTouched.input = true"
          />
          <div class="mt-1.5 flex gap-3">
            <button
              v-for="opt in INPUT_CTX_OPTIONS"
              :key="opt"
              class="rounded-md px-2 py-0.5 text-xs text-lo transition-colors hover:bg-ink-3 hover:text-mid"
              :class="{ '!bg-accent-soft !text-accent': form.input_ctx === opt }"
              @click="form.input_ctx = opt; ctxTouched.input = true"
            >
              {{ opt }}
            </button>
          </div>
        </div>
        <div>
          <label class="mb-1.5 block text-xs font-medium text-mid">{{ t("model.outputCtx") }}</label>
          <input
            v-model="form.output_ctx"
            type="text"
            :placeholder="outputCtxPlaceholder"
            class="w-full rounded-lg border border-line bg-ink-2/70 px-3 py-2.5 text-[13px] text-hi outline-none transition-all placeholder:text-lo focus:border-accent/45 focus:shadow-[0_0_0_3px_var(--color-accent-soft)]"
            @input="ctxTouched.output = true"
          />
          <div class="mt-1.5 flex gap-3">
            <button
              v-for="opt in OUTPUT_CTX_OPTIONS"
              :key="opt"
              class="rounded-md px-2 py-0.5 text-xs text-lo transition-colors hover:bg-ink-3 hover:text-mid"
              :class="{ '!bg-accent-soft !text-accent': form.output_ctx === opt }"
              @click="form.output_ctx = opt; ctxTouched.output = true"
            >
              {{ opt }}
            </button>
          </div>
        </div>
      </div>

      <!-- 操作 -->
      <div class="flex justify-end gap-3 pt-1">
        <button
          class="rounded-xl border border-line px-5 py-2 text-[13px] font-medium text-mid transition-colors hover:bg-ink-3 hover:text-hi"
          @click="emit('close')"
        >
          {{ t("common.cancel") }}
        </button>
        <button
          class="rounded-xl bg-gradient-to-br from-accent to-accent-deep px-6 py-2 text-[13px] font-semibold text-on-accent shadow-[0_4px_18px_rgba(42,227,164,0.28)] transition-all hover:shadow-[0_4px_24px_var(--color-accent-glow)] hover:brightness-110 active:scale-95 disabled:opacity-40 disabled:shadow-none"
          :disabled="saving"
          @click="save"
        >
          {{ saving ? t("model.saving") : t("common.save") }}
        </button>
      </div>
    </div>
  </Modal>
</template>
