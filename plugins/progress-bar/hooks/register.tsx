import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Shown, Tracked } from '../types'
import { asHistory, CAP, eta, fitAdd, fitEval, lookup, rate, record, step, target, targetByTime, targetRate } from './est'
import type { History } from './est'
import { bar, elapsed, etaText, expandPath, pct, readProgress, redirectTargets } from './parse'

// 欄位改了就換 shape:舊版存的值會被拒收,不會被讀成錯的形狀(重載之後 $.state 還在)
const tasks = atom({ plugin: 'progress-bar', key: 'tasks' } as const, [] as Tracked[], { shape: 'tasks-2' })
// 每一拍寫一次現在的時間,讓經過時間跟著重畫
const now = atom({ plugin: 'progress-bar', key: 'now' } as const, 0)
// 這個 session 背景任務輸出檔所在的資料夾:從第一個背景 Bash 的結果學到,接上已經在跑的任務時用
const outputDir = atom({ plugin: 'progress-bar', key: 'outputDir' } as const, null as string | null)
// 畫面上的顯示值:顯示時鐘算出來,畫出來的字串變了才寫
const shown = atom({ plugin: 'progress-bar', key: 'shown' } as const, {} as Record<string, Shown>, { shape: 'shown-1' })

const POLL_MS = 2000
const DISPLAY_MS = 250                 // 顯示時鐘:只算、不讀檔
const KEEP_DONE_MS = 15_000            // 結束後再顯示多久
const STALE_MS = 6 * 60 * 60 * 1000    // 沒收到結束通知的任務,最多留多久
const MAX_TASKS = 6
const MAX_READ = 4 * 1024 * 1024       // $.fs.read 的上限;更大的檔改用 tail
const DROP = 5                         // 讀數下降超過幾個百分點算新階段
const MIN_RECORD_MS = 2000             // 跑不到這麼久的不寫歷史
const HISTORY = 'history-1'            // $.store 的鍵:指令字串 → 最近幾次跑完的長度
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const OUTPUT = /Output is being written to: (\S+?)\.?(?:\s|$)/
const NOTICE = /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g

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

async function loadHistory($: EngineInterface): Promise<History> {
  return asHistory(await $.store.get(HISTORY).catch(() => undefined))
}

/** 收到新讀數:更新速率估計。下降超過 DROP 是新階段:統計量重來,速率帶過去。 */
function addReading(x: Tracked, t: number, p: number): Pick<Tracked, 'fit' | 'phased'> {
  const ts = Math.max(0, (t - x.startedAt) / 1000)
  if (x.fit === null) {
    // 開始時間是真的:(開始, 0%) 當第一個點,第一個讀數一到就有斜率
    const seed = x.startKnown && p > 0 && ts > 0 ? fitAdd(null, 0, 0) : null
    return { fit: fitAdd(seed, ts, p), phased: x.phased }
  }
  if (p < x.fit.pLast - DROP) {
    const slope = fitEval(x.fit).slope
    const carry = slope !== null && slope > 0 ? slope : x.fit.carry
    return { fit: { ...fitAdd(null, ts, p), carry }, phased: true }
  }
  return { fit: fitAdd(x.fit, ts, p), phased: x.phased }
}

type Estimate = { target: number; speed: number; eta: number | null }

/**
 * 這一刻的目標值、目標的速度與還要幾秒;null = 沒有估計(畫轉圈)。
 * 只有歷史(或多階段而有歷史)時依經過時間;有讀數時依讀數的速率,讀數少時往歷史收縮。
 */
function estimateNow(x: Tracked, t: number, d: number): Estimate | null {
  const elapsedS = Math.max(0, (t - x.startedAt) / 1000)
  const priorS = x.prior !== null && x.prior > 0 ? x.prior / 1000 : null
  if (priorS !== null && x.startKnown && (x.fit === null || x.phased)) {
    const tgt = targetByTime(elapsedS, priorS)
    return { target: tgt, speed: tgt < CAP ? 100 / priorS : 0, eta: priorS - elapsedS }
  }
  if (x.fit === null) return null
  const ev = fitEval(x.fit)
  const avg = x.startKnown && !x.phased && x.fit.tLast > 0 ? x.fit.pLast / x.fit.tLast : null
  const b = rate(ev, priorS === null ? null : 100 / priorS, avg, x.fit.carry)
  const showEta = b !== null && (ev.nEff >= 2 || priorS !== null)
  return {
    target: target(x.fit, elapsedS, b),
    speed: targetRate(x.fit, elapsedS, b),
    eta: showEta && b !== null ? eta(d, x.fit.pLast, b) : null,
  }
}

