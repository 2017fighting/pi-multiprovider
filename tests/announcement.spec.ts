import type { Api, Model, Provider } from '@earendil-works/pi-ai'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { createServiceAnnouncement } from '../src/announcement.ts'
import {
  MultiProviderService,
  PI_UPSTREAM_ACCOUNT_ID,
  type ActiveAccount,
  type MultiProviderIntegration,
  type MultiProviderServiceContext,
  type ProviderAccount,
} from '../src/index.ts'

const accounts: ProviderAccount<string>[] = [
  {
    id: PI_UPSTREAM_ACCOUNT_ID,
    label: 'Pi default',
    authKind: 'custom',
    credentialRef: PI_UPSTREAM_ACCOUNT_ID,
  },
  { id: 'a', label: 'Work', authKind: 'oauth', credentialRef: 'ref-a' },
  { id: 'b', label: 'Personal', authKind: 'oauth', credentialRef: 'ref-b' },
]

interface ResolveResult {
  auth: { apiKey?: string; headers?: Record<string, string> }
  source?: string
}

function makeHarness(options: {
  affinity?: boolean
  selectionBias?: 'first-account' | 'none'
  resolve?: ResolveResult | Error
} = {}) {
  const resolve: ResolveResult | Error = options.resolve
    ?? { auth: { apiKey: 'token-a' }, source: 'Work · Test OAuth' }
  const integration: MultiProviderIntegration<Api, unknown> = {
    id: 'example',
    label: 'Example',
    accounts: () => accounts,
    resolveAuth: async () => {
      if (resolve instanceof Error) throw resolve
      return resolve
    },
  }
  const scheduler = new MultiProviderService({
    ...(options.affinity === undefined ? {} : { affinity: options.affinity }),
    randomInt: () => 1,
    randomId: () => 'lease-1',
  })
  scheduler.registerProvider({
    id: 'example',
    label: 'Example',
    accounts: () => accounts,
    ...(options.selectionBias === undefined ? {} : { selectionBias: options.selectionBias }),
  })
  const model = { id: 'model', provider: 'example' } as unknown as Model<Api>
  const provider = {
    id: 'example',
    name: 'Example',
    getModels: () => [model],
  } as unknown as Provider<Api>
  const ctx = {
    model: undefined,
    sessionManager: { getSessionId: () => 'session-1' },
    modelRegistry: { getProvider: () => provider },
  } as unknown as MultiProviderServiceContext
  const announcement = createServiceAnnouncement({
    scheduler,
    getIntegration: providerId => (providerId === 'example' ? integration : undefined),
    getBaseProvider: () => provider,
    affinityKeyFor: () => 'session-1',
  })
  return { scheduler, announcement, ctx }
}

