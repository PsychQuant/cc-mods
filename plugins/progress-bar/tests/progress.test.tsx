import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { hashCommand, MAX_LEAD } from '../hooks/est'
import { bar, elapsed, etaText, expandPath, pct, readProgress, redirectTargets } from '../hooks/parse'

describe('readProgress', () => {
  test('最後一個百分比;pytest 的 [ NN%] 也算', () => {
    const log = 'tests/a.py ....  [ 12%]\ntests/b.py ....  [ 29%]\n'
    expect(readProgress(log)).toEqual({ percent: 29, line: 'tests/b.py ....  [ 29%]' })
  })

  test('\\r 原地重畫的進度列取最後一格,顏色碼拿掉', () => {
    const log = 'Downloading  10%\r\x1b[32mDownloading  55%\x1b[0m\r'
    expect(readProgress(log)).toEqual({ percent: 55, line: 'Downloading  55%' })
  })

  test('大於 100 的數不算;沒有百分比就只有最後一行', () => {
    expect(readProgress('zoom 150%\nbuilding\n').percent).toBe(null)
    expect(readProgress('step one\nstep two\n')).toEqual({ percent: null, line: 'step two' })
  })
})

describe('redirectTargets / expandPath', () => {
  test('> >> tee 的目標;2>&1 與 /dev/null 不算', () => {
    const cmd = 'pytest -q > $CLAUDE_JOB_DIR/tmp/a.log 2>&1; make >> "/tmp/b c.log"; ls | tee -a ~/x.log >/dev/null'
    expect(redirectTargets(cmd)).toEqual(['$CLAUDE_JOB_DIR/tmp/a.log', '/tmp/b c.log', '~/x.log'])
  })

  test('只展開給了值的變數與開頭的 ~;相對路徑不讀', () => {
    const env = { HOME: '/Users/me', CLAUDE_JOB_DIR: '/jobs/1' }
    expect(expandPath('$CLAUDE_JOB_DIR/tmp/a.log', env)).toBe('/jobs/1/tmp/a.log')
    expect(expandPath('${HOME}/x.log', env)).toBe('/Users/me/x.log')
    expect(expandPath('~/x.log', env)).toBe('/Users/me/x.log')
    expect(expandPath('$OTHER/x.log', env)).toBe(undefined)
    expect(expandPath('build/x.log', env)).toBe(undefined)
  })
})

test('bar 與 elapsed', () => {
  expect(bar(50, 10)).toBe('█████░░░░░')
  expect(bar(0, 4)).toBe('░░░░')
  expect(bar(100, 4)).toBe('████')
  expect(elapsed(45_000)).toBe('45s')
  expect(elapsed(12 * 60_000)).toBe('12m')
  expect(elapsed(65 * 60_000)).toBe('1h05m')
})

test('長條用八分之一格;百分比一位小數;還要多久', () => {
  expect(bar(55, 10)).toBe('█████▌░░░░')
  expect(bar(51.25, 10)).toBe('█████▏░░░░')
  expect(bar(99.9, 10)).toBe('█████████▉')
  expect(bar(55, 10).length).toBe(10)
  expect(pct(0)).toBe('  0.0%')
  expect(pct(42.04)).toBe(' 42.0%')
  expect(pct(100)).toBe('100.0%')
  expect(etaText(42_000)).toBe('還要 42s')
  expect(etaText(59_400)).toBe('還要 60s')
  expect(etaText(3.4 * 60_000)).toBe('還要約 3m')
  expect(etaText(65 * 60_000)).toBe('還要約 1h05m')
  expect(etaText(0)).toBe('比平常久')
  expect(etaText(-5000)).toBe('比平常久')
})

