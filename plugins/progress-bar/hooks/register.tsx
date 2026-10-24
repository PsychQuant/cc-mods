import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Tracked } from '../types'
import { bar, elapsed, expandPath, readProgress, redirectTargets } from './parse'

// 欄位改了就換 shape:舊版存的值會被拒收,不會被讀成錯的形狀(重載之後 $.state 還在)
const tasks = atom({ plugin: 'progress-bar', key: 'tasks' } as const, [] as Tracked[], { shape: 'tasks-1' })
// 每一拍寫一次現在的時間,讓經過時間跟著重畫
const now = atom({ plugin: 'progress-bar', key: 'now' } as const, 0)

const POLL_MS = 2000
const KEEP_DONE_MS = 15_000            // 結束後再顯示多久
const STALE_MS = 6 * 60 * 60 * 1000    // 沒收到結束通知的任務,最多留多久
const MAX_TASKS = 6
const MAX_READ = 4 * 1024 * 1024       // $.fs.read 的上限;更大的檔改用 tail
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

/** 讀一次每個還在跑(或剛結束)的任務的檔,有變才寫回。 */
async function tick($: EngineInterface, mtimes: Map<string, number>): Promise<void> {
  const list = await read($, tasks)
  if (list.length === 0) return
  const t = await $.clock.now()
  const patch = new Map<string, Pick<Tracked, 'percent' | 'line'>>()
  const drop = new Set<string>()
  for (const task of list) {
    const isOver = task.endedAt !== null && t - task.endedAt > KEEP_DONE_MS
    if (isOver || t - task.startedAt > STALE_MS) {
      drop.add(task.id)
      continue
    }
    // 結束之後再讀一兩拍,最後的百分比(常常是 100%)才會畫上去
    if (task.endedAt !== null && t - task.endedAt > 2 * POLL_MS) continue
    let { percent, line } = task
    for (const f of task.files) {
      const st = await $.fs.stat(f).catch(() => undefined)
      if (st === undefined || st.kind !== 'file' || st.size === 0 || mtimes.get(f) === st.mtimeMs) continue
      mtimes.set(f, st.mtimeMs)
      const text = await readTail($, f, st.size)
      if (text === undefined) continue
      const r = readProgress(text)
      percent = r.percent ?? percent
      line = r.line || line
    }
    if (percent !== task.percent || line !== task.line) patch.set(task.id, { percent, line })
  }
  if (patch.size > 0 || drop.size > 0) {
    // 用最新的清單套改動:這段時間 tool.call 可能剛加進一個任務
    await update($, tasks, latest =>
      latest.filter(x => !drop.has(x.id)).map(x => (patch.has(x.id) ? { ...x, ...patch.get(x.id) } : x)))
  }
  await update($, now, () => t)
}

function row(x: Tracked, t: number, width: number): string {
  const took = elapsed((x.endedAt ?? t) - x.startedAt)
  if (x.endedAt !== null) {
    const mark = x.status === 'completed' ? '✓' : '✗'
    const pct = x.percent === null ? '' : ` ${x.percent}%`
    return `${mark} ${x.label}${pct} · ${x.status ?? 'ended'} · ${took}`
  }
  if (x.percent === null) return `⋯ ${x.label} · ${took}${x.line ? ` · ${x.line}` : ''}`
  return `▕${bar(x.percent, width)}▏ ${String(x.percent).padStart(3)}%  ${x.label} · ${took}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const mtimes = new Map<string, number>()   // 檔 → 上次讀時的 mtime;重載就從頭讀一次,無妨
    $.clock.every(POLL_MS, () => {
      void tick($, mtimes).catch(() => undefined)
    })
    return next(e)
  })

  // 背景跑的 Bash:記下它的 id 與要讀的檔。追蹤失敗不影響指令本身
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const id = ran.result.backgroundTaskId
    if (id === undefined) return ran
    try {
      const output = OUTPUT.exec(ran.text ?? '')?.[1]
      const files = await filesOf($, e.command, output)
      if (files.length > 0) {
        const tracked: Tracked = {
          id,
          label: (e.description ?? e.command).replace(/\s+/g, ' ').slice(0, 48),
          files,
          startedAt: await $.clock.now(),
          percent: null,
          line: '',
          endedAt: null,
          status: null,
        }
        await update($, tasks, list => [...list.filter(x => x.id !== id), tracked].slice(-MAX_TASKS))
      }
    } catch {
      // 只是顯示,記不起來就不畫
    }
    return ran
  }).catch(($, e, next) => next(e))   // 這個 hook 壞了也不擋指令:照原樣跑

  // 背景任務結束的通知:`<task-id>` 與 `<status>`
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
      await update($, tasks, list =>
        list.map(x => (ends.has(x.id) && x.endedAt === null ? { ...x, endedAt: t, status: ends.get(x.id) ?? null } : x)))
    }
    return r
  }).catch(($, e, next) => next(e))   // 壞了也照原樣存這一列

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, tasks)
    if (e.props.hasSurvey || list.length === 0) return next(e)
    const t = Math.max(await read($, now), ...list.map(x => x.startedAt))
    const width = Math.max(10, Math.min(30, e.props.bodyColumns - 60))
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {list.map(x => (
          <Box key={x.id}>
            <Text
              wrap="truncate-end"
              color={x.endedAt === null ? undefined : x.status === 'completed' ? 'green' : 'red'}
              dimColor={x.endedAt === null && x.percent === null}
            >
              {row(x, t, width)}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}
