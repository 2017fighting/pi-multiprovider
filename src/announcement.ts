import { normalizeContext } from '@earendil-works/pi-ai'
import type { Api, Provider, ProviderHeaders } from '@earendil-works/pi-ai'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { PI_UPSTREAM_ACCOUNT_ID } from './managed.ts'
import type { MultiProviderService } from './service.ts'
import type {
  ActiveAccount,
  ActiveAccountAuth,
  ActiveAccountChangedEvent,
  MultiProviderIntegration,
  MultiProviderServiceAnnouncement,
  MultiProviderServiceContext,
} from './types.ts'
export interface AnnouncementDependencies {
  scheduler: MultiProviderService
  getIntegration(providerId: string): MultiProviderIntegration<Api, unknown> | undefined
  getBaseProvider(
    providerId: string,
    ctx: MultiProviderServiceContext,
  ): Provider<Api> | undefined
  affinityKeyFor(
    integration: MultiProviderIntegration<Api, unknown>,
    ctx: MultiProviderServiceContext,
    providerId: string,
  ): string
  /**
   * Resolve a virtual provider's backing pool. A virtual model maps one model id
   * onto several (providerId, modelId) backends, scheduled under the composite
   * id `${virtualProviderId}::${modelId}`. When it returns a registration, the
   * announcement resolves the active backend through the same affinity machinery
   * as a normal pool, which is what lets a sibling extension show "dsv4 → kimi".
   */
  getVirtualIntegration?(
    virtualProviderId: string,
    modelId: string | undefined,
  ): VirtualAnnouncementTarget | undefined
}

/**
 * A virtual pool plus enough information to translate its scheduler accounts
 * back into the real backing provider identity for consumers. Only the account
 * inventory is needed: virtual backends are not credential-resolvable through
 * the announcement (each backend resolves its own ambient auth).
 */
export interface VirtualAnnouncementTarget {
  integration: VirtualAccountSource
  /** Scheduler id used for the virtual pool, i.e. `${virtualProviderId}::${modelId}`. */
  schedulerId: string
}

/**
 * The slice of an integration the announcement needs for a virtual pool. Kept
 * structurally minimal and synchronous-or-async tolerant so both managed
 * integrations and `ProviderRegistration`s satisfy it.
 */
export interface VirtualAccountSource {
  accounts():
    | ReadonlyArray<{ id: string; label: string; authKind: ActiveAccount['authKind'] }>
    | Promise<ReadonlyArray<{ id: string; label: string; authKind: ActiveAccount['authKind'] }>>
  affinityKey?: (input: {
    provider: unknown
    model: unknown
    context: { messages: unknown[] }
  }) => string | undefined
}

// The public announcement plus the notify hook the bundled extension uses after
// /switch-account changes the session's pinned account.
export interface ServiceAnnouncementHandle extends MultiProviderServiceAnnouncement {
  notifyActiveAccountChanged(
    providerId: string,
    ctx: ExtensionContext,
    account: ActiveAccount | undefined,
  ): void
}

function bearerTokenFromHeaders(headers: ProviderHeaders | undefined): string | undefined {
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== 'authorization' || typeof value !== 'string') continue
    const match = /^bearer\s+(.+)$/i.exec(value.trim())
    if (match !== null) return match[1]!.trim()
  }
  return undefined
}

