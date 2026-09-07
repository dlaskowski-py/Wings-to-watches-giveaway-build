/**
 * drand public-randomness client (Deno / Edge Function copy).
 *
 * See the long note in draw-core.ts for why a public beacon is load-bearing:
 * without it, a seed commitment alone lets the operator grind seeds privately
 * and publish only the run they like.
 */
import type { BeaconValue } from './draw-core.ts'

export const DRAND_CHAIN_QUICKNET =
  '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971'

const DRAND_ENDPOINTS = [
  'https://api.drand.sh',
  'https://drand.cloudflare.com',
  'https://api2.drand.sh',
  'https://api3.drand.sh',
]

export interface DrandChainInfo {
  genesisTime: number
  period: number
  chainHash: string
}

async function fetchFromAnyEndpoint(path: string): Promise<unknown> {
  const errors: string[] = []
  for (const base of DRAND_ENDPOINTS) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      try {
        const res = await fetch(`${base}${path}`, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        })
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
        return await res.json()
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      errors.push(`${base}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(`All drand endpoints failed. ${errors.join(' | ')}`)
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error(`${context}: expected an object`)
  return value as Record<string, unknown>
}

export async function fetchChainInfo(): Promise<DrandChainInfo> {
  const raw = asRecord(await fetchFromAnyEndpoint(`/${DRAND_CHAIN_QUICKNET}/info`), 'drand info')
  const genesisTime = raw.genesis_time
  const period = raw.period
  if (typeof genesisTime !== 'number' || typeof period !== 'number' || period <= 0) {
    throw new Error('drand info: malformed genesis_time or period')
  }
  if (raw.hash !== DRAND_CHAIN_QUICKNET) {
    throw new Error('drand endpoint served a different chain than expected')
  }
  return { genesisTime, period, chainHash: DRAND_CHAIN_QUICKNET }
}

export function roundAt(info: DrandChainInfo, atUnixSeconds: number): number {
  if (atUnixSeconds < info.genesisTime) return 1
  return Math.floor((atUnixSeconds - info.genesisTime) / info.period) + 1
}

export function timeOfRound(info: DrandChainInfo, round: number): Date {
  return new Date((info.genesisTime + (round - 1) * info.period) * 1000)
}

/**
 * Choose a round far enough ahead that the operator can publish the commitment
 * to the group before its value exists. That delay IS the security margin, so
 * it defaults to a full hour rather than a few minutes.
 */
export async function chooseFutureRound(leadSeconds: number) {
  const info = await fetchChainInfo()
  const nowSeconds = Math.floor(Date.now() / 1000)
  const round = roundAt(info, nowSeconds + leadSeconds) + 1
  return { info, round, expectedAt: timeOfRound(info, round) }
}

export async function fetchRound(round: number): Promise<BeaconValue> {
  const raw = asRecord(
    await fetchFromAnyEndpoint(`/${DRAND_CHAIN_QUICKNET}/public/${round}`),
    `drand round ${round}`,
  )
  const randomness = raw.randomness
  if (typeof randomness !== 'string' || !/^[0-9a-f]+$/i.test(randomness)) {
    throw new Error(`drand round ${round}: randomness missing or not hex`)
  }
  if (raw.round !== round) {
    throw new Error(`drand returned round ${String(raw.round)} when ${round} was requested`)
  }
  return { chain: DRAND_CHAIN_QUICKNET, round, randomness: randomness.toLowerCase() }
}
