import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Pending, Shown, Tracked } from '../types'
import {
  asRun, CAP, capPending, etaFromReading, evictRunKeys, expiredKeys, fitAdd, fitEval, frameDt, hashCommand, HISTORY_PREFIX,
  parseRunKey, rate, runKey, seedDisplay, step, summarize, target, targetByTime, targetRate,
} from './est'
import { bar, elapsed, etaText, expandPath, pct, readProgress, redirectTargets } from './parse'

// 欄位改了就換 shape:舊版存的值會被拒收,不會被讀成錯的形狀(重載之後 $.state 還在)
const tasks = atom({ plugin: 'progress-bar', key: 'tasks' } as const, [] as Tracked[], { shape: 'tasks-4' })
// 每一拍寫一次現在的時間,讓經過時間跟著重畫
const now = atom({ plugin: 'progress-bar', key: 'now' } as const, 0)
// 這個 session 背景任務輸出檔所在的資料夾:從第一個背景 Bash 的結果學到,接上已經在跑的任務時用
const outputDir = atom({ plugin: 'progress-bar', key: 'outputDir' } as const, null as string | null)
// 畫面上的顯示值:顯示時鐘算出來,畫出來的字串變了才寫
const shown = atom({ plugin: 'progress-bar', key: 'shown' } as const, {} as Record<string, Shown>, { shape: 'shown-2' })
// 跑完、還沒寫進歷史的長度:與顯示的任務清單分開,任務收起之後晚到的通知仍找得到(verify R2 #3)
const pending = atom({ plugin: 'progress-bar', key: 'pending' } as const, [] as Pending[], { shape: 'pending-2' })

const POLL_MS = 2000
const POLL_STALE_MS = 3 * POLL_MS      // 輪詢時鐘這麼久沒跑,顯示時鐘或下一個事件就重開它(verify R2 #5)
const DISPLAY_MS = 250                 // 顯示時鐘:只算、不讀檔
const STALE_FRAME_MS = 1000            // 顯示時鐘這麼久沒跑,2 秒的 tick 就重開它(verify R1 #2、#6)
const SPIN_MS = 1000                   // 轉圈每秒一格:轉圈列 shown 每秒最多寫一次(verify R1 #13)
const KEEP_DONE_MS = 15_000            // 結束後再顯示多久
const STALE_MS = 6 * 60 * 60 * 1000    // 沒收到結束通知的任務(與待寫的歷史),最多留多久
const MAX_TASKS = 6
const MAX_TRIES = 3                    // 一次跑完的長度寫不進 store,最多試幾次
const MAX_READ = 4 * 1024 * 1024       // $.fs.read 的上限;更大的檔改用 tail
const DROP = 5                         // 讀數下降超過幾個百分點算新階段
const MIN_RECORD_MS = 2000             // 跑不到這麼久的不寫歷史
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const OUTPUT = /Output is being written to: (\S+?)\.?(?:\s|$)/
const NOTICE = /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g

/** 0.3.0 開發版的歷史鍵(`history-1` 存明文指令字串、`h2:` 讀改寫):session 開始時刪掉(verify R1 #11)。 */
const isLegacyKey = (k: string): boolean => k === 'history-1' || k.startsWith('h2:')

/**
 * 路徑裡能展開的變數:只有這四個(封閉列舉)。`$.env.get` 只收字面的變數名,引擎才列得出 mod 讀了哪些變數;
 * 用到其他變數的路徑展不開,就不讀。
 */
async function knownEnv($: EngineInterface): Promise<Record<string, string | undefined>> {
  return {
    HOME: await $.env.get('HOME'),
    TMPDIR: await $.env.get('TMPDIR'),
    CLAUDE_JOB_DIR: await $.env.get('CLAUDE_JOB_DIR'),
    PWD: await $.env.get('PWD'),
  }
}

