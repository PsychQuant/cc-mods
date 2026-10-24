/**
 * 進度的估計與顯示控制:全部是純函式,不碰 `$`(cc-mods#1)。
 *
 * 時間一律是「秒,從任務開始(或接上)算起」,速率是「百分點 / 秒」;只有歷史的長度用 ms。
 * 三層:
 *  1. 速率:指數權重的 local linear regression(單邊核,只用過去的讀數),遞迴更新六個統計量。
 *  2. 目標:以最後一個真實讀數為錨往前外插,外插會飽和、最多領先一個典型步幅 —— 顯示值不能往回,
 *     寧可落後(追得回來)也不要超前(收不回來)。
 *  3. 控制器:落後時以一階延遲追這一拍結束時的目標,超前時跟著目標的速度、超前越多越慢;
 *     最低速度是剩下距離的 1/3600 每秒 —— 只增不減、不停,但讀數停住時不會一路衝上去。
 */

import type { Fit, Pending } from '../types'

// ── 參數:手感要調只改這裡 ──
export const CAP = 99.5            // 任務結束前的上限(%)
const H_MIN = 15                   // 帶寬下限(秒)
const H_MAX = 300                  // 帶寬上限(秒)
const H_FIRST = 30                 // 讀數間隔還不知道時的帶寬(秒)
const H_GAPS = 3                   // 帶寬 = 3 × 讀數間隔
const PRIOR_WEIGHT = 2             // 歷史速率的先驗強度(相當於幾個讀數)
const FLOOR_FRAC = 0.2             // 速率下限 = 0.2 × 平均速率
const GAIN = 3                     // 增益尺度(百分點):超前 3 點,速度 ×1/e
const CREEP_S = 3600               // 最低速度 = (CAP − d) / 3600 每秒
const CATCH_S = 0.75               // 落後時追趕的時間常數(秒)
const SNAP = 0.05                  // 差不到這麼多就直接貼上目標(百分點)
const TAU_MIN = 5                  // 外插飽和的時間常數下限(秒)
export const MAX_LEAD = 10         // 領先最後讀數最多幾個百分點
const EW = 0.3                     // 讀數間隔、步幅的 EW 平均係數
const MAX_RUNS = 5                 // 每個指令留幾次的長度
const MAX_COMMANDS = 200           // 最多記幾個指令
const MAX_PENDING = 20             // 跑完、還沒寫進歷史的最多留幾筆
const MAX_AGE_MS = 90 * 86_400_000 // 90 天前的歷史刪掉
const MAX_DT_S = 0.5               // 每拍的 dt 上限(秒):兩拍隔很久時只會落後,不會超前(verify R1 #7)

// 指數權重 local linear 的狀態放在 state 裡,型別由 contract 定義;原點放在最後一個讀數(`tLast`),所以 `s1` ≤ 0。
export type { Fit }

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
  const tt = Math.max(t, fit.tLast)       // 時間倒退:原點不動(verify R1 #20)
  const dt = tt - fit.tLast
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
    tLast: tt,
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
  const { ext, lead } = extrapolation(fit, t, b)
  return Math.min(fit.pLast + Math.min(ext, lead), CAP)
}

/** 目標值每秒走幾個百分點:外插還沒到領先上限(與 `CAP`)時是 `b·e^{−Δ/τ}`,到了就是 0。 */
export function targetRate(fit: Fit, t: number, b: number | null): number {
  const { ext, lead, decay } = extrapolation(fit, t, b)
  if (b === null || ext >= lead || fit.pLast + ext >= CAP) return 0
  return b * decay
}

function extrapolation(fit: Fit, t: number, b: number | null): { ext: number; lead: number; decay: number } {
  const dt = Math.max(0, t - fit.tLast)
  const tau = Math.max(TAU_MIN, 2 * (fit.gap ?? H_FIRST / 2))
  const decay = Math.exp(-dt / tau)
  return { ext: b === null ? 0 : b * tau * (1 - decay), lead: Math.min(fit.step ?? MAX_LEAD, MAX_LEAD), decay }
}

