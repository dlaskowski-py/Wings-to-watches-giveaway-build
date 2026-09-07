import { describe, expect, it } from 'vitest'
import {
  DRAW_PROTOCOL_VERSION,
  DeterministicRng,
  bytesToHex,
  canonicalizeSnapshot,
  computeFinalSeed,
  computeSeedCommitment,
  executeDraw,
  generateSecretSeed,
  hashSnapshot,
  hexToBytes,
  selectWinners,
  sha256Hex,
  verifyDraw,
  type BeaconValue,
  type DrawSnapshot,
  type SnapshotEntrant,
} from './core'

/* -------------------------------------------------------------------------- *
 * Fixtures. Everything is fixed — no Date.now(), no Math.random() — so a
 * failure always means the protocol changed, never that the test got unlucky.
 * -------------------------------------------------------------------------- */

const SEED_A = 'a'.repeat(64)
const SEED_B = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

const BEACON: BeaconValue = {
  chain: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  round: 4_500_000,
  randomness: '9f2b7c1d4e5a6b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e',
}

function entrant(publicId: string, tickets: number, displayLabel = `E ${publicId}`): SnapshotEntrant {
  return { publicId, displayLabel, tickets }
}

function snapshot(overrides: Partial<DrawSnapshot> = {}): DrawSnapshot {
  return {
    protocolVersion: DRAW_PROTOCOL_VERSION,
    drawingId: '11111111-2222-3333-4444-555555555555',
    drawingName: '2026 Q3 Giveaway',
    ticketPriceCents: 2500,
    winnerCount: 3,
    alternateCount: 2,
    entrants: [entrant('c', 1), entrant('a', 4), entrant('b', 2)],
    ...overrides,
  }
}

/** Deterministically derive distinct seeds from an index, without Math.random. */
async function seedForTrial(i: number): Promise<string> {
  return sha256Hex(`trial/${i}`)
}

/* -------------------------------------------------------------------------- *
 * Hex helpers
 * -------------------------------------------------------------------------- */

describe('hex helpers', () => {
  it('round-trips bytes', () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 127, 128, 254, 255])
    expect(bytesToHex(bytes)).toBe('00010f107f80feff')
    expect(Array.from(hexToBytes('00010f107f80feff'))).toEqual(Array.from(bytes))
  })

  it('rejects malformed hex rather than silently producing NaN bytes', () => {
    expect(() => hexToBytes('abc')).toThrow(/odd-length/i)
    expect(() => hexToBytes('zz')).toThrow(/non-hex/i)
  })

  it('accepts uppercase and surrounding whitespace', () => {
    expect(Array.from(hexToBytes('  DEADBEEF '))).toEqual([0xde, 0xad, 0xbe, 0xef])
  })
})

/* -------------------------------------------------------------------------- *
 * Canonicalisation — the foundation of third-party verification
 * -------------------------------------------------------------------------- */

