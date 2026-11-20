/**
 * dsh-gomoku —— 浏览器半端（浏览器自注册脚本，**不是 ESM**，没有 import）
 * ============================================================================
 * 挂载点：`conversation.input.dock`，props 里只依赖 `sessionId`。
 *
 * 数据只走两个同源 POST JSON 接口（Host 半端提供，契约固定）：
 *   · POST /dsh-gomoku/api/state  body { sessionId }                → { ok:true, value: Snapshot }
 *   · POST /dsh-gomoku/api/act    body { sessionId, action, x?, y? } → { ok:true, value: Snapshot }
 *     action = move / new / undo / resign
 *   失败信封：{ ok:false, error:"<人类可读的错误>" }（也可能是 HTTP 4xx/5xx）
 *
 * 样式约定：外壳颜色只用已确认的 `--dsw-alias-*` 主题 token（14 个白名单内），
 * 棋盘 artwork 才用固定木色常量；所有选择器带 `data-gm-*` 前缀；
 * `<style>` 作为渲染树里的一个节点输出（不碰宿主页面的 head / body）。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-deepseekgo',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /* ============================================================
     * 1. Host 接口
     * ============================================================ */
    const STATE_URL = '/dsh-gomoku/api/state'
    const ACT_URL = '/dsh-gomoku/api/act'

    /** `pending: true` 的乐观快照最多挂多久；日志迟迟不落地就放弃，改听轮询的。 */
    const PENDING_TTL = 15000

    /** 把 fetch 的失败归一成带 status / inactive 标记的 Error，方便 UI 决定文案。 */
    async function requestJson(url, body) {
      let res
      try {
        res = await fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
      } catch (e) {
        const err = new Error('network: ' + String((e && e.message) || e))
        err.status = 0
        throw err
      }
      let data = null
      let parsed = false
      try {
        data = await res.json()
        parsed = true
      } catch (e) {
        parsed = false
      }
      if (!res.ok) {
        const fromHost = parsed && data && typeof data.error === 'string' && data.error !== ''
        const err = new Error(fromHost ? data.error : ('HTTP ' + res.status))
        err.status = res.status
        // 401 / 空 404 基本就是「路由没注册 / 被宿主拦了」。
        // 但 Host 也会用 404 表示「这个会话当前没有激活」并附上具体原因 ——
        // 那种情况照 Host 的话显示，比笼统的「Host 半端未激活」有用。
        err.inactive = res.status === 401 || (!fromHost && res.status === 404)
        throw err
      }
      if (!parsed || !data || typeof data !== 'object') {
        // 路由没注册时开发服务器可能回 200 + index.html，同样算「Host 半端没激活」
        const err = new Error('bad response (no JSON envelope)')
        err.status = res.status
        err.inactive = true
        throw err
      }
      if (data.ok !== true) {
        const err = new Error(typeof data.error === 'string' && data.error ? data.error : 'request failed')
        err.status = res.status
        throw err
      }
      return data.value
    }

    const requestState = (sessionId) => requestJson(STATE_URL, { sessionId })
    const requestAct = (sessionId, action, extra) =>
      requestJson(ACT_URL, Object.assign({ sessionId, action }, extra || {}))

    /* ============================================================
     * 2. 棋盘几何与 artwork（viewBox 480×480）
     * ============================================================ */
    const GRID = 15
    const VIEW = 480
    const G0 = 44 // 网格左上角
    const CELL = 28 // 格距（14 * 28 = 392，网格 44..436，四周对称留 32）
    const LAST = G0 + (GRID - 1) * CELL // 436
    const R = 11.6 // 棋子半径
    const HUMAN = 1
    const MODEL = 2
    const COLS = 'ABCDEFGHIJKLMNO'.split('')
    const STAR = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]]
    const pos = (i) => G0 + i * CELL

    /** 木色棋盘是 artwork：深浅主题共用一套固定色，靠内描边从背景里分出来。 */
    const INK = {
      woodFrom: '#ecd2a6',
      woodTo: '#dfbf8b',
      woodEdge: 'rgba(94, 64, 30, 0.45)',
      woodInner: 'rgba(255, 255, 255, 0.22)',
      line: '#8a6a43',
      lineEdge: '#7d5c36',
      star: '#7a5a32',
      label: '#7b5f3d',
      blackHi: '#767c87',
      blackMid: '#2c3038',
      blackLo: '#0b0c0f',
      blackEdge: 'rgba(0, 0, 0, 0.55)',
      whiteHi: '#ffffff',
      whiteMid: '#f4f1ea',
      whiteLo: '#d6cfc1',
      whiteEdge: '#a99a80',
      winLine: '#e2582f',
      winRing: '#ffd166',
      dotOnBlack: '#f3f4f6',
      dotOnWhite: '#25282d',
      ghostEdge: 'rgba(0, 0, 0, 0.18)',
    }

    /* ============================================================
     * 3. 文案（中 / 英，按 locale 二选一；不读 locale json）
     * ============================================================ */
    const STR = {
      zh: {
        title: '五子棋',
        loading: '载入中…',
        idle: '点棋盘开始对局',
        yourMove: '轮到你落子（黑）',
        thinking: 'DS 思考中…',
        waiting: '等待 DS 落子',
        humanWin: '你赢了',
        modelWin: 'DS 赢了',
        humanResign: '你认输了',
        draw: '平局',
        newGame: '新局',
        undo: '悔棋',
        resign: '认输',
        confirmResign: '确认认输',
        collapse: '收起',
        expandAria: '展开五子棋棋盘',
        collapseAria: '收起五子棋棋盘',
        newGameAria: '开始新的一局',
        undoAria: '悔棋：撤回上一手',
        resignAria: '认输（需要连点两次确认）',
        boardAria: '五子棋棋盘',
        hostInactive: '插件 Host 半端未激活',
        network: '连不上插件 Host 半端',
        unknownError: '请求失败',
      },
      en: {
        title: 'Gomoku',
        loading: 'Loading…',
        idle: 'Click the board to start',
        yourMove: 'Your move (black)',
        thinking: 'DeepSeek is thinking…',
        waiting: 'Waiting for DeepSeek',
        humanWin: 'You win',
        modelWin: 'DeepSeek wins',
        humanResign: 'You resigned',
        draw: 'Draw',
        newGame: 'New game',
        undo: 'Undo',
        resign: 'Resign',
        confirmResign: 'Confirm resign',
        collapse: 'Collapse',
        expandAria: 'Expand Gomoku board',
        collapseAria: 'Collapse Gomoku board',
        newGameAria: 'Start a new game',
        undoAria: 'Undo the last move',
        resignAria: 'Resign (click twice to confirm)',
        boardAria: 'Gomoku board',
        hostInactive: 'The plugin host half is not active',
        network: 'Cannot reach the plugin host',
        unknownError: 'Request failed',
      },
    }

    /* 主题 token 白名单（外壳颜色只用这些）：
       --dsw-alias-bg-base / bg-layer-1 / bg-layer-2 / bg-overlay
       --dsw-alias-border-l1 / border-l2
       --dsw-alias-brand-primary
       --dsw-alias-label-primary / label-secondary
       --dsw-alias-state-error-primary / state-success-primary / state-warn-primary / state-idle-primary
       --dsw-specific-sidebar-fill  */
    const CSS = `
[data-gm-root]{width:100%;min-width:0;font-size:12px;line-height:16px;color:var(--dsw-alias-label-primary);}
[data-gm-bar]{display:flex;align-items:center;gap:7px;width:100%;height:32px;padding:0 8px;box-sizing:border-box;
  border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;text-align:left;}
[data-gm-bar]:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);}
[data-gm-bar]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}
[data-gm-baricon]{flex:none;display:block;color:var(--dsw-alias-label-secondary);}
[data-gm-bartitle]{flex:none;font-weight:500;color:var(--dsw-alias-label-primary);}
[data-gm-barsum]{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);}
[data-gm-barsum][data-gm-tone="bad"]{color:var(--dsw-alias-state-error-primary);}
[data-gm-barchev]{flex:none;color:var(--dsw-alias-label-secondary);}
[data-gm-card]{display:flex;flex-direction:column;gap:8px;width:100%;max-width:404px;box-sizing:border-box;
  padding:10px 12px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);}
[data-gm-head]{display:flex;align-items:center;gap:8px;min-width:0;}
[data-gm-title]{flex:none;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}
[data-gm-status]{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;
  color:var(--dsw-alias-label-primary);}
[data-gm-status][data-gm-tone="muted"]{color:var(--dsw-alias-label-secondary);}
[data-gm-status][data-gm-tone="good"]{color:var(--dsw-alias-state-success-primary);}
[data-gm-status][data-gm-tone="bad"]{color:var(--dsw-alias-state-error-primary);}
[data-gm-actions]{flex:none;display:flex;align-items:center;gap:4px;}
[data-gm-btn]{appearance:none;font:inherit;font-size:11.5px;line-height:1;padding:5px 8px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);
  cursor:pointer;white-space:nowrap;}
[data-gm-btn]:hover:not([disabled]){background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
  color:var(--dsw-alias-label-primary);}
[data-gm-btn]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}
[data-gm-btn][disabled]{opacity:.45;cursor:default;}
[data-gm-btn][data-gm-danger]{color:var(--dsw-alias-state-error-primary);
  border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, var(--dsw-alias-border-l1));}
[data-gm-err]{font-size:12px;line-height:16px;color:var(--dsw-alias-state-error-primary);
  display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;word-break:break-word;}
[data-gm-board]{display:block;width:100%;max-width:352px;margin:0 auto;aspect-ratio:1/1;border-radius:8px;cursor:default;}
[data-gm-board][data-gm-playable]{cursor:pointer;}
[data-gm-cell]{fill:transparent;}
[data-gm-cell][data-gm-free]:hover{fill:color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);}
[data-gm-dots]{display:inline-flex;gap:3px;margin-left:5px;vertical-align:middle;}
[data-gm-dots] span{display:block;width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.35;
  animation:gm-dots-blink 1.1s ease-in-out infinite;}
[data-gm-dots] span:nth-child(2){animation-delay:.16s;}
[data-gm-dots] span:nth-child(3){animation-delay:.32s;}
@keyframes gm-dots-blink{0%,80%,100%{opacity:.2;}40%{opacity:1;}}
@media (prefers-reduced-motion: reduce){[data-gm-dots] span{animation:none;opacity:.6;}}
`

    /* ============================================================
     * 4. 小工具
     * ============================================================ */
    const localeOf = (ctx) => {
      try {
        return String(ctx.get('locale')?.getSnapshot?.().active || 'zh')
      } catch {
        return 'zh'
      }
    }

    const isZh = (code) => String(code || '').toLowerCase().indexOf('zh') === 0

    /** 把异常归一成 UI 可用的结构；kind 用来区分「轮询失败」和「动作失败」。 */
    function toErr(e, kind) {
      const status = e && typeof e.status === 'number' ? e.status : 0
      return {
        kind,
        status,
        inactive: e && typeof e.inactive === 'boolean' ? e.inactive : (status === 401 || status === 404),
        message: String((e && e.message) || e || 'request failed'),
      }
    }

    function errTextOf(info, s) {
      if (!info) return ''
      if (info.inactive) return s.hostInactive
      if (!info.status && /fetch|network|load failed/i.test(info.message)) return s.network
      return info.message || s.unknownError
    }

    function statusInfo(snap, s) {
      if (!snap || typeof snap !== 'object') return { text: s.loading, tone: 'muted' }
      const human = snap.human || HUMAN
      switch (snap.status) {
        case 'human-win':
          return { text: s.humanWin, tone: 'good' }
        case 'model-win':
          return { text: s.modelWin, tone: 'bad' }
        case 'human-resign':
          return { text: s.humanResign, tone: 'bad' }
        case 'draw':
          return { text: s.draw, tone: 'normal' }
        case 'playing':
          if (snap.turn === human) return { text: s.yourMove, tone: 'normal' }
          return { text: snap.thinking ? s.thinking : s.waiting, tone: snap.thinking ? 'muted' : 'normal' }
        default:
          return { text: s.idle, tone: 'normal' }
      }
    }

    /**
     * 局面指纹：判断「日志里是否已经落地了这次动作」。
     * `pending` 期间轮询拿到的还是动作前的局面（指纹相同）→ 不能用来覆盖乐观快照；
     * 一旦指纹变了，说明日志前进了（这一手进来了 / 轮到模型了），就该听轮询的。
     */
    function stateFingerprint(state) {
      if (!state || typeof state !== 'object') return ''
      const lm = state.lastMove || null
      const win = Array.isArray(state.winLine) ? state.winLine : []
      return [
        state.moveCount,
        state.status,
        state.turn,
        lm ? lm.x : '',
        lm ? lm.y : '',
        lm ? lm.c : '',
        win.length,
      ].join('|')
    }

    function mkButton(key, label, ariaLabel, onClick, opts) {
      const o = opts || {}
      const attrs = {
        key,
        type: 'button',
        'data-gm-btn': '',
        'aria-label': ariaLabel,
        disabled: Boolean(o.disabled),
        onClick: o.disabled ? undefined : onClick,
      }
      if (o.danger) attrs['data-gm-danger'] = ''
      if (o.strong) attrs['data-gm-strong'] = ''
      if (o.expanded !== undefined) attrs['aria-expanded'] = o.expanded
      return h('button', attrs, label)
    }

    /* ============================================================
     * 5. 图标（16px 内联小棋盘 / 12px chevron）
     * ============================================================ */
    function BarIcon() {
      return h('svg', {
        'data-gm-baricon': '',
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('rect', {
          x: 1.25, y: 1.25, width: 13.5, height: 13.5, rx: 3,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.1, opacity: 0.55,
        }),
        h('path', {
          d: 'M5.75 2.2v11.6M10.25 2.2v11.6M2.2 5.75h11.6M2.2 10.25h11.6',
          fill: 'none', stroke: 'currentColor', strokeWidth: 0.75, opacity: 0.3,
        }),
        h('circle', { cx: 5.75, cy: 5.75, r: 1.85, fill: 'currentColor' }),
        h('circle', { cx: 10.25, cy: 10.25, r: 1.85, fill: 'currentColor', opacity: 0.45 }))
    }

    function Chevron() {
      return h('svg', {
        'data-gm-barchev': '',
        viewBox: '0 0 12 12',
        width: 12,
        height: 12,
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', {
          d: 'M2.75 4.5 6 7.75 9.25 4.5',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }))
    }

    /* ============================================================
     * 6. 棋盘（SVG）
     * ============================================================ */
    function Board(props) {
      const snap = props.snap
      const s = props.s
      const uid = props.uid
      const playable = Boolean(props.playable)
      const [hover, setHover] = React.useState(null)

      React.useEffect(() => {
        if (!playable) setHover(null)
      }, [playable])

      const board = Array.isArray(snap && snap.board) ? snap.board : []
      const at = (x, y) => board[y * GRID + x]
      const blackFill = 'url(#' + uid + '-black)'
      const whiteFill = 'url(#' + uid + '-white)'

      /* 棋子 */
      const stones = []
      for (let y = 0; y < GRID; y++) {
        for (let x = 0; x < GRID; x++) {
          const v = at(x, y)
          if (v !== HUMAN && v !== MODEL) continue
          stones.push(h('circle', {
            key: 's' + x + '-' + y,
            cx: pos(x),
            cy: pos(y),
            r: R,
            fill: v === HUMAN ? blackFill : whiteFill,
            stroke: v === HUMAN ? INK.blackEdge : INK.whiteEdge,
            strokeWidth: v === HUMAN ? 0.6 : 0.8,
          }))
        }
      }

      /* 合法空点：只有在轮到自己、且模型没在思考时才铺交互层 */
      const cells = []
      if (playable) {
        for (let y = 0; y < GRID; y++) {
          for (let x = 0; x < GRID; x++) {
            const free = !at(x, y)
            cells.push(h('rect', {
              key: 'c' + x + '-' + y,
              'data-gm-cell': '',
              'data-gm-free': free ? '' : undefined,
              x: pos(x) - CELL / 2,
              y: pos(y) - CELL / 2,
              width: CELL,
              height: CELL,
              // fill 是 transparent：显式声明命中区域，别指望 visiblePainted 的默认行为
              pointerEvents: 'all',
              onClick: free ? () => props.onMove(x, y) : undefined,
              onMouseEnter: free ? () => setHover({ x, y }) : undefined,
            }))
          }
        }
      }

      /* 五连高亮 */
      const rawWin = snap && Array.isArray(snap.winLine) ? snap.winLine : []
      const winPts = []
      for (let i = 0; i < rawWin.length; i++) {
        const p = rawWin[i]
        if (!p || typeof p.length !== 'number' || p.length < 2) continue
        const wx = Number(p[0])
        const wy = Number(p[1])
        if (!Number.isFinite(wx) || !Number.isFinite(wy)) continue
        winPts.push([wx, wy])
      }
      const winLine = winPts.length >= 2
        ? h('polyline', {
          key: 'win',
          points: winPts.map((p) => pos(p[0]) + ',' + pos(p[1])).join(' '),
          fill: 'none',
          stroke: INK.winLine,
          strokeWidth: 2.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          opacity: 0.8,
          pointerEvents: 'none',
        })
        : null
      const winRings = winPts.length
        ? h('g', { key: 'rings', pointerEvents: 'none' }, winPts.map((p, i) => h('circle', {
          key: 'ring' + i,
          cx: pos(p[0]),
          cy: pos(p[1]),
          r: R + 2.4,
          fill: 'none',
          stroke: INK.winRing,
          strokeWidth: 2.2,
          opacity: 0.95,
          pointerEvents: 'none',
        })))
        : null

      /* 最后一手：黑子上打白点，白子上打黑点 */
      const lm = snap && snap.lastMove
      let lastDot = null
      if (lm && Number.isFinite(Number(lm.x)) && Number.isFinite(Number(lm.y))) {
        const lx = Number(lm.x)
        const ly = Number(lm.y)
        if (lx >= 0 && lx < GRID && ly >= 0 && ly < GRID) {
          const whiteStone = at(lx, ly) === MODEL || lm.c === MODEL
          lastDot = h('circle', {
            key: 'last',
            cx: pos(lx),
            cy: pos(ly),
            r: 3,
            fill: whiteStone ? INK.dotOnWhite : INK.dotOnBlack,
            opacity: 0.92,
            pointerEvents: 'none',
          })
        }
      }

      /* 悬停幽灵子（人 = 黑）。⚠️ 必须 pointer-events:none —— 否则它盖在交互层上面，
         鼠标一悬停，接下来那一下点击就打在幽灵子上而不是下面的格子里，表现就是「点不动」。 */
      const ghost = playable && hover && !at(hover.x, hover.y)
        ? h('circle', {
          key: 'ghost',
          cx: pos(hover.x),
          cy: pos(hover.y),
          r: R,
          fill: blackFill,
          opacity: 0.4,
          stroke: INK.ghostEdge,
          strokeWidth: 0.8,
          pointerEvents: 'none',
        })
        : null

      /* 网格 + 星位 + 坐标标注 */
      const gridD = []
      for (let i = 0; i < GRID; i++) {
        gridD.push('M' + pos(i) + ',' + G0 + 'V' + LAST)
        gridD.push('M' + G0 + ',' + pos(i) + 'H' + LAST)
      }
      const stars = STAR.map((p, i) => h('circle', {
        key: 'star' + i,
        cx: pos(p[0]),
        cy: pos(p[1]),
        r: 2.7,
        fill: INK.star,
        opacity: 0.75,
      }))
      const coordLabels = []
      for (let i = 0; i < GRID; i++) {
        coordLabels.push(h('text', {
          key: 'col' + i,
          'data-gm-coord': '',
          x: pos(i),
          y: G0 - 13,
          textAnchor: 'middle',
          dominantBaseline: 'middle',
          fontSize: 9,
          fill: INK.label,
          fillOpacity: 0.85,
        }, COLS[i]))
      }
      for (let j = 0; j < GRID; j++) {
        coordLabels.push(h('text', {
          key: 'row' + j,
          'data-gm-coord': '',
          x: G0 - 13,
          y: pos(j),
          textAnchor: 'middle',
          dominantBaseline: 'middle',
          fontSize: 9,
          fill: INK.label,
          fillOpacity: 0.85,
        }, String(GRID - j)))
      }

      return h('svg', {
        'data-gm-board': '',
        'data-gm-playable': playable ? '' : undefined,
        role: 'img',
        'aria-label': s.boardAria,
        viewBox: '0 0 ' + VIEW + ' ' + VIEW,
        // 鼠标离开棋盘就清掉幽灵子（否则它会停在最后悬停的那一格）
        onMouseLeave: () => setHover(null),
      },
        h('defs', { key: 'defs' },
          h('radialGradient', {
            key: 'gblack',
            id: uid + '-black',
            cx: '36%',
            cy: '30%',
            r: '78%',
          },
            h('stop', { offset: '0%', stopColor: INK.blackHi }),
            h('stop', { offset: '38%', stopColor: INK.blackMid }),
            h('stop', { offset: '100%', stopColor: INK.blackLo })),
          h('radialGradient', {
            key: 'gwhite',
            id: uid + '-white',
            cx: '36%',
            cy: '30%',
            r: '78%',
          },
            h('stop', { offset: '0%', stopColor: INK.whiteHi }),
            h('stop', { offset: '58%', stopColor: INK.whiteMid }),
            h('stop', { offset: '100%', stopColor: INK.whiteLo })),
          h('linearGradient', {
            key: 'gwood',
            id: uid + '-wood',
            x1: '0%',
            y1: '0%',
            x2: '100%',
            y2: '100%',
          },
            h('stop', { offset: '0%', stopColor: INK.woodFrom }),
            h('stop', { offset: '100%', stopColor: INK.woodTo }))),
        h('rect', {
          key: 'wood',
          x: 12, y: 12, width: 456, height: 456, rx: 10,
          fill: 'url(#' + uid + '-wood)',
          stroke: INK.woodEdge,
          strokeWidth: 1,
        }),
        h('rect', {
          key: 'woodinner',
          x: 15.5, y: 15.5, width: 449, height: 449, rx: 7.5,
          fill: 'none', stroke: INK.woodInner, strokeWidth: 1,
        }),
        h('path', {
          key: 'grid',
          d: gridD.join(' '),
          fill: 'none',
          stroke: INK.line,
          strokeWidth: 1,
          strokeOpacity: 0.55,
        }),
        h('rect', {
          key: 'border',
          x: G0, y: G0, width: LAST - G0, height: LAST - G0,
          fill: 'none',
          stroke: INK.lineEdge,
          strokeWidth: 1.6,
          strokeOpacity: 0.85,
        }),
        h('g', { key: 'stars' }, stars),
        h('g', { key: 'labels' }, coordLabels),
        winLine,
        h('g', { key: 'cells' }, cells),
        h('g', { key: 'stones', style: { pointerEvents: 'none' } }, stones),
        winRings,
        lastDot,
        ghost)
    }

    /* ============================================================
     * 7. Dock：收起 = 入口条，展开 = 卡片 + 棋盘
     * ============================================================ */
    let pluginCtx = null
    let uidSeq = 0

    function Dock(props) {
      const sessionId = props ? props.sessionId : undefined
      const zh = isZh(localeOf(pluginCtx))
      const s = zh ? STR.zh : STR.en
      const [uid] = React.useState(() => {
        uidSeq += 1
        return 'gmb' + uidSeq
      })

      const [expanded, setExpanded] = React.useState(false)
      const [snap, setSnap] = React.useState(null)
      const [err, setErr] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [confirmResign, setConfirmResign] = React.useState(false)

      const alive = React.useRef(true)
      const warned = React.useRef(false)
      const busyRef = React.useRef('')
      const resignTimer = React.useRef(null)
      /** 最近一次提交的快照；act 用它当「动作前局面」的 base（闭包里的可能已过期）。 */
      const snapRef = React.useRef(null)
      /** 未结算的乐观快照：{ snap, base, at }。base = 动作前的局面，at = 收到 pending 的时间。 */
      const pendingRef = React.useRef(null)

      React.useEffect(() => {
        snapRef.current = snap
      }, [snap])

      /* unmount：停掉 dismiss 用的计时器，并让后续异步回调不再 setState */
      React.useEffect(() => () => {
        alive.current = false
        if (resignTimer.current) {
          clearTimeout(resignTimer.current)
          resignTimer.current = null
        }
      }, [])

      /* 切换会话：清掉上一局的数据、未结算的乐观快照和未完成的动作 */
      React.useEffect(() => {
        setSnap(null)
        setErr(null)
        setConfirmResign(false)
        busyRef.current = ''
        setBusy('')
        pendingRef.current = null
        if (resignTimer.current) {
          clearTimeout(resignTimer.current)
          resignTimer.current = null
        }
      }, [sessionId])

      /* 轮询：挂载即取一次；展开 1200ms / 收起 5000ms（切换时重建 interval） */
      React.useEffect(() => {
        if (!sessionId) return undefined
        let stopped = false
        const tick = async () => {
          try {
            const value = await requestState(sessionId)
            if (stopped || !alive.current) return
            const pending = pendingRef.current
            if (pending) {
              const settled = stateFingerprint(value) !== stateFingerprint(pending.base)
              const expired = Date.now() - pending.at >= PENDING_TTL
              if (!settled && !expired) {
                // 动作已提交但日志还没落地：轮询拿到的还是旧局面，不能覆盖乐观快照
                // （否则刚点的子会消失、回合回到人、棋盘重新可点 → 重复排队同一手）。
                setErr((prev) => (prev && prev.kind === 'act' ? prev : null))
                return
              }
              // 指纹变了（日志前进了）或超时：乐观快照退休，听轮询的
              pendingRef.current = null
            }
            setSnap(value)
            // 轮询成功只清掉轮询错误；动作失败（例如 Host 拒绝某手）留着给人看
            setErr((prev) => (prev && prev.kind === 'act' ? prev : null))
          } catch (e) {
            if (stopped || !alive.current) return
            const info = toErr(e, 'poll')
            setErr(info)
            if (!warned.current) {
              warned.current = true
              console.warn('[dsh-gomoku] state poll failed:', info.message)
            }
          }
        }
        tick()
        const timer = setInterval(tick, expanded ? 1200 : 5000)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [sessionId, expanded])

      /* ── 乐观快照：pending 未结算时，渲染 / canPlay / 状态文案全部以它为准 ── */
      const pendingActive = Boolean(pendingRef.current)
      const shown = (pendingRef.current && pendingRef.current.snap) || snap

      /* 局结束了就把「确认认输」的状态复位 */
      const statusKey = shown ? shown.status : 'idle'
      React.useEffect(() => {
        if (statusKey !== 'playing' && confirmResign) {
          setConfirmResign(false)
          if (resignTimer.current) {
            clearTimeout(resignTimer.current)
            resignTimer.current = null
          }
        }
      }, [statusKey, confirmResign])

      const act = async (action, extra) => {
        if (!sessionId || busyRef.current) return
        busyRef.current = action
        setBusy(action)
        const before = snapRef.current
        try {
          const value = await requestAct(sessionId, action, extra)
          if (!alive.current) return
          if (value && value.pending === true && before && stateFingerprint(value) !== stateFingerprint(before)) {
            // 动作已提交、但会话日志还没落地：挂住乐观快照，别让下一次轮询用旧局面盖掉它。
            // 只有「乐观局面确实不同于动作前」才挂：空盘上点「新局」局面没变，
            // 挂住只会把棋盘白锁 15 秒（指纹永远不变 → 永远不结算）。
            pendingRef.current = { snap: value, base: before, at: Date.now() }
          } else {
            pendingRef.current = null
          }
          setSnap(value)
          setErr(null)
        } catch (e) {
          const info = toErr(e, 'act')
          if (!alive.current) return
          setErr(info)
          if (!warned.current) {
            warned.current = true
            console.warn('[dsh-gomoku] action failed:', info.message)
          }
        } finally {
          busyRef.current = ''
          if (alive.current) setBusy('')
        }
      }

      const human = (shown && shown.human) || HUMAN
      const playing = Boolean(shown && shown.status === 'playing')
      const idle = Boolean(shown && shown.status === 'idle')
      const thinking = Boolean(shown && shown.thinking)
      const started = Boolean(shown && shown.started)
      const busyAny = Boolean(busy)
      // 注意：Host 的 `new` 只是把局面重置成 idle（moves = 0），第一手必须由人落下
      // （lib/game.js 的 placeMove 在 idle 局面接受黑棋）。所以 idle 也必须可点，
      // 否则「新局 → idle」之后就再也没有办法开始对局了。
      // 但 pending 未结算时一律不放行：'new' 的乐观快照正好是 idle / turn=human，
      // 放行会让人在日志落地前重复排队同一手（甚至把刚点的子顶掉）。
      const canPlay = Boolean(
        !pendingActive &&
        shown &&
        (playing || idle) &&
        shown.turn === human &&
        !shown.thinking &&
        !busyAny
      )
      const thinkingDots = Boolean(playing && thinking && shown.turn !== human)

      const onMove = (x, y) => {
        if (canPlay) act('move', { x, y })
      }

      const onResign = () => {
        if (!playing || busyAny || pendingActive) return
        if (!confirmResign) {
          setConfirmResign(true)
          if (resignTimer.current) clearTimeout(resignTimer.current)
          resignTimer.current = setTimeout(() => {
            resignTimer.current = null
            if (alive.current) setConfirmResign(false)
          }, 3000)
          return
        }
        if (resignTimer.current) {
          clearTimeout(resignTimer.current)
          resignTimer.current = null
        }
        setConfirmResign(false)
        act('resign')
      }

      const info = statusInfo(shown, s)
      const errLine = err ? errTextOf(err, s) : ''
      const summary = shown ? info.text : (errLine || s.loading)
      const barTone = !shown && errLine ? 'bad' : 'muted'

      /* ---- 收起态：一行入口条 ---- */
      const bar = h('button', {
        key: 'bar',
        type: 'button',
        'data-gm-bar': '',
        'aria-expanded': false,
        'aria-label': s.expandAria,
        title: s.expandAria,
        onClick: () => setExpanded(true),
      },
        h(BarIcon, { key: 'icon' }),
        h('span', { key: 'title', 'data-gm-bartitle': '' }, s.title),
        h('span', {
          key: 'sum',
          'data-gm-barsum': '',
          'data-gm-tone': barTone,
        }, summary),
        h(Chevron, { key: 'chev' }))

      /* ---- 展开态：卡片 ---- */
      const head = h('div', { key: 'head', 'data-gm-head': '' },
        h('span', { key: 'title', 'data-gm-title': '' }, s.title),
        h('span', {
          key: 'status',
          'data-gm-status': '',
          'data-gm-tone': info.tone,
          'aria-live': 'polite',
        },
          info.text,
          thinkingDots
            ? h('span', { key: 'dots', 'data-gm-dots': '', 'aria-hidden': 'true' },
              h('span'), h('span'), h('span'))
            : null),
        h('div', { key: 'actions', 'data-gm-actions': '' },
          mkButton('new', s.newGame, s.newGameAria, () => act('new'), {
            disabled: busyAny || pendingActive || (playing && thinking),
          }),
          mkButton('undo', s.undo, s.undoAria, () => act('undo'), {
            disabled: !started || thinking || busyAny || pendingActive,
          }),
          mkButton('resign', confirmResign ? s.confirmResign : s.resign, s.resignAria, onResign, {
            disabled: !playing || busyAny || pendingActive,
            danger: true,
            strong: confirmResign,
          }),
          mkButton('fold', s.collapse, s.collapseAria, () => setExpanded(false), {
            expanded: true,
          })))

      const card = h('div', { key: 'card', 'data-gm-card': '' },
        head,
        errLine ? h('div', { key: 'err', 'data-gm-err': '', title: errLine }, errLine) : null,
        h(Board, {
          key: 'board',
          snap: shown,
          playable: canPlay,
          onMove,
          uid,
          s,
        }))

      return h(React.Fragment, null,
        h('style', { key: 'style' }, CSS),
        h('div', { key: 'root', 'data-gm-root': '' }, expanded ? card : bar))
    }

    /* ============================================================
     * 8. 注册
     * ============================================================ */
    return {
      inject: ['slots'],
      apply(ctx) {
        pluginCtx = ctx
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'dsh-gomoku',
          order: 30,
        }, Dock))
      },
    }
  },
})