/** 只有歷史、沒有讀數時的目標:經過時間 ÷ 歷史長度。 */
export function targetByTime(elapsed: number, total: number): number {
  return Math.min(CAP, (100 * elapsed) / total)
}

/**
 * 控制器的一步:顯示值 `d` 經過 `dt` 秒之後;`tgt` 是這一拍結束時的目標,`vt` 是目標的速度(百分點 / 秒)。
 * 只增不減、不超過 `CAP`(輸入先夾進 [0, CAP])。
 *  - 落後:補上差距的 `1 − e^{−dt/CATCH_S}`(一階延遲,差一點點就直接貼上)。`tgt` 已經含這一拍目標的移動,
 *    不另外加 `vt·dt` —— 否則高速率、小差距時一拍就越過目標(verify R2 #3:原本 step(0, 1, 10, 0.5) ≈ 5.5)。
 *    目標以等速前進時,顯示值落後約 `vt · CATCH_S`。
 *  - 剛好在目標上:不動(只剩最低速度)—— 下一拍目標往前了,就回到落後那一支。
 *  - 超前:目標的速度乘上 `e^{g/GAIN}`,超前越多越慢(目標往回跳到新讀數之後,顯示值不凍住)。
 *  - 最低速度 `(CAP − d) / CREEP_S`:不停,但讀數停住十分鐘,50% 附近只會多走約 8 個百分點;只有這一項會越過目標,
 *    每拍最多 `(CAP − d) · dt / CREEP_S`。
 */
export function step(d: number, tgt: number, vt: number, dt: number): number {
  const cur = clamp(d, 0, CAP)
  const g = tgt - cur
  let next = g > 0 ? cur + g * (1 - Math.exp(-dt / CATCH_S))
    : g < 0 ? cur + vt * Math.exp(g / GAIN) * dt
    : cur
  if (g > 0 && tgt - next < SNAP) next = tgt
  next = Math.max(next, cur + ((CAP - cur) / CREEP_S) * dt)
  return Math.max(cur, Math.min(CAP, next))
}

/**
 * 顯示值的初值(這個任務的列還沒有長條顯示值時,或剛從轉圈變成長條時):
 *  - 依讀數:上次顯示值與讀數的較大者 —— 剛讀到時畫讀數(verify R1 #12)。
 *  - 依經過時間:只延續上次的顯示值,沒有就從 0 —— 分段指令的讀數是「這一段」的,不能拿來當整體進度(verify R2 #4)。
 * 一律夾進 [0, CAP]。
 */
export function seedDisplay(prev: number | undefined, reading: number | null, timeMode: boolean): number {
  return clamp(timeMode ? (prev ?? 0) : Math.max(prev ?? 0, reading ?? 0), 0, CAP)
}

/** 這一拍的 dt(秒):`fromMs` 到 `toMs`,上限 `MAX_DT_S`、下限 0。 */
export function frameDt(fromMs: number, toMs: number): number {
  return Math.min(MAX_DT_S, Math.max(0, (toMs - fromMs) / 1000))
}

/** 讀數那一支的還要幾秒:從最後讀數到 100%;讀數已到 100% 或速率不是正的就不顯示(verify R1 #9)。 */
export function etaFromReading(pLast: number, b: number): number | null {
  const v = (100 - pLast) / b
  return b > 0 && v > 0 ? v : null
}

// ── 歷史:完全相同的指令字串 → 最近幾次跑完的長度(ms)。store 裡只存字串的雜湊,不存原字串(verify R1 #11)。
//    每次跑完寫一個新鍵 `h3:<雜湊>:<時間>:<隨機>`,值是 `{ms, phased}`:只新增、不讀改寫,同一個指令同時跑完兩次
//    也不會互蓋;過期與淘汰只看鍵名,淘汰只刪「比留下的都舊」的鍵,跟並發的寫入不衝突(verify R2 #1、#2) ──

