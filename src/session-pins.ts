// Journal of /switch-account decisions persisted inside the Pi session. Pi
// stores custom entries in the session file and never sends them to the model,
// so a resumed session restores the operator's last explicit account choice
// while account health, cooldowns, and implicit affinity stay in memory where
// the scheduler owns them.

export const SESSION_PIN_ENTRY_TYPE = 'pi-multiprovider:switch-account'

/** One /switch-account decision: the account pinned to one session pool. */
export interface SessionPin {
  pool: string
  key: string
  /** Pinned account; undefined records an explicit return to automatic selection. */
  accountId?: string
  /** Account label at switch time, used only to describe restore failures. */
  label?: string
}

export interface SessionPinHost {
  /** Whether the pool's scheduler is registered yet. */
  hasPool(pool: string): boolean
  pin(pool: string, key: string, accountId: string): void | Promise<void>
  clear(pool: string, key: string): void
}

function pinFromRecord(value: unknown): SessionPin | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const pool = typeof record.pool === 'string' ? record.pool.trim() : ''
  const key = typeof record.key === 'string' ? record.key.trim() : ''
  if (pool === '' || key === '') return undefined
  const accountId = typeof record.accountId === 'string' ? record.accountId.trim() : undefined
  if (record.accountId !== undefined && (accountId === undefined || accountId === '')) return undefined
  const label = typeof record.label === 'string' && record.label.trim() !== ''
    ? record.label
    : undefined
  return {
    pool,
    key,
    ...(accountId === undefined ? {} : { accountId }),
    ...(label === undefined ? {} : { label }),
  }
}

/**
 * Reads the session's custom entries and returns the latest decision per pool
 * and affinity key, in the order the pools were first decided. Entries written
 * by other extensions, malformed records, and superseded decisions are ignored.
 */
export function sessionPinsFromEntries(entries: Iterable<unknown>): SessionPin[] {
  const latest = new Map<string, SessionPin>()
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown }
    if (candidate.type !== 'custom' || candidate.customType !== SESSION_PIN_ENTRY_TYPE) continue
    const pin = pinFromRecord(candidate.data)
    if (pin === undefined) continue
    latest.set(JSON.stringify([pin.pool, pin.key]), pin)
  }
  return [...latest.values()]
}

/**
 * Replays recorded decisions into the scheduler. Pools whose scheduler is not
 * registered yet are returned so the caller can retry after the next
 * reconcile; stale records — a removed or disabled account — are reported to
 * onError and dropped so they never block a later pin.
 */
export async function applySessionPins(
  pins: readonly SessionPin[],
  host: SessionPinHost,
  onError?: (pin: SessionPin, error: unknown) => void,
): Promise<SessionPin[]> {
  const pending: SessionPin[] = []
  for (const pin of pins) {
    if (!host.hasPool(pin.pool)) {
      pending.push(pin)
      continue
    }
    try {
      if (pin.accountId === undefined) host.clear(pin.pool, pin.key)
      else await host.pin(pin.pool, pin.key, pin.accountId)
    } catch (error) {
      onError?.(pin, error)
    }
  }
  return pending
}