/** 這個背景指令要讀哪些檔:指令自己寫到的絕對路徑優先,任務的輸出檔放最後。 */
async function filesOf($: EngineInterface, command: string, output: string | undefined): Promise<string[]> {
  const raws = redirectTargets(command)
  const env = raws.length > 0 ? await knownEnv($) : {}
  const paths = raws.map(r => expandPath(r, env)).filter((p): p is string => p !== undefined)
  return [...new Set([...paths, ...(output === undefined ? [] : [output])])]
}

async function readTail($: EngineInterface, path: string, size: number): Promise<string | undefined> {
  if (size <= MAX_READ) return $.fs.read(path).catch(() => undefined)
  const r = await $.process.run(['tail', '-c', '8192', path]).catch(() => undefined)
  return r?.exitCode === 0 ? r.stdout : undefined
}

// ── 歷史:每次跑完一個 store 鍵 `h3:<指令字串的雜湊>:<時間>:<隨機>`(不存原字串、不讀改寫) ──

/** 這個指令過去幾次跑完的長度中位數,以及會不會分段;沒有歷史是 `{ prior: null }`。 */
async function loadPrior($: EngineInterface, key: string, t: number): Promise<{ prior: number | null; phased: boolean }> {
  if (key === '') return { prior: null, phased: false }
  const mine = (await $.store.keys().catch(() => [] as string[])).filter(k => k.startsWith(`${HISTORY_PREFIX}${key}:`))
  const stale = new Set(expiredKeys(mine, t))
  const runs: { ms: number; phased: boolean; at: number }[] = []
  for (const k of mine) {
    const at = parseRunKey(k)?.at
    if (at === undefined || stale.has(k)) continue
    const r = asRun(await $.store.get(k).catch(() => undefined))
    if (r !== null) runs.push({ ...r, at })
  }
  return summarize(runs)
}

const nonce = (): string => Math.floor(Math.random() * 36 ** 6).toString(36)

/**
 * 刪掉不該留的歷史鍵:0.3.0 開發版的鍵、90 天前寫的(verify R2 #10)、超過每個指令 5 次 / 200 個指令的。
 * session 開始時、每次寫入之後、寫入失敗時都跑一次 —— store 滿了寫不進去時,要先騰出空間(verify R3 #4)。
 */
async function pruneHistory($: EngineInterface, t: number): Promise<void> {
  const keys = await $.store.keys()
  const doomed = new Set([...keys.filter(isLegacyKey), ...expiredKeys(keys, t), ...evictRunKeys(keys)])
  for (const k of doomed) await $.store.delete(k).catch(() => undefined)
}

/**
 * 寫一次跑完的長度到這一筆自己的鍵(`p.store`,建這一筆時就決定):重試與熱重載都寫同一個鍵,不會記成兩次(verify R3 #6)。
 * 寫不進去時先清一次再試;還是不行就往外丟,讓呼叫端下一次 tick 再試。寫入之後的淘汰失敗不影響這一次。
 */
async function saveRun($: EngineInterface, p: Pending, t: number): Promise<void> {
  const value = { ms: p.ms, phased: p.phased }
  try {
    await $.store.set(p.store, value)
  } catch {
    await pruneHistory($, t).catch(() => undefined)
    await $.store.set(p.store, value)
  }
  await pruneHistory($, t).catch(() => undefined)
}

/** 跑完的長度能不能記:開始時間是真的、是 shell(有雜湊)、跑了至少 2 秒。 */
const recordable = (x: Tracked, end: number): boolean => x.startKnown && x.key !== '' && end - x.startedAt >= MIN_RECORD_MS

const pendingOf = (x: Tracked, end: number, status: string | null): Pending =>
  ({ id: x.id, key: x.key, ms: end - x.startedAt, phased: x.phased, status, at: end, tries: 0, store: runKey(x.key, end, nonce()) })

const saved = new Set<string>()        // 這個模組寫過的任務 id:重複的通知、交錯的兩次寫入都不再寫一次
const recording = new Set<string>()    // 正在寫的

