/**
 * dsh-gomoku — 在 DeepSeek Harness 里和模型下五子棋（Host 半端）
 * ============================================================================
 * 这一半负责三件事：
 *   1. **对局状态**：从会话日志里「重建」出来，不存插件私有状态。
 *      人的每一手 / 开新局 / 悔棋 / 认输 = 一条带 `【五子棋】` 前缀的用户消息；
 *      模型的每一手 = 一条 `gomoku_play` 工具调用。两者都已在 Session 日志里，
 *      于是 `fold(session.snapshotEvents())` 就是唯一事实来源：刷新、fork、重启
 *      都能重建棋盘（符合 DSH「日志是唯一事实来源」的约定）。
 *   2. **模型侧的入口**：注册 `gomoku_play` / `gomoku_state` 两个工具。
 *      工具执行时这一手 `tool/call` **已经**在日志里了，所以 execute 不再「落子」，
 *      只校验「折叠出来的局面里最后一手是不是这一手」，避免同一手应用两次。
 *   3. **浏览器侧的入口**：`/dsh-gomoku/api/state|act` 两条同源 JSON 接口。
 *      客户端点棋盘 -> act(move) -> 这里把一手写成用户消息（agent.followup），
 *      既唤醒模型、又把这一手落到日志里。
 * 纯规则在 lib/game.js（无 IO，可单测）。
 * ============================================================================
 */
import { randomUUID } from 'node:crypto'
import {
  EMPTY, HUMAN, MODEL, SIZE, TAG,
  applyEvent, coordLabel, initialState, isOver, placeMove, renderBoard,
  resign, resolveArgs, snapshotOf, statusLabel, turnOf, undoMove,
} from './lib/game.js'

export const name = 'dsh-gomoku'
export const inject = ['webServer', 'tools']

const API_PREFIX = '/dsh-gomoku/api'
const MAX_BODY = 64 * 1024
const CACHE_LIMIT = 128

/* ═══════════════════════════════ 给模型 / 用户看的文案 ═══════════════════════════════ */

const HOW_TO = '轮到你（白棋 O）。请调用 `gomoku_play` 工具落子：`move` 传人类坐标（例如 "H8"，列 A–O 从左到右，行 1–15 从下到上，最下面一行是 1）。'

function explainIllegal(state, type, payload) {
  if (type !== 'move') return '这一步不能执行'
  if (isOver(state)) return '对局已经结束了，开个新局吧'
  if (turnOf(state) !== HUMAN) return '现在不是你的回合'
  const x = Number(payload?.x)
  const y = Number(payload?.y)
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= SIZE || y >= SIZE) {
    return '落子坐标不对'
  }
  if (state.board[y * SIZE + x] !== EMPTY) return '这个交叉点已经有子了'
  return '这一手不合法'
}

/** 人做的一个动作 -> 写进对话的那段话（第一行就是折叠时要解析的那一行）。 */
function messageFor(kind, state, cell) {
  if (kind === 'new') {
    return [
      `${TAG}开新局，我执黑先行。`,
      '',
      '棋盘：15 路五子棋，X 是我的黑棋，O 是你的白棋，我先行。',
      '等我落下第一手，我会把棋盘贴给你，你再用 `gomoku_play` 应一手。',
    ].join('\n')
  }
  if (kind === 'undo') {
    return [
      `${TAG}悔棋：撤销上一手（我的一手和你的一手都撤掉，重新轮到我）。`,
      '',
      '```',
      renderBoard(state),
      '```',
      '',
      '这一手不需要你落子，等我的下一手。',
    ].join('\n')
  }
  if (kind === 'resign') {
    return `${TAG}我认输，这局你赢了。我们随时可以开新局。`
  }
  return [
    `${TAG}我落子 ${coordLabel(cell.x, cell.y)}（第 ${state.moves.length} 手）。`,
    '',
    '当前棋盘（X 是我的黑棋，O 是你的白棋）：',
    '```',
    renderBoard(state),
    '```',
    '',
    HOW_TO,
  ].join('\n')
}

/** 工具成功后给模型看的文本。 */
function toolBoardText(state, note) {
  const lines = []
  if (note) lines.push(note, '')
  lines.push('```', renderBoard(state), '```', '')
  const last = state.moves.length > 0 ? state.moves[state.moves.length - 1] : null
  lines.push(`最后一手：${last ? coordLabel(last.x, last.y) : '无'}`)
  lines.push(`状态：${statusLabel(state)}`)
  if (isOver(state)) {
    if (state.status === 'model-win') lines.push('你连成五子，赢了这局。等用户开新局。')
    if (state.status === 'human-win') lines.push('用户连成五子，这局用户赢了。')
    if (state.status === 'human-resign') lines.push('用户认输了，这局你赢了。')
    if (state.status === 'draw') lines.push('平局。')
  } else if (turnOf(state) === HUMAN) {
    lines.push('现在等用户在棋盘上落子，不要连续落子。')
  }
  return lines.join('\n')
}

