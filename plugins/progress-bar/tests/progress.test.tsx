import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { bar, elapsed, expandPath, readProgress, redirectTargets } from '../hooks/parse'

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
