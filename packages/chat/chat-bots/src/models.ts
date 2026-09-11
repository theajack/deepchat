import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { z } from 'zod'

/** One durable custom-model record (chat-agent's `ai_models` successor). */
export interface ModelRecord {
  /** Stable identity; also the storage key. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** UI provider family: `openai` | `anthropic` | `deepseek` | `custom`. */
  readonly provider: string
  /** Endpoint base URL; empty keeps the provider family default. */
  readonly baseUrl: string
  /** API key, stored locally and mirrored into the credential store. */
  readonly apiKey: string
  /** Model id sent to the endpoint. */
  readonly modelName: string
  /** Whether the model supports tool calls. */
  readonly toolUse: boolean
  /** Whether the model accepts image input. */
  readonly imageInput: boolean
  /** Whether the model exposes reasoning effort. */
  readonly reasoningMode: boolean
  /** Whether a non-standard protocol is required. */
  readonly customProtocol: boolean
  /** Free-form context-window hint for the UI (e.g. `128k`). */
  readonly inputCtx: string
  /** Free-form output-window hint for the UI. */
  readonly outputCtx: string
  readonly createdAt: number
  readonly updatedAt: number
}

const modelRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  baseUrl: z.string().default(''),
  apiKey: z.string().default(''),
  modelName: z.string().default(''),
  toolUse: z.boolean().default(true),
  imageInput: z.boolean().default(false),
  reasoningMode: z.boolean().default(false),
  customProtocol: z.boolean().default(false),
  inputCtx: z.string().default(''),
  outputCtx: z.string().default(''),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}) satisfies z.ZodType<ModelRecord>

export { modelRecordSchema }

/** Wire protocol per provider family. */
const PROTOCOL_FOR: Readonly<Record<string, string>> = {
  openai: 'openai-completions',
  custom: 'openai-completions',
  deepseek: 'openai-completions',
  anthropic: 'anthropic-messages',
}

/** Endpoint default per provider family, used when `baseUrl` is empty. */
const DEFAULT_BASE_URL: Readonly<Record<string, string>> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  deepseek: 'https://api.deepseek.com',
  custom: '',
}

/** The llm-pi-ai settings route key this record owns. */
export function routeIdFor(id: string): string {
  return `chat-${id}`
}

/**
 * The inverse of {@link routeIdFor}: recover the model id from a route key.
 *
 * Used to backfill legacy bot records that only stored the route; returns
 * undefined when the value is not one of our routes.
 */
export function modelIdFromRoute(route: string): string | undefined {
  return route.startsWith('chat-') && route.length > 'chat-'.length
    ? route.slice('chat-'.length)
    : undefined
}

/** The credential reference (environment-variable name) this record owns. */
export function apiKeyRefFor(id: string): string {
  return `CHAT_AGENT_MODEL_${id.replace(/-/g, '_').toUpperCase()}`
}

/** True when a record targets DeepSeek's official endpoints (empty baseUrl = family default). */
function usesOfficialDeepSeek(record: ModelRecord): boolean {
  if (record.provider !== 'deepseek') return false
  const baseUrl = record.baseUrl !== '' ? record.baseUrl : DEFAULT_BASE_URL.deepseek
  return baseUrl === DEFAULT_BASE_URL.deepseek
}

/**
 * Mirror one official-DeepSeek record's key to the shared `DEEPSEEK_API_KEY`
 * credential. dsh's web-search-deepseek provider (the `web_search` tool's
 * backend) authenticates with that reference — without the mirror the model
 * page's per-record credentials are invisible to it.
 */
export const DEEPSEEK_SHARED_CREDENTIAL_REF = 'DEEPSEEK_API_KEY'

/** Mirror official-DeepSeek keys so dsh built-ins (web search) can use them. */
export async function mirrorDeepSeekCredential(ctx: Context, records: readonly ModelRecord[]): Promise<void> {
  const official = records.filter(record => usesOfficialDeepSeek(record) && record.apiKey !== '')
  if (official.length === 0) {
    await ctx.credentials.unset(credentialRef(DEEPSEEK_SHARED_CREDENTIAL_REF))
    return
  }
  // Multiple official records: the newest-synced one wins (same as the UI's
  // "default model" semantics — acceptable, keys normally identical).
  const newest = official[official.length - 1]
  if (newest !== undefined) {
    await ctx.credentials.set(credentialRef(DEEPSEEK_SHARED_CREDENTIAL_REF), newest.apiKey)
  }
}

/** The llm-pi-ai hand-declared provider profile for one record. */
export function providerProfile(record: ModelRecord): Record<string, unknown> {
  const baseUrl = record.baseUrl !== '' ? record.baseUrl : DEFAULT_BASE_URL[record.provider] ?? ''
  return {
    displayName: record.name,
    api: PROTOCOL_FOR[record.provider] ?? 'openai-completions',
    ...(baseUrl === '' ? {} : { baseURL: baseUrl }),
    apiKeyEnv: apiKeyRefFor(record.id),
    models: [{
      id: record.modelName,
      name: record.name,
      input: record.imageInput ? ['text', 'image'] : ['text'],
    }],
  }
}

