/** 一個在背景跑的指令:它的輸出檔與讀到的進度。 */
export type Tracked = {
  /** 背景任務的 id(Bash 結果的 backgroundTaskId) */
  id: string
  /** 顯示的名字:Bash 的 description,沒有就用指令開頭 */
  label: string
  /** 要讀的檔:任務的輸出檔,加上指令裡 `>`、`>>`、`tee` 寫到的絕對路徑 */
  files: string[]
  /** 開始的時間(epoch ms) */
  startedAt: number
  /** 讀到的最後一個百分比(0–100);讀不到是 null */
  percent: number | null
  /** 輸出的最後一行(截短) */
  line: string
  /** 任務結束的時間;還在跑是 null */
  endedAt: number | null
  /** 結束時的狀態(completed、failed、killed);還在跑是 null */
  status: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'progress-bar': { tasks: Shaped<Tracked[]>; now: number; outputDir: string | null }
  }
}