export const HISTORY_PREFIX = 'h3:'
export type Run = { ms: number; phased: boolean }

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK64 = (1n << 64n) - 1n
const RUN_KEY = /^h3:([0-9a-f]{16}):(\d+):[0-9a-z]+$/

/** 64 位元 FNV-1a(逐個 UTF-16 code unit):同一字串同一雜湊;16 位十六進位。 */
export function hashCommand(command: string): string {
  let h = FNV_OFFSET
  for (let i = 0; i < command.length; i++) {
    h = ((h ^ BigInt(command.charCodeAt(i))) * FNV_PRIME) & MASK64
  }
  return h.toString(16).padStart(16, '0')
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** 一次跑完的鍵。`nonce` 是 [0-9a-z]+,讓同一毫秒跑完的兩次不撞鍵。 */
export function runKey(hash: string, at: number, nonce: string): string {
  return `${HISTORY_PREFIX}${hash}:${at}:${nonce}`
}

/** 歷史的鍵 → 雜湊與時間;不是歷史的鍵(舊版的 `history-1`、`h2:` …)是 null。 */
export function parseRunKey(k: string): { hash: string; at: number } | null {
  const m = RUN_KEY.exec(k)
  return m === null ? null : { hash: m[1]!, at: Number(m[2]) }
}

/** 讀回 store 的值:形狀不對是 null。 */
export function asRun(v: unknown): Run | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const { ms, phased } = v as { ms?: unknown; phased?: unknown }
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? { ms, phased: phased === true } : null
}

/** 一個指令的幾次:最近 5 次長度的中位數;分段只要有一次就記著。 */
export function summarize(runs: readonly (Run & { at: number })[]): { prior: number | null; phased: boolean } {
  const recent = [...runs].sort((a, b) => b.at - a.at).slice(0, MAX_RUNS)
  return { prior: median(recent.map(r => r.ms)), phased: runs.some(r => r.phased) }
}

/** 90 天前寫的歷史鍵:session 開始時刪掉(不只是查詢時忽略,verify R2 #10)。 */
export function expiredKeys(keys: readonly string[], now: number): string[] {
  return keys.filter(k => {
    const r = parseRunKey(k)
    return r !== null && now - r.at > MAX_AGE_MS
  })
}

/** 要淘汰的鍵:每個指令只留最近 5 次;最近一次跑完最晚的 200 個指令以外,整個指令刪掉。 */
export function evictRunKeys(keys: readonly string[], maxRuns = MAX_RUNS, maxCommands = MAX_COMMANDS): string[] {
  const byHash = new Map<string, { k: string; at: number }[]>()
  for (const k of keys) {
    const r = parseRunKey(k)
    if (r === null) continue
    byHash.set(r.hash, [...(byHash.get(r.hash) ?? []), { k, at: r.at }])
  }
  const newestFirst = (a: { k: string; at: number }, b: { k: string; at: number }) => b.at - a.at || (a.k < b.k ? 1 : -1)
  const groups = [...byHash.values()].map(g => [...g].sort(newestFirst))
  const out = groups.flatMap(g => g.slice(maxRuns).map(x => x.k))
  const ranked = [...groups].sort((a, b) => newestFirst(a[0]!, b[0]!))
  return [...out, ...ranked.slice(maxCommands).flatMap(g => g.slice(0, maxRuns).map(x => x.k))]
}

/** 待寫的最多 `max` 筆;超過時先丟沒等到通知的、再丟最舊的 —— 已確認跑完、還沒寫進去的盡量留著(verify R3 #7)。不改動 `list`。 */
export function capPending(list: readonly Pending[], max = MAX_PENDING): Pending[] {
  if (list.length <= max) return [...list]
  const order = [...list].sort((a, b) => Number(a.status !== null) - Number(b.status !== null) || a.at - b.at)
  const out = new Set(order.slice(0, list.length - max).map(p => p.id))
  return list.filter(p => !out.has(p.id))
}