/** Read the current user section of the llm-pi-ai namespace (or `{}`). */
async function readUserSection(ctx: Context): Promise<Record<string, unknown>> {
  const ns = settingsNamespace('llm-pi-ai')
  const descriptor = ctx.settings.describe().find(entry => entry.ns === ns)
  const user = descriptor?.user
  return (user !== undefined && typeof user === 'object' && user !== null)
    ? { ...(user as Record<string, unknown>) }
    : {}
}

/**
 * Sync one record's llm-pi-ai route: rewrite the user section's `providers`
 * map with this route's profile (replace semantics, revision-guarded) and
 * mirror the API key into the credential store.
 */
export async function syncRoute(ctx: Context, record: ModelRecord, apiKey: string): Promise<void> {
  await ctx.credentials.set(credentialRef(apiKeyRefFor(record.id)), apiKey)
  const ns = settingsNamespace('llm-pi-ai')
  const descriptor = ctx.settings.describe().find(entry => entry.ns === ns)
  const section = await readUserSection(ctx)
  const providers = (section.providers !== undefined && typeof section.providers === 'object' && section.providers !== null)
    ? { ...(section.providers as Record<string, unknown>) }
    : {}
  providers[routeIdFor(record.id)] = providerProfile(record)
  section.providers = providers
  await ctx.settings.replace(ns, section, descriptor?.revision)
}

/**
 * Remove one record's llm-pi-ai route and credential by rewriting the user
 * section without the route key (merge updates cannot delete keys).
 */
export async function removeRoute(ctx: Context, id: string, provider: string): Promise<void> {
  const routeId = routeIdFor(id)
  const ns = settingsNamespace('llm-pi-ai')
  const descriptor = ctx.settings.describe().find(entry => entry.ns === ns)
  const section = await readUserSection(ctx)
  const providers = (section.providers !== undefined && typeof section.providers === 'object' && section.providers !== null)
    ? { ...(section.providers as Record<string, unknown>) }
    : {}
  if (routeId in providers) {
    section.providers = Object.fromEntries(
      Object.entries(providers).filter(([key]) => key !== routeId))
    await ctx.settings.replace(ns, section, descriptor?.revision)
  }
  await ctx.credentials.unset(credentialRef(apiKeyRefFor(id)))
  void provider
}

/** The models store accessor bound to the shared chat-bots domain. */
export class ModelStore {
  constructor(private readonly domain: ModelsDomainView) {}

  list(): ModelRecord[] {
    return [...this.domain.table('models').entries()]
      .map(([, record]) => record)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): ModelRecord | undefined {
    return this.domain.table('models').get(id)
  }

  async put(record: ModelRecord): Promise<void> {
    await this.domain.table('models').put(record.id, record)
  }

  async delete(id: string): Promise<void> {
    await this.domain.table('models').delete(id)
  }
}

/** Structural view of the chat-bots domain restricted to the `models` table. */
interface ModelsDomainView {
  table(name: 'models'): {
    entries(): IterableIterator<[string, ModelRecord]>
    get(key: string): ModelRecord | undefined
    put(key: string, record: ModelRecord): Promise<unknown>
    delete(key: string): Promise<unknown>
  }
}

/** Storage key holding the user's default-model choice. */
export const DEFAULT_MODEL_KEY = 'default_model_id'

/**
 * Storage key holding the group-scheduling model: the one-shot "who should
 * speak next" arbitrator that replaces per-member probability rolls.
 */
export const GROUP_JUDGE_MODEL_KEY = 'group_judge_model_id'

/** Structural view of the shared `meta` key/value table. */
interface MetaDomainView {
  table(name: 'meta'): {
    get(key: string): string | undefined
    put(key: string, value: string): Promise<unknown>
    delete(key: string): Promise<unknown>
  }
}

/**
 * One model preference persisted in the shared `meta` table — e.g. the default
 * model, or the group-scheduling model.
 *
 * Separate from {@link ModelStore} so each holder sees exactly the one table it
 * needs, and parameterised by key so several preferences share one
 * implementation instead of duplicating it.
 */
export class ModelPreferenceStore {
  constructor(
    private readonly domain: MetaDomainView,
    private readonly models: ModelStore,
    private readonly key: string,
  ) {}

  /** The chosen model id, or undefined when never set. */
  id(): string | undefined {
    return this.domain.table('meta').get(this.key)
  }

  async set(modelId: string): Promise<void> {
    await this.domain.table('meta').put(this.key, modelId)
  }

  async clear(): Promise<void> {
    await this.domain.table('meta').delete(this.key)
  }

  /**
   * Only the explicit choice, with no fallback. Undefined when unset or when
   * the chosen record no longer exists.
   *
   * Needed by preference chains: a caller must be able to tell "the user
   * picked nothing here" (so the next preference in the chain applies) from
   * "the user picked something invalid" (which should also fall through).
   */
  resolveExplicit(): ModelRecord | undefined {
    const id = this.id()
    return id === undefined ? undefined : this.models.get(id)
  }

  /**
   * The effective model: the explicit choice when it still exists, otherwise
   * the newest record — i.e. "whatever the user configured", falling back to
   * "the first model available".
   */
  resolve(): ModelRecord | undefined {
    return this.resolveExplicit() ?? this.models.list()[0]
  }
}
