import { describe, expect, it } from 'vitest'
import {
  buildWedges, easeOutQuint, labelColorOn, normalizeDeg, planSpin, wedgeAtRotation,
  wedgeColor, WHEEL_COLORS,
  type WheelEntrant,
} from './wheel'

const E = (publicId: string, tickets: number): WheelEntrant => ({ publicId, label: publicId, tickets })

describe('buildWedges', () => {
  it('sizes each wedge in proportion to tickets', () => {
    const wedges = buildWedges([E('a', 1), E('b', 2), E('c', 1)])
    expect(wedges.map((w) => Math.round(w.sweepDeg))).toEqual([90, 180, 90])
    expect(wedges[0]!.startDeg).toBe(0)
  })

  it('closes the ring exactly, with no gap from floating-point drift', () => {
    // 7 tickets across 3 people does not divide evenly into 360.
    const wedges = buildWedges([E('a', 3), E('b', 2), E('c', 2)])
    const last = wedges[wedges.length - 1]!
    expect(last.startDeg + last.sweepDeg).toBe(360)
  })

  it('lays entrants out in canonical snapshot order', () => {
    const wedges = buildWedges([E('c', 1), E('a', 1), E('b', 1)])
    expect(wedges.map((w) => w.publicId)).toEqual(['a', 'b', 'c'])
  })

  it('ignores anyone holding no tickets', () => {
    const wedges = buildWedges([E('a', 2), E('b', 0)])
    expect(wedges.map((w) => w.publicId)).toEqual(['a'])
    expect(wedges[0]!.sweepDeg).toBe(360)
  })

  it('returns nothing when there are no tickets at all', () => {
    expect(buildWedges([])).toEqual([])
    expect(buildWedges([E('a', 0)])).toEqual([])
  })

  it('handles a realistic quarter: 1000 entrants, ~3000 tickets', () => {
    const entrants = Array.from({ length: 1000 }, (_, i) => E(`p${String(i).padStart(4, '0')}`, (i % 5) + 1))
    const wedges = buildWedges(entrants)
    expect(wedges).toHaveLength(1000)
    expect(wedges[wedges.length - 1]!.startDeg + wedges[wedges.length - 1]!.sweepDeg).toBe(360)
    // Every wedge is far below label-legible size, which is why the reveal
    // reads the name from the hub rather than from the rim.
    expect(Math.max(...wedges.map((w) => w.sweepDeg))).toBeLessThan(1)
  })
})

describe('wedgeAtRotation', () => {
  it('reports the wedge sitting under the pointer', () => {
    const wedges = buildWedges([E('a', 1), E('b', 1), E('c', 1), E('d', 1)]) // 90 deg each
    expect(wedgeAtRotation(wedges, 0)!.publicId).toBe('a')
    expect(wedgeAtRotation(wedges, -45)!.publicId).toBe('a')
    expect(wedgeAtRotation(wedges, -100)!.publicId).toBe('b')
    expect(wedgeAtRotation(wedges, -190)!.publicId).toBe('c')
    expect(wedgeAtRotation(wedges, -280)!.publicId).toBe('d')
  })

  it('wraps around whole turns', () => {
    const wedges = buildWedges([E('a', 1), E('b', 1)])
    expect(wedgeAtRotation(wedges, -3600 - 10)!.publicId).toBe('a')
    expect(wedgeAtRotation(wedges, 3600 + 10)!.publicId).toBe('b')
  })

  it('returns null for an empty wheel', () => {
    expect(wedgeAtRotation([], 12)).toBeNull()
  })
})

describe('planSpin', () => {
  it('lands the pointer on the winner, and only the winner', () => {
    const wedges = buildWedges([E('a', 1), E('b', 1), E('c', 1), E('d', 1)])
    for (const id of ['a', 'b', 'c', 'd']) {
      const plan = planSpin(wedges, id, 0)!
      expect(wedgeAtRotation(wedges, plan.toDeg)!.publicId, `landing on ${id}`).toBe(id)
    }
  })

  it('lands correctly for every jitter value across the wedge', () => {
    // The resting point is nudged so repeated spins do not stop identically.
    // It must never nudge far enough to select a neighbour.
    const wedges = buildWedges([E('a', 3), E('b', 1), E('c', 2)])
    for (const id of ['a', 'b', 'c']) {
      for (let j = 0; j <= 1.0001; j += 0.05) {
        const plan = planSpin(wedges, id, 0, { jitter: j })!
        expect(wedgeAtRotation(wedges, plan.toDeg)!.publicId, `${id} @ jitter ${j.toFixed(2)}`).toBe(id)
      }
    }
  })

  it('still lands precisely with 1000 entrants, where a wedge is a fraction of a degree', () => {
    const entrants = Array.from({ length: 1000 }, (_, i) => E(`p${String(i).padStart(4, '0')}`, (i % 5) + 1))
    const wedges = buildWedges(entrants)
    for (const id of ['p0000', 'p0499', 'p0999', 'p0250']) {
      for (const j of [0, 0.25, 0.5, 0.75, 1]) {
        const plan = planSpin(wedges, id, 0, { jitter: j })!
        expect(wedgeAtRotation(wedges, plan.toDeg)!.publicId, `${id} @ ${j}`).toBe(id)
      }
    }
  })

  it('always spins forwards, never snaps backwards', () => {
    const wedges = buildWedges([E('a', 1), E('b', 1), E('c', 1)])
    let from = 0
    for (let i = 0; i < 12; i++) {
      const plan = planSpin(wedges, 'b', from)!
      expect(plan.toDeg).toBeGreaterThan(from)
      expect(wedgeAtRotation(wedges, plan.toDeg)!.publicId).toBe('b')
      from = plan.toDeg
    }
  })

  it('turns at least the requested number of full rotations', () => {
    const wedges = buildWedges([E('a', 1), E('b', 1)])
    const plan = planSpin(wedges, 'a', 0, { turns: 6 })!
    expect(plan.toDeg).toBeGreaterThanOrEqual(6 * 360)
  })

  it('returns null when the winner is not on the wheel', () => {
    expect(planSpin(buildWedges([E('a', 1)]), 'nobody', 0)).toBeNull()
  })
})

