/**
 * Provably-fair drawing core.
 *
 * ============================================================================
 * THIS FILE IS THE SINGLE SOURCE OF TRUTH FOR THE DRAW.
 * ============================================================================
 *
 * It is deliberately self-contained: zero imports, no Node/Deno/browser-only
 * APIs beyond WebCrypto (`globalThis.crypto.subtle`), which exists in all three.
 * The identical bytes of this file run in:
 *
 *   1. the Supabase Edge Function that executes the official draw,
 *   2. the browser page any group member uses to verify that draw,
 *   3. the unit tests.
 *
 * `scripts/sync-draw-core.mjs` copies it to supabase/functions/_shared/ and
 * `core.sync.test.ts` fails the build if the two copies ever drift. If the
 * verifier could run different code than the drawer, the whole exercise is
 * theatre — so do not add imports to this file.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DRAW IS TRUSTWORTHY
 * ---------------------------------------------------------------------------
 * The threat model is not an outside hacker. It is a group member who suspects
 * the *operator* rigged the draw for a friend. Everything below exists to make
 * that accusation refutable with arithmetic rather than with a promise.
 *
 * A naive "we used a secret seed and here's its hash" commitment is NOT enough.
 * A dishonest operator can privately generate a thousand seeds, run the draw a
 * thousand times, pick the run where their friend wins, and publish only that
 * seed and its matching hash. Every published number checks out. The scheme is
 * worthless.
 *
 * So the final seed mixes in PUBLIC randomness that did not exist yet when the
 * operator committed:
 *
 *   LOCK (T0)  Freeze the entrant list. Publish three values to the group:
 *                - snapshotHash  — SHA-256 of the canonical entrant list
 *                - seedCommitment — SHA-256 of the operator's secret seed
 *                - beaconRound   — a drand round number in the FUTURE
 *              At T0 nobody on earth knows what beaconRound will contain.
 *
 *   WAIT       The drand beacon (League of Entropy, a public threshold network)
 *              emits round `beaconRound` on schedule. Its value is unpredictable
 *              in advance and permanently public afterwards.
 *
 *   DRAW (T1)  finalSeed = H(snapshotHash, secretSeed, beaconRound, beaconValue)
 *              Winners follow deterministically.
 *
 * The operator cannot grind seeds, because they must commit before the beacon
 * value exists. The operator cannot swap the entrant list, because its hash was
 * published at T0. The operator cannot fake the beacon, because it is signed by
 * a distributed network and anyone can re-fetch round N forever.
 *
 * Anyone can independently recompute the winners from four published values.
 * The operator's honesty is not an input.
 */

/* ========================================================================== *
 * Domain-separation tags.
 *
 * Every hash in this system is prefixed with a distinct ASCII tag so that a
 * digest computed for one purpose can never be replayed as a digest for
 * another. Changing any tag changes every downstream result, so these strings
 * are effectively part of the protocol version. Never edit one in place —
 * bump to /v2 instead, or previously published draws stop verifying.
 * ========================================================================== */
const TAG_SNAPSHOT = 'wtw-snapshot/v1'
const TAG_SEED_COMMITMENT = 'wtw-seed-commitment/v1'
const TAG_FINAL_SEED = 'wtw-final-seed/v1'
const TAG_PRNG = 'wtw-prng/v1'

export const DRAW_PROTOCOL_VERSION = 'wtw-draw/v1'

/* ========================================================================== *
 * Types
 * ========================================================================== */

/**
 * One entrant as they appear in the public, verifiable snapshot.
 *
 * Note what is absent: no email, no phone, no payment amounts, no Venmo handle.
 * The snapshot is designed to be published to ~1000 people, so it carries only
 * what a member needs to find themselves and check their own ticket count.
 */
export interface SnapshotEntrant {
  /** Stable random UUID for this entrant *within this drawing*. Not reused across drawings. */
  publicId: string
  /** Human-recognisable but low-disclosure, e.g. "Daniel L." — lets a member spot their own row. */
  displayLabel: string
  /** Number of $25 tickets held. Must be a positive integer. */
  tickets: number
}