const BAND = {
  plugin: 'progress-bar',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

/** 引擎自己的畫面:mod 沒東西畫、交給 next(e) 時由這裡接 */
const engineDraws = (on: On) =>
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

const OUTPUT = '/tmp/tasks/b1.output'
const LOG = '/jobs/1/tmp/pytest.log'

/** 一列畫出來的百分比(一位小數);沒有就是 NaN */
const shownPct = (text: string): number => Number(/(\d+\.\d)%/.exec(text)?.[1] ?? NaN)
const SPINNER = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /

test('背景 Bash 的進度畫在提示列上方,結束後打勾、15 秒後收起', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  engineDraws(on)
  mock.env(on, { HOME: '/Users/me', CLAUDE_JOB_DIR: '/jobs/1' })
  let log = 'collecting ...\n'
  let mtime = 1
  on('fs.stat', (_, e) =>
    e.path === LOG || e.path === OUTPUT
      ? { value: { kind: 'file', size: e.path === LOG ? log.length : 0, mtimeMs: mtime, isLink: false } }
      : { value: { kind: 'other', size: 0, mtimeMs: 0, isLink: false } })
  on('fs.read', (_, e) => ({ value: e.path === LOG ? log : '' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' },
    text: `Command running in background with ID: b1. Output is being written to: ${OUTPUT}. You will be notified when it completes.`,
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'Bash',
    command: 'pytest -q > $CLAUDE_JOB_DIR/tmp/pytest.log 2>&1',
    description: 'Run full pytest suite',
    run_in_background: true,
  })

  log += 'tests/a.py ....  [ 42%]\n'
  mtime = 2
  await clock.advance(2000)
  await clock.advance(3000)    // 顯示值追上讀數(顯示時鐘每 250 ms 一拍)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const text = (await ui.find({ type: 'Text', text: /Run full pytest suite/ }))?.text ?? ''
    // 追上了讀數,最多再領先一個典型步幅(上限 10 個百分點)
    expect(shownPct(text) >= 42 && shownPct(text) <= 42 + MAX_LEAD + 0.5).toBe(true)
    expect(text).toContain('█')
    // 疊在下面的東西照樣畫(同一條 band 上的其他 mod 不被蓋掉)
    expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    await ui.unmount()
  }

  // 結束通知:一列 user row,內文帶 <task-id> 與 <status>
  await $.session.append({
    message: {
      type: 'user',
      role: 'user',
      isMeta: true,
      content: [{ type: 'text', text: '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>' }],
    },
    door: 'main',
    origin: { kind: 'task-notification' },
    uuid: 'u1',
  } as never)
  {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const text = (await ui.find({ type: 'Text', text: /Run full pytest suite/ }))?.text ?? ''
    expect(text).toContain('✓')
    expect(text).toContain('completed')
    expect(text).toContain('100%')          // 結束那一刻不往回掉(verify R1 #16)
    await ui.unmount()
  }

  await clock.advance(20_000)
  {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Run full pytest suite/ })).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    await ui.unmount()
  }
})

test('不是背景跑的 Bash 不畫', async ($, on) => {
  mock.clock(on)
  engineDraws(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ls > /tmp/x.log' })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /ls/ })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})

const fileStat = (size: number, mtimeMs: number) => ({ value: { kind: 'file', size, mtimeMs, isLink: false } }) as const
const noFile = { value: { kind: 'other', size: 0, mtimeMs: 0, isLink: false } } as const

test('已經在跑的背景 shell:每一輪結束時接上,讀它重導向的檔', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000_000 })
  engineDraws(on)
  mock.env(on, { HOME: '/Users/me', CLAUDE_JOB_DIR: '/jobs/1' })
  const log = 'tests/a.py ....  [ 63%]\n'
  on('fs.stat', (_, e) => (e.path === LOG ? fileStat(log.length, 7) : noFile))
  on('fs.read', (_, e) => ({ value: e.path === LOG ? log : '' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.Stop', () => ({}))   // 引擎這一端:沒有任何決定
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [
      { id: 'b9', type: 'shell', status: 'running', description: 'Old pytest run', command: 'pytest -q > $CLAUDE_JOB_DIR/tmp/pytest.log 2>&1' },
      { id: 'a1', type: 'subagent', status: 'running', description: 'Some agent' },
    ],
  })
  await clock.advance(2000)
  await clock.advance(6000)    // 顯示值追上讀數

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // 接上的任務沒有開始時間、只有一個讀數:追到讀數就停在那裡(不往前猜)
  const old = (await ui.find({ type: 'Text', text: /Old pytest run/ }))?.text ?? ''
  expect(Math.abs(shownPct(old) - 63) < 0.6).toBe(true)
  // 不是 shell 的背景工作也顯示一列:轉圈、名字與經過時間,沒有長條
  const agent = (await ui.find({ type: 'Text', text: /Some agent/ }))?.text ?? ''
  expect(SPINNER.test(agent) && agent.includes('Some agent')).toBe(true)
  expect(agent.includes('▕')).toBe(false)
  await ui.unmount()

  // 下一輪結束時清單裡沒有了:當作結束(沒有結束通知也收得起來),15 秒後收起
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  const done = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await done.find({ type: 'Text', text: /Some agent/ }))?.text ?? '').toContain('ended')
  await done.unmount()
  await clock.advance(20_000)
  const gone = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await gone.find({ type: 'Text', text: /Some agent/ })).toBe(undefined)
  await gone.unmount()
})

