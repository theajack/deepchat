/**
 * 主流大模型上下文窗口默认值表
 * 数据来源：start-agent 项目内置模型列表（packages/llm/src/models.ts），均为官方/实测数据
 * key 为模型 ID（全部小写），查找时对模型 ID 做 case-insensitive 匹配；
 * 带日期/版本后缀的模型通过前缀匹配命中。
 * 原模型 ID 中的 -ioa 网关后缀已去除；glm-5.2-internal 保留 -internal 以区分自部署版。
 */

export interface ModelContextDefaults {
  /** 输入上下文窗口，如 "128K" / "1M" */
  inputCtx: string
  /** 最大输出 token，如 "8K" / "64K" */
  outputCtx: string
  /** 是否支持图像（多模态）输入 */
  imageInput: boolean
}

/** 模型 ID（小写）→ 默认上下文 */
export const MODEL_CONTEXT_DEFAULTS: Record<string, ModelContextDefaults> = {
  // ===== 混元 Hunyuan =====
  'hy3': { inputCtx: '256K', outputCtx: '64K', imageInput: false },

  // ===== DeepSeek =====
  'deepseek-v4-flash': { inputCtx: '1M', outputCtx: '50K', imageInput: false },
  'deepseek-v4-pro': { inputCtx: '1M', outputCtx: '50K', imageInput: false },

  // ===== Anthropic Claude =====
  'claude-sonnet-5': { inputCtx: '1M', outputCtx: '128K', imageInput: true },
  'claude-sonnet-4.6': { inputCtx: '1M', outputCtx: '24K', imageInput: true },
  'claude-opus-5': { inputCtx: '1M', outputCtx: '128K', imageInput: true },
  'claude-opus-4.8': { inputCtx: '1M', outputCtx: '128K', imageInput: true },
  'claude-opus-4.7': { inputCtx: '1M', outputCtx: '128K', imageInput: true },
  'claude-opus-4.6': { inputCtx: '1M', outputCtx: '64K', imageInput: true },
  'claude-haiku-4.5': { inputCtx: '176K', outputCtx: '24K', imageInput: true },

  // ===== Google Gemini =====
  'gemini-3.1-pro': { inputCtx: '400K', outputCtx: '64K', imageInput: true },
  'gemini-3.5-flash': { inputCtx: '1M', outputCtx: '65536', imageInput: true },

  // ===== OpenAI =====
  'gpt-5.6-sol': { inputCtx: '1M', outputCtx: '128K', imageInput: true },
  'gpt-5.6-terra': { inputCtx: '1M', outputCtx: '128K', imageInput: true },
  'gpt-5.6-luna': { inputCtx: '1M', outputCtx: '128K', imageInput: true },
  'gpt-5.5': { inputCtx: '1M', outputCtx: '128K', imageInput: true },
  'gpt-5.4': { inputCtx: '272K', outputCtx: '128K', imageInput: true },
  'gpt-5.3-codex': { inputCtx: '272K', outputCtx: '128K', imageInput: true },

  // ===== GLM（智谱）=====
  'glm-5.3': { inputCtx: '1M', outputCtx: '48K', imageInput: true },
  'glm-5.2': { inputCtx: '1M', outputCtx: '48K', imageInput: true },
  'glm-5v-turbo': { inputCtx: '200K', outputCtx: '38K', imageInput: true },
  'glm-5.0': { inputCtx: '200K', outputCtx: '48K', imageInput: false },

  // ===== MiniMax =====
  'minimax-m3': { inputCtx: '512K', outputCtx: '48K', imageInput: true },
  'minimax-m2.7': { inputCtx: '200K', outputCtx: '48K', imageInput: true },

  // ===== Kimi / Moonshot =====
  'kimi-k3': { inputCtx: '1M', outputCtx: '32K', imageInput: true },
  'kimi-k2.7': { inputCtx: '256K', outputCtx: '32K', imageInput: true },
  'kimi-k2.6': { inputCtx: '256K', outputCtx: '32K', imageInput: true },
}

/** 缓存小写 key 数组（按长度降序，保证前缀匹配取最长） */
const sortedKeys = Object.keys(MODEL_CONTEXT_DEFAULTS).sort((a, b) => b.length - a.length)

/**
 * 按模型 ID 查找默认上下文：
 * 1. 先精确匹配（忽略大小写）
 * 2. 再前缀匹配（处理带日期/版本后缀的 ID，如 claude-sonnet-5-1m-xxx → claude-sonnet-5-1m）
 * 未命中返回 null（调用方应留空）
 */
export function getModelContextDefaults(modelName: string): ModelContextDefaults | null {
  const id = modelName.trim().toLowerCase()
  if (!id) return null
  if (MODEL_CONTEXT_DEFAULTS[id]) return MODEL_CONTEXT_DEFAULTS[id]
  for (const key of sortedKeys) {
    if (id.startsWith(`${key}-`) || id === key) return MODEL_CONTEXT_DEFAULTS[key]
  }
  return null
}

/**
 * 解析上下文字符串为 token 数：
 * 支持 "128K"/"128k"/"1M"/"1m"/"65536" → number
 * K/M 不区分大小写；非法输入返回 null
 */
export function parseContextTokens(ctx: string): number | null {
  const m = ctx.trim().match(/^(\d+(?:\.\d+)?)\s*([kKmM])?$/)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const unit = m[2]?.toLowerCase()
  if (unit === 'k') return Math.round(n * 1000)
  if (unit === 'm') return Math.round(n * 1000 * 1000)
  return Math.round(n)
}

/**
 * 归一化用户输入的上下文值：
 * "128k" → "128K"，"1m" → "1M"，" 65536 " → "65536"
 * 非法/空输入原样返回（trim 后）
 */
export function normalizeContextInput(ctx: string): string {
  const s = ctx.trim()
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([kKmM])$/)
  if (!m) return s
  return `${m[1]}${m[2].toUpperCase()}`
}
