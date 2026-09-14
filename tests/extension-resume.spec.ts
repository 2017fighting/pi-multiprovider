import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProvider, type Model, type Provider } from '@earendil-works/pi-ai'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'

// The extension reads its credential store and the session manager at load and
// session start, so the harness points Pi's agent dir at a scratch directory
// before anything constructs a store.
const agentDir = mkdtempSync(join(tmpdir(), 'pi-multiprovider-resume-'))
process.env.PI_CODING_AGENT_DIR = agentDir

const { MULTIPROVIDER_SERVICE_EVENT } = await import('../src/types.ts')
const { MultiAuthStore, SESSION_PIN_ENTRY_TYPE } = await import('../src/index.ts')
const { default: multiprovider } = await import('../extensions/multiprovider.ts')

const model: Model<'probe-api'> = {
  id: 'probe-model',
  name: 'Probe Model',
  api: 'probe-api',
  provider: 'example',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
}

const base = createProvider<'probe-api'>({
  id: 'example',
  name: 'Example',
  auth: { apiKey: { name: 'Example API key', async resolve() { return undefined } } },
  models: [model],
  api: {
    stream() { throw new Error('not used') },
    streamSimple() { throw new Error('not used') },
  },
}) as Provider<'probe-api'>

const store = new MultiAuthStore()
await store.addAccount('example', { label: 'Work', credential: { type: 'api_key', key: 'k-work' } })
await store.addAccount('example', { label: 'Personal', credential: { type: 'api_key', key: 'k-personal' } })
const seeded = (await store.getPool('example'))!.accounts.map(account => ({
  id: account.id,
  label: account.label,
}))
const personal = seeded.find(account => account.label === 'Personal')!

interface Announcement {
  getActiveAccount(providerId: string, ctx: ExtensionContext): Promise<unknown>
}

interface ExtensionHarness {
  entries: unknown[]
  notifications: string[]
  ctx: ExtensionContext & { model?: Model<'probe-api'> }
  active(poolId: string): Promise<unknown>
  start(): Promise<void>
  switchAccount(args: string): Promise<void>
}

// Boots the real bundled extension against duck-typed Pi APIs: provider
// registration, the event bus, session entries, and the TUI context surface
// that /switch-account and session_start touch.
async function launch(initialEntries: readonly unknown[]): Promise<ExtensionHarness> {
  const entries: unknown[] = [...initialEntries]
  const notifications: string[] = []
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => Promise<void> | void)[]>()
  const bus = new Map<string, Set<(value: unknown) => void>>()
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>()
  let announcement: Announcement | undefined

  const ctx = {
    ui: {
      notify(message: string) { notifications.push(message) },
      async select() { return undefined },
      async input() { return undefined },
      async confirm() { return false },
      async custom() { return undefined },
    },
    mode: 'tui',
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => 'session-1', getEntries: () => entries },
    modelRegistry: {
      getProvider: (id: string) => (id === base.id ? base : undefined),
      getAll: () => [model],
      getApiKeyAndHeaders: async () => ({ ok: true }),
    },
    model: undefined as Model<'probe-api'> | undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort() {},
    hasPendingMessages: () => false,
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => '',
  } as unknown as ExtensionHarness['ctx']

  const pi = {
    events: {
      emit(name: string, value: unknown) { for (const callback of bus.get(name) ?? []) callback(value) },
      on(name: string, callback: (value: unknown) => void) {
        const listeners = bus.get(name) ?? new Set<(value: unknown) => void>()
        listeners.add(callback)
        bus.set(name, listeners)
        return () => listeners.delete(callback)
      },
    },
    on(name: string, handler: () => Promise<void> | void) {
      const list = handlers.get(name) ?? []
      list.push(handler as (event: unknown, ctx: unknown) => Promise<void> | void)
      handlers.set(name, list)
    },
    registerProvider() {},
    unregisterProvider() {},
    getAllTools: () => [],
    registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, def)
    },
    // Mirrors pi: appendEntry writes a custom entry into the session file.
    appendEntry(customType: string, data?: unknown) {
      entries.push({
        type: 'custom',
        customType,
        data,
        id: 'entry-' + (entries.length + 1),
        parentId: null,
        timestamp: new Date().toISOString(),
      })
    },
  }

  bus.set(MULTIPROVIDER_SERVICE_EVENT, new Set([(value: unknown) => {
    announcement = value as Announcement
  }]))
  await multiprovider(pi as unknown as ExtensionAPI)
  if (announcement === undefined) throw new Error('extension did not announce its service')

  return {
    entries,
    notifications,
    ctx,
    active: poolId => announcement!.getActiveAccount(poolId, ctx),
    async start() {
      ctx.model = model
      for (const handler of handlers.get('session_start') ?? []) {
        await handler({ type: 'session_start', reason: 'startup' }, ctx)
      }
    },
    async switchAccount(args) {
      const command = commands.get('switch-account')
      if (command === undefined) throw new Error('/switch-account is not registered')
      await command.handler(args, ctx)
    },
  }
}

function journal(entries: readonly unknown[]): unknown[] {
  return entries
    .filter((entry): entry is { customType: string; data: unknown } =>
      typeof entry === 'object'
      && entry !== null
      && (entry as { customType?: string }).customType === SESSION_PIN_ENTRY_TYPE)
    .map(entry => entry.data)
}

describe('/switch-account survival across resume', () => {
  it('journals a switch in the session and restores it when a fresh runtime resumes', async () => {
    const live = await launch([])
    await live.start()
    expect(await live.active('example')).toBeUndefined()
    await live.switchAccount('personal')
    expect(journal(live.entries)).toEqual([
      { pool: 'example', key: 'session-1', accountId: personal.id, label: 'Personal' },
    ])
    expect(await live.active('example')).toEqual({
      id: personal.id, label: 'Personal', authKind: 'api-key',
    })
    const sessionFile = structuredClone(live.entries)

    // Resuming spawns a new extension runtime and scheduler; only the session
    // journal carries the switch across.
    const resumed = await launch(sessionFile)
    await resumed.start()
    expect(await resumed.active('example')).toEqual({
      id: personal.id, label: 'Personal', authKind: 'api-key',
    })
    expect(resumed.notifications.filter(message => message.includes('could not be restored'))).toEqual([])
  })

  it('stays automatic without a journal and does not resurrect a cleared pin', async () => {
    const plain = await launch([])
    await plain.start()
    expect(await plain.active('example')).toBeUndefined()

    const live = await launch([])
    await live.start()
    await live.switchAccount('personal')
    await live.switchAccount('auto')
    expect(await live.active('example')).toBeUndefined()

    const afterClear = await launch(live.entries)
    await afterClear.start()
    expect(await afterClear.active('example')).toBeUndefined()
  })

  it('falls back to automatic and warns when the pinned account is gone', async () => {
    const removed = new MultiAuthStore(join(agentDir, 'multiprovider-auth.json'))
    const pinned = await launch([{
      type: 'custom',
      customType: SESSION_PIN_ENTRY_TYPE,
      data: { pool: 'example', key: 'session-1', accountId: 'deleted-account', label: 'Deleted' },
      id: 'entry-1',
      parentId: null,
      timestamp: new Date().toISOString(),
    }])
    await pinned.start()
    expect(await pinned.active('example')).toBeUndefined()
    expect(pinned.notifications.filter(message => message.includes('"Deleted" could not be restored'))).toHaveLength(1)
    expect(await removed.listProviderIds()).toContain('example')
  })
})