describe('canonicalizeSnapshot', () => {
  it('is independent of the order entrants arrive in', () => {
    const a = canonicalizeSnapshot(snapshot({ entrants: [entrant('a', 4), entrant('b', 2), entrant('c', 1)] }))
    const b = canonicalizeSnapshot(snapshot({ entrants: [entrant('c', 1), entrant('a', 4), entrant('b', 2)] }))
    expect(a).toBe(b)
  })

  it('emits a stable, human-readable document ending in a newline', () => {
    const doc = canonicalizeSnapshot(snapshot())
    expect(doc.endsWith('\n')).toBe(true)
    expect(doc).toContain('wtw-snapshot/v1')
    expect(doc).toContain('total_tickets\t7')
    expect(doc).toContain('entrant_count\t3')
    // Entrants sorted by publicId, tab-delimited.
    const body = doc.slice(doc.indexOf('entrants\n') + 'entrants\n'.length, doc.indexOf('\nend'))
    expect(body.split('\n')).toEqual(['\ta\t4\tE a', '\tb\t2\tE b', '\tc\t1\tE c'])
  })

  it('normalises unicode so composed and decomposed names hash identically', () => {
    const composed = canonicalizeSnapshot(snapshot({ entrants: [entrant('a', 1, 'Renée')] }))
    const decomposed = canonicalizeSnapshot(snapshot({ entrants: [entrant('a', 1, 'Renée')] }))
    expect(composed).toBe(decomposed)
  })

  it('refuses field values that would break the delimiter', () => {
    expect(() => canonicalizeSnapshot(snapshot({ entrants: [entrant('a', 1, 'Bad\tLabel')] }))).toThrow(/tab or newline/i)
    expect(() => canonicalizeSnapshot(snapshot({ entrants: [entrant('a', 1, 'Bad\nLabel')] }))).toThrow(/tab or newline/i)
    expect(() => canonicalizeSnapshot(snapshot({ drawingName: 'Q3\nGiveaway' }))).toThrow(/tab or newline/i)
  })

  it('refuses duplicate entrants, empty ids, and non-positive ticket counts', () => {
    expect(() => canonicalizeSnapshot(snapshot({ entrants: [entrant('a', 1), entrant('a', 2)] }))).toThrow(/duplicate/i)
    expect(() => canonicalizeSnapshot(snapshot({ entrants: [entrant('', 1)] }))).toThrow(/may not be empty/i)
    expect(() => canonicalizeSnapshot(snapshot({ entrants: [entrant('a', 0)] }))).toThrow(/at least one whole ticket/i)
    expect(() => canonicalizeSnapshot(snapshot({ entrants: [entrant('a', -1)] }))).toThrow(/at least one whole ticket/i)
    expect(() => canonicalizeSnapshot(snapshot({ entrants: [entrant('a', 1.5)] }))).toThrow(/at least one whole ticket/i)
  })

  it('produces a fixed golden hash — a change here breaks every published draw', async () => {
    // If this assertion fails, the wire protocol changed. That is allowed only
    // via a version bump (wtw-snapshot/v2), never by editing v1 in place, or
    // draws already published to the group stop verifying.
    const hash = await hashSnapshot(snapshot())
    expect(hash).toMatchInlineSnapshot(`"3bc09ef06a3ddc51d94fb902ed4d9dec41ca3ee93ef6eecc78187f32e1ca19f9"`)
  })
})

/* -------------------------------------------------------------------------- *
 * Commitments and seed derivation
 * -------------------------------------------------------------------------- */

describe('commitments', () => {
  it('commits to a seed reproducibly and distinguishes different seeds', async () => {
    const c1 = await computeSeedCommitment(SEED_A)
    expect(await computeSeedCommitment(SEED_A)).toBe(c1)
    expect(await computeSeedCommitment(SEED_B)).not.toBe(c1)
    expect(c1).toMatch(/^[0-9a-f]{64}$/)
  })

  it('insists on a full 32-byte seed', async () => {
    await expect(computeSeedCommitment('abcd')).rejects.toThrow(/exactly 32 bytes/i)
    await expect(computeSeedCommitment('a'.repeat(62))).rejects.toThrow(/exactly 32 bytes/i)
  })

  it('derives a final seed that changes when ANY input changes', async () => {
    const base = await computeFinalSeed('a'.repeat(64), SEED_A, BEACON)
    expect(await computeFinalSeed('a'.repeat(64), SEED_A, BEACON)).toBe(base)

    // Different entrant list.
    expect(await computeFinalSeed('b'.repeat(64), SEED_A, BEACON)).not.toBe(base)
    // Different operator secret.
    expect(await computeFinalSeed('a'.repeat(64), SEED_B, BEACON)).not.toBe(base)
    // Different beacon round — this is the anti-grinding property.
    expect(await computeFinalSeed('a'.repeat(64), SEED_A, { ...BEACON, round: BEACON.round + 1 })).not.toBe(base)
    // Different beacon randomness.
    expect(await computeFinalSeed('a'.repeat(64), SEED_A, { ...BEACON, randomness: 'ff'.repeat(32) })).not.toBe(base)
  })

  it('rejects a nonsensical beacon', async () => {
    await expect(computeFinalSeed('a'.repeat(64), SEED_A, { ...BEACON, round: 0 })).rejects.toThrow(/positive integer/i)
    await expect(computeFinalSeed('a'.repeat(64), SEED_A, { ...BEACON, randomness: '' })).rejects.toThrow(/may not be empty/i)
  })

  it('generates 32-byte seeds', () => {
    const seed = generateSecretSeed()
    expect(seed).toMatch(/^[0-9a-f]{64}$/)
    expect(generateSecretSeed()).not.toBe(seed)
  })
})