/**
 * 把收到 completed 通知的那幾筆寫進歷史。寫入成功才從待寫的清單拿掉;失敗的下一次 tick 再試,
 * 試了 MAX_TRIES 次都失敗就放棄,並提示一次(不含指令內容,verify R2 #11)。failed、killed 不記;
 * 推定結束之後 6 小時都沒等到通知的丟掉。
 */
async function flushHistory($: EngineInterface, t: number): Promise<void> {
  const list = await read($, pending)
  if (list.length === 0) return
  const result = new Map<string, boolean>()
  for (const p of list) {
    if (p.status !== 'completed' || saved.has(p.id) || recording.has(p.id)) continue
    recording.add(p.id)
    try {
      await saveRun($, p, t)
      saved.add(p.id)
      result.set(p.id, true)
    } catch {
      result.set(p.id, false)
    }
  }
  const gaveUp = list.filter(p => result.get(p.id) === false && p.tries + 1 >= MAX_TRIES).length
  try {
    await update($, pending, latest => latest.flatMap(p => {
      if (saved.has(p.id)) return []
      if (p.status !== null && p.status !== 'completed') return []
      if (p.status === null && t - p.at > STALE_MS) return []
      if (result.get(p.id) === false) return p.tries + 1 >= MAX_TRIES ? [] : [{ ...p, tries: p.tries + 1 }]
      return [p]
    }))
  } finally {
    // 待寫清單寫不回去也要放掉:不然這幾筆以後永遠被當成「正在寫」,再也不重試(verify R3 #5)
    for (const id of result.keys()) recording.delete(id)
  }
  if (saved.size > 200) for (const id of [...saved].slice(0, saved.size - 200)) saved.delete(id)
  if (gaveUp > 0) {
    try {
      $.ui.toast(`progress-bar:${gaveUp} 次跑完的長度寫不進歷史(試了 ${MAX_TRIES} 次)`)
    } catch {
      // 提示不了就算了
    }
  }
}

/** 收到新讀數:更新速率估計。下降超過 DROP 是新階段:統計量重來,速率帶過去。 */
function addReading(x: Tracked, t: number, p: number): Pick<Tracked, 'fit' | 'phased' | 'phase'> {
  const ts = Math.max(0, (t - x.startedAt) / 1000)
  if (x.fit === null) {
    // 開始時間是真的:(開始, 0%) 當第一個點,第一個讀數一到就有斜率
    const seed = x.startKnown && p > 0 && ts > 0 ? fitAdd(null, 0, 0) : null
    return { fit: fitAdd(seed, ts, p), phased: x.phased, phase: x.phase }
  }
  if (p < x.fit.pLast - DROP) {
    const slope = fitEval(x.fit).slope
    const carry = slope !== null && slope > 0 ? slope : x.fit.carry
    return { fit: { ...fitAdd(null, ts, p), carry }, phased: true, phase: x.phase + 1 }
  }
  return { fit: fitAdd(x.fit, ts, p), phased: x.phased, phase: x.phase }
}

/** 依經過時間畫:有歷史、開始時間已知,而且沒有讀數、或這一次分段了、或歷史記著這個指令會分段(verify R1 #5、#8)。 */
function byTime(x: Tracked): boolean {
  return x.prior !== null && x.prior > 0 && x.startKnown && (x.fit === null || x.phased || x.priorPhased)
}

type Estimate = { target: number; speed: number; eta: number | null; note: string | null }

/**
 * 這一刻的目標值、目標的速度、還要幾秒與這一段的說明;null = 沒有估計(畫轉圈)。
 *  - 依經過時間(`byTime`):目標 = 經過時間 ÷ 歷史長度。
 *  - 分段了而沒有歷史:長條不退(只剩最低速度),說明寫這一段的真實讀數,不顯示還要多久。
 *  - 其餘:依讀數的速率,讀數少時往歷史收縮。
 */
