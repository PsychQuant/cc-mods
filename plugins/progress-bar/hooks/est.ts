/**
 * 進度的估計與顯示控制:全部是純函式,不碰 `$`(cc-mods#1)。
 *
 * 時間一律是「秒,從任務開始(或接上)算起」,速率是「百分點 / 秒」;只有歷史的長度用 ms。
 * 三層:
 *  1. 速率:指數權重的 local linear regression(單邊核,只用過去的讀數),遞迴更新六個統計量。
 *  2. 目標:以最後一個真實讀數為錨往前外插,外插會飽和、最多領先一個典型步幅 —— 顯示值不能往回,
 *     寧可落後(追得回來)也不要超前(收不回來)。
 *  3. 控制器:顯示值只增不減;落後時加快、超前時變慢但不停。
 */

// ── 參數:手感要調只改這裡 ──
export const CAP = 99.5            // 任務結束前的上限(%)
const H_MIN = 15                   // 帶寬下限(秒)
const H_MAX = 300                  // 帶寬上限(秒)
const H_FIRST = 30                 // 讀數間隔還不知道時的帶寬(秒)
const H_GAPS = 3                   // 帶寬 = 3 × 讀數間隔
const PRIOR_WEIGHT = 2             // 歷史速率的先驗強度(相當於幾個讀數)
const FLOOR_FRAC = 0.2             // 速率下限 = 0.2 × 平均速率
const GAIN = 3                     // 增益尺度(百分點):差 3 點,速度 ×e
const V_LO = 0.1                   // 超前時速度最少是估計速率的幾倍
const V_HI = 4                     // 落後時(倍率那一項)最多幾倍
const CATCH_S = 0.75               // 落後時追趕的時間常數(秒)
const SNAP = 0.05                  // 差不到這麼多就直接貼上目標(百分點)
const TAU_MIN = 5                  // 外插飽和的時間常數下限(秒)
const MAX_LEAD = 10                // 領先最後讀數最多幾個百分點
const EW = 0.3                     // 讀數間隔、步幅的 EW 平均係數
const MAX_RUNS = 5                 // 每個指令留幾次的長度
const MAX_COMMANDS = 200           // 最多記幾個指令

/** 指數權重 local linear 的狀態。原點放在最後一個讀數(`tLast`),所以 `s1` ≤ 0。 */
export type Fit = {
  s0: number    // Σw
  s1: number    // Σw·t
  s2: number    // Σw·t²
  sy: number    // Σw·p
  sty: number   // Σw·t·p
  sww: number   // Σw²(算有效樣本數)
  tLast: number // 最後一個讀數的時間(秒)
  pLast: number // 最後一個讀數(%)
  gap: number | null  // 讀數間隔的 EW 平均(秒)
  step: number | null // 每次讀數增加量的 EW 平均(百分點)
  carry: number | null // 換階段時從上一段帶過來的速率
}

export type Eval = { level: number; slope: number | null; nEff: number }

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const ewAvg = (prev: number | null, x: number): number => (prev === null ? x : prev + EW * (x - prev))

function bandwidth(gap: number | null): number {
  return gap === null ? H_FIRST : clamp(H_GAPS * gap, H_MIN, H_MAX)
}

/** 加入讀數 `(t, p)`:舊的權重乘上 `e^{−Δt/h}`、原點移到新的點,再加入它(權重 1)。不改動 `fit`。 */
export function fitAdd(fit: Fit | null, t: number, p: number): Fit {
  if (fit === null) {
    return { s0: 1, s1: 0, s2: 0, sy: p, sty: 0, sww: 1, tLast: t, pLast: p, gap: null, step: null, carry: null }
  }
  const dt = Math.max(0, t - fit.tLast)
  const lam = Math.exp(-dt / bandwidth(fit.gap))
  // 衰減,再把原點往後移 dt:t' = t − dt
  const s0 = lam * fit.s0
  const s1 = lam * fit.s1
  const s2 = lam * fit.s2
  const sy = lam * fit.sy
  const sty = lam * fit.sty
  const dp = p - fit.pLast
  return {
    s0: s0 + 1,
    s1: s1 - dt * s0,
    s2: s2 - 2 * dt * s1 + dt * dt * s0,
    sy: sy + p,
    sty: sty - dt * sy,
    sww: lam * lam * fit.sww + 1,
    tLast: t,
    pLast: p,
    gap: dt > 0 ? ewAvg(fit.gap, dt) : fit.gap,
    step: dp > 0 ? ewAvg(fit.step, dp) : fit.step,
    carry: fit.carry,
  }
}

/** 最後一點的水準、斜率(只有一個點、或時間都一樣時是 null)、有效樣本數。 */
export function fitEval(fit: Fit): Eval {
  const denom = fit.s0 * fit.s2 - fit.s1 * fit.s1
  const nEff = (fit.s0 * fit.s0) / fit.sww
  if (!(denom > 1e-12 * fit.s0 * fit.s0)) return { level: fit.sy / fit.s0, slope: null, nEff }
  const slope = (fit.s0 * fit.sty - fit.s1 * fit.sy) / denom
  return { level: (fit.sy - slope * fit.s1) / fit.s0, slope, nEff }
}

