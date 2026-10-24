# cc-mods

Claude Code 的 mod 集。mod 是用 function hooks(TypeScript 的 hooks module)改 Claude Code 介面與行為的 plugin:
`hooks/hooks.json` 寫 `{ "modules": ["./register.tsx"] }`,`register` 拿到引擎介面 `$`,能畫在提示列上方、開側邊窗格、看工具呼叫。

## 安裝

```
/plugin marketplace add PsychQuant/cc-mods
/plugin install <mod>@cc-mods
```

## Mods

| mod | 做什麼 |
|---|---|
| [progress-bar](plugins/progress-bar) | Claude 在背景跑的指令(pytest、安裝、下載),在提示列上方顯示進度條 |

## 加一個 mod

在 `plugins/<name>/` 放 `.claude-plugin/plugin.json`、`hooks/hooks.json`、`hooks/register.tsx`(用到 `$.state` 再加 `types/index.d.ts`),在 `.claude-plugin/marketplace.json` 加一筆 entry。版本只寫在 plugin.json。改完跑 `claude plugin validate .` 與 `claude plugin test plugins/<name>`。

MIT License
