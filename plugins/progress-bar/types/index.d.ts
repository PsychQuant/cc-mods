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
  /** 指令字串的雜湊(歷史的鍵,store 裡不存原字串);不是 shell 的背景工作是空字串 */
  key: string
  /** 要讀的檔:任務的輸出檔,加上指令裡 `>`、`>>`、`tee` 寫到的絕對路徑 */
  files: string[]
  /** 讀數取自哪一個檔(第一個讀到百分比的檔);兩個檔各有百分比時只看這一個 */
  src: string | null
  /** 開始的時間(epoch ms);接上的任務是接上的那一刻 */
  startedAt: number
  /** 開始時間是真的(Bash 開跑時記下的);接上的任務是 false,不寫歷史 */
  startKnown: boolean
  /** 同一個指令字串過去跑完的長度的中位數(ms);沒有歷史是 null */
  prior: number | null
  /** 歷史記著這個指令會分段(讀數到頂後又從頭開始) */
  priorPhased: boolean
  /** 讀到的最後一個百分比(0–100);讀不到是 null */
  percent: number | null
  /** 速率估計的狀態;還沒有讀數是 null */
  fit: Fit | null
  /** 這一次讀數往回掉過(多階段的指令) */
  phased: boolean
  /** 第幾段(從 1 起) */
  phase: number
  /** 輸出的最後一行(截短) */
  line: string
  /** 任務結束的時間(推定結束的列是推定的那一刻,之後收到通知也不改);還在跑是 null */
  endedAt: number | null
  /** 收起前的 15 秒從這一刻算:收到結束通知的那一刻;沒有(還沒收到通知,或舊版存的狀態)就用 endedAt */
  keepFrom?: number | null
  /** 結束時的狀態(completed、failed、killed;每一輪結束時清單裡沒有了是 ended);還在跑是 null */
  status: string | null
  /** 只是從背景清單推定結束,還沒收到結束通知 */
  presumed: boolean
  /** 結束那一刻畫面上的顯示值;沒有是 null */
  final: number | null
}

/**
 * 一次跑完、還沒寫進歷史的長度。與顯示的任務清單分開放:任務結束 15 秒後就從畫面收起,
 * 晚到的結束通知仍找得到這一筆(verify R2 #3)。
 */
export type Pending = {
  /** 背景任務的 id */
  id: string
  /** 指令字串的雜湊 */
  key: string
  /** 長度(ms):開始到最早得知結束的那一刻(推定結束或結束通知);沒有引擎的完成時間,是估計 */
  ms: number
  /** 這一次讀數往回掉過 */
  phased: boolean
  /** 結束通知的狀態;推定結束、還沒等到通知是 null */
  status: string | null
  /** 得知結束的時間(epoch ms):沒等到通知的,過一段時間丟掉 */
  at: number
  /** 寫入 store 失敗過幾次 */
  tries: number
  /** 這一次要寫的 store 鍵,建這一筆時就決定:重試與熱重載都寫同一個鍵,不會記成兩次(verify R3 #6) */
  store: string
}

/** 畫面上的顯示值(每 250 ms 由顯示時鐘算出;畫出來的字串變了才寫)。 */
export type Shown = {
  /** 顯示的百分比 */
  d: number
  /** 轉圈的第幾格(每秒一格) */
  frame: number
  /** 還要幾秒;不顯示是 null */
  eta: number | null
  /** 沒有估計:畫轉圈 */
  spin: boolean
  /** 列尾的說明(分段時是這一段的真實讀數);沒有是 null */
  note: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'progress-bar': {
      tasks: Shaped<Tracked[]>
      now: number
      outputDir: string | null
      shown: Shaped<Record<string, Shown>>
      pending: Shaped<Pending[]>
    }
  }
}