function estimateNow(x: Tracked, t: number): Estimate | null {
  const elapsedS = Math.max(0, (t - x.startedAt) / 1000)
  const priorS = x.prior !== null && x.prior > 0 ? x.prior / 1000 : null
  const note = x.phased && x.fit !== null ? `第 ${x.phase} 段 ${Math.round(x.fit.pLast)}%` : null
  if (priorS !== null && byTime(x)) {
    const tgt = targetByTime(elapsedS, priorS)
    return { target: tgt, speed: tgt < CAP ? 100 / priorS : 0, eta: priorS - elapsedS, note }
  }
  if (x.fit === null) return null
  if (x.phased) return { target: 0, speed: 0, eta: null, note }
  const ev = fitEval(x.fit)
  const avg = x.startKnown && x.fit.tLast > 0 ? x.fit.pLast / x.fit.tLast : null
  const b = rate(ev, priorS === null ? null : 100 / priorS, avg, x.fit.carry)
  const showEta = b !== null && (ev.nEff >= 2 || priorS !== null)
  return {
    target: target(x.fit, elapsedS, b),
    speed: targetRate(x.fit, elapsedS, b),
    eta: showEta && b !== null ? etaFromReading(x.fit.pLast, b) : null,
    note: null,
  }
}

/** 字串層級的比較鍵:畫出來會一樣就不寫(顯示值到一位小數、還要多久的文字、轉圈的格、這一段的說明)。 */
function keyOf(m: Readonly<Record<string, Shown>>): string {
  return Object.entries(m)
    .map(([id, s]) => `${id}:${s.spin ? `s${s.frame}` : s.d.toFixed(1)}:${s.eta === null ? '' : etaText(s.eta * 1000)}:${s.note ?? ''}`)
    .sort()
    .join('|')
}

// ── 兩個時鐘:2 秒的輪詢(讀檔)與 250 ms 的顯示(只算)。一期被拒會結束整個 interval,所以互相守門,
//    每個事件也看一次;換掉的計時器已經在跑的那一拍,不再改共享的狀態(generation,verify R2 #5、#6) ──

/** 顯示的那一份:每個執行中任務的顯示值(精確值;`spin` = 上一拍畫的是轉圈),畫面上的 `shown` 只在字串變了時才寫。 */
const live = new Map<string, { d: number; at: number; spin: boolean }>()
const mtimes = new Map<string, number>()   // 檔 → 上次讀時的 mtime;重載就從頭讀一次,無妨
let display: Timer | null = null
let displayGen = 0
let lastFrame = 0
let startRequests = 0
let poll: Timer | null = null
let pollGen = 0
let lastTick = 0

function startDisplay($: EngineInterface, t: number): void {
  startRequests += 1
  if (display !== null) return
  const gen = ++displayGen
  lastFrame = t
  display = $.clock.every(DISPLAY_MS, () => {
    void frame($, gen).catch(() => undefined)
  })
}

function stopDisplay(): void {
  display?.cancel()
  display = null
  displayGen += 1
}

function startPoll($: EngineInterface, t: number): void {
  poll?.cancel()
  const gen = ++pollGen
  lastTick = t
  poll = $.clock.every(POLL_MS, () => {
    void tick($, gen).catch(() => undefined)
  })
}

/** 輪詢時鐘不在或太久沒跑:重開。 */
function ensurePoll($: EngineInterface, t: number): void {
  if (poll === null || t - lastTick > POLL_STALE_MS) startPoll($, t)
}

/** 結束那一刻畫面上的顯示值;畫的是轉圈或還沒畫過是 null。 */
function shownD(id: string): number | null {
  const w = live.get(id)
  return w === undefined || w.spin ? null : w.d
}