/* -------------------------------------------------------------------------- *
 * PRNG
 * -------------------------------------------------------------------------- */

describe('DeterministicRng', () => {
  it('produces the same stream for the same seed, always', async () => {
    const a = new DeterministicRng(SEED_A)
    const b = new DeterministicRng(SEED_A)
    const streamA: bigint[] = []
    const streamB: bigint[] = []
    for (let i = 0; i < 40; i++) streamA.push(await a.nextUint64())
    for (let i = 0; i < 40; i++) streamB.push(await b.nextUint64())
    expect(streamB).toEqual(streamA)
  })

  it('produces different streams for different seeds', async () => {
    const a = new DeterministicRng(SEED_A)
    const b = new DeterministicRng(SEED_B)
    expect(await b.nextUint64()).not.toBe(await a.nextUint64())
  })

  it('crosses block boundaries correctly (4 words per HMAC block)', async () => {
    const rng = new DeterministicRng(SEED_A)
    const words: bigint[] = []
    for (let i = 0; i < 12; i++) words.push(await rng.nextUint64())
    // Three full blocks consumed; every word distinct means the counter advanced.
    expect(new Set(words.map(String)).size).toBe(12)
    expect(rng.wordsConsumed).toBe(12)
  })

  it('stays within bounds', async () => {
    const rng = new DeterministicRng(SEED_A)
    for (const bound of [1, 2, 3, 7, 100, 5000]) {
      for (let i = 0; i < 50; i++) {
        const v = await rng.nextBelow(bound)
        expect(v).toBeGreaterThanOrEqual(0n)
        expect(v).toBeLessThan(BigInt(bound))
      }
    }
  })

  it('rejects invalid bounds', async () => {
    const rng = new DeterministicRng(SEED_A)
    await expect(rng.nextBelow(0)).rejects.toThrow(/must be positive/i)
    await expect(rng.nextBelow(-5)).rejects.toThrow(/must be positive/i)
  })

  it('is statistically uniform across a small bound', async () => {
    // 7 buckets over 14k samples: expected 2000 each, sd = sqrt(14000*(1/7)*(6/7)) ≈ 41.4.
    // A 6-sigma band (±249) essentially never trips by chance, and the seed is
    // fixed anyway, so this test is deterministic.
    const rng = new DeterministicRng(SEED_B)
    const counts = new Array<number>(7).fill(0)
    const N = 14_000
    for (let i = 0; i < N; i++) counts[Number(await rng.nextBelow(7))]! += 1
    for (const c of counts) {
      expect(c).toBeGreaterThan(2000 - 249)
      expect(c).toBeLessThan(2000 + 249)
    }
    expect(counts.reduce((a, b) => a + b, 0)).toBe(N)
  })
})

/* -------------------------------------------------------------------------- *
 * Winner selection
 * -------------------------------------------------------------------------- */

