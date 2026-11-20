/**
 * 五子棋的纯函数引擎：无 IO、无依赖、无状态。
 * ============================================================================
 * 坐标约定：
 *   · 内部 (x, y)：x 0–14 从左到右，y 0–14 从上到下，下标 = y * 15 + x；
 *   · 人类坐标：列 A–O（左→右）+ 行 1–15（下→上），所以天元 = "H8"。
 * 颜色：1 = 黑（人，先行），2 = 白（模型）。
 * 规则：15 路无禁手，任意方向连成 5 子或更多即胜。
 * ============================================================================
 */

export const SIZE = 15
export const EMPTY = 0
export const BLACK = 1
export const WHITE = 2
export const HUMAN = BLACK
export const MODEL = WHITE
export const CELLS = SIZE * SIZE
export const COLS = 'ABCDEFGHIJKLMNO'
export const TAG = '【五子棋】'

export const idx = (x, y) => y * SIZE + x

const FINISHED = new Set(['human-win', 'model-win', 'human-resign', 'draw'])

export function isOver(state) {
  return FINISHED.has(state.status)
}

/** 内部坐标 -> 人类坐标，如 (7,7) -> "H8" */
export function coordLabel(x, y) {
  return COLS[x] + String(SIZE - y)
}

/** "H8" -> {x:7,y:7}；不合法返回 null。 */
export function parseCoordText(text) {
  const match = /^([A-Za-z])\s*(\d{1,2})$/.exec(String(text ?? '').trim())
  if (!match) return null
  const x = COLS.indexOf(match[1].toUpperCase())
  const y = SIZE - Number(match[2])
  if (x < 0 || x >= SIZE) return null
  if (!Number.isInteger(y) || y < 0 || y >= SIZE) return null
  return { x, y }
}

export function initialState() {
  return {
    board: new Array(CELLS).fill(EMPTY),
    moves: [],
    status: 'idle',
    winLine: null,
  }
}

/** 轮到谁：黑先、一手一换；对局结束后为 0。 */
export function turnOf(state) {
  if (isOver(state)) return 0
  return state.moves.length % 2 === 0 ? BLACK : WHITE
}

/** (x,y) 落 color 后是否连成五（含长连）；返回该线上的坐标，否则 null。 */
export function winLineAt(board, x, y, color) {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]]
  for (const [dx, dy] of dirs) {
    const line = [[x, y]]
    for (const sign of [1, -1]) {
      let nx = x + dx * sign
      let ny = y + dy * sign
      while (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE && board[idx(nx, ny)] === color) {
        line.push([nx, ny])
        nx += dx * sign
        ny += dy * sign
      }
    }
    if (line.length >= 5) {
      line.sort((a, b) => (a[0] * dx + a[1] * dy) - (b[0] * dx + b[1] * dy))
      return line
    }
  }
  return null
}

/**
 * 落子。不合法时**原样返回同一个 state**（调用方用引用相等判断是否成功）。
 */
export function placeMove(state, x, y, color) {
  if (isOver(state)) return state
  if (turnOf(state) !== color) return state
  if (!Number.isInteger(x) || !Number.isInteger(y)) return state
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return state
  if (state.board[idx(x, y)] !== EMPTY) return state

  const board = state.board.slice()
  board[idx(x, y)] = color
  const moves = state.moves.concat([{ x, y, c: color }])
  const winLine = winLineAt(board, x, y, color)
  if (winLine) {
    return { board, moves, status: color === HUMAN ? 'human-win' : 'model-win', winLine }
  }
  if (moves.length >= CELLS) {
    return { board, moves, status: 'draw', winLine: null }
  }
  return { board, moves, status: 'playing', winLine: null }
}

/** 悔棋：退回到人的回合——一直退到「剩余手数为偶数」（黑先，所以偶数就是人的回合）。 */
export function undoMove(state) {
  if (state.moves.length === 0) return state
  const moves = state.moves.slice()
  moves.pop()
  if (moves.length % 2 === 1) moves.pop()
  const board = new Array(CELLS).fill(EMPTY)
  for (const move of moves) board[idx(move.x, move.y)] = move.c
  return { board, moves, status: moves.length > 0 ? 'playing' : 'idle', winLine: null }
}

/** 认输：人向模型认输。 */
export function resign(state) {
  if (isOver(state)) return state
  return { ...state, status: 'human-resign', winLine: null }
}