/** The frozen, canonical input to a draw. Hashing this is what "locking" means. */
export interface DrawSnapshot {
  protocolVersion: string
  /** Supabase UUID of the drawing. */
  drawingId: string
  /** Operator-facing name, e.g. "2026 Q3 Giveaway". Included so a snapshot can't be re-pointed at another drawing. */
  drawingName: string
  /** Price of one ticket in integer cents. 2500 = $25.00. */
  ticketPriceCents: number
  /** How many actual prize winners to select. */
  winnerCount: number
  /** How many ranked backups to select in the same pass (see selectWinners). */
  alternateCount: number
  /** Every entrant. Order is irrelevant on input — canonicalisation sorts it. */
  entrants: SnapshotEntrant[]
}

/** What the operator publishes at LOCK time, before the beacon value exists. */
export interface DrawCommitment {
  snapshotHash: string
  seedCommitment: string
  beaconChain: string
  beaconRound: number
  /** ISO-8601 UTC instant at which `beaconRound` is expected to be emitted. */
  beaconExpectedAt: string
}

/** The public randomness that unlocks the draw. */
export interface BeaconValue {
  chain: string
  round: number
  /** Hex-encoded randomness from the drand round. */
  randomness: string
}

export interface DrawWinner {
  /** 1-based. Ranks 1..winnerCount are winners; the rest are alternates in order. */
  rank: number
  publicId: string
  displayLabel: string
  /** Ticket count this entrant held at draw time — useful for showing the odds honestly. */
  tickets: number
  /** True when rank > winnerCount, i.e. this is a standby rather than a prize winner. */
  isAlternate: boolean
}

export interface DrawResult {
  protocolVersion: string
  snapshotHash: string
  seedCommitment: string
  beacon: BeaconValue
  finalSeed: string
  totalTickets: number
  totalEntrants: number
  winners: DrawWinner[]
  /** How many 64-bit samples the PRNG consumed, rejections included. Lets a verifier confirm stream position. */
  randomWordsConsumed: number
}

/* ========================================================================== *
 * Byte / hex / hash primitives
 * ========================================================================== */

const HEX: string[] = /* @__PURE__ */ (() =>
  Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0')))()

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += HEX[bytes[i]!]
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase()
  if (clean.length % 2 !== 0) throw new Error(`hexToBytes: odd-length hex string (${clean.length} chars)`)
  if (clean.length > 0 && !/^[0-9a-f]+$/.test(clean)) throw new Error('hexToBytes: non-hex characters present')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto
  if (!c?.subtle) {
    throw new Error(
      'WebCrypto (crypto.subtle) is unavailable. The draw requires it. ' +
        'In browsers this means the page must be served over HTTPS or localhost.',
    )
  }
  return c.subtle
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? utf8(data) : data
  // `as BufferSource` keeps TS happy across the DOM/Deno lib differences.
  const digest = await subtle().digest('SHA-256', bytes as unknown as BufferSource)
  return bytesToHex(new Uint8Array(digest))
}

/* ========================================================================== *
 * Canonical serialisation
 *
 * A hash only proves something if two parties can independently produce the
 * exact same bytes. JSON cannot do that — key order, whitespace, number
 * formatting and unicode escaping all vary by implementation. So the snapshot
 * is serialised into an explicit line-based text format with rules tight
 * enough that a verifier writing their own implementation in Python will get
 * byte-identical output.
 *
 * Rules:
 *   - Field order is fixed by this function, not by object key order.
 *   - Lines are joined with "\n" (never "\r\n") and the document ends with "\n".
 *   - Text is Unicode-normalised to NFC, so "é" as one codepoint and as
 *     "e" + combining-accent hash identically.
 *   - Fields are tab-separated, and tabs/newlines are forbidden inside values
 *     (rejected loudly rather than escaped, so ambiguity is impossible).
 *   - Entrants are sorted by publicId using codepoint order — NOT locale
 *     collation, which differs between machines.
 *   - Integers are rendered by JS base-10 with no separators or signs.
 * ========================================================================== */

function assertCleanField(value: string, field: string): void {
  if (value.includes('\t') || value.includes('\n') || value.includes('\r')) {
    throw new Error(`Canonicalisation: ${field} may not contain tab or newline characters`)
  }
}