describe('selectWinners', () => {
  it('is deterministic for a given seed', async () => {
    const s = snapshot()
    const seed = await sha256Hex('deterministic')
    expect(await selectWinners(s, seed)).toEqual(await selectWinners(s, seed))
  })

  it('ignores the input ordering of entrants', async () => {
    const seed = await sha256Hex('ordering')
    const forward = await selectWinners(snapshot({ entrants: [entrant('a', 4), entrant('b', 2), entrant('c', 1)] }), seed)
    const reverse = await selectWinners(snapshot({ entrants: [entrant('c', 1), entrant('b', 2), entrant('a', 4)] }), seed)
    expect(reverse).toEqual(forward)
  })

  it('never selects the same entrant twice', async () => {
    for (let trial = 0; trial < 60; trial++) {
      const winners = await selectWinners(
        snapshot({
          winnerCount: 3,
          alternateCount: 2,
          entrants: [entrant('a', 40), entrant('b', 30), entrant('c', 20), entrant('d', 5), entrant('e', 1)],
        }),
        await seedForTrial(trial),
      )
      expect(winners).toHaveLength(5)
      expect(new Set(winners.map((w) => w.publicId)).size).toBe(5)
      expect(winners.map((w) => w.rank)).toEqual([1, 2, 3, 4, 5])
    }
  })

  it('marks ranks past winnerCount as alternates', async () => {
    const winners = await selectWinners(snapshot({ winnerCount: 2, alternateCount: 1 }), await sha256Hex('alt'))
    expect(winners.map((w) => w.isAlternate)).toEqual([false, false, true])
  })

  it('stops gracefully when the pool is smaller than the requested ranks', async () => {
    const winners = await selectWinners(
      snapshot({ winnerCount: 5, alternateCount: 3, entrants: [entrant('a', 1), entrant('b', 1)] }),
      await sha256Hex('small'),
    )
    expect(winners).toHaveLength(2)
    expect(new Set(winners.map((w) => w.publicId))).toEqual(new Set(['a', 'b']))
  })

  it('handles a single entrant holding every ticket', async () => {
    const winners = await selectWinners(
      snapshot({ winnerCount: 1, alternateCount: 0, entrants: [entrant('solo', 12)] }),
      await sha256Hex('solo'),
    )
    expect(winners).toEqual([
      { rank: 1, publicId: 'solo', displayLabel: 'E solo', tickets: 12, isAlternate: false },
    ])
  })

  it('reports the ticket count the winner actually held', async () => {
    const winners = await selectWinners(
      snapshot({ winnerCount: 1, alternateCount: 0, entrants: [entrant('a', 4), entrant('b', 7)] }),
      await sha256Hex('tickets'),
    )
    expect(winners[0]!.tickets).toBe(winners[0]!.publicId === 'a' ? 4 : 7)
  })

  it('weights odds by ticket count — the core fairness claim', async () => {
    // a=4 tickets, b/c/d=1 each. Total 7. P(a wins rank 1) = 4/7 ≈ 0.5714.
    // Over 3500 single-winner draws: expected 2000, sd = sqrt(3500*4/7*3/7) ≈ 29.3.
    // Assert within 5 sd (±147). Seeds are derived from the trial index, so this
    // is fully deterministic — it either passes forever or the weighting is wrong.
    const N = 3500
    const wins: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 }
    const s = snapshot({
      winnerCount: 1,
      alternateCount: 0,
      entrants: [entrant('a', 4), entrant('b', 1), entrant('c', 1), entrant('d', 1)],
    })
    for (let i = 0; i < N; i++) {
      const w = await selectWinners(s, await seedForTrial(i))
      wins[w[0]!.publicId] = (wins[w[0]!.publicId] ?? 0) + 1
    }

    expect(wins.a).toBeGreaterThan(2000 - 147)
    expect(wins.a).toBeLessThan(2000 + 147)

    // Each single-ticket holder should land near 500 (sd ≈ 20.7; ±104 is 5 sd).
    for (const id of ['b', 'c', 'd'] as const) {
      expect(wins[id]).toBeGreaterThan(500 - 104)
      expect(wins[id]).toBeLessThan(500 + 104)
    }
    expect(wins.a! + wins.b! + wins.c! + wins.d!).toBe(N)
  })

  it('gives equal odds when everyone holds one ticket', async () => {
    // 5 entrants, 2500 draws: expected 500 each, sd ≈ 20; ±120 is 6 sd.
    const N = 2500
    const wins = new Map<string, number>()
    const s = snapshot({
      winnerCount: 1,
      alternateCount: 0,
      entrants: ['a', 'b', 'c', 'd', 'e'].map((id) => entrant(id, 1)),
    })
    for (let i = 0; i < N; i++) {
      const w = await selectWinners(s, await seedForTrial(i + 100_000))
      wins.set(w[0]!.publicId, (wins.get(w[0]!.publicId) ?? 0) + 1)
    }
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      expect(wins.get(id) ?? 0).toBeGreaterThan(500 - 120)
      expect(wins.get(id) ?? 0).toBeLessThan(500 + 120)
    }
  })

  it('scales to a realistic quarter (1000 entrants, ~2500 tickets)', async () => {
    const entrants = Array.from({ length: 1000 }, (_, i) =>
      entrant(`p${String(i).padStart(4, '0')}`, (i % 5) + 1, `Member ${i}`),
    )
    const s = snapshot({ winnerCount: 3, alternateCount: 5, entrants })
    const winners = await selectWinners(s, await sha256Hex('scale'))
    expect(winners).toHaveLength(8)
    expect(new Set(winners.map((w) => w.publicId)).size).toBe(8)
  })
})

