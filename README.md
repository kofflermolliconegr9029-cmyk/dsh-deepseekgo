# dsh-deepseekgo · 和 DS 下五子棋

给 **DeepSeek Harness** 装的一副五子棋：输入框上方多一条「五子棋」入口，展开就是 15×15 棋盘。
你点棋盘落黑子，模型用工具 `gomoku_play` 应白子；棋盘不靠插件私有内存，而是**每次从会话日志重建**，
所以刷新页面、切会话、fork、甚至 Host 重启都不会把棋局弄丢。

（English: a Gomoku bundle for DeepSeek Harness — a board docked above the composer. Your click becomes a
user message in the session log, the model answers by calling the `gomoku_play` tool, and the board is folded
back out of the log, so the position survives reload/fork/restart.)

## 怎么玩

1. 在会话输入框上方找到「五子棋」那一行（默认收起，32px），点开。
2. 点棋盘交叉点落子（你执黑先行，点第一手即开局）。落子会作为一条 `【五子棋】我落子 H8…` 的用户消息进入对话，
   消息里带当前棋盘，模型就会调用 `gomoku_play` 回一手。
3. 状态行显示轮到谁 / DS 思考中 / 你赢了 / DS 赢了 / 平局；五连会被高亮。顶部按钮：**新局 / 悔棋 / 认输 / 收起**。
4. 人的落子**只能**通过棋盘产生。手工在对话里说“我落子 H8”，棋盘不会移动（它只折叠带 `【五子棋】` 前缀的消息和模型的工具调用）；
   但你可以直接说“下 H12”，模型会自己调 `gomoku_play` 落白子。

坐标：列 **A–O**（左→右），行 **1–15**（下→上），最下面一行是 1，所以天元是 **H8**。

## 两种调用方，同一套实现

| 调用方 | 入口 | 落进日志的东西 |
| --- | --- | --- |
| 你（浏览器） | `POST /dsh-gomoku/api/act` → `agent.followup(用户消息)` | `user/message`（首行带 `【五子棋】`） |
| 模型 | 工具 `gomoku_play` / `gomoku_state` | `tool/call` |

对局状态 = 对 `Session.snapshotEvents()` 的纯函数折叠（`lib/game.js`）：

- `user/message` 且首行是 `【五子棋】我落子 H8` / `开新局` / `悔棋` / `我认输` → 人的动作
- `tool/call` 且 `name === 'gomoku_play'` → 模型的落子（参数 `move` 或 `x`/`y`）

工具执行时这一手 `tool/call` 已经在日志里了，所以 `gomoku_play` **不再落子**，只做两件事：
校验「折叠出来的局面里最后一手是不是这一手」，然后把棋盘文本回给模型——避免同一手被应用两次。

折叠带增量缓存（按日志长度 + 末条 seq 续算），一个几千条事件的会话也就是微秒级。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host：工具注册、两条 HTTP 接口、日志折叠缓存、浏览器路由准入 |
| `lib/game.js` | 纯规则：坐标、落子、五连、悔棋、认输、AST 棋盘、日志事件折叠（无 IO，可单测） |
| `client.js` | Client：自注册脚本，`conversation.input.dock` 里的入口条 + 棋盘 UI（轮询 + 乐观快照） |
| `cordis.patch.yml` | bundle patch，插入一行 `dsh-deepseekgo` |
| `locale/zh.json`、`locale/en.json` | 插件管理页的标题/描述 |
| `icon.svg` | 插件图标（自绘） |
| `PUBLISHING.md` | 发 npm + 上架插件市场的完整清单（含换名要改的三处） |
| `.dev/test-engine.mjs` | 规则单测（24 项） |
| `.dev/test-host.mjs` | 用假 ctx 跑 `apply()`，直打路由和工具（24 项） |

## 安装 / 维护

```
plugin_manager install_bundle  target: D:\devin\deepseekgo
```

本机已经装好（profile 里是指向本目录的符号链接，`dsh.profile.bundles` 已含 `dsh-deepseekgo`）。

源码在 GitHub：**https://github.com/kofflermolliconegr9029-cmyk/dsh-deepseekgo**（暂未发 npm）。
换一台机器想装，二选一：

```
# A. 直接从 GitHub 装（DSH 的 plugin add 支持 git 规格）
dsh plugin --profile <profile> add github:kofflermolliconegr9029-cmyk/dsh-deepseekgo

# B. 先 clone 到本地，再按目录装
git clone https://github.com/kofflermolliconegr9029-cmyk/dsh-deepseekgo.git
plugin_manager install_bundle  target: <clone 下来的目录>
```

- **改 Host（`index.js` / `lib/game.js`）** 需要重启 DSH 才会重新 import 这棵模块。
- **改 Client（`client.js`）** 刷新页面即可（客户端 bundle 按内容哈希重新取）。
- 想重新自测：
  ```
  node .dev/test-engine.mjs
  node .dev/test-host.mjs
  ```
  （这两个脚本只依赖 Node 内置模块，不需要装任何依赖。）

## 已验证

- 规则单测 24 项：坐标往返、黑先、占位/越界拒绝、横/纵/斜/反斜五连、长连、悔棋回到人的回合、认输、日志折叠（人消息 + 工具调用）、快照字段、ASCII 棋盘。
- Host 胶水 24 项：路由注册、`/state` 与 `/act` 的正常/400/404/405/403 分支、非 loopback 拒绝、乐观快照、无 agent 会话 409、工具去重与越权报错。
- 真机：插件安装 `application: applied`；`gomoku_play` / `gomoku_state` 出现在工具表里；`POST /dsh-gomoku/api/state` 返回 200 和完整快照；`conversation.input.dock` 里 `dsh-gomoku`（order 30）`active: true`。
- 端到端（一次性会话实测）：点棋盘 → `【五子棋】我落子 H8` 用户消息进入对话并带出棋盘 → 模型 `gomoku_play {"move":"H9"}` 成功 → 再读状态 `moveCount:2 / turn:1 / lastMove(7,6) 白`，棋盘 X=H8、O=H9；越权落子报「现在不是你的回合」。

## 边界与已知限制

- **只做五子棋**：15 路、无禁手（长连也算赢），人执黑先行。围棋还没做。
- 模型正在跑一轮时点棋盘，那条消息会**排队到下一轮**才落地（runtime 的 followup 语义）；客户端会先用乐观快照顶住（最多 15s），日志落地后以日志为准。
- 会话必须在 Host 进程里活着（`agents.get(sessionId)` 有值）才能落子；归档/未打开的会话只能看不能动。
- 胜负只用于显示，不记分、不存战绩。
- 插件没有 Config（不需要调参）；`dsh-deepseekgo` 这一行在插件管理里显示「无配置」。

## 许可

MIT。
