import { describe, expect, test } from 'claude-code/testing'

import {
  asRun, CAP, etaFromReading, expiredKeys, evictRunKeys, fitAdd, fitEval, frameDt, hashCommand, MAX_LEAD, median, parseRunKey,
  rate, runKey, seedDisplay, step, summarize, target, targetRate,
} from '../hooks/est'
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
  test('落後時一階延遲追這一拍的目標;剛好在目標上只剩最低速度;超前時照目標的速度變慢但不停', () => {
    const vt = 1                                            // 目標每秒走 1 個百分點
    const behind = step(50, 60, vt, 0.25) - 50
    const even = step(50, 50, vt, 0.25) - 50
    const ahead = step(60, 50, vt, 0.25) - 60
    expect(Math.abs(behind - 10 * (1 - Math.exp(-0.25 / 0.75))) < 1e-12).toBe(true)
    expect(Math.abs(even - ((CAP - 50) / 3600) * 0.25) < 1e-12).toBe(true)   // 不另外加目標的移動(verify R2 #3)
    expect(ahead > 0 && ahead < vt * 0.25).toBe(true)
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

describe('長間隔與時間倒退(cc-mods#1 verify R1 #7、#20)', () => {
  test('兩拍之間隔很久(休眠、事件迴圈卡住):每拍的 dt 有上限,顯示值不會超前目標', () => {
    expect(frameDt(1000, 1250)).toBe(0.25)
    expect(frameDt(1000, 121_000)).toBe(0.5)
    expect(frameDt(5000, 1000)).toBe(0)
    // 只靠歷史、每秒 1/6 個百分點的目標:一次 120 秒的空檔之後,顯示值不超過目標太多
    const vt = 100 / 600
    let d = 10
    const tgt = 30
    d = step(d, tgt, vt, frameDt(0, 120_000))
    expect(d <= tgt + vt * 0.5 + 1e-9).toBe(true)
  })

  test('時間倒退:原點不動、最後讀數更新、沒有 NaN;之後的讀數照常算斜率', () => {
    const f = fitAdd(fitAdd(null, 10, 20), 5, 25)
    expect(f.tLast).toBe(10)
    expect(f.pLast).toBe(25)
    expect(Number.isFinite(fitEval(f).level)).toBe(true)
    const g = fitAdd(f, 20, 35)
    expect((fitEval(g).slope ?? 0) > 0).toBe(true)
  })

  test('還要多久(讀數那一支):用最後讀數算;讀數 100% 時不顯示', () => {
    expect(etaFromReading(40, 2)).toBe(30)
    expect(etaFromReading(100, 2)).toBe(null)
    expect(etaFromReading(50, 0)).toBe(null)
  })

  test('落後時只追到目標,不另外加上目標的移動(verify R2 #3:原本 step(0, 1, 10, 0.5) ≈ 5.5)', () => {
    for (const [d, tgt, vt, dt] of [[0, 1, 10, 0.5], [40, 41, 50, 0.5], [10, 60, 2, 0.25], [0, 99.5, 30, 0.5]] as const) {
      const n = step(d, tgt, vt, dt)
      expect(n <= tgt + ((CAP - d) / 3600) * dt + 1e-9).toBe(true)
      expect(n > d).toBe(true)
    }
  })

  test('顯示值的初值:依讀數的那一支取讀數,依時間的那一支不取(verify R2 #4);一律不超過上限', () => {
    expect(seedDisplay(undefined, 42, false)).toBe(42)
    expect(seedDisplay(50, 42, false)).toBe(50)
    expect(seedDisplay(undefined, 100, true)).toBe(0)
    expect(seedDisplay(12, 100, true)).toBe(12)
    expect(seedDisplay(undefined, 100, false)).toBe(CAP)
    expect(seedDisplay(undefined, null, false)).toBe(0)
  })

  test('MAX_LEAD 有匯出,測試的上界跟著它', () => {
    expect(MAX_LEAD > 0).toBe(true)
  })
})

describe('歷史(每次跑完一個 store 鍵,不覆寫)', () => {
  test('中位數', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([])).toBe(null)
  })

  test('指令字串的雜湊:16 位十六進位;同一字串同一雜湊,差一個空白就不同;不含原字串', () => {
    const a = hashCommand('curl -H "Authorization: Bearer secret" https://x')
    expect(/^[0-9a-f]{16}$/.test(a)).toBe(true)
    expect(hashCommand('curl -H "Authorization: Bearer secret" https://x')).toBe(a)
    expect(hashCommand('curl -H "Authorization: Bearer secret" https://x ')).not.toBe(a)
    expect(a.includes('secret')).toBe(false)
  })

  test('每次跑完一個鍵:鍵裡有雜湊與時間,讀得回來;別的字串不是歷史的鍵', () => {
    const h = hashCommand('make build')
    const k = runKey(h, 1_700_000_000_000, 'ab12')
    expect(k).toBe(`h3:${h}:1700000000000:ab12`)
    expect(parseRunKey(k)).toEqual({ hash: h, at: 1_700_000_000_000 })
    expect(parseRunKey('history-1')).toBe(null)
    expect(parseRunKey('h3:zz:1:x')).toBe(null)
  })

  test('彙總:取最近 5 次的中位數;分段只要有一次就記著;值的形狀不對的丟掉', () => {
    const runs = [10, 20, 30, 40, 50, 60].map((ms, i) => ({ at: i, ms, phased: i === 2 }))
    expect(summarize(runs)).toEqual({ prior: 40, phased: true })
    expect(summarize([])).toEqual({ prior: null, phased: false })
    expect(asRun({ ms: 1000, phased: true })).toEqual({ ms: 1000, phased: true })
    expect(asRun({ ms: -1 })).toBe(null)
    expect(asRun('x')).toBe(null)
    expect(asRun({ ms: 5 })?.phased).toBe(false)
  })

  test('過期與淘汰只看鍵名:90 天前的刪;每個指令留最近 5 次;最多 200 個指令', () => {
    const day = 86_400_000
    const now = 200 * day
    const h = hashCommand('a')
    const keys = [runKey(h, now - 91 * day, '0'), runKey(h, now - day, '1'), 'history-1', 'other']
    expect(expiredKeys(keys, now)).toEqual([runKey(h, now - 91 * day, '0')])
    const seven = Array.from({ length: 7 }, (_, i) => runKey(h, now - (10 - i) * day, String(i)))
    expect(evictRunKeys(seven).sort()).toEqual(seven.slice(0, 2).sort())
    const many = Array.from({ length: 203 }, (_, i) => runKey(hashCommand(`c${i}`), i + 1, 'x'))
    expect(evictRunKeys(many).sort()).toEqual(many.slice(0, 3).sort())
    expect(evictRunKeys(many.slice(0, 200))).toEqual([])
  })
})