describe('service announcement', () => {
  it('resolves the explicit session pin and its stored credential', async () => {
    const { scheduler, announcement, ctx } = makeHarness({ affinity: false })
    expect(await announcement.getActiveAccount('example', ctx)).toBeUndefined()
    await scheduler.pinAccount('example', 'session-1', 'a')
    expect(await announcement.getActiveAccount('example', ctx)).toEqual({
      id: 'a',
      label: 'Work',
      authKind: 'oauth',
    })
    expect(await announcement.resolveActiveAccountAuth('example', ctx)).toEqual({
      accessToken: 'token-a',
      label: 'Work',
      source: 'Work · Test OAuth',
    })
  })

  it('reports the last scheduler selection while affinity is on', async () => {
    const { scheduler, announcement, ctx } = makeHarness({ selectionBias: 'none' })
    const lease = await scheduler.acquire({ providerId: 'example', affinityKey: 'session-1' })
    lease.release({ status: 'success' })
    expect(await announcement.getActiveAccount('example', ctx)).toEqual({
      id: 'a',
      label: 'Work',
      authKind: 'oauth',
    })
  })

  it('never resolves credentials for the upstream account or without a pin', async () => {
    const { scheduler, announcement, ctx } = makeHarness({})
    expect(await announcement.resolveActiveAccountAuth('example', ctx)).toBeUndefined()
    await scheduler.pinAccount('example', 'session-1', PI_UPSTREAM_ACCOUNT_ID)
    expect(await announcement.getActiveAccount('example', ctx)).toEqual({
      id: PI_UPSTREAM_ACCOUNT_ID,
      label: 'Pi default',
      authKind: 'custom',
    })
    expect(await announcement.resolveActiveAccountAuth('example', ctx)).toBeUndefined()
  })

  it('extracts bearer tokens from headers and tolerates resolver failures', async () => {
    const header = makeHarness({
      resolve: { auth: { headers: { Authorization: 'Bearer header-token' } } },
    })
    await header.scheduler.pinAccount('example', 'session-1', 'a')
    expect(await header.announcement.resolveActiveAccountAuth('example', header.ctx)).toEqual({
      accessToken: 'header-token',
      label: 'Work',
    })

    const failing = makeHarness({ resolve: new Error('resolve failed') })
    await failing.scheduler.pinAccount('example', 'session-1', 'b')
    expect(await failing.announcement.resolveActiveAccountAuth('example', failing.ctx)).toBeUndefined()

    const empty = makeHarness({ resolve: { auth: {} } })
    await empty.scheduler.pinAccount('example', 'session-1', 'a')
    expect(await empty.announcement.resolveActiveAccountAuth('example', empty.ctx)).toBeUndefined()
  })

  it('notifies account-changed listeners per provider and supports unsubscribe', () => {
    const { announcement, ctx } = makeHarness({})
    const commandCtx = ctx as unknown as ExtensionContext
    const events: { providerId: string; account: ActiveAccount | undefined }[] = []
    const unsubscribe = announcement.onActiveAccountChanged('example', event => {
      events.push({ providerId: event.providerId, account: event.account })
    })
    const account: ActiveAccount = { id: 'a', label: 'Work', authKind: 'oauth' }
    announcement.notifyActiveAccountChanged('example', commandCtx, account)
    announcement.notifyActiveAccountChanged('example', commandCtx, undefined)
    announcement.notifyActiveAccountChanged('other', commandCtx, account)
    unsubscribe()
    announcement.notifyActiveAccountChanged('example', commandCtx, account)
    expect(events).toEqual([
      { providerId: 'example', account },
      { providerId: 'example', account: undefined },
    ])
  })

  it('returns undefined for providers without an integration', async () => {
    const { announcement, ctx } = makeHarness({})
    expect(await announcement.getActiveAccount('missing', ctx)).toBeUndefined()
    expect(await announcement.resolveActiveAccountAuth('missing', ctx)).toBeUndefined()
  })

  it('resolves the active backend of a virtual pool', async () => {
    const scheduler = new MultiProviderService({ randomId: () => 'lease-1', randomInt: () => 1 })
    const backends: ProviderAccount<string>[] = [
      { id: 'kimi-coding::k3', label: 'kimi-coding · k3', authKind: 'oauth', credentialRef: 'r1' },
      { id: 'deepseek::deepseek-v4-pro', label: 'deepseek · v4-pro', authKind: 'oauth', credentialRef: 'r2' },
    ]
    const virtualIntegration = {
      id: 'dsv4::k3',
      label: 'dsv4',
      accounts: () => backends,
    }
    scheduler.registerProvider({
      id: 'dsv4::k3',
      label: 'dsv4',
      accounts: () => backends,
      selectionBias: 'none',
    })
    const model = { id: 'k3', provider: 'dsv4' } as unknown as Model<Api>
    const ctx = {
      model,
      sessionManager: { getSessionId: () => 'session-1' },
      modelRegistry: { getProvider: () => undefined },
    } as unknown as MultiProviderServiceContext
    const announcement = createServiceAnnouncement({
      scheduler,
      getIntegration: () => undefined,
      getBaseProvider: () => undefined,
      affinityKeyFor: () => 'session-1',
      getVirtualIntegration: (virtualProviderId, modelId) => {
        if (virtualProviderId !== 'dsv4' || modelId !== 'k3') return undefined
        return { integration: virtualIntegration, schedulerId: 'dsv4::k3' }
      },
    })

    // A virtual provider has no integration under its own id, so the plain
    // lookup fails; the virtual resolver is what makes this work.
    const lease = await scheduler.acquire({ providerId: 'dsv4::k3', affinityKey: 'session-1' })
    lease.release({ status: 'success' })
    const active = await announcement.getActiveAccount('dsv4', ctx)
    // The announcement must report the backend the scheduler actually selected,
    // not merely the first backend in the pool.
    const selected = scheduler.getAffinity('dsv4::k3', 'session-1')
    expect(selected).toBeDefined()
    expect(active?.id).toBe(selected!.accountId)
    expect(backends.map(backend => backend.id)).toContain(active!.id)
    // And it is a real backend identity, not the virtual provider id.
    expect(active!.id).not.toBe('dsv4')
  })

  it('exposes pool account health with cooldowns via getPoolSnapshot', async () => {
    const { scheduler, announcement } = makeHarness({ affinity: false })
    const snapshot = await announcement.getPoolSnapshot?.('example')
    expect(snapshot).toBeDefined()
    expect(snapshot!.accounts.map(account => account.id)).toEqual(accounts.map(account => account.id))
    expect(snapshot!.accounts.every(account => ['ready', 'cooldown', 'disabled'].includes(account.status))).toBe(true)
    expect(await announcement.getPoolSnapshot?.('missing')).toBeUndefined()
    // Silence an unused-variable lint without weakening the assertion.
    expect(scheduler).toBeDefined()
  })
})

describe('pool account recency', () => {
  it('reports the most recently leased account', async () => {
    const { scheduler, announcement, ctx } = makeHarness({ selectionBias: 'none' })
    // No selection yet: nothing to report.
    expect(await announcement.getMostRecentlyUsedAccount?.('example')).toBeUndefined()

    const lease = await scheduler.acquire({ providerId: 'example', affinityKey: 'session-1' })
    lease.release({ status: 'success' })
    const used = await announcement.getMostRecentlyUsedAccount?.('example')
    expect(used).toBeDefined()
    expect(accounts.map(account => account.id)).toContain(used!.id)

    // Snapshot exposes the timestamp used to pick it.
    const snapshot = await announcement.getPoolSnapshot?.('example')
    expect(snapshot?.accounts.some(account => account.lastSelectedAt !== undefined)).toBe(true)
    expect(await announcement.getMostRecentlyUsedAccount?.('missing')).toBeUndefined()
    // Suppress an unused-variable lint without weakening the assertion.
    expect(ctx).toBeDefined()
  })
})
