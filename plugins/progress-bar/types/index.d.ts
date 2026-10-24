/** 指數權重 local linear 的狀態(hooks/est.ts)。時間是秒,從任務開始(或接上)算起;原點放在最後一個讀數。 */
export type Fit = {
  /** Σw */
  s0: number
  /** Σw·t */
  s1: number
  /** Σw·t² */
  s2: number
  /** Σw·p */
  sy: number
  /** Σw·t·p */
  sty: number
  /** Σw²(算有效樣本數) */
  sww: number
  /** 最後一個讀數的時間(秒) */
  tLast: number
  /** 最後一個讀數(%) */
  pLast: number
  /** 讀數間隔的 EW 平均(秒) */
  gap: number | null
  /** 每次讀數增加量的 EW 平均(百分點) */
  step: number | null
  /** 換階段(讀數往回掉)時從上一段帶過來的速率 */
  carry: number | null
}

/** 一個在背景跑的指令:它的輸出檔與讀到的進度。 */
export type Tracked = {
  /** 背景任務的 id(Bash 結果的 backgroundTaskId) */
  id: string
  /** 顯示的名字:Bash 的 description,沒有就用指令開頭 */
  label: string
  /** 指令字串原樣(歷史的鍵);不是 shell 的背景工作是空字串 */
  command: string
  /** 要讀的檔:任務的輸出檔,加上指令裡 `>`、`>>`、`tee` 寫到的絕對路徑 */
  files: string[]
  /** 開始的時間(epoch ms);接上的任務是接上的那一刻 */
  startedAt: number
  /** 開始時間是真的(Bash 開跑時記下的);接上的任務是 false,不寫歷史 */
  startKnown: boolean
  /** 同一個指令字串過去跑完的長度的中位數(ms);沒有歷史是 null */
  prior: number | null
  /** 讀到的最後一個百分比(0–100);讀不到是 null */
  percent: number | null
  /** 速率估計的狀態;還沒有讀數是 null */
  fit: Fit | null
  /** 讀數往回掉過(多階段的指令) */
  phased: boolean
  /** 輸出的最後一行(截短) */
  line: string
  /** 任務結束的時間;還在跑是 null */
  endedAt: number | null
  /** 結束時的狀態(completed、failed、killed);還在跑是 null */
  status: string | null
}

/** 畫面上的顯示值(每 250 ms 由顯示時鐘算出;畫出來的字串變了才寫)。 */
export type Shown = {
  /** 顯示的百分比 */
  d: number
  /** 轉圈的第幾格 */
  frame: number
  /** 還要幾秒;不顯示是 null */
  eta: number | null
  /** 沒有估計:畫轉圈 */
  spin: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'progress-bar': {
      tasks: Shaped<Tracked[]>
      now: number
      outputDir: string | null
      shown: Shaped<Record<string, Shown>>
    }
  }
}