/** 给模型看的 ASCII 棋盘。 */
export function renderBoard(state) {
  const head = '    ' + COLS.split('').join(' ')
  const rows = []
  for (let y = 0; y < SIZE; y++) {
    const cells = []
    for (let x = 0; x < SIZE; x++) {
      const value = state.board[idx(x, y)]
      cells.push(value === BLACK ? 'X' : value === WHITE ? 'O' : '.')
    }
    rows.push(String(SIZE - y).padStart(2, ' ') + '  ' + cells.join(' '))
  }
  return [head, ...rows, head].join('\n')
}

export function statusLabel(state) {
  switch (state.status) {
    case 'idle': return '对局还没开始'
    case 'playing': return turnOf(state) === HUMAN ? '轮到人（黑 X）落子' : '轮到模型（白 O）落子'
    case 'human-win': return '人（黑 X）连成五子获胜'
    case 'model-win': return '模型（白 O）连成五子获胜'
    case 'human-resign': return '人认输'
    case 'draw': return '棋盘下满，平局'
    default: return String(state.status)
  }
}

/* ─────────────────────────── 从会话日志折叠局面 ─────────────────────────── */

const MOVE_RE = /^【五子棋】\s*我落子\s*([A-Za-z])\s*(\d{1,2})/
const NEW_RE = /^【五子棋】\s*开新局/
const UNDO_RE = /^【五子棋】\s*悔棋/
const RESIGN_RE = /^【五子棋】\s*我认输/

function safeJson(text) {
  try { return JSON.parse(String(text)) } catch { return null }
}

/** 一条用户消息里我们自己生成的那一行（第一条以 TAG 开头的文本行）。 */
export function taggedLine(data) {
  const content = Array.isArray(data?.content) ? data.content : []
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    for (const line of block.text.split('\n')) {
      if (line.trimStart().startsWith(TAG)) return line.trimStart()
    }
  }
  return null
}

/** 用户消息 -> 人的动作（落子 / 开新局 / 悔棋 / 认输）。 */
export function applyUserMessage(state, data) {
  const line = taggedLine(data)
  if (line === null) return state
  if (NEW_RE.test(line)) return initialState()
  if (UNDO_RE.test(line)) return undoMove(state)
  if (RESIGN_RE.test(line)) return resign(state)
  const match = MOVE_RE.exec(line)
  if (match) {
    const x = COLS.indexOf(match[1].toUpperCase())
    const y = SIZE - Number(match[2])
    if (x >= 0 && y >= 0 && y < SIZE) return placeMove(state, x, y, HUMAN)
  }
  return state
}

/** 工具参数 -> 坐标：优先 move 文本，其次 x / y（0–14）。 */
export function resolveArgs(args) {
  if (!args || typeof args !== 'object') return null
  if (typeof args.move === 'string') {
    const parsed = parseCoordText(args.move)
    if (parsed) return parsed
  }
  const x = Number(args.x)
  const y = Number(args.y)
  if (Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < SIZE && y < SIZE) {
    return { x, y }
  }
  return null
}

/** 一条日志事件对局面的影响。 */
export function applyEvent(state, event) {
  if (!event || typeof event.type !== 'string') return state
  if (event.type === 'user/message') return applyUserMessage(state, event.data)
  if (event.type === 'tool/call' && event.data?.name === 'gomoku_play') {
    const cell = resolveArgs(safeJson(event.data.arguments))
    if (cell) return placeMove(state, cell.x, cell.y, MODEL)
  }
  return state
}

/** 日志末尾是否有一轮正在进行（模型在思考 / 正在回话）。 */
export function isThinking(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i]?.type
    if (type === 'turn/end') return false
    if (type === 'turn/start') return true
  }
  return false
}

/** 浏览器侧看到的快照（纯 JSON）。 */
export function snapshotOf(state, events) {
  const last = state.moves.length > 0 ? state.moves[state.moves.length - 1] : null
  return {
    size: SIZE,
    board: state.board.slice(),
    turn: turnOf(state),
    status: state.status,
    winLine: state.winLine,
    lastMove: last,
    thinking: isThinking(events),
    human: HUMAN,
    model: MODEL,
    started: state.moves.length > 0,
    moveCount: state.moves.length,
  }
}
