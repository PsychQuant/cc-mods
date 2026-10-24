/** 從一段輸出讀出的進度。 */
export type Reading = { percent: number | null; line: string }

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
// 百分比:`42%`、`42.5 %`、pytest 的 `[ 29%]`;大於 100 的數不算(像 `150%` 的縮放倍率)
const PERCENT = /(\d{1,3}(?:\.\d+)?)\s?%/g
const TAIL = 8192
const LINE_MAX = 120

/**
 * 讀輸出的尾端:最後一個 0–100 的百分比,與最後一個非空行。
 * 進度列常用 `\r` 原地重畫,所以 `\r` 也算換行;顏色碼先拿掉。
 */
export function readProgress(text: string): Reading {
  const tail = text.slice(-TAIL).replace(ANSI, '')
  let percent: number | null = null
  for (const m of tail.matchAll(PERCENT)) {
    const v = Number(m[1])
    if (v <= 100) percent = v
  }
  const lines = tail.split(/\r\n|\r|\n/).map(l => l.trim()).filter(l => l !== '')
  return { percent, line: (lines.at(-1) ?? '').slice(0, LINE_MAX) }
}

// `>` `>>` `1>` `&>` 後面的目標(`2>&1` 這種接到另一個 fd 的不算),以及 `tee [-a]` 的目標
const REDIRECT = /(?:^|[\s;&|(])(?:\d?>>?|&>>?)\s*(?!&)("[^"]+"|'[^']+'|[^\s;&|()<>]+)/g
const TEE = /\btee\s+(?:(?:-a|--append)\s+)?("[^"]+"|'[^']+'|[^\s;&|()<>]+)/g
const VAR = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g

/** 指令裡寫到檔的目標,原樣(變數還沒展開、引號已拿掉)。`/dev/null` 不算。 */
export function redirectTargets(command: string): string[] {
  const out: string[] = []
  for (const rx of [REDIRECT, TEE]) {
    for (const m of command.matchAll(rx)) {
      const target = (m[1] ?? '').replace(/^["']|["']$/g, '')
      if (target !== '' && target !== '/dev/null' && !out.includes(target)) out.push(target)
    }
  }
  return out
}

/**
 * 展開 `$VAR`、`${VAR}` 與開頭的 `~`;展開後是絕對路徑才回傳,否則 undefined
 * (相對路徑要看指令當時的 cwd,`cd` 之後就猜不準,寧可不讀)。
 */
export function expandPath(raw: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
  let missing = false
  let path = raw.replace(VAR, (_m, a: string | undefined, b: string | undefined) => {
    const v = env[a ?? b ?? '']
    if (v === undefined) missing = true
    return v ?? ''
  })
  if (missing) return undefined
  if (path === '~' || path.startsWith('~/')) {
    const home = env.HOME
    if (home === undefined) return undefined
    path = home + path.slice(1)
  }
  return path.startsWith('/') ? path : undefined
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/**
 * `█` 與 `░` 畫的長條,寬 `width` 格;最後一格用八分之一格(`▏`–`▉`),解析度是 `width × 8`。
 * 無條件捨去:只有 100% 才是滿格(執行中的上限 99.5% 不會畫成已經跑完)。
 */
export function bar(percent: number, width = 20): string {
  const units = Math.max(0, Math.min(width * 8, Math.floor((percent / 100) * width * 8 + 1e-9)))
  const full = Math.floor(units / 8)
  const part = EIGHTHS[units % 8] ?? ''
  return '█'.repeat(full) + part + '░'.repeat(width - full - (part === '' ? 0 : 1))
}

/** 百分比,一位小數,寬 6(`  0.0%`–`100.0%`)。 */
export function pct(percent: number): string {
  return `${percent.toFixed(1)}%`.padStart(6)
}

/** 還要多久:一分鐘以內以秒計,以上取到分;0 或負的(跑得比歷史久)寫「比平常久」。 */
export function etaText(ms: number): string {
  if (!(ms > 0)) return '比平常久'
  if (ms < 60_000) return `還要 ${Math.ceil(ms / 1000)}s`
  return `還要約 ${elapsed(Math.round(ms / 60_000) * 60_000)}`
}

/** 經過時間:`45s`、`12m`、`1h05m`。 */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}
