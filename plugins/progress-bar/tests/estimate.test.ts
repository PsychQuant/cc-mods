import { describe, expect, test } from 'claude-code/testing'

import { CAP, fitAdd, fitEval, lookup, median, rate, record, step, target, targetRate } from '../hooks/est'
import type { Fit } from '../hooks/est'

/** 固定種子的亂數(mulberry32):每次跑都是同一串 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function fitOf(points: [number, number][]): Fit {
  let f: Fit | null = null
  for (const [t, p] of points) f = fitAdd(f, t, p)
  if (f === null) throw new Error('no points')
  return f
}

describe('local linear(指數權重)', () => {
  test('讀數剛好在 p = 2t 上:斜率與最後一點的水準精確還原', () => {
    const ev = fitEval(fitOf([[0, 0], [3, 6], [7, 14], [12, 24], [20, 40]]))
    expect(Math.abs((ev.slope ?? NaN) - 2) < 1e-9).toBe(true)
    expect(Math.abs(ev.level - 40) < 1e-9).toBe(true)
    expect(ev.nEff > 1).toBe(true)
  })

  test('只有一個讀數:斜率未定,沒有 NaN', () => {
    const ev = fitEval(fitOf([[5, 12]]))
    expect(ev.slope).toBe(null)
    expect(ev.level).toBe(12)
    // 沒有歷史 → 沒有速率;有歷史 → 用歷史速率
    expect(rate(ev, null, null, null)).toBe(null)
    expect(rate(ev, 0.5, null, null)).toBe(0.5)
  })

  test('讀數少時往歷史速率收縮,讀數多時以讀數為主', () => {
    const few = fitEval(fitOf([[0, 0], [10, 20]]))          // 斜率 2
    const many = fitEval(fitOf(Array.from({ length: 30 }, (_, i) => [i * 2, i * 4] as [number, number])))
    const prior = 1
    const bFew = rate(few, prior, null, null) ?? NaN
    const bMany = rate(many, prior, null, null) ?? NaN
    expect(bFew > 1 && bFew < 2).toBe(true)
    expect(Math.abs(bMany - 2) < Math.abs(bFew - 2)).toBe(true)
  })

  test('斜率是負的(讀數停住)時,速率不低於平均速率的 0.2 倍', () => {
    const ev = fitEval(fitOf([[0, 50], [10, 50], [20, 49.9]]))
    const b = rate(ev, null, 2, null) ?? NaN
    expect(Math.abs(b - 0.4) < 1e-12).toBe(true)
  })
})

describe('目標值:以最後讀數為錨,外插會飽和', () => {
  test('最後讀數之後很久都沒有新讀數:目標停在有限值,不超過一個典型步幅', () => {
    const f = fitOf([[0, 0], [5, 4], [10, 8], [15, 12]])   // 每 5 秒 4%
    const b = 0.8
    const soon = target(f, 16, b)
    const later = target(f, 20, b)
    const forever = target(f, 1e6, b)
    expect(soon > 12 && soon < later).toBe(true)
    expect(forever <= 12 + 4 + 1e-9).toBe(true)
    expect(Number.isFinite(forever)).toBe(true)
  })

  test('沒有速率:目標就是最後讀數;永遠不超過上限', () => {
    const f = fitOf([[3, 97]])
    expect(target(f, 100, null)).toBe(97)
    expect(target(fitOf([[0, 0], [1, 99]]), 50, 5) <= CAP).toBe(true)
  })
})

describe('控制器', () => {
  test('跟著目標的速度走:落後時追趕、超前時變慢但不停', () => {
    const vt = 1                                            // 目標每秒走 1 個百分點
    const behind = step(50, 60, vt, 0.25) - 50
    const even = step(50, 50, vt, 0.25) - 50
    const ahead = step(60, 50, vt, 0.25) - 60
    expect(behind > even).toBe(true)
    expect(Math.abs(even - 0.25) < 1e-12).toBe(true)
    expect(ahead > 0 && ahead < even).toBe(true)
    // 差距很大:追趕項在幾秒內接近
    let d = 0
    for (let i = 0; i < 12; i++) d = step(d, 63, 0, 0.25)
    expect(d > 60 && d <= 63.01).toBe(true)
  })

  test('目標不動:仍以極慢的速度前進(不停,也不往回),一拍不到 0.01', () => {
    const at = step(63, 63, 0, 0.25) - 63
    const over = step(70, 63, 0, 0.25) - 70
    expect(at > 0 && at < 0.01).toBe(true)
    expect(over > 0 && over < 0.01).toBe(true)
  })

  test('早期速率很高、目標已經飽和:顯示值不會衝過目標(超前收不回來)', () => {
    const fit = fitOf([[0, 0], [2, 42]])                    // 兩個點:斜率 21%/s,步幅上限 10
    const b = rate(fitEval(fit), null, 21, null) ?? NaN
    let d = 0
    for (let t = 2.25; t <= 6; t += 0.25) d = step(d, target(fit, t, b), targetRate(fit, t, b), 0.25)
    expect(d > 50 && d < 52.5).toBe(true)
  })

  test('任意讀數序列(含往回掉):顯示值單調不減、不超過上限(結束前不到 100%)、執行中一直在動', () => {
    const r = rng(20261025)
    let fit: Fit | null = null
    let p = 0
    let next = 3
    let d = 0
    const dt = 0.25
    for (let i = 1; i <= 2400; i++) {
      const t = i * dt
      if (t >= next) {
        next = t + 1 + r() * 20
        if (r() < 0.05) p = r() * 30                        // 新階段:讀數往回掉
        else p = Math.min(99, p + r() * 6)
        fit = fit !== null && p >= fit.pLast - 5 ? fitAdd(fit, t, p) : fitAdd(null, t, p)
      }
      if (fit === null) continue
      const b = rate(fitEval(fit), null, null, null) ?? 0.05
      const before = d
      d = step(d, target(fit, t, b), targetRate(fit, t, b), dt)
      expect(d >= before).toBe(true)
      expect(d <= CAP).toBe(true)
      if (before < CAP) expect(d > before).toBe(true)
    }
  })
})

describe('歷史', () => {
  test('中位數', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBe(null)
  })

  test('同一個指令字串:只留最近 5 次,查到的是中位數;字串不同就查不到', () => {
    let h = {}
    for (const [i, ms] of [10, 20, 30, 40, 50, 60].entries()) h = record(h, 'pytest -q', ms, i)
    expect(lookup(h, 'pytest -q')).toBe(40)                   // 20, 30, 40, 50, 60
    expect(lookup(h, 'pytest -q ')).toBe(null)
  })

  test('超過 200 個指令時丟掉最久沒寫入的;不改動原本的物件', () => {
    let h = {}
    for (let i = 0; i < 201; i++) h = record(h, `cmd ${i}`, 1000, i)
    expect(Object.keys(h).length).toBe(200)
    expect(lookup(h, 'cmd 0')).toBe(null)
    expect(lookup(h, 'cmd 200')).toBe(1000)
    const before = JSON.stringify(h)
    record(h, 'cmd new', 5, 999)
    expect(JSON.stringify(h)).toBe(before)
  })
})
