import { describe, expect, it } from 'vitest'
import {
  applySessionPins,
  createVirtualIntegrations,
  MultiProviderService,
  SESSION_PIN_ENTRY_TYPE,
  sessionPinsFromEntries,
  virtualBackendAccountId,
  virtualSchedulerId,
  type ProviderAccount,
  type SessionPin,
  type VirtualBackend,
  type VirtualProviderConfig,
} from '../src/index.ts'

const accounts: ProviderAccount<string>[] = [
  { id: 'a', label: 'Work', authKind: 'api-key', credentialRef: 'secret-work', weight: 3, priority: 1 },
  { id: 'b', label: 'Personal', authKind: 'oauth', credentialRef: 'secret-personal', weight: 1, priority: 2 },
]

let entrySeq = 0

function entry(data: unknown, customType: string = SESSION_PIN_ENTRY_TYPE) {
  entrySeq += 1
  return {
    type: 'custom',
    id: `entry-${entrySeq}`,
    parentId: null,
    timestamp: new Date(entrySeq).toISOString(),
    customType,
    data,
  }
}

function scheduler(options: ConstructorParameters<typeof MultiProviderService>[0] = {}) {
  const service = new MultiProviderService(options)
  service.registerProvider({ id: 'example', label: 'Example', accounts: () => accounts })
  return service
}

function host(service: MultiProviderService) {
  return {
    hasPool: (pool: string) => service.hasProvider(pool),
    pin: (pool: string, key: string, accountId: string) => service.pinAccount(pool, key, accountId),
    clear: (pool: string, key: string) => service.clearAffinity(pool, key),
  }
}