/**
 * 現在用的速率(百分點 / 秒):局部斜率往歷史速率收縮;沒有斜率時用歷史、再來用上一段帶過來的;
 * 不低於 `0.2 ×` 平均速率(平均速率、歷史、上一段依序取第一個有的)。都沒有 → null。
 */
export function rate(ev: Eval | null, prior: number | null, avg: number | null, carry: number | null): number | null {
  let b = ev?.slope ?? null
  if (b !== null && prior !== null && ev !== null) b = (ev.nEff * b + PRIOR_WEIGHT * prior) / (ev.nEff + PRIOR_WEIGHT)
  if (b === null) b = prior ?? carry
  if (b === null) return null
  const ref = avg ?? prior ?? carry
  if (ref !== null && ref > 0) b = Math.max(b, FLOOR_FRAC * ref)
  return b > 0 ? b : null
}

/**
 * 時間 `t` 的目標值:最後讀數 + 會飽和的外插 `b·τ·(1 − e^{−Δ/τ})`,`τ = 2 ×` 讀數間隔;
 * 最多領先一個典型步幅(且不超過 `MAX_LEAD`),不超過 `CAP`。讀數該來沒來,外插就平了。
 */
export function target(fit: Fit, t: number, b: number | null): number {
  const dt = Math.max(0, t - fit.tLast)
  const tau = Math.max(TAU_MIN, 2 * (fit.gap ?? H_FIRST / 2))
  const ext = b === null ? 0 : b * tau * (1 - Math.exp(-dt / tau))
  const lead = Math.min(fit.step ?? MAX_LEAD, MAX_LEAD)
  return Math.min(fit.pLast + Math.min(ext, lead), CAP)
}

/** 只有歷史、沒有讀數時的目標:經過時間 ÷ 歷史長度。 */
export function targetByTime(elapsed: number, total: number): number {
  return Math.min(CAP, (100 * elapsed) / total)
}

/**
 * 控制器的一步:顯示值 `d` 經過 `dt` 秒之後。只增不減、不超過 `CAP`。
 * 有速率時以 `b · clamp(e^{g/GAIN}, V_LO, V_HI)` 前進(超前也不停);落後時另有追趕項,
 * 每 `dt` 補上差距的 `1 − e^{−dt/CATCH_S}`,取兩者較快的。沒有速率時只追到目標為止。
 */
export function step(d: number, tgt: number, b: number | null, dt: number): number {
  const g = tgt - d
  let next = d
  if (b !== null) next = d + b * clamp(Math.exp(g / GAIN), V_LO, V_HI) * dt
  if (g > 0) {
    next = Math.max(next, d + g * (1 - Math.exp(-dt / CATCH_S)))
    if (tgt - next < SNAP && tgt - next > 0) next = tgt
  }
  return Math.max(d, Math.min(CAP, next))
}

/** 還要幾秒:從顯示值(或最後讀數,取大的)到 100%。 */
export function eta(shown: number, pLast: number, b: number): number {
  return (100 - Math.max(shown, pLast)) / b
}

// ── 歷史:完全相同的指令字串 → 最近幾次跑完的長度(ms) ──

export type History = Readonly<Record<string, { runs: readonly number[]; at: number }>>

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** 這個指令過去跑完的長度的中位數(ms);沒有就是 null。 */
export function lookup(h: History, command: string): number | null {
  return Object.hasOwn(h, command) ? median(h[command]!.runs) : null
}

/** 記一次跑完的長度。回傳新的物件:每個指令留最近 5 次,超過 200 個指令時丟掉最久沒寫入的。 */
export function record(h: History, command: string, ms: number, now: number): History {
  const prev = Object.hasOwn(h, command) ? h[command]!.runs : []
  const next: Record<string, { runs: readonly number[]; at: number }> = { ...h, [command]: { runs: [...prev, ms].slice(-MAX_RUNS), at: now } }
  const keys = Object.keys(next)
  if (keys.length <= MAX_COMMANDS) return next
  const keep = keys.sort((a, b) => next[b]!.at - next[a]!.at).slice(0, MAX_COMMANDS)
  return Object.fromEntries(keep.map(k => [k, next[k]!]))
}

/** 讀回 store 的值:形狀不對的項目丟掉(store 是舊版或別人寫壞的)。 */
export function asHistory(v: unknown): History {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {}
  const out: Record<string, { runs: readonly number[]; at: number }> = {}
  for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
    if (typeof e !== 'object' || e === null) continue
    const { runs, at } = e as { runs?: unknown; at?: unknown }
    if (!Array.isArray(runs) || typeof at !== 'number') continue
    const ok = runs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0)
    if (ok.length > 0) out[k] = { runs: ok.slice(-MAX_RUNS), at }
  }
  return out
}
