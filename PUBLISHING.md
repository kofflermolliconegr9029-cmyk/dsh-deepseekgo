# 上架 / 发布清单（dsh-deepseekgo）

这个包本身已经是一个合法的 DSH bundle（`dsh.bundle.patch` + `dsh.client` + `files` 齐全），
所以「发布」= **发到 npm** + **在插件目录里登记一条**。下面是完整步骤和当前状态。

## 现状

| 项目 | 状态 |
| --- | --- |
| bundle 形态（`dsh.bundle.patch` / `dsh.client` / `exports` / `files`） | ✅ 齐全，本机 `install_bundle` 验证过 |
| 包名 `dsh-deepseekgo` | ✅ 2026-11 查过 npm：**可用**（`dsh-gomoku` 已被别人占，所以没沿用） |
| `private: true` | ✅ 已删除（npm 会拒绝私有包） |
| `engines.dsh` / `publishConfig.access` / `LICENSE` | ✅ `>=0.2.0` / `public` / MIT |
| 图标、`locale/zh.json` + `locale/en.json` | ✅ 自绘 SVG + 中英标题/描述（标题带 `DeepSeek Go` 品牌） |
| 换名（`package.json` / `cordis.patch.yml` / `client.js` 模块 id） | ✅ 已改并**卸载重装**过，本机现在挂的就是 `dsh-deepseekgo` |
| HTTP 路由前缀 | 保留 `/dsh-gomoku/api`（它描述功能，不是包名，不用跟着改） |
| GitHub 仓库地址（`repository` / `homepage` / `bugs`） | ✅ `https://github.com/kofflermolliconegr9029-cmyk/dsh-deepseekgo` |
| npm 已发布版本 | ⏸️ 暂缓（当前策略：先只发 GitHub，见下） |

## 当前选择：先只发 GitHub

仓库：`https://github.com/kofflermolliconegr9029-cmyk/dsh-deepseekgo`

```powershell
cd D:\devin\deepseekgo
git init -b main                 # 只需一次
git add -A
git commit -m "dsh-deepseekgo 0.1.0"
git remote add origin https://github.com/kofflermolliconegr9029-cmyk/dsh-deepseekgo.git
git push -u origin main
```

别人安装：

```
# 直接从 GitHub 装
dsh plugin --profile <profile> add github:kofflermolliconegr9029-cmyk/dsh-deepseekgo
# 或者 clone 后按目录装
plugin_manager install_bundle  target: <clone 目录>
```

> 注意：**插件市场（dshmarket / 官方 Discover）的机器可读 index 只收 npm 上有已知版本的条目**，
> 所以只发 GitHub 的话进不了市场搜索，只能靠 README 里那行命令安装；
> awesome-dsh-plugin 的列表可以收 GitHub-only 条目，但索引里不会出现。想进市场还得补发 npm。

## 发 npm（以后想做再做）

## 名字这件事（留档）

- npm **不允许新包名带大写**，所以 `dsh-deepseekGo` 落成 `dsh-deepseekgo`。
  品牌写法（`DeepSeek Go`）保留在插件标题和 README 里。
- 英文里 “Go” 天然指**围棋**，而这个插件是**五子棋（Gomoku）**——所以描述里明确写了
  “Unofficial community plugin — Gomoku, not the board game Go”，避免英文用户误解；
  以后真加围棋模式，这个名字反而正好。
- `deepseek` 是品牌词；描述里标注 “Unofficial community plugin” 是必要的（`@deepseek-ai/*`
  是官方 scope）。

## 发 npm

```powershell
cd D:\devin\deepseekgo
node .dev/test-engine.mjs      # 24 项规则单测
node .dev/test-host.mjs        # 24 项 Host 胶水
npm pack --dry-run             # 清单应只有 index.js / client.js / lib / locale / icon / patch / README / LICENSE
npm login                      # 你自己的 npm 账号
npm publish --access public    # scoped 包（@you/xxx）必须带 --access public
```

发完别人就能装：

```powershell
dsh plugin --profile web add dsh-deepseekgo
```

## 上架插件市场（一次 PR 覆盖两个市场）

插件市场（`dshmarket`）读的是精选列表
[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)；
dsh 0.2.1+ 的官方 Discover（`pluginMarket` 服务）也能把这个列表当 format-1 index 源
（`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`）。所以**只要上这个列表**，
两个市场都能搜到。

在列表里找 **Just for Fun** 一节，按现有行的格式加一条（把 `<你的GitHub用户名>` 换掉）：

```markdown
- [<你的GitHub用户名>/dsh-deepseekgo](https://github.com/<你的GitHub用户名>/dsh-deepseekgo) - Gomoku (five in a row, not the board game Go) for DeepSeek Harness: a board docked above the composer where you click to play black, the model answers through the `gomoku_play` tool, and the position is rebuilt from the session log so it survives reload, fork and restart. Chinese and English UI.
```

评审会真的去看源码，所以这行必须句句能对上：

- ✅ 下在 composer 上方的棋盘（`conversation.input.dock`）
- ✅ 模型用 `gomoku_play` 工具应手
- ✅ 棋盘状态从会话日志折叠（刷新/fork/重启都在）
- ✅ 中英双语
- ✅ HTTP 路由有准入检查（`ctx.connection.requestRejection` + loopback 兜底），
  不像列表里那些被标了「no access check」的插件——这点评审也会核

上架前需要：

1. **公开 GitHub 仓库**（列表条目是仓库链接，不是 npm 名），仓库里放这个包的源码，
   `package.json` 里补 `repository` / `homepage` / `bugs`。
2. npm 上已有**已发布版本**（市场只收录有已知版本的条目）。
3. 提 PR 后一般一天内站点和 `dshmarket` 会自动收录。

## 可选：官方市场自建 index

不想进 awesome 列表也可以自己发一个 format-1 index JSON（条目字段：
`name` / `title` / `description` / `icon` / `author` / `homepage` / `repository` /
`metadata.category,keywords,labels` / `versions[{version,publishTimestamp,source:{type:'npm',registry?},engines:{dsh}}]`），
然后在 dsh 0.2.1+ 的 **插件 → Discover → Index sources** 里加这个 URL，或直接调
`pluginMarket.setIndexes([...])`。只有你自己的用户能看到，进不了公共列表。
