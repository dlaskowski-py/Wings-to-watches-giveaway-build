import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { MARK } from './brand'

/**
 * The mark exists twice: as the Mark component and as public/favicon.svg,
 * which a browser tab loads without running any of our code. The kit's own
 * favicon is a hand-drawn approximation of its construction table — the centre
 * bar is 0.533 of an outer bar there rather than 0.55, and its corner radius
 * is 0.267 of the bar width rather than 0.22 — so copying it verbatim would
 * ship two different shapes under one name. This derives the expected numbers
 * from the same constants the component uses and fails if they drift.
 */
const SVG = readFileSync(new URL('../../public/favicon.svg', import.meta.url), 'utf8')

function rects(svg: string) {
  return [...svg.matchAll(/<rect([^>]*)\/>/g)].map((m) => {
    const attr = (name: string) => {
      const hit = m[1]!.match(new RegExp(`${name}="([^"]*)"`))
      return hit ? hit[1]! : undefined
    }
    return {
      x: Number(attr('x') ?? 0), y: Number(attr('y') ?? 0),
      width: Number(attr('width')), height: Number(attr('height')),
      rx: Number(attr('rx') ?? 0), fill: (attr('fill') ?? '').toLowerCase(),
    }
  })
}

const BOX = 32

describe('favicon', () => {
  const [ground, left, centre, right] = rects(SVG)

  it('is the kit artboard: porcelain ground, 6px radius', () => {
    expect(ground).toMatchObject({ width: BOX, height: BOX, rx: 6, fill: '#fafafc' })
  })

  it('draws three bars, only the middle one copper', () => {
    expect(left!.fill).toBe('#0e1117')
    expect(centre!.fill).toBe('#d9542a')
    expect(right!.fill).toBe('#0e1117')
  })

  it('matches the Mark component construction', () => {
    // One bar width, solved so the mark plus a bar of clear space fills the box.
    const bar = Math.min(BOX / (MARK.width + 2), BOX / (MARK.height + 2))
    const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 2)

    close(left!.width, bar)
    close(right!.width, bar)
    close(centre!.width, MARK.centre * bar)
    close(left!.height, MARK.height * bar)
    close(left!.rx, bar * MARK.radius)
    close(centre!.rx, MARK.centre * bar * MARK.radius)
    // Gaps come out of the positions rather than being stated.
    close(centre!.x - (left!.x + left!.width), MARK.gap * bar)
    close(right!.x - (centre!.x + centre!.width), MARK.gap * bar)
  })

  it('keeps at least one bar width of clear space, and stays centred', () => {
    // The kit states clear space as a minimum. The mark is taller than it is
    // wide (3.67 x 3.39 bars), so centring it in a square artboard makes the
    // height the binding constraint: the vertical clear space lands on exactly
    // one bar and the horizontal gets a little more.
    const bar = left!.width
    const leftGap = left!.x
    const rightGap = BOX - (right!.x + right!.width)
    const topGap = left!.y
    const bottomGap = BOX - (left!.y + left!.height)

    for (const gap of [leftGap, rightGap, topGap, bottomGap]) {
      expect(gap).toBeGreaterThanOrEqual(bar - 0.01)
    }
    expect(leftGap).toBeCloseTo(rightGap, 2)
    expect(topGap).toBeCloseTo(bottomGap, 2)
    // And the mark is as large as that rule allows, so the icon is not
    // needlessly small in a 16px tab.
    expect(Math.min(topGap, leftGap)).toBeCloseTo(bar, 2)
  })
})