/* -------------------------------------------------------------------------- *
 * End-to-end draw + verification
 * -------------------------------------------------------------------------- */

describe('executeDraw / verifyDraw', () => {
  it('runs a draw whose result verifies against the published values', async () => {
    const s = snapshot()
    const result = await executeDraw(s, SEED_A, BEACON)

    expect(result.protocolVersion).toBe(DRAW_PROTOCOL_VERSION)
    expect(result.totalTickets).toBe(7)
    expect(result.totalEntrants).toBe(3)
    expect(result.winners).toHaveLength(3) // 3 entrants; 5 ranks requested, pool exhausts
    expect(result.randomWordsConsumed).toBeGreaterThan(0)

    const report = await verifyDraw(s, result, SEED_A)
    expect(report.checks.map((c) => c.id)).toEqual(['snapshot_hash', 'seed_commitment', 'final_seed', 'winners'])
    expect(report.valid).toBe(true)
    expect(report.recomputedWinners).toEqual(result.winners)
  })

  it('is reproducible across independent runs', async () => {
    const s = snapshot()
    expect(await executeDraw(s, SEED_A, BEACON)).toEqual(await executeDraw(s, SEED_A, BEACON))
  })

  it('catches an entrant list edited after the lock', async () => {
    const s = snapshot()
    const result = await executeDraw(s, SEED_A, BEACON)

    // Operator sneaks an extra 50 tickets to their friend after locking.
    const tampered = snapshot({ entrants: [entrant('c', 1), entrant('a', 54), entrant('b', 2)] })
    const report = await verifyDraw(tampered, result, SEED_A)

    expect(report.valid).toBe(false)
    expect(report.checks.find((c) => c.id === 'snapshot_hash')!.passed).toBe(false)
    expect(report.checks.find((c) => c.id === 'snapshot_hash')!.detail).toMatch(/changed after locking/i)
  })

  it('catches a swapped secret seed', async () => {
    const s = snapshot()
    const result = await executeDraw(s, SEED_A, BEACON)
    const report = await verifyDraw(s, result, SEED_B)

    expect(report.valid).toBe(false)
    expect(report.checks.find((c) => c.id === 'seed_commitment')!.passed).toBe(false)
  })

  it('catches hand-edited winners', async () => {
    const s = snapshot()
    const result = await executeDraw(s, SEED_A, BEACON)
    const forged = {
      ...result,
      winners: result.winners.map((w, i) => (i === 0 ? { ...w, publicId: 'b', displayLabel: 'E b' } : w)),
    }
    const report = await verifyDraw(s, forged, SEED_A)

    expect(report.valid).toBe(false)
    expect(report.checks.find((c) => c.id === 'winners')!.passed).toBe(false)
  })

  it('catches a substituted beacon value', async () => {
    const s = snapshot()
    const result = await executeDraw(s, SEED_A, BEACON)
    const forged = { ...result, beacon: { ...BEACON, randomness: 'ab'.repeat(32) } }
    const report = await verifyDraw(s, forged, SEED_A)

    expect(report.valid).toBe(false)
    expect(report.checks.find((c) => c.id === 'final_seed')!.passed).toBe(false)
  })

  it('reports a clean failure instead of throwing on a malformed snapshot', async () => {
    const s = snapshot()
    const result = await executeDraw(s, SEED_A, BEACON)
    const broken = snapshot({ entrants: [entrant('a', 0)] })
    const report = await verifyDraw(broken, result, SEED_A)

    expect(report.valid).toBe(false)
    expect(report.checks.some((c) => c.id === 'error')).toBe(true)
  })

  it('changes the outcome when only the beacon changes — proof the operator cannot pre-compute', async () => {
    const s = snapshot({
      winnerCount: 1,
      alternateCount: 0,
      entrants: Array.from({ length: 50 }, (_, i) => entrant(`p${i}`, 1)),
    })
    const seen = new Set<string>()
    for (let round = 0; round < 25; round++) {
      const r = await executeDraw(s, SEED_A, { ...BEACON, round: BEACON.round + round })
      seen.add(r.winners[0]!.publicId)
    }
    // With the same committed seed but 25 different beacon rounds, the winner
    // moves around. If this collapsed to one name, the beacon would not be
    // influencing the draw at all.
    expect(seen.size).toBeGreaterThan(10)
  })
})
