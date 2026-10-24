import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

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

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const text = (await ui.find({ type: 'Text', text: /Run full pytest suite/ }))?.text ?? ''
    expect(text).toContain('42%')
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

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Old pytest run/ }))?.text ?? '').toContain('63%')
  // 不是 shell 的背景工作也顯示一列:名字與經過時間,沒有長條
  const agent = (await ui.find({ type: 'Text', text: /Some agent/ }))?.text ?? ''
  expect(agent.startsWith('⋯ Some agent')).toBe(true)
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

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Download data/ }))?.text ?? '').toContain('37%')
  await ui.unmount()
})