describe('easing and colours', () => {
  it('eases from 0 to 1 and decelerates', () => {
    expect(easeOutQuint(0)).toBe(0)
    expect(easeOutQuint(1)).toBe(1)
    expect(easeOutQuint(-5)).toBe(0)
    expect(easeOutQuint(5)).toBe(1)
    // Most of the distance is covered early, so it visibly slows into the stop.
    expect(easeOutQuint(0.5)).toBeGreaterThan(0.9)
    const lateGain = easeOutQuint(1) - easeOutQuint(0.9)
    const earlyGain = easeOutQuint(0.1) - easeOutQuint(0)
    expect(lateGain).toBeLessThan(earlyGain)
  })

  it('never gives two neighbouring wedges the same colour', () => {
    for (let i = 0; i < 30; i++) expect(wedgeColor(i)).not.toBe(wedgeColor(i + 1))
  })

  it('normalises angles into 0..360', () => {
    expect(normalizeDeg(0)).toBe(0)
    expect(normalizeDeg(-90)).toBe(270)
    expect(normalizeDeg(450)).toBe(90)
    expect(normalizeDeg(-3610)).toBe(350)
  })
})

describe('formatOdds', () => {
  it('stays readable when the pool is large', async () => {
    const { formatOdds } = await import('./format')
    // A percentage collapses to "0.0%" here, which reads like a bug on stream.
    expect(formatOdds(1, 3000)).toBe('about a 1 in 3,000 chance')
    expect(formatOdds(4, 3000)).toBe('about a 1 in 750 chance')
    expect(formatOdds(5, 21)).toBe('a 23.8% chance')
    expect(formatOdds(1, 50)).toBe('a 2.0% chance')
    expect(formatOdds(1, 1)).toBe('a certainty')
    expect(formatOdds(0, 100)).toBe('no chance')
    expect(formatOdds(1, 0)).toBe('no chance')
  })
})

describe('labelColorOn', () => {
  it('puts ink on light fills and paper on dark ones', () => {
    expect(labelColorOn('#e2734b')).toBe('#0e1117') // light copper
    expect(labelColorOn('#fceee8')).toBe('#0e1117') // the winner tint
    expect(labelColorOn('#0a7070')).toBe('#fafafc') // teal deep
    expect(labelColorOn('#1f5e4e')).toBe('#fafafc') // viridian
  })

  it('clears 4.5:1 for every colour the wheel can actually draw', () => {
    // A rim label is small text on a solid fill, so it has to meet the normal
    // bar rather than the large-text one.
    const lin = (v: number) => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    }
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1), 16)
      return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
    }
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
      return (hi + 0.05) / (lo + 0.05)
    }
    // Every palette entry, plus the tint the winning wedge is filled with.
    for (const fill of [...WHEEL_COLORS, '#fceee8']) {
      expect(ratio(labelColorOn(fill), fill)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('keeps the palette in step with wedgeColor', () => {
    expect(wedgeColor(0)).toBe(WHEEL_COLORS[0])
    expect(wedgeColor(WHEEL_COLORS.length)).toBe(WHEEL_COLORS[0])
  })
})

describe('the wheel palette and the design tokens', () => {
  it('paints only colours that exist as tokens', async () => {
    // The wheel draws to a canvas, so its colours have to be literals — a
    // canvas context cannot read a CSS custom property. That makes them a
    // second copy of values that also live in @theme, and a copy that nothing
    // checks is a copy that drifts. This is the check.
    const { readFileSync } = await import('node:fs')
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
    const theme = css.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    const defined = new Map(
      [...theme.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map(
        (m) => [m[2]!.toLowerCase(), m[1]!],
      ),
    )
    expect(defined.size).toBeGreaterThan(0)

    for (const fill of WHEEL_COLORS) {
      expect(defined.has(fill), `${fill} is painted by the wheel but is not a token`).toBe(true)
    }
  })
})