/** 讀一次每個還在跑(或剛結束)的任務的檔,有變才寫回;重試寫不進的歷史;看顯示時鐘還在不在跑。 */
async function tick($: EngineInterface, gen: number): Promise<void> {
  const t = await $.clock.now()
  if (gen !== pollGen) return
  lastTick = t
  const list = await read($, tasks)
  if (list.length === 0) {
    await flushHistory($, t)
    return
  }
  const patch = new Map<string, Pick<Tracked, 'percent' | 'line' | 'fit' | 'phased' | 'phase' | 'src'>>()
  const drop = new Set<string>()
  // 這一拍讀到的 mtime 先記在這裡,讀數寫回去了才併進 mtimes:讀檔失敗、或這一拍已經被換掉時,下一拍還會再讀(verify R3 #2)
  const seen = new Map<string, number>()
  for (const task of list) {
    const isOver = task.endedAt !== null && t - task.endedAt > KEEP_DONE_MS
    if (isOver || t - task.startedAt > STALE_MS) {
      drop.add(task.id)
      continue
    }
    // 結束之後再讀一兩拍,最後的百分比(常常是 100%)才會畫上去
    if (task.endedAt !== null && t - task.endedAt > 2 * POLL_MS) continue
    let cur: Tracked = task
    for (const f of task.files) {
      const st = await $.fs.stat(f).catch(() => undefined)
      if (st === undefined || st.kind !== 'file' || st.size === 0 || mtimes.get(f) === st.mtimeMs) continue
      const text = await readTail($, f, st.size)
      if (text === undefined) continue
      seen.set(f, st.mtimeMs)
      const r = readProgress(text)
      // 讀數只取一個檔(第一個讀到百分比的):兩個檔交替時不會被當成分段(verify R1 #37)。
      // 同一個百分比再讀到一次不算新讀數(pytest 一整行才印一次百分比,其間檔案照樣在變)
      if (r.percent !== null && (cur.src === null || cur.src === f)) {
        if (r.percent !== cur.percent) cur = { ...cur, ...addReading(cur, t, r.percent), percent: r.percent }
        if (cur.src === null) cur = { ...cur, src: f }
      }
      if (r.line) cur = { ...cur, line: r.line }
    }
    // 比欄位,不比物件身分:沒變就不寫(verify R1 #25)
    if (cur.percent !== task.percent || cur.line !== task.line || cur.fit !== task.fit || cur.phased !== task.phased
      || cur.phase !== task.phase || cur.src !== task.src) {
      patch.set(task.id, { percent: cur.percent, line: cur.line, fit: cur.fit, phased: cur.phased, phase: cur.phase, src: cur.src })
    }
  }
  if (gen !== pollGen) return
  let committed = true
  if (patch.size > 0 || drop.size > 0) {
    committed = false
    // 用最新的清單套改動:這段時間 tool.call 可能剛加進一個任務。套的那一刻再看一次 generation(verify R3 #3)
    await update($, tasks, latest => {
      if (gen !== pollGen) return latest
      committed = true
      return latest.filter(x => !drop.has(x.id)).map(x => (patch.has(x.id) ? { ...x, ...patch.get(x.id) } : x))
    })
  }
  if (!committed || gen !== pollGen) return
  for (const [f, m] of seen) mtimes.set(f, m)
  await update($, now, cur => (gen === pollGen ? Math.max(cur, t) : cur))
  await flushHistory($, t)
  if (gen !== pollGen) return
  // 有執行中的任務,顯示時鐘卻不在或太久沒跑(被取消的競態、某一期被拒):重開(verify R1 #2、#6)
  if (list.some(x => x.endedAt === null && !drop.has(x.id)) && (display === null || t - lastFrame > STALE_FRAME_MS)) {
    stopDisplay()
    startDisplay($, t)
  }
}

