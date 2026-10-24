# progress-bar

Claude Code 的 mod:Claude 用 Bash 在背景跑指令(`run_in_background`)時,在提示列上方畫一條進度條。

```
▕██████░░░░░░░░░░░░░░▏  29%  Run full pytest suite · 12m
⋯ Install package dependencies · 45s · Downloading numpy-2.3.1.tar.gz
✓ Build documentation site 100% · completed · 3m
```

## 它怎麼知道跑到幾趴

mod 看不到程式內部,只讀程式寫出來的輸出:

1. 背景 Bash 指令開始時,記下它的任務 id 與要讀的檔 —— 任務的輸出檔,加上指令裡 `>`、`>>`、`tee` 寫到的檔。
2. 每 2 秒讀一次那些檔的尾端(檔沒變就不讀),取**最後一個 0–100 的百分比**(`42%`、pytest 的 `[ 29%]`);
   讀不到百分比就顯示最後一行與經過時間。
3. 收到背景任務結束的通知時打勾(或打叉),15 秒後收起。

## 限制

- 只看得到程式自己印出的百分比。沒有印進度的程式只會顯示最後一行與經過時間。
- 指令寫到的檔要是絕對路徑,或只用到 `HOME`、`TMPDIR`、`CLAUDE_JOB_DIR`、`PWD` 這四個變數(與開頭的 `~`)。
  相對路徑要看指令當時的工作目錄,`cd` 之後猜不準,所以不讀。
- 進度列用 `\r` 原地重畫的程式(pip、curl)也讀得到,因為 `\r` 算換行;顏色碼會先拿掉。
- 同時最多顯示 6 個任務;沒收到結束通知的任務 6 小時後收起。

## 安裝

在 Claude Code 的提示列輸入:

```
/plugin marketplace add PsychQuant/cc-mods
/plugin install progress-bar@cc-mods
```

## 檔案

| 檔 | 內容 |
|---|---|
| `hooks/register.tsx` | hooks module:`tool.call`(記下背景任務)、`session.append`(結束通知)、`session.start`(每 2 秒讀檔)、`ui.render`(畫在提示列上方) |
| `hooks/parse.ts` | 純函式:讀百分比與最後一行、找重導向的目標、展開路徑、畫長條 |
| `types/index.d.ts` | `$.state` 的型別合約 |

這是 function hooks 的 plugin(mod):`hooks/hooks.json` 寫的是 `{ "modules": [...] }`,不是命令 hook 的 `{ "hooks": ... }`。