test('沒有重導向的 shell:從學到的輸出資料夾讀 <id>.output', async ($, on) => {
  const clock = mock.clock(on, { now: 9_000_000 })
  engineDraws(on)
  const dir = '/tmp/claude-9/proj/sess/tasks'
  const out = 'Downloading  37%\r'
  on('fs.stat', (_, e) => (e.path === `${dir}/b7.output` ? fileStat(out.length, 3) : noFile))
  on('fs.read', (_, e) => ({ value: e.path === `${dir}/b7.output` ? out : '' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.Stop', () => ({}))
  on('tool.call', () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b6' },
    text: `Command running in background with ID: b6. Output is being written to: ${dir}/b6.output. You will be notified.`,
  }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'sleep 1', run_in_background: true, description: 'Learn dir' })

  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{ id: 'b7', type: 'shell', status: 'running', description: 'Download data', command: 'curl -O https://example.com/data.zip' }],
  })
  await clock.advance(2000)
  await clock.advance(6000)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const text = (await ui.find({ type: 'Text', text: /Download data/ }))?.text ?? ''
  expect(Math.abs(shownPct(text) - 37) < 0.6).toBe(true)
  await ui.unmount()
})

const ended = (id: string, status = 'completed') => ({
  message: {
    type: 'user',
    role: 'user',
    isMeta: true,
    content: [{ type: 'text', text: `<task-notification><task-id>${id}</task-id><status>${status}</status></task-notification>` }],
  },
  door: 'main',
  origin: { kind: 'task-notification' },
  uuid: `u-${id}`,
}) as never

const background = (on: On, id: () => string) =>
  on('tool.call', () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: id() },
    text: `Command running in background with ID: ${id()}. Output is being written to: /tmp/tasks/${id()}.output. You will be notified.`,
  }))