describe('session pins', () => {
  it('keeps the latest decision per pool and ignores foreign or malformed entries', () => {
    const pins = sessionPinsFromEntries([
      { type: 'message', id: 'm1', parentId: null, timestamp: '', message: { role: 'user' } },
      entry({ pool: 'example', key: 'session-1', accountId: 'a', label: 'Work' }),
      // Newest decision for the same pool and key wins: an explicit return to
      // automatic selection.
      entry({ pool: 'example', key: 'session-1' }),
      null,
      entry('not-an-object'),
      entry({ pool: '', key: 'session-1', accountId: 'a' }),
      entry({ pool: 'broken', key: 'session-1', accountId: 7 }),
      entry({ pool: 'other', key: 'session-1', accountId: 'x' }),
      entry({ pool: 'example', key: 'session-1', accountId: 'b' }, 'other-extension:pin'),
    ])
    expect(pins).toEqual([
      { pool: 'example', key: 'session-1' },
      { pool: 'other', key: 'session-1', accountId: 'x' },
    ])
  })

  it('restores the last switched account into a fresh scheduler', async () => {
    // A resumed session starts with a new scheduler, so the recorded decision
    // is the only thing that can reproduce the switch.
    const resumed = scheduler({ affinity: false })
    const pending = await applySessionPins(
      sessionPinsFromEntries([
        entry({ pool: 'example', key: 'session-1', accountId: 'a', label: 'Work' }),
        entry({ pool: 'example', key: 'session-1', accountId: 'b', label: 'Personal' }),
      ]),
      host(resumed),
    )
    expect(pending).toEqual([])
    expect(resumed.getAffinity('example', 'session-1')).toEqual({ accountId: 'b', explicit: true })

    // An explicit pin outranks the pool's disabled session affinity.
    const lease = await resumed.acquire<string>({ providerId: 'example', affinityKey: 'session-1' })
    expect(lease.accountId).toBe('b')
    lease.release({ status: 'success' })
  })

  it('keeps pins pending until their pool registers, then applies them', async () => {
    const recorded: SessionPin[] = [
      { pool: 'example', key: 'session-1', accountId: 'b', label: 'Personal' },
    ]
    const service = new MultiProviderService()
    const pending = await applySessionPins(recorded, host(service))
    expect(pending).toEqual(recorded)
    expect(service.hasProvider('example')).toBe(false)

    service.registerProvider({ id: 'example', label: 'Example', accounts: () => accounts })
    expect(await applySessionPins(pending, host(service))).toEqual([])
    expect(service.getAffinity('example', 'session-1')).toEqual({ accountId: 'b', explicit: true })
  })

  it('reports applied decisions and stays silent about pending or stale ones', async () => {
    const service = scheduler()
    const applied: SessionPin[] = []
    const pending = await applySessionPins([
      { pool: 'example', key: 'session-1', accountId: 'a', label: 'Work' },
      { pool: 'unregistered', key: 'session-1', accountId: 'a', label: 'Work' },
      { pool: 'example', key: 'session-1', accountId: 'gone', label: 'Removed' },
    ], host(service), () => {}, pin => applied.push(pin))

    expect(applied).toEqual([{ pool: 'example', key: 'session-1', accountId: 'a', label: 'Work' }])
    expect(pending).toEqual([{ pool: 'unregistered', key: 'session-1', accountId: 'a', label: 'Work' }])
  })

  it('reports a stale pin and drops it instead of blocking later pins', async () => {
    const service = scheduler()
    const failures: string[] = []
    const pending = await applySessionPins([
      { pool: 'example', key: 'session-1', accountId: 'gone', label: 'Removed' },
      { pool: 'example', key: 'session-1', accountId: 'a', label: 'Work' },
    ], host(service), (pin, error) => {
      failures.push(`${pin.accountId}:${error instanceof Error ? error.message : String(error)}`)
    })
    expect(pending).toEqual([])
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('gone')
    expect(service.getAffinity('example', 'session-1')).toEqual({ accountId: 'a', explicit: true })
  })

  it('drops a pin whose account was disabled', async () => {
    const service = scheduler()
    await service.updatePool('example', {
      accounts: [{ accountId: 'b', enabled: false, weight: 1, priority: 2 }],
    })
    const reported: SessionPin[] = []
    const pending = await applySessionPins(
      [{ pool: 'example', key: 'session-1', accountId: 'b', label: 'Personal' }],
      host(service),
      pin => reported.push(pin),
    )
    expect(pending).toEqual([])
    expect(reported).toHaveLength(1)
    expect(service.getAffinity('example', 'session-1')).toBeUndefined()
  })

  it('restores a pin recorded against a virtual provider model', async () => {
    const service = new MultiProviderService({ affinity: false })
    const config: VirtualProviderConfig = {
      id: 'pooled',
      label: 'Pooled',
      models: [{
        id: 'virtual',
        backends: [
          { providerId: 'example', modelId: 'a' },
          { providerId: 'example', modelId: 'b' },
        ],
      }],
    }
    for (const integration of createVirtualIntegrations(config)) service.registerProvider(integration)
    const poolId = virtualSchedulerId('pooled', 'virtual')
    const pending = await applySessionPins(
      sessionPinsFromEntries([entry({
        pool: poolId,
        key: 'session-1',
        accountId: virtualBackendAccountId({ providerId: 'example', modelId: 'b' }),
      })]),
      host(service),
    )
    expect(pending).toEqual([])
    const lease = await service.acquire<VirtualBackend>({ providerId: poolId, affinityKey: 'session-1' })
    expect(lease.accountId).toBe('example::b')
    lease.release({ status: 'success' })
  })

  it('replays an explicit return to automatic selection', async () => {
    const service = scheduler()
    await service.pinAccount('example', 'session-1', 'b')
    const pending = await applySessionPins(
      sessionPinsFromEntries([
        entry({ pool: 'example', key: 'session-1', accountId: 'b' }),
        entry({ pool: 'example', key: 'session-1' }),
      ]),
      host(service),
    )
    expect(pending).toEqual([])
    expect(service.getAffinity('example', 'session-1')).toBeUndefined()
  })
})