// Builds the in-process service announced on MULTIPROVIDER_SERVICE_EVENT. The
// active account is the session's explicit /switch-account pin, else the
// scheduler's last selection while pool affinity is on; undefined means the
// caller should fall back to its own upstream credential resolution. Stored
// account credentials resolve through the integration (refreshing OAuth under
// the account-store lock) so consumers never read the private store directly.
export function createServiceAnnouncement(deps: AnnouncementDependencies): ServiceAnnouncementHandle {
  const listeners = new Map<string, Set<(event: ActiveAccountChangedEvent) => void>>()

  const activeAccount = async (
    providerId: string,
    ctx: MultiProviderServiceContext,
  ): Promise<ActiveAccount | undefined> => {
    // Real pooled provider. `getIntegration` is only consulted for real ids; a
    // virtual id yields undefined here and is handled by the virtual branch.
    const integration = deps.getIntegration(providerId)
    if (integration === undefined) return resolveVirtualActiveAccount(providerId, ctx)
    return activeAccountFor(providerId, integration, ctx)
  }

  // Resolve the active account of a virtual pool. The scheduler id is the
  // composite `${virtualProviderId}::${modelId}`; the returned account id is the
  // backend account id that virtual.ts synthesizes.
  const resolveVirtualActiveAccount = async (
    virtualProviderId: string,
    ctx: MultiProviderServiceContext,
  ): Promise<ActiveAccount | undefined> => {
    if (deps.getVirtualIntegration === undefined) return undefined
    const modelId = (ctx.model as { id?: string } | undefined)?.id
    const target = deps.getVirtualIntegration(virtualProviderId, modelId)
    if (target === undefined) return undefined
    return activeAccountForVirtual(target, ctx)
  }

  const activeAccountFor = async (
    providerId: string,
    integration: MultiProviderIntegration<Api, unknown>,
    ctx: MultiProviderServiceContext,
  ): Promise<ActiveAccount | undefined> => {
    let affinity: boolean
    try {
      affinity = deps.scheduler.getPoolPreference(providerId).affinity
    } catch {
      return undefined
    }
    const pin = deps.scheduler.getAffinity(
      providerId,
      deps.affinityKeyFor(integration, ctx, providerId),
    )
    if (pin === undefined || (!pin.explicit && !affinity)) return undefined
    const account = (await integration.accounts()).find(
      candidate => candidate.id === pin.accountId,
    )
    if (account === undefined) return undefined
    return { id: account.id, label: account.label, authKind: account.authKind }
  }

  const activeAccountForVirtual = async (
    target: VirtualAnnouncementTarget,
    ctx: MultiProviderServiceContext,
  ): Promise<ActiveAccount | undefined> => {
    let affinity: boolean
    try {
      affinity = deps.scheduler.getPoolPreference(target.schedulerId).affinity
    } catch {
      return undefined
    }
    const pin = deps.scheduler.getAffinity(
      target.schedulerId,
      sessionAffinityKeyFor(target, ctx),
    )
    if (pin === undefined || (!pin.explicit && !affinity)) return undefined
    const accounts = await target.integration.accounts()
    const account = accounts.find(candidate => candidate.id === pin.accountId)
    if (account === undefined) return undefined
    return { id: account.id, label: account.label, authKind: account.authKind }
  }

  // Virtual pools derive their affinity key from the session id, matching
  // virtual.ts's own getAffinityKey wiring.
  const sessionAffinityKeyFor = (
    target: VirtualAnnouncementTarget,
    ctx: MultiProviderServiceContext,
  ): string => {
    const custom = target.integration.affinityKey
    if (custom === undefined) return ctx.sessionManager.getSessionId()
    const provider = ctx.modelRegistry.getProvider(target.schedulerId)
    const model = ctx.model
    if (provider === undefined || model === undefined) return ctx.sessionManager.getSessionId()
    try {
      return custom({ provider, model, context: { messages: [] } }) ?? ctx.sessionManager.getSessionId()
    } catch {
      return ctx.sessionManager.getSessionId()
    }
  }

  return {
    async getActiveAccount(providerId, ctx) {
      return activeAccount(providerId, ctx)
    },
    async resolveActiveAccountAuth(providerId, ctx, signal) {
      const active = await activeAccount(providerId, ctx)
      if (active === undefined || active.id === PI_UPSTREAM_ACCOUNT_ID) return undefined
      const integration = deps.getIntegration(providerId)
      const base = deps.getBaseProvider(providerId, ctx)
      if (integration === undefined || base === undefined) return undefined
      const model = ctx.model ?? base.getModels()[0]
      if (model === undefined) return undefined
      const account = (await integration.accounts()).find(candidate => candidate.id === active.id)
      if (account === undefined) return undefined
      const effectiveSignal = signal ?? new AbortController().signal
      try {
        const resolution = await integration.resolveAuth(account, effectiveSignal, {
          provider: base,
          model,
          context: normalizeContext({ messages: [] }),
          requestOptions: {},
          signal: effectiveSignal,
        })
        const accessToken = resolution.auth.apiKey ?? bearerTokenFromHeaders(resolution.auth.headers)
        if (accessToken === undefined || accessToken.trim() === '') return undefined
        return {
          accessToken: accessToken.trim(),
          label: active.label,
          ...(resolution.source === undefined ? {} : { source: resolution.source }),
        }
      } catch {
        return undefined
      }
    },
    onActiveAccountChanged(providerId, callback) {
      let callbacks = listeners.get(providerId)
      if (callbacks === undefined) {
        callbacks = new Set()
        listeners.set(providerId, callbacks)
      }
      callbacks.add(callback)
      return () => {
        const current = listeners.get(providerId)
        if (current === undefined) return
        current.delete(callback)
        if (current.size === 0) listeners.delete(providerId)
      }
    },
    async getPoolSnapshot(providerId) {
      // Route virtual composite ids (`dsv4::model`) through unchanged; the
      // scheduler stores virtual pools under exactly that id.
      const snapshot = await deps.scheduler.snapshot()
      const pool = snapshot.providers.find(provider => provider.id === providerId)
      if (pool === undefined) return undefined
      return {
        accounts: pool.accounts.map(account => ({
          id: account.id,
          label: account.label,
          status: account.status,
          ...(account.cooldownUntil === undefined ? {} : { cooldownUntil: account.cooldownUntil }),
          ...(account.lastSelectedAt === undefined ? {} : { lastSelectedAt: account.lastSelectedAt }),
        })),
      }
    },
    async getMostRecentlyUsedAccount(providerId) {
      // The account the pool most recently leased. For a nested setup
      // (virtual provider -> pooled provider) this is the real credential that
      // served the request, which affinity alone does not reveal when the
      // upstream account is included in the pool.
      const snapshot = await deps.scheduler.snapshot()
      const pool = snapshot.providers.find(provider => provider.id === providerId)
      if (pool === undefined) return undefined
      const candidates = pool.accounts.filter(account => account.lastSelectedAt !== undefined)
      if (candidates.length === 0) return undefined
      const latest = candidates.reduce((best, account) =>
        (account.lastSelectedAt ?? 0) > (best.lastSelectedAt ?? 0) ? account : best,
      )
      return { id: latest.id, label: latest.label, authKind: latest.authKind }
    },
    notifyActiveAccountChanged(providerId, ctx, account) {
      const callbacks = listeners.get(providerId)
      if (callbacks === undefined) return
      for (const callback of callbacks) {
        try {
          callback({ providerId, account, ctx })
        } catch {
          // A misbehaving listener must not break the switch notification.
        }
      }
    },
  }
}
