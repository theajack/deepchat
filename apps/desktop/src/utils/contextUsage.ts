import type { Message } from "../types";

/**
 * 粗略估算一段文本的 token 数。
 *
 * 仅在模型未返回 usage 时作为兜底：中日韩文字约 1 字 1 token，其余（拉丁
 * 字母、数字、标点）约 4 字符 1 token。够用于「上下文占用」这类量级展示，
 * 不用于计费。
 */
export function estimateTokens(text: string | undefined): number {
  if (!text) return 0;
  const cjk = text.match(/[぀-ヿ㐀-䶿一-鿿가-힯]/g)?.length ?? 0;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

/**
 * 计算会话当前的上下文占用（token）。
 *
 * 模型每次请求都会带上完整历史，所以「最近一次请求的 prompt」就是当时的
 * 上下文占用。以最近一条带 prompt usage 的 AI 消息为锚点，再补上它之后
 * 新增的内容（AI 输出用实际 completion，用户消息只能按字符估算）——否则
 * 用户发完消息、AI 还没回复的这段时间里，圆环会停在上一轮的数字上。
 *
 * 整个会话都没有 usage 时（模型不返回用量），退化为按内容估算全会话，
 * 而不是退化成「只有上一次输出」。
 *
 * @param list 会话消息（按时间正序）
 * @param botId 群聊里只统计该成员的消息；私聊省略
 */
export function computeContextUsage(
  list: readonly Message[] | undefined,
  botId?: string,
): number {
  if (!list || list.length === 0) return 0;

  // 锚点：最近一条 prompt_tokens > 0 的 AI 消息（prompt 才是「全量历史」，
  // completion 只是本次输出，不能用它当基准）
  let anchor = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.sender_type !== "ai_bot") continue;
    if (botId !== undefined && m.sender_id !== botId) continue;
    if ((m.prompt_tokens ?? 0) > 0) {
      anchor = i;
      break;
    }
  }

  if (anchor < 0) {
    return list.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  }

  const base = list[anchor];
  let used = (base.prompt_tokens ?? 0) + (base.completion_tokens ?? 0);
  for (let i = anchor + 1; i < list.length; i++) {
    const m = list[i];
    if (m.sender_type === "ai_bot") {
      used +=
        (m.completion_tokens ?? 0) > 0
          ? (m.completion_tokens ?? 0)
          : estimateTokens(m.content);
    } else {
      used += estimateTokens(m.content);
    }
  }
  return used;
}
