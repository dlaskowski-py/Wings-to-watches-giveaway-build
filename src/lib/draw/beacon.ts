/**
 * drand public randomness beacon client.
 *
 * drand (the League of Entropy) is a distributed threshold network run by
 * Cloudflare, Kudelski, EPFL, Protocol Labs and others. Every few seconds it
 * publishes a signed random value for a numbered "round". Two properties are
 * what make it useful here:
 *
 *   - Round N's value is unpredictable until round N actually happens.
 *   - Round N's value is permanently public and identical for everyone afterwards.
 *
 * So the operator can commit to using round N *before* it exists, and every
 * group member can independently look up what round N turned out to be. That
 * is what stops the operator from re-rolling the draw until they like the
 * winners — see the long explanation at the top of core.ts.
 *
 * We use the `quicknet` chain: 3-second rounds, unchained (each round is
 * independent of the last), signatures verifiable against a fixed public key.
 */

import type { BeaconValue } from './core'

/** quicknet chain hash — pinned so a hijacked API cannot silently serve a different chain. */
export const DRAND_CHAIN_QUICKNET = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971'

/**
 * Public HTTP endpoints. They are interchangeable mirrors of the same chain, so
 * a member verifying a draw can use whichever they trust — or run their own node.
 */
export const DRAND_ENDPOINTS = [
  'https://api.drand.sh',
  'https://drand.cloudflare.com',
  'https://api2.drand.sh',
  'https://api3.drand.sh',
] as const

export interface DrandChainInfo {
  /** Unix seconds at which round 1 was emitted. */
  genesisTime: number
  /** Seconds between rounds. */
  period: number
  chainHash: string
}

export interface DrandRound {
  round: number
  randomness: string
  signature: string
}

const DEFAULT_TIMEOUT_MS = 10_000

async function fetchJson(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`${url} responded ${res.status} ${res.statusText}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Try each mirror in turn. A single endpoint being down must never block a draw
 * or a verification, so failures fall through and only the last error surfaces.
 */
async function fetchFromAnyEndpoint(path: string): Promise<unknown> {
  const errors: string[] = []
  for (const base of DRAND_ENDPOINTS) {
    try {
      return await fetchJson(`${base}${path}`)
    } catch (err) {
      errors.push(`${base}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(`All drand endpoints failed.\n${errors.join('\n')}`)
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error(`${context}: expected a JSON object`)
  return value as Record<string, unknown>
}

/** Chain parameters, needed to convert between wall-clock time and round numbers. */
export async function fetchChainInfo(): Promise<DrandChainInfo> {
  const raw = asRecord(await fetchFromAnyEndpoint(`/${DRAND_CHAIN_QUICKNET}/info`), 'drand chain info')
  const genesisTime = raw.genesis_time
  const period = raw.period
  const chainHash = raw.hash

  if (typeof genesisTime !== 'number' || typeof period !== 'number' || period <= 0) {
    throw new Error('drand chain info: malformed genesis_time or period')
  }
  if (chainHash !== DRAND_CHAIN_QUICKNET) {
    throw new Error(
      `drand chain hash mismatch: expected ${DRAND_CHAIN_QUICKNET}, endpoint served ${String(chainHash)}. ` +
        'Refusing to proceed — this endpoint is serving a different chain.',
    )
  }
  return { genesisTime, period, chainHash }
}

/** Round number active at a given instant. Round 1 is emitted at genesis. */
export function roundAt(info: DrandChainInfo, atUnixSeconds: number): number {
  if (atUnixSeconds < info.genesisTime) return 1
  return Math.floor((atUnixSeconds - info.genesisTime) / info.period) + 1
}

/** Wall-clock instant at which a round is emitted. */
export function timeOfRound(info: DrandChainInfo, round: number): Date {
  return new Date((info.genesisTime + (round - 1) * info.period) * 1000)
}

/**
 * Pick the round to commit to: far enough ahead that the operator has time to
 * publish the commitment to the group before the value exists.
 *
 * This delay is the entire security margin of the scheme. If the operator can
 * see the beacon value before the group sees the commitment, the commitment is
 * worthless — so default to a full hour rather than a few minutes.
 */
export async function chooseFutureRound(leadSeconds = 3600): Promise<{ info: DrandChainInfo; round: number; expectedAt: Date }> {
  const info = await fetchChainInfo()
  const nowSeconds = Math.floor(Date.now() / 1000)
  const round = roundAt(info, nowSeconds + leadSeconds) + 1
  return { info, round, expectedAt: timeOfRound(info, round) }
}

/** Fetch one round. Throws while the round is still in the future. */
export async function fetchRound(round: number): Promise<BeaconValue> {
  if (!Number.isInteger(round) || round <= 0) throw new Error(`Invalid drand round: ${String(round)}`)

  const raw = asRecord(
    await fetchFromAnyEndpoint(`/${DRAND_CHAIN_QUICKNET}/public/${round}`),
    `drand round ${round}`,
  )
  const randomness = raw.randomness
  const returnedRound = raw.round

  if (typeof randomness !== 'string' || !/^[0-9a-f]+$/i.test(randomness)) {
    throw new Error(`drand round ${round}: randomness is missing or not hex`)
  }
  if (returnedRound !== round) {
    throw new Error(`drand returned round ${String(returnedRound)} when ${round} was requested`)
  }

  return { chain: DRAND_CHAIN_QUICKNET, round, randomness: randomness.toLowerCase() }
}

/** Latest available round — used to tell the operator how long until their committed round lands. */
export async function fetchLatestRound(): Promise<BeaconValue> {
  const raw = asRecord(
    await fetchFromAnyEndpoint(`/${DRAND_CHAIN_QUICKNET}/public/latest`),
    'drand latest round',
  )
  const randomness = raw.randomness
  const round = raw.round
  if (typeof randomness !== 'string' || typeof round !== 'number') {
    throw new Error('drand latest: malformed response')
  }
  return { chain: DRAND_CHAIN_QUICKNET, round, randomness: randomness.toLowerCase() }
}

/** Public URL a sceptical group member can open to see the beacon value themselves. */
export function drandPublicUrl(round: number): string {
  return `${DRAND_ENDPOINTS[0]}/${DRAND_CHAIN_QUICKNET}/public/${round}`
}