function assertNonNegativeInt(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Canonicalisation: ${field} must be a non-negative integer, got ${String(value)}`)
  }
}

/**
 * Render a snapshot to the exact bytes that get hashed.
 * Exported so the verification UI can show a member the precise document.
 */
export function canonicalizeSnapshot(snapshot: DrawSnapshot): string {
  assertNonNegativeInt(snapshot.ticketPriceCents, 'ticketPriceCents')
  assertNonNegativeInt(snapshot.winnerCount, 'winnerCount')
  assertNonNegativeInt(snapshot.alternateCount, 'alternateCount')

  const drawingName = snapshot.drawingName.normalize('NFC')
  assertCleanField(snapshot.drawingId, 'drawingId')
  assertCleanField(drawingName, 'drawingName')

  const seen = new Set<string>()
  const rows = snapshot.entrants.map((e) => {
    const publicId = e.publicId.normalize('NFC')
    const displayLabel = e.displayLabel.normalize('NFC')
    assertCleanField(publicId, 'entrant.publicId')
    assertCleanField(displayLabel, 'entrant.displayLabel')
    if (publicId.length === 0) throw new Error('Canonicalisation: entrant.publicId may not be empty')
    if (!Number.isInteger(e.tickets) || e.tickets <= 0) {
      throw new Error(
        `Canonicalisation: entrant ${publicId} has tickets=${String(e.tickets)}; ` +
          'every snapshot entrant must hold at least one whole ticket',
      )
    }
    if (seen.has(publicId)) throw new Error(`Canonicalisation: duplicate entrant publicId ${publicId}`)
    seen.add(publicId)
    return { publicId, displayLabel, tickets: e.tickets }
  })

  // Codepoint sort. `Array.prototype.sort` on strings is already codepoint-based
  // (unlike localeCompare), which is exactly what a third-party verifier will
  // reproduce most easily.
  rows.sort((a, b) => (a.publicId < b.publicId ? -1 : a.publicId > b.publicId ? 1 : 0))

  const totalTickets = rows.reduce((sum, r) => sum + r.tickets, 0)

  const lines: string[] = [
    TAG_SNAPSHOT,
    `protocol\t${snapshot.protocolVersion}`,
    `drawing_id\t${snapshot.drawingId}`,
    `drawing_name\t${drawingName}`,
    `ticket_price_cents\t${snapshot.ticketPriceCents}`,
    `winner_count\t${snapshot.winnerCount}`,
    `alternate_count\t${snapshot.alternateCount}`,
    `entrant_count\t${rows.length}`,
    `total_tickets\t${totalTickets}`,
    'entrants',
  ]
  for (const r of rows) lines.push(`\t${r.publicId}\t${r.tickets}\t${r.displayLabel}`)
  lines.push('end')

  return lines.join('\n') + '\n'
}

export async function hashSnapshot(snapshot: DrawSnapshot): Promise<string> {
  return sha256Hex(canonicalizeSnapshot(snapshot))
}

/** SHA-256 over the tagged secret seed. Published at LOCK; proves the seed pre-existed the beacon. */
export async function computeSeedCommitment(secretSeedHex: string): Promise<string> {
  const seed = hexToBytes(secretSeedHex)
  if (seed.length !== 32) throw new Error(`Secret seed must be exactly 32 bytes, got ${seed.length}`)
  return sha256Hex(`${TAG_SEED_COMMITMENT}\n${bytesToHex(seed)}\n`)
}

/**
 * Bind the entrant list, the operator's committed secret, and the public beacon
 * into one seed. All four inputs are published after the draw, so this is
 * reproducible by anyone.
 */
export async function computeFinalSeed(
  snapshotHash: string,
  secretSeedHex: string,
  beacon: BeaconValue,
): Promise<string> {
  const seed = hexToBytes(secretSeedHex)
  if (seed.length !== 32) throw new Error(`Secret seed must be exactly 32 bytes, got ${seed.length}`)
  if (!Number.isInteger(beacon.round) || beacon.round <= 0) {
    throw new Error(`Beacon round must be a positive integer, got ${String(beacon.round)}`)
  }
  const randomness = hexToBytes(beacon.randomness) // validates hex
  if (randomness.length === 0) throw new Error('Beacon randomness may not be empty')
  assertCleanField(beacon.chain, 'beacon.chain')

  const doc =
    `${TAG_FINAL_SEED}\n` +
    `snapshot\t${snapshotHash.toLowerCase()}\n` +
    `seed\t${bytesToHex(seed)}\n` +
    `beacon_chain\t${beacon.chain}\n` +
    `beacon_round\t${beacon.round}\n` +
    `beacon_randomness\t${bytesToHex(randomness)}\n`
  return sha256Hex(doc)
}

/* ========================================================================== *
 * Deterministic CSPRNG
 *
 * HMAC-SHA256 in counter mode: block_i = HMAC(finalSeed, TAG || u64be(i)).
 * Keyed by the 32-byte final seed, so the output stream is unpredictable
 * without the seed but perfectly reproducible with it. Blocks are generated
 * lazily and consumed as 64-bit words.
 * ========================================================================== */

const BLOCK_BYTES = 32
const WORD_BYTES = 8
const WORDS_PER_BLOCK = BLOCK_BYTES / WORD_BYTES // 4
const U64_MODULUS = 1n << 64n

export class DeterministicRng {
  #key: CryptoKey | null = null
  readonly #seed: Uint8Array
  #block: Uint8Array = new Uint8Array(0)
  #blockIndex = 0n
  #wordInBlock = WORDS_PER_BLOCK // forces a refill on first use
  #wordsConsumed = 0

  constructor(finalSeedHex: string) {
    const seed = hexToBytes(finalSeedHex)
    if (seed.length !== 32) throw new Error(`Final seed must be exactly 32 bytes, got ${seed.length}`)
    this.#seed = seed
  }

  /** Total 64-bit words drawn, including ones discarded by rejection sampling. */
  get wordsConsumed(): number {
    return this.#wordsConsumed
  }

  async #ensureKey(): Promise<CryptoKey> {
    if (!this.#key) {
      this.#key = await subtle().importKey(
        'raw',
        this.#seed as unknown as BufferSource,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      )
    }
    return this.#key
  }

  async #refill(): Promise<void> {
    const key = await this.#ensureKey()
    const msg = new Uint8Array(TAG_PRNG.length + 8)
    msg.set(utf8(TAG_PRNG), 0)
    // Big-endian u64 counter, so the stream is byte-order independent.
    new DataView(msg.buffer).setBigUint64(TAG_PRNG.length, this.#blockIndex, false)
    const sig = await subtle().sign('HMAC', key, msg as unknown as BufferSource)
    this.#block = new Uint8Array(sig)
    this.#blockIndex += 1n
    this.#wordInBlock = 0
  }

  /** Next uniformly random 64-bit value. */
  async nextUint64(): Promise<bigint> {
    if (this.#wordInBlock >= WORDS_PER_BLOCK) await this.#refill()
    const offset = this.#wordInBlock * WORD_BYTES
    const view = new DataView(this.#block.buffer, this.#block.byteOffset + offset, WORD_BYTES)
    this.#wordInBlock += 1
    this.#wordsConsumed += 1
    return view.getBigUint64(0, false)
  }

  /**
   * Uniformly random integer in [0, bound) with NO modulo bias.
   *
   * The naive `next() % bound` is biased whenever bound does not evenly divide
   * 2^64: the low residues occur once more often than the high ones. With 5000
   * tickets the skew is around one part in 3.7e15 — undetectable in practice,
   * but "undetectable" is not the standard when someone is accusing you of
   * cheating. So we reject the final partial cycle instead.
   *
   * `limit` is the largest multiple of `bound` that fits in 2^64. Any sample at
   * or above it lands in the short tail and is discarded, leaving a perfectly
   * uniform distribution. Expected discards are under one per call for any
   * realistic bound.
   */
  async nextBelow(bound: number | bigint): Promise<bigint> {
    const n = BigInt(bound)
    if (n <= 0n) throw new Error(`nextBelow: bound must be positive, got ${String(bound)}`)
    if (n > U64_MODULUS) throw new Error('nextBelow: bound exceeds 2^64')
    if (n === 1n) return 0n

    const limit = U64_MODULUS - (U64_MODULUS % n)
    for (;;) {
      const x = await this.nextUint64()
      if (x < limit) return x % n
    }
  }
}

/* ========================================================================== *
 * Winner selection
 * ========================================================================== */

/**
 * Draw ranked winners from a snapshot.
 *
 * Weighting: each $25 ticket is one slot in the pool, so somebody holding four
 * tickets is exactly four times as likely to be picked as somebody holding one.
 *
 * Uniqueness: when an entrant is drawn, ALL of their remaining tickets leave the
 * pool, so nobody can occupy two ranks. This is what the operator chose over
 * allowing repeat winners.
 *
 * Alternates: ranks past `winnerCount` are drawn in the same continuous pass and
 * published alongside the winners. This matters for verifiability — if a winner
 * turns out to be unreachable or ineligible, the operator promotes the next
 * alternate from an already-published list instead of running a fresh secret
 * draw that nobody can check.
 *
 * Implementation note: after each pick the cumulative-weight array is rebuilt
 * from scratch. At this scale (≈1000 entrants, a handful of ranks) that is a
 * few thousand additions — far cheaper than the bug surface of an incrementally
 * mutated Fenwick tree, and much easier for a third party to re-implement when
 * they verify the result.
 */
export async function selectWinners(snapshot: DrawSnapshot, finalSeedHex: string): Promise<DrawWinner[]> {
  return selectWinnersWithRng(snapshot, new DeterministicRng(finalSeedHex))
}

/**
 * The one and only selection implementation. `selectWinners` and `executeDraw`
 * both route through it, so the winners a verifier recomputes are produced by
 * literally the same code path that produced the official result. Taking an
 * RNG rather than a seed also lets `executeDraw` report how much of the stream
 * was consumed.
 */
export async function selectWinnersWithRng(
  snapshot: DrawSnapshot,
  rng: DeterministicRng,
): Promise<DrawWinner[]> {
  // Canonicalise first: this both validates the snapshot and fixes entrant
  // order, so selection is reproducible regardless of how rows arrived.
  canonicalizeSnapshot(snapshot)

  const pool = snapshot.entrants
    .map((e) => ({
      publicId: e.publicId.normalize('NFC'),
      displayLabel: e.displayLabel.normalize('NFC'),
      tickets: e.tickets,
      remaining: e.tickets,
    }))
    .sort((a, b) => (a.publicId < b.publicId ? -1 : a.publicId > b.publicId ? 1 : 0))

  const wanted = snapshot.winnerCount + snapshot.alternateCount
  const winners: DrawWinner[] = []

  for (let rank = 1; rank <= wanted; rank++) {
    // Cumulative weights over entrants still in the pool.
    let total = 0
    const cumulative: number[] = new Array(pool.length)
    for (let i = 0; i < pool.length; i++) {
      total += pool[i]!.remaining
      cumulative[i] = total
    }
    // Pool exhausted: fewer entrants than requested ranks. Return what we have
    // rather than throwing, so a small quarter still produces a valid draw.
    if (total === 0) break

    const pick = Number(await rng.nextBelow(total))

    // First index whose cumulative weight strictly exceeds `pick`.
    let lo = 0
    let hi = pool.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (cumulative[mid]! > pick) hi = mid
      else lo = mid + 1
    }
    const chosen = pool[lo]!
    if (chosen.remaining === 0) {
      // Unreachable if the binary search is correct; kept as a loud tripwire
      // because silently awarding a prize to a zero-ticket entrant is the one
      // failure mode that would be catastrophic and invisible.
      throw new Error(`Draw invariant violated: selected entrant ${chosen.publicId} holds no tickets`)
    }

    winners.push({
      rank,
      publicId: chosen.publicId,
      displayLabel: chosen.displayLabel,
      tickets: chosen.tickets,
      isAlternate: rank > snapshot.winnerCount,
    })
    chosen.remaining = 0 // unique winners: remove every ticket they hold
  }

  return winners
}

/**
 * Run a complete draw and return the full, publishable result.
 * Pure: identical inputs always produce identical output, on any runtime.
 */
export async function executeDraw(
  snapshot: DrawSnapshot,
  secretSeedHex: string,
  beacon: BeaconValue,
): Promise<DrawResult> {
  const snapshotHash = await hashSnapshot(snapshot)
  const seedCommitment = await computeSeedCommitment(secretSeedHex)
  const finalSeed = await computeFinalSeed(snapshotHash, secretSeedHex, beacon)

  const rng = new DeterministicRng(finalSeed)
  const winners = await selectWinnersWithRng(snapshot, rng)

  return {
    protocolVersion: DRAW_PROTOCOL_VERSION,
    snapshotHash,
    seedCommitment,
    beacon,
    finalSeed,
    totalTickets: snapshot.entrants.reduce((sum, e) => sum + e.tickets, 0),
    totalEntrants: snapshot.entrants.length,
    winners,
    randomWordsConsumed: rng.wordsConsumed,
  }
}

/* ========================================================================== *
 * Independent verification
 * ========================================================================== */

export interface VerificationCheck {
  id: string
  label: string
  passed: boolean
  detail: string
}

export interface VerificationReport {
  valid: boolean
  checks: VerificationCheck[]
  recomputedWinners: DrawWinner[]
}

/**
 * Recompute a published draw from published values and report, check by check,
 * whether it holds up. This is what the public /verify page runs — in the
 * member's own browser, against data they can also fetch themselves.
 */
export async function verifyDraw(
  snapshot: DrawSnapshot,
  published: DrawResult,
  secretSeedHex: string,
): Promise<VerificationReport> {
  const checks: VerificationCheck[] = []
  let recomputedWinners: DrawWinner[] = []

  const add = (id: string, label: string, passed: boolean, detail: string) =>
    checks.push({ id, label, passed, detail })

  try {
    const snapshotHash = await hashSnapshot(snapshot)
    add(
      'snapshot_hash',
      'Entrant list matches the one locked before the draw',
      snapshotHash === published.snapshotHash,
      snapshotHash === published.snapshotHash
        ? `SHA-256 ${snapshotHash} matches the hash published at lock time.`
        : `Recomputed ${snapshotHash} but the published hash was ${published.snapshotHash}. The entrant list changed after locking.`,
    )

    const seedCommitment = await computeSeedCommitment(secretSeedHex)
    add(
      'seed_commitment',
      'Revealed seed matches the commitment published before the draw',
      seedCommitment === published.seedCommitment,
      seedCommitment === published.seedCommitment
        ? `SHA-256 of the revealed seed is ${seedCommitment}, exactly as committed.`
        : `The revealed seed hashes to ${seedCommitment}, but ${published.seedCommitment} was committed. The seed was swapped.`,
    )

    const finalSeed = await computeFinalSeed(published.snapshotHash, secretSeedHex, published.beacon)
    add(
      'final_seed',
      'Final seed correctly derives from entrants + seed + public beacon',
      finalSeed === published.finalSeed,
      finalSeed === published.finalSeed
        ? `Derived ${finalSeed}.`
        : `Derived ${finalSeed} but ${published.finalSeed} was published.`,
    )

    recomputedWinners = await selectWinners(snapshot, published.finalSeed)
    const same =
      recomputedWinners.length === published.winners.length &&
      recomputedWinners.every((w, i) => {
        const p = published.winners[i]
        return !!p && p.rank === w.rank && p.publicId === w.publicId
      })
    add(
      'winners',
      'Winners recompute exactly from the published seed',
      same,
      same
        ? `All ${recomputedWinners.length} ranked selections reproduce identically.`
        : 'Recomputed winners differ from the published winners.',
    )
  } catch (err) {
    add('error', 'Verification ran without errors', false, err instanceof Error ? err.message : String(err))
  }

  return { valid: checks.every((c) => c.passed), checks, recomputedWinners }
}

/** Cryptographically strong 32-byte secret seed, hex-encoded. Server-side only. */
export function generateSecretSeed(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}