/** 這個 test 自己的 store:看得到 mod 寫了什麼 */
function memoryStore(on: On): Record<string, unknown> {
  const mem: Record<string, unknown> = {}
  on('store.get', (_, e) => ({ value: mem[e.key] }))
  on('store.set', (_, e) => {
    mem[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    delete mem[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(mem) }))
  return mem
}

const rowText = async ($: Engine, label: RegExp): Promise<string> => {
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const text = (await ui.find({ type: 'Text', text: label }))?.text ?? ''
  await ui.unmount()
  return text
}

test('兩次讀數之間百分比照樣往前走,不超過最後讀數加一個步幅', async ($, on) => {
  const clock = mock.clock(on, { now: 2_000_000 })
  engineDraws(on)
  mock.env(on, { HOME: '/Users/me', CLAUDE_JOB_DIR: '/jobs/1' })
  let log = ''
  let mtime = 0
  on('fs.stat', (_, e) => (e.path === LOG ? fileStat(Math.max(1, log.length), mtime) : noFile))
  on('fs.read', (_, e) => ({ value: e.path === LOG ? log : '' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  background(on, () => 'b2')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'pytest -q > $CLAUDE_JOB_DIR/tmp/pytest.log 2>&1', description: 'Steady run', run_in_background: true })

  // 第 10 秒讀到 10%、第 20 秒讀到 20%(每 2 秒讀一次檔)
  await clock.advance(8000)
  log = 'a ....  [ 10%]\n'
  mtime = 1
  await clock.advance(2000)
  await clock.advance(8000)
  log += 'b ....  [ 20%]\n'
  mtime = 2
  await clock.advance(2000)

  await clock.advance(4000)                 // 之後沒有新讀數
  const first = await rowText($, /Steady run/)
  await clock.advance(4000)
  const second = await rowText($, /Steady run/)
  expect(shownPct(first) > 20).toBe(true)
  expect(shownPct(second) > shownPct(first)).toBe(true)
  expect(shownPct(second) <= 30).toBe(true)
  expect(second).toContain('還要')
})

test('跑完的時間記進 store;同一個指令字串下次沒有讀數也有百分比與還要多久', async ($, on) => {
  const clock = mock.clock(on, { now: 3_000_000 })
  engineDraws(on)
  const mem = memoryStore(on)
  on('fs.stat', () => noFile)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let id = 'h1'
  background(on, () => id)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // 第一次:沒有歷史 → 轉圈
  await $.tool.call({ tool: 'Bash', command: 'make build', description: 'Build it', run_in_background: true })
  await clock.advance(1000)
  expect(SPINNER.test(await rowText($, /Build it/))).toBe(true)
  await clock.advance(29_000)
  await $.session.append(ended('h1'))
  const stored = mem[`h2:${hashCommand('make build')}`] as { runs: number[] } | undefined
  expect(stored?.runs).toEqual([30_000])
  expect(JSON.stringify(mem).includes('make build')).toBe(false)   // store 裡不存指令原字串(verify R1 #11)

  // 第二次:同一個指令字串,依經過時間畫長條
  await clock.advance(20_000)               // 第一列收起
  id = 'h2'
  await $.tool.call({ tool: 'Bash', command: 'make build', description: 'Build again', run_in_background: true })
  await clock.advance(15_000)
  const text = await rowText($, /Build again/)
  expect(Math.abs(shownPct(text) - 50) < 3).toBe(true)
  expect(text).toContain('還要 15s')
})

test('沒有百分比也沒有歷史:轉圈隨時鐘前進;任務結束後清空顯示值、顯示時鐘停下', async ($, on) => {
  const clock = mock.clock(on, { now: 4_000_000 })
  engineDraws(on)
  on('fs.stat', () => noFile)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  background(on, () => 's1')
  const writes: unknown[] = []
  on('state.set', ($, e, next) => {
    if (e.plugin === 'progress-bar' && e.key === 'shown') writes.push(e.value)
    return next(e)
  })
  let reads = 0
  let counting = false
  on('state.get', (_, e, next) => {
    if (counting && e.plugin === 'progress-bar' && e.key === 'tasks') reads += 1
    return next(e)
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'sleep 60', description: 'Just wait', run_in_background: true })

  await clock.advance(250)
  const a = (await rowText($, /Just wait/)).slice(0, 1)
  await clock.advance(1000)                   // 轉圈每秒一格
  const b = (await rowText($, /Just wait/)).slice(0, 1)
  expect(SPINNER.test(`${a} `) && SPINNER.test(`${b} `)).toBe(true)
  expect(a === b).toBe(false)

  await $.session.append(ended('s1'))
  await clock.advance(1000)
  // shape 版本的 atom 存成 { shape, value }
  expect((writes.at(-1) as { value?: unknown } | undefined)?.value).toEqual({})
  const count = writes.length
  reads = 0
  counting = true
  await clock.advance(3000)
  expect(writes.length).toBe(count)
  // 顯示時鐘真的停了:3 秒內讀 tasks 的只有 2 秒一次的 tick(時鐘還在的話每 250 ms 一次,verify R1 #26)
  expect(reads <= 3).toBe(true)
})


test('轉圈列每秒最多寫一次 shown(其他 mod 不會跟著每 250 ms 重畫)', async ($, on) => {
  const clock = mock.clock(on, { now: 6_000_000 })
  engineDraws(on)
  on('fs.stat', () => noFile)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  background(on, () => 's2')
  let writes = 0
  on('state.set', ($, e, next) => {
    if (e.plugin === 'progress-bar' && e.key === 'shown') writes += 1
    return next(e)
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'sleep 99', description: 'Spin only', run_in_background: true })
  writes = 0
  await clock.advance(3000)
  expect(writes <= 4).toBe(true)
})

test('停顯示時鐘的那一拍剛好加進新任務:時鐘照樣重開(verify R1 #2、#6)', async ($, on) => {
  const clock = mock.clock(on, { now: 7_000_000 })
  engineDraws(on)
  on('fs.stat', () => noFile)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let id = 'r1'
  background(on, () => id)
  const seen = new Set<string>()
  let armed = false
  on('state.get', async (_, e, next) => {
    if (armed && e.plugin === 'progress-bar' && e.key === 'shown') {
      armed = false                          // 這一拍讀到的清單已經是空的:在它停時鐘之前加進新任務
      id = 'r2'
      await $.tool.call({ tool: 'Bash', command: 'sleep 98', description: 'Late task', run_in_background: true })
    }
    return next(e)
  })
  on('state.set', ($, e, next) => {
    if (e.plugin === 'progress-bar' && e.key === 'shown') {
      const v = (e.value as { value?: Record<string, unknown> } | undefined)?.value ?? {}
      for (const k of Object.keys(v)) seen.add(k)
    }
    return next(e)
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'sleep 97', description: 'First task', run_in_background: true })
  await clock.advance(500)
  await $.session.append(ended('r1'))
  armed = true
  await clock.advance(250)                   // 這一拍沒有執行中的任務 → 停時鐘;停之前 r2 加進來了
  await clock.advance(750)                   // 不到 tick 的 2 秒:只能靠 frame 自己重開
  expect(seen.has('r2')).toBe(true)
})

test('多階段:讀數往回掉後列尾寫這一段的讀數、不顯示還要多久;跑完記下分段,下次一開始就依經過時間', async ($, on) => {
  const clock = mock.clock(on, { now: 8_000_000 })
  engineDraws(on)
  const mem = memoryStore(on)
  mock.env(on, { HOME: '/Users/me', CLAUDE_JOB_DIR: '/jobs/1' })
  let log = ''
  let mtime = 0
  on('fs.stat', (_, e) => (e.path === LOG ? fileStat(Math.max(1, log.length), mtime) : noFile))
  on('fs.read', (_, e) => ({ value: e.path === LOG ? log : '' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let id = 'm1'
  background(on, () => id)
  const cmd = 'git clone x > $CLAUDE_JOB_DIR/tmp/pytest.log 2>&1'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: cmd, description: 'Clone repo', run_in_background: true })
  log = 'Counting objects: 100%\n'
  mtime = 1
  await clock.advance(2000)
  log += 'Receiving objects:  10%\r'
  mtime = 2
  await clock.advance(2000)
  await clock.advance(500)
  const text = await rowText($, /Clone repo/)
  expect(text).toContain('第 2 段 10%')
  expect(text.includes('還要')).toBe(false)
  await clock.advance(20_000)
  await $.session.append(ended('m1'))
  const entry = mem[`h2:${hashCommand(cmd)}`] as { phased?: boolean } | undefined
  expect(entry?.phased).toBe(true)

  // 第二次:同一個指令字串,歷史記著會分段 → 依經過時間畫,不被第一段推到頂
  await clock.advance(20_000)
  id = 'm2'
  log = ''
  mtime = 3
  await $.tool.call({ tool: 'Bash', command: cmd, description: 'Clone again', run_in_background: true })
  log = 'Counting objects: 100%\n'
  mtime = 4
  await clock.advance(4000)
  const again = await rowText($, /Clone again/)
  expect(shownPct(again) < 50).toBe(true)
  expect(again).toContain('還要')
})

test('每一輪結束時先被推定結束、之後才到的 completed 通知:照樣寫進歷史(verify R1 #3、#10)', async ($, on) => {
  const clock = mock.clock(on, { now: 9_500_000 })
  engineDraws(on)
  const mem = memoryStore(on)
  on('fs.stat', () => noFile)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.Stop', () => ({}))
  background(on, () => 'p1')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'make docs', description: 'Docs', run_in_background: true })
  await clock.advance(10_000)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })   // 清單裡沒有了:推定結束
  await clock.advance(3000)
  await $.session.append(ended('p1'))
  const entry = mem[`h2:${hashCommand('make docs')}`] as { runs: number[] } | undefined
  expect(entry?.runs).toEqual([10_000])      // 長度取推定結束那一刻,不是通知到達的那一刻
  expect((await rowText($, /Docs/))).toContain('completed')
})