/** 字串層級的比較鍵:畫出來會一樣就不寫(顯示值到一位小數、還要多久的文字、轉圈的格)。 */
function keyOf(m: Readonly<Record<string, Shown>>): string {
  return Object.entries(m)
    .map(([id, s]) => `${id}:${s.spin ? `s${s.frame}` : s.d.toFixed(1)}:${s.eta === null ? '' : etaText(s.eta * 1000)}`)
    .sort()
    .join('|')
}

/** 讀一次每個還在跑(或剛結束)的任務的檔,有變才寫回。 */
async function tick($: EngineInterface, mtimes: Map<string, number>): Promise<void> {
  const list = await read($, tasks)
  if (list.length === 0) return
  const t = await $.clock.now()
  const patch = new Map<string, Pick<Tracked, 'percent' | 'line' | 'fit' | 'phased'>>()
  const drop = new Set<string>()
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
      mtimes.set(f, st.mtimeMs)
      const text = await readTail($, f, st.size)
      if (text === undefined) continue
      const r = readProgress(text)
      // 同一個百分比再讀到一次不算新讀數(pytest 一整行才印一次百分比,其間檔案照樣在變)
      if (r.percent !== null && r.percent !== cur.percent) cur = { ...cur, ...addReading(cur, t, r.percent), percent: r.percent }
      if (r.line) cur = { ...cur, line: r.line }
    }
    if (cur !== task) patch.set(task.id, { percent: cur.percent, line: cur.line, fit: cur.fit, phased: cur.phased })
  }
  if (patch.size > 0 || drop.size > 0) {
    // 用最新的清單套改動:這段時間 tool.call 可能剛加進一個任務
    await update($, tasks, latest =>
      latest.filter(x => !drop.has(x.id)).map(x => (patch.has(x.id) ? { ...x, ...patch.get(x.id) } : x)))
  }
  await update($, now, () => t)
}

/** 顯示的那一份:每個執行中任務的顯示值(精確值),畫面上的 `shown` 只在字串變了時才寫。 */
const live = new Map<string, { d: number; at: number; frame: number }>()
let display: Timer | null = null

/** 顯示時鐘的一拍:只算、不讀檔。沒有執行中的任務就停掉自己。 */
async function frame($: EngineInterface): Promise<void> {
  const list = await read($, tasks)
  const running = list.filter(x => x.endedAt === null)
  const prev = await read($, shown)
  if (running.length === 0) {
    display?.cancel()
    display = null
    live.clear()
    if (Object.keys(prev).length > 0) await update($, shown, () => ({}))
    return
  }
  const t = await $.clock.now()
  const next: Record<string, Shown> = {}
  for (const x of running) {
    const was = live.get(x.id) ?? { d: prev[x.id]?.d ?? 0, at: t, frame: prev[x.id]?.frame ?? 0 }
    const est = estimateNow(x, t, was.d)
    const d = est === null ? was.d : step(was.d, est.target, est.speed, Math.max(0, (t - was.at) / 1000))
    const fr = est === null ? (was.frame + 1) % SPIN.length : was.frame
    live.set(x.id, { d, at: t, frame: fr })
    next[x.id] = { d, frame: fr, eta: est?.eta ?? null, spin: est === null }
  }
  for (const id of live.keys()) if (!(id in next)) live.delete(id)
  if (keyOf(prev) !== keyOf(next)) await update($, shown, () => next)
}

function startDisplay($: EngineInterface): void {
  if (display !== null) return
  display = $.clock.every(DISPLAY_MS, () => {
    void frame($).catch(() => undefined)
  })
}

/** 執行中的那一列畫轉圈還是長條;顯示時鐘還沒算過的任務,有讀數或歷史就從 0 開始畫。 */
function isSpin(x: Tracked, s: Shown | undefined): boolean {
  return s === undefined ? x.percent === null && x.prior === null : s.spin
}

function row(x: Tracked, s: Shown | undefined, t: number, width: number): string {
  const took = elapsed((x.endedAt ?? t) - x.startedAt)
  if (x.endedAt !== null) {
    const mark = x.status === 'completed' ? '✓' : x.status === 'failed' || x.status === 'killed' ? '✗' : '·'
    const p = x.percent === null ? '' : ` ${x.percent}%`
    return `${mark} ${x.label}${p} · ${x.status ?? 'ended'} · ${took}`
  }
  if (isSpin(x, s)) return `${SPIN[(s?.frame ?? 0) % SPIN.length]} ${x.label} · ${took}${x.line ? ` · ${x.line}` : ''}`
  const d = Math.min(s?.d ?? 0, CAP)
  const left = s?.eta === null || s?.eta === undefined ? '' : ` · ${etaText(s.eta * 1000)}`
  return `▕${bar(d, width)}▏ ${pct(d)}  ${x.label} · ${took}${left}`
}