/** 顯示時鐘的一拍:只算、不讀檔;順便看輪詢時鐘還在不在跑。沒有執行中的任務就停掉自己。 */
async function frame($: EngineInterface, gen: number): Promise<void> {
  const req0 = startRequests
  const t = await $.clock.now()
  const list = await read($, tasks)
  const prev = await read($, shown)
  if (gen !== displayGen) return
  lastFrame = t
  ensurePoll($, t)
  const running = list.filter(x => x.endedAt === null)
  if (running.length === 0) {
    live.clear()
    if (Object.keys(prev).length > 0) await update($, shown, cur => (gen === displayGen ? {} : cur))
    if (gen !== displayGen) return
    stopDisplay()
    // 這一拍讀到的清單是同一刻的:停之前有人要了時鐘(剛加進任務),就重開(verify R1 #2)
    if (startRequests !== req0) startDisplay($, t)
    return
  }
  const next: Record<string, Shown> = {}
  for (const x of running) {
    const est = estimateNow(x, t)
    const w = live.get(x.id)
    let d: number
    if (est === null) d = w?.d ?? 0
    else if (w !== undefined && !w.spin) d = step(w.d, est.target, est.speed, frameDt(w.at, t))
    else {
      // 這一列第一次畫長條(剛開始、剛從轉圈換成長條、重載之後):從初值起畫 —— 依讀數的畫讀數,
      // 依經過時間的延續畫面上原本的值(verify R1 #12、R2 #4)
      const p = prev[x.id]
      d = seedDisplay(p !== undefined && !p.spin ? p.d : undefined, x.percent, byTime(x))
    }
    live.set(x.id, { d, at: t, spin: est === null })
    const fr = Math.floor(Math.max(0, t - x.startedAt) / SPIN_MS) % SPIN.length
    next[x.id] = { d, frame: est === null ? fr : 0, eta: est?.eta ?? null, spin: est === null, note: est?.note ?? null }
  }
  for (const id of live.keys()) if (!(id in next)) live.delete(id)
  if (keyOf(prev) !== keyOf(next)) await update($, shown, cur => (gen === displayGen ? next : cur))
}

/** 執行中的那一列畫轉圈還是長條;顯示時鐘還沒算過的任務,照 estimateNow 會走的那一支(verify R1 #28)。 */
function isSpin(x: Tracked, s: Shown | undefined): boolean {
  return s === undefined ? x.percent === null && !byTime(x) : s.spin
}

function row(x: Tracked, s: Shown | undefined, t: number, width: number): string {
  const took = elapsed((x.endedAt ?? t) - x.startedAt)
  if (x.endedAt !== null) {
    // 跑完的那一列把長條畫滿再打勾(#2):讀數稀疏時,執行中的長條停在九成多(最多比最後讀數多 MAX_LEAD),
    // 只換成一行文字的話,長條從來沒畫滿,看起來像沒跑完
    if (x.status === 'completed') return `▕${bar(100, width)}▏ ${pct(100)} ✓ ${x.label} · completed · ${took}`
    const mark = x.status === 'failed' || x.status === 'killed' ? '✗' : '·'
    // 結束那一刻不往回掉:寫最後的顯示值(verify R1 #16)
    const last = x.final ?? x.percent
    const p = last === null ? '' : ` ${Math.round(last * 10) / 10}%`
    return `${mark} ${x.label}${p} · ${x.status ?? 'ended'} · ${took}`
  }
  if (isSpin(x, s)) return `${SPIN[(s?.frame ?? 0) % SPIN.length]} ${x.label} · ${took}${x.line ? ` · ${x.line}` : ''}`
  const d = Math.min(s?.d ?? seedDisplay(undefined, x.percent, byTime(x)), CAP)
  const left = s?.eta === null || s?.eta === undefined ? '' : ` · ${etaText(s.eta * 1000)}`
  // 這一段的讀數也放在標籤前:第一次跑的多階段指令,長條停住時它是唯一在動的進度,截斷先截標籤(verify R2 #9)
  const note = s?.note ? ` · ${s.note}` : ''
  // 依經過時間畫的長條(沒有讀數)保留最後一行輸出(verify R1 #14)
  const line = x.percent === null && x.line ? ` · ${x.line}` : ''
  return `▕${bar(d, width)}▏ ${pct(d)}${left}${note}  ${x.label} · ${took}${line}`
}