const TOOL_OUTPUT = {
  schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

/* ═══════════════════════════════ 插件主体 ═══════════════════════════════ */

export function apply(ctx) {
  /** sessionId -> { eventsLength, lastSeq, state } —— 只缓存折叠结果，日志才是事实。 */
  const foldCache = new Map()

  /** 活着的会话对象（Host 内存里的 Session）与它的 agent。 */
  function live(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null
    let agent
    try { agent = ctx.get('agents')?.get?.(sessionId) } catch { agent = undefined }
    let session
    try { session = ctx.get('sessions')?.get?.(sessionId) } catch { session = undefined }
    if (!session && agent?.session) session = agent.session
    if (!session) return null
    return { session, agent }
  }

  /** 增量折叠：日志是 append-only，所以只在尾部追加时继续算。 */
  function foldSession(session) {
    let events = []
    try { events = session.snapshotEvents() } catch { events = [] }
    const key = String(session?.id ?? '')
    const lastSeq = events.length > 0 ? events[events.length - 1].seq : undefined
    let entry = foldCache.get(key)
    const usable = entry !== undefined
      && entry.eventsLength <= events.length
      && (entry.eventsLength === 0 || events[entry.eventsLength - 1]?.seq === entry.lastSeq)
    if (!usable) entry = { eventsLength: 0, lastSeq: undefined, state: initialState() }

    let state = entry.state
    for (let i = entry.eventsLength; i < events.length; i++) {
      state = applyEvent(state, events[i])
    }
    if (foldCache.size >= CACHE_LIMIT && !foldCache.has(key)) {
      const oldest = foldCache.keys().next().value
      if (oldest !== undefined) foldCache.delete(oldest)
    }
    foldCache.set(key, { eventsLength: events.length, lastSeq, state })
    return { state, events }
  }

  /* ─────────── 工具 ─────────── */

  /** 工具执行时拿到的调用方 agent（`exec.agent` 是规范入口）。 */
  function agentOf(exec) {
    if (exec?.agent) return exec.agent
    try { return ctx.get('agents')?.currentInitiator?.() } catch { return undefined }
  }

  /** 当前这一手为什么不能落（给模型看的解释）。 */
  function reasonFor(state, cell) {
    if (state.board[cell.y * SIZE + cell.x] !== EMPTY) return '那个交叉点已经有棋子了'
    if (isOver(state)) return '对局已经结束了'
    if (turnOf(state) === HUMAN) return '现在不是你的回合（用户在走）'
    return '这一手不合法'
  }

  ctx.effect(() => ctx.tools.register({
    name: 'gomoku_play',
    description: '在「五子棋」对局里落一手白棋（你是白棋 O，用户是黑棋 X，用户先行）。'
      + '用户在输入框上方的棋盘上点黑棋，轮到你时调用本工具。'
      + '参数 move 用人类坐标，例如 "H8"：列 A–O 从左到右，行 1–15 从下到上（最下面一行是 1）。'
      + '也可以传 x / y（0–14，x 从左到右，y 从上到下）。落子不合法时工具会报错，请换一手。',
    parameters: {
      type: 'object',
      properties: {
        move: { type: 'string', description: '人类坐标，如 "H8"（列 A–O，行 1–15）' },
        x: { type: 'number', description: '可选：0–14，从左到右（与 move 二选一）' },
        y: { type: 'number', description: '可选：0–14，从上到下（与 move 二选一）' },
      },
      additionalProperties: false,
    },
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      exec?.signal?.throwIfAborted?.()
      const session = agentOf(exec)?.session
      if (!session) throw new Error('找不到当前会话，无法读取五子棋局面')
      const cell = resolveArgs(args)
      if (cell === null) throw new Error('请给出落子坐标：move 例如 "H8"，或 x / y（0–14）')

      const { state } = foldSession(session)
      // 这一手 tool/call 在执行前就进了日志：折叠结果里最后一手就是它 -> 已经生效。
      const last = state.moves.length > 0 ? state.moves[state.moves.length - 1] : null
      if (last !== null && last.c === MODEL && last.x === cell.x && last.y === cell.y) {
        return { text: toolBoardText(state) }
      }
      // 还没进日志（或这一手不合法）：在折叠结果上真落一手来判断。
      const next = placeMove(state, cell.x, cell.y, MODEL)
      if (next === state) {
        throw new Error(`${coordLabel(cell.x, cell.y)} 不能落子：${reasonFor(state, cell)}`)
      }
      return { text: toolBoardText(next) }
    },
  }), 'dsh-gomoku: gomoku_play tool')

  ctx.effect(() => ctx.tools.register({
    name: 'gomoku_state',
    description: '查看当前五子棋棋盘（不落子）。需要重新核对局面、或不确定轮到谁时调用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: TOOL_OUTPUT,
    async execute(_args, exec) {
      const session = agentOf(exec)?.session
      if (!session) throw new Error('找不到当前会话，无法读取五子棋局面')
      return { text: toolBoardText(foldSession(session).state) }
    },
  }), 'dsh-gomoku: gomoku_state tool')

  /* ─────────── 浏览器侧 API ─────────── */

  function requireSession(payload) {
    const sessionId = payload && typeof payload.sessionId === 'string' ? payload.sessionId : ''
    if (sessionId === '') {
      const error = new Error('缺少 sessionId')
      error.status = 400
      throw error
    }
    const found = live(sessionId)
    if (!found) {
      const error = new Error('这个会话当前没有激活，棋盘暂时不可用')
      error.status = 404
      throw error
    }
    return found
  }

  /** 把一个动作变成「下一帧局面 + 写进对话的那段话」。 */
  function describeAction(action, before, payload) {
    if (action === 'move') {
      const x = Number(payload?.x)
      const y = Number(payload?.y)
      const next = placeMove(before, x, y, HUMAN)
      if (next === before) {
        const error = new Error(explainIllegal(before, 'move', payload))
        error.status = 400
        throw error
      }
      return { next, text: messageFor('move', next, { x, y }) }
    }
    if (action === 'new') {
      const next = initialState()
      return { next, text: messageFor('new', next, null) }
    }
    if (action === 'undo') {
      const next = undoMove(before)
      if (next === before) {
        const error = new Error('还没有落子，没有可悔的棋')
        error.status = 400
        throw error
      }
      return { next, text: messageFor('undo', next, null) }
    }
    if (action === 'resign') {
      if (isOver(before)) {
        const error = new Error('对局已经结束了')
        error.status = 400
        throw error
      }
      if (before.status === 'idle') {
        const error = new Error('还没有开局，先落一手吧')
        error.status = 400
        throw error
      }
      return { next: resign(before), text: messageFor('resign', before, null) }
    }
    const error = new Error(`不认识的 action：${String(action)}`)
    error.status = 400
    throw error
  }

  function userMessage(text) {
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }
  }

  const signature = (state) => `${state.moves.length}|${state.status}|${turnOf(state)}`

  const api = {
    state(payload) {
      const { session } = requireSession(payload)
      const { state, events } = foldSession(session)
      return snapshotOf(state, events)
    },

    async act(payload) {
      const { session, agent } = requireSession(payload)
      if (!agent) {
        const error = new Error('这个会话没有运行中的 agent，落子无法交给模型')
        error.status = 409
        throw error
      }
      const action = typeof payload.action === 'string' ? payload.action : ''
      const before = foldSession(session).state
      const described = describeAction(action, before, payload)

      try {
        agent.followup(userMessage(described.text))
      } catch (error) {
        ctx.logger?.warn?.('dsh-gomoku: followup failed: %s', String(error?.message ?? error))
        const failure = new Error('落子没能送进对话（agent 拒绝了这次输入）')
        failure.status = 500
        throw failure
      }

      const after = foldSession(session)
      const pending = signature(after.state) === signature(before)
      return {
        ...snapshotOf(pending ? described.next : after.state, after.events),
        pending,
      }
    },
  }

  /* ─────────── HTTP 路由 ─────────── */

  function loopback(req) {
    const host = String(req?.headers?.host ?? '')
    if (!/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i.test(host)) return false
    if (String(req?.headers?.['sec-fetch-site'] ?? '') === 'cross-site') return false
    const origin = req?.headers?.origin
    if (typeof origin !== 'string' || origin === '') return true
    try {
      return new URL(origin).hostname === new URL(`http://${host}`).hostname
    } catch {
      return false
    }
  }

  /** DSH 对浏览器路由的准入检查；拿不到 connection 时退回 loopback 校验。 */
  function admit(req) {
    const isLoopback = loopback(req)
    const connection = ctx.get('connection')
    if (connection?.requestRejection) {
      try {
        const rejection = connection.requestRejection({ headers: req.headers })
        if (rejection === 403) return 403
        if (rejection === 401 && !isLoopback) return 401
      } catch {
        // 检查抛错时不要因此放行任意来源
      }
    }
    return isLoopback ? 0 : 403
  }

  function send(res, status, body) {
    if (res.writableEnded || res.headersSent) return
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(body))
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let settled = false
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY) {
          if (!settled) { settled = true; reject(Object.assign(new Error('请求体过大'), { status: 413 })) }
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (settled) return
        settled = true
        if (chunks.length === 0) { resolve({}); return }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }))
        }
      })
      req.on('error', (error) => {
        if (!settled) { settled = true; reject(error) }
      })
    })
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const rejection = admit(req)
      if (rejection !== 0) {
        send(res, rejection, { ok: false, error: rejection === 401 ? '未登录或登录已失效' : '这个来源不允许访问' })
        return
      }
      if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: '只支持 POST' })
        return
      }
      let pathname = ''
      try { pathname = new URL(String(req.url ?? '/'), 'http://dsh.invalid').pathname } catch { /* 保持空 */ }
      const endpoint = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : ''
      try {
        const payload = await readJson(req)
        if (endpoint === '/state') {
          send(res, 200, { ok: true, value: api.state(payload) })
          return
        }
        if (endpoint === '/act') {
          send(res, 200, { ok: true, value: await api.act(payload) })
          return
        }
        send(res, 404, { ok: false, error: '不认识的接口' })
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 400
        send(res, status, { ok: false, error: String(error?.message ?? error) })
      }
    },
  }), 'dsh-gomoku: /dsh-gomoku/api routes')
}