export const register: Register = on => {
  // 重載時兩個時鐘都在 session.start 重開
  on('session.start', async ($, e, next) => {
    const mtimes = new Map<string, number>()   // 檔 → 上次讀時的 mtime;重載就從頭讀一次,無妨
    $.clock.every(POLL_MS, () => {
      void tick($, mtimes).catch(() => undefined)
    })
    display = null                              // 重載取消了舊的計時器
    startDisplay($)                             // 沒有執行中的任務,第一拍就自己停
    return next(e)
  })

  // 背景跑的 Bash:記下它的 id、指令字串與要讀的檔。追蹤失敗不影響指令本身
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
      // 讀不到檔也照樣記下:沒有百分比的任務顯示轉圈(有歷史就依經過時間畫長條)
      const tracked: Tracked = {
        id,
        label: (e.description ?? e.command).replace(/\s+/g, ' ').slice(0, 48),
        command: e.command,
        files: await filesOf($, e.command, output),
        startedAt: await $.clock.now(),
        startKnown: true,
        prior: lookup(await loadHistory($), e.command),
        percent: null,
        fit: null,
        phased: false,
        line: '',
        endedAt: null,
        status: null,
      }
      await update($, tasks, list => [...list.filter(x => x.id !== id), tracked].slice(-MAX_TASKS))
      startDisplay($)
    } catch {
      // 只是顯示,記不起來就不畫
    }
    return ran
  }).catch(($, e, next) => next(e))   // 這個 hook 壞了也不擋指令:照原樣跑

  // 每一輪結束:對照引擎列出的背景工作(shell、subagent、workflow、monitor)。
  // (1) 還在跑、但沒被記下的接上(例如 mod 載入之前就開始跑的);只有 shell 讀檔、查歷史,其他種類只轉圈。
  //     接上的這一列沒有開始時間,經過時間從接上的那一刻算,也不寫歷史。
  // (2) 記著、但已經不在清單裡的,當作結束(沒有結束通知的種類也收得起來)
  on('classic.Stop', async ($, e, next) => {
    const r = await next(e)
    if (e.background_tasks === undefined) return r       // 引擎沒給清單:不猜
    const running = e.background_tasks.filter(b => b.status === 'running' || b.status === 'pending')
    const alive = new Set(running.map(b => b.id))
    const list = await read($, tasks)
    const known = new Set(list.map(x => x.id))
    const dir = await read($, outputDir)
    const t = await $.clock.now()
    const picked: Tracked[] = []
    let hist: History | null = null
    for (const b of running) {
      if (known.has(b.id)) continue
      const isShell = b.type === 'shell'
      const command = isShell ? (b.command ?? '') : ''
      if (command !== '' && hist === null) hist = await loadHistory($)
      picked.push({
        id: b.id,
        label: (b.description || b.name || b.agent_type || b.command || b.id).replace(/\s+/g, ' ').slice(0, 48),
        command,
        files: isShell ? await filesOf($, command, dir === null ? undefined : `${dir}/${b.id}.output`) : [],
        startedAt: t,
        startKnown: false,
        prior: command !== '' && hist !== null ? lookup(hist, command) : null,
        percent: null,
        fit: null,
        phased: false,
        line: '',
        endedAt: null,
        status: null,
      })
    }
    const gone = new Set(list.filter(x => x.endedAt === null && !alive.has(x.id)).map(x => x.id))
    if (picked.length > 0 || gone.size > 0) {
      await update($, tasks, latest => [
        ...latest.map(x => (gone.has(x.id) && x.endedAt === null ? { ...x, endedAt: t, status: x.status ?? 'ended' } : x)),
        ...picked.filter(p => !latest.some(x => x.id === p.id)),
      ].slice(-MAX_TASKS))
    }
    if (picked.length > 0) startDisplay($)
    return r
  }).catch(($, e, next) => next(e))   // 壞了也不影響這一輪的結束

  // 背景任務結束的通知:`<task-id>` 與 `<status>`。跑完(completed)、開始時間已知的寫進歷史
  on('session.append', async ($, e, next) => {
    const r = await next(e)
    if (e.message.type !== 'user') return r
    const text = JSON.stringify(e.message)
    if (!text.includes('<task-id>')) return r
    const ends = new Map<string, string>()
    for (const m of text.matchAll(NOTICE)) {
      if (m[1] !== undefined && m[2] !== undefined) ends.set(m[1], m[2])
    }
    if (ends.size > 0) {
      const t = await $.clock.now()
      const done = (await read($, tasks)).filter(x =>
        x.endedAt === null && ends.get(x.id) === 'completed' && x.startKnown && x.command !== '' && t - x.startedAt >= MIN_RECORD_MS)
      await update($, tasks, list =>
        list.map(x => (ends.has(x.id) && x.endedAt === null ? { ...x, endedAt: t, status: ends.get(x.id) ?? null } : x)))
      if (done.length > 0) {
        let h = await loadHistory($)
        for (const x of done) h = record(h, x.command, t - x.startedAt, t)
        await $.store.set(HISTORY, h).catch(() => undefined)
      }
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