export const register: Register = on => {
  // 重載時兩個時鐘都在這裡重開;同一個模組再收到一次也先停掉舊的,不會有兩個
  on('session.start', async ($, e, next) => {
    const t = await $.clock.now()
    stopDisplay()
    startPoll($, t)
    startDisplay($, t)                          // 沒有執行中的任務,第一拍就自己停
    void pruneHistory($, t).catch(() => undefined)
    return next(e)
  })

  // 背景跑的 Bash:記下它的 id、指令字串的雜湊與要讀的檔。追蹤失敗不影響指令本身
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const id = ran.result.backgroundTaskId
    if (id === undefined) return ran
    try {
      const output = OUTPUT.exec(ran.text ?? '')?.[1]
      const own = `/${id}.output`
      if (output !== undefined && output.endsWith(own)) {
        const dir = output.slice(0, -own.length)
        await update($, outputDir, () => dir)
      }
      const t0 = await $.clock.now()
      const key = hashCommand(e.command)
      const hist = await loadPrior($, key, t0)
      // 讀不到檔也照樣記下:沒有百分比的任務顯示轉圈(有歷史就依經過時間畫長條)
      const tracked: Tracked = {
        id,
        label: (e.description ?? e.command).replace(/\s+/g, ' ').slice(0, 48),
        key,
        files: await filesOf($, e.command, output),
        src: null,
        startedAt: t0,
        startKnown: true,
        prior: hist.prior,
        priorPhased: hist.phased,
        percent: null,
        fit: null,
        phased: false,
        phase: 1,
        line: '',
        endedAt: null,
        status: null,
        presumed: false,
        final: null,
      }
      await update($, tasks, list => [...list.filter(x => x.id !== id), tracked].slice(-MAX_TASKS))
      ensurePoll($, t0)
      startDisplay($, t0)
    } catch {
      // 只是顯示,記不起來就不畫
    }
    return ran
  }).catch(($, e, next) => next(e))   // 這個 hook 壞了也不擋指令:照原樣跑

  // 每一輪結束:對照引擎列出的背景工作(shell、subagent、workflow、monitor)。
  // (1) 還在跑、但沒被記下的接上(例如 mod 載入之前就開始跑的);只有 shell 讀檔、查歷史,其他種類只轉圈。
  //     接上的這一列沒有開始時間,經過時間從接上的那一刻算,也不寫歷史。
  // (2) 記著、但已經不在清單裡的,推定結束;能記歷史的先放進待寫的清單,等結束通知說它是不是 completed
  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    // next(e) 已經跑過了:之後的錯誤在這裡接住(丟出去的話引擎把這個 hook 記成被跳過;結果照樣是 next(e) 的那一個)
    try {
      ensurePoll($, await $.clock.now())
      if (e.background_tasks === undefined) return r       // 引擎沒給清單:不猜
      const running = e.background_tasks.filter(b => b.status === 'running' || b.status === 'pending')
      const alive = new Set(running.map(b => b.id))
      const list = await read($, tasks)
      const known = new Set(list.map(x => x.id))
      const dir = await read($, outputDir)
      const t = await $.clock.now()
      const picked: Tracked[] = []
      for (const b of running) {
        if (known.has(b.id)) continue
        const isShell = b.type === 'shell'
        const command = isShell ? (b.command ?? '') : ''
        const key = command === '' ? '' : hashCommand(command)
        const hist = await loadPrior($, key, t)
        picked.push({
          id: b.id,
          label: (b.description || b.name || b.agent_type || b.command || b.id).replace(/\s+/g, ' ').slice(0, 48),
          key,
          files: isShell ? await filesOf($, command, dir === null ? undefined : `${dir}/${b.id}.output`) : [],
          src: null,
          startedAt: t,
          startKnown: false,
          prior: hist.prior,
          priorPhased: hist.phased,
          percent: null,
          fit: null,
          phased: false,
          phase: 1,
          line: '',
          endedAt: null,
          status: null,
          presumed: false,
          final: null,
        })
      }
      const gone = list.filter(x => x.endedAt === null && !alive.has(x.id))
      const goneIds = new Set(gone.map(x => x.id))
      if (picked.length > 0 || gone.length > 0) {
        await update($, tasks, latest => [
          ...latest.map(x => (goneIds.has(x.id) && x.endedAt === null
            ? { ...x, endedAt: t, status: x.status ?? 'ended', presumed: true, final: shownD(x.id) }
            : x)),
          ...picked.filter(p => !latest.some(x => x.id === p.id)),
        ].slice(-MAX_TASKS))
      }
      const add = gone.filter(x => recordable(x, t)).map(x => pendingOf(x, t, null))
      if (add.length > 0) {
        await update($, pending, latest => capPending([...latest, ...add.filter(a => !latest.some(p => p.id === a.id))]))
      }
      if (picked.length > 0) startDisplay($, t)
    } catch {
      // 只是顯示,記不起來就算了
    }
    return r
  }).catch(($, e, next) => next(e))   // 壞了也不影響這一輪的結束

  // 背景任務結束的通知:`<task-id>` 與 `<status>`。推定結束的也更正;跑完(completed)、開始時間已知的寫進歷史。
  // 長度取「開始」到「最早得知結束」(推定結束或這個通知):沒有引擎的完成時間,是估計
  on('session.append', async ($, e, next) => {
    const r = await next(e)
    // next(e) 已經跑過了:之後的錯誤在這裡接住(丟出去的話引擎把這個 hook 記成被跳過;這一列照樣只存一次)
    try {
      if (e.message.type !== 'user') return r
      const text = JSON.stringify(e.message)
      if (!text.includes('<task-id>')) return r
      const ends = new Map<string, string>()
      for (const m of text.matchAll(NOTICE)) {
        if (m[1] !== undefined && m[2] !== undefined) ends.set(m[1], m[2])
      }
      if (ends.size === 0) return r
      const t = await $.clock.now()
      const list = await read($, tasks)
      const open = (x: Tracked) => ends.has(x.id) && (x.endedAt === null || x.presumed)
      // 推定結束了的也建:每一輪結束時先寫任務、再寫待寫清單,通知可能剛好插在中間(verify R3 #1)。長度用推定結束的那一刻
      const fresh = list.filter(x => open(x) && recordable(x, x.endedAt ?? t))
        .map(x => pendingOf(x, x.endedAt ?? t, ends.get(x.id) ?? null))
      await update($, tasks, l => l.map(x => (open(x)
        ? { ...x, endedAt: x.endedAt ?? t, status: ends.get(x.id) ?? null, presumed: false, final: x.final ?? shownD(x.id) }
        : x)))
      await update($, pending, latest => capPending([
        ...latest.map(p => (ends.has(p.id) && p.status === null ? { ...p, status: ends.get(p.id) ?? null } : p)),
        ...fresh.filter(f => !latest.some(p => p.id === f.id)),
      ]))
      ensurePoll($, t)
      await flushHistory($, t)
    } catch {
      // 只是顯示,記不起來就算了
    }
    return r
  }).catch(($, e, next) => next(e))   // 壞了也照原樣存這一列

  // 疊在下面的 plugin(或引擎)畫的東西上方,不取代它:同一條 band 上的其他 mod(例如 token-weather)照樣畫得出來
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, tasks)
    if (e.props.hasSurvey || list.length === 0) return next(e)
    const below = await next(e)
    const view = await read($, shown)
    const t = Math.max(await read($, now), ...list.map(x => x.startedAt))
    const width = Math.max(10, Math.min(30, e.props.bodyColumns - 60))
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {below}
        {list.map(x => (
          <Box key={x.id}>
            <Text
              wrap="truncate-end"
              color={x.endedAt === null ? undefined
                : x.status === 'completed' ? 'green' : x.status === 'failed' || x.status === 'killed' ? 'red' : undefined}
              dimColor={(x.endedAt === null && isSpin(x, view[x.id])) || (x.endedAt !== null && x.status === 'ended')}
            >
              {row(x, view[x.id], t, width)}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}
