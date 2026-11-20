/**
 * Host 半端胶水测试：用假 ctx 跑 index.js 的 apply()，直接调 HTTP handler 和工具 execute。
 *   node .dev/test-host.mjs
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { apply } from '../index.js'

let checks = 0
let chain = Promise.resolve()

/** 串行排队（异步测试也保持顺序，失败立即中断）。 */
function ok(name, fn) {
  chain = chain
    .then(async () => {
      await fn()
      checks += 1
      console.log(`  ok  ${name}`)
    })
    .catch((error) => {
      console.error(`  FAIL ${name}`)
      throw error
    })
}

function step(name) {
  chain = chain.then(() => console.log(name))
}

/* ─────────────── 假 DSH：session + agent + ctx ─────────────── */

function createFake({ liveAgent = true } = {}) {
  const events = []
  let seq = 0
  const append = (type, data) => {
    events.push({ type, seq: seq++, time: Date.now(), data })
  }
  const session = {
    id: 's1',
    get seq() { return seq },
    snapshotEvents: () => events.slice(),
  }
  const followups = []
  const agent = {
    id: 's1',
    session,
    followup(message) {
      followups.push(message)
      append('turn/start', { turn: 1 })
      append('user/message', message)
    },
  }
  const routes = []
  const tools = new Map()
  const services = {
    agents: liveAgent
      ? { get: (id) => (id === 's1' ? agent : undefined), currentInitiator: () => agent }
      : {},
    sessions: { get: (id) => (id === 's1' ? session : undefined) },
  }
  const ctx = {
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get(name) { return services[name] },
    logger: { warn: (...args) => console.warn('[host warn]', ...args) },
    tools: {
      register(def) {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    webServer: {
      register(route) { routes.push(route); return () => {} },
    },
  }
  return { ctx, events, agent, session, followups, routes, tools, append, setAgent: (next) => (services.agents.get = () => next) }
}

const exec = (fake) => ({ agent: fake.agent, signal: { throwIfAborted() {} } })

/** 直接调用注册进来的 prefix 路由（模拟一次同源 POST）。 */
async function callRoute(routes, path, body, { host = '127.0.0.1:1925', method = 'POST' } = {}) {
  const route = routes.find((candidate) => candidate.path === '/dsh-gomoku/api')
  assert.ok(route, '应注册 /dsh-gomoku/api 路由')
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = path
  req.headers = { host }
  const out = { status: 0, body: undefined }
  const res = {
    headersSent: false,
    writableEnded: false,
    writeHead(status) { out.status = status; this.headersSent = true },
    end(text) { out.body = JSON.parse(text); this.writableEnded = true },
  }
  await route.handler(req, res)
  return out
}

const tagged = (message) => {
  const text = message?.content?.[0]?.text ?? ''
  return typeof text === 'string' && text.startsWith('【五子棋】')
}

/* ─────────────── 测试 ─────────────── */

const fake = createFake()
apply(fake.ctx, {})

step('注册')
ok('注册了两个工具', () => {
  assert.deepEqual([...fake.tools.keys()].sort(), ['gomoku_play', 'gomoku_state'])
  assert.equal(fake.tools.get('gomoku_play').parameters.additionalProperties, false)
})
ok('注册了 /dsh-gomoku/api 前缀路由', () => {
  assert.equal(fake.routes.length, 1)
  assert.equal(fake.routes[0].kind, 'prefix')
})

step('GET /state')
ok('空棋盘初始快照', async () => {
  const out = await callRoute(fake.routes, '/dsh-gomoku/api/state', { sessionId: 's1' })
  assert.equal(out.status, 200)
  assert.equal(out.body.ok, true)
  assert.equal(out.body.value.status, 'idle')
  assert.equal(out.body.value.turn, 1)
  assert.equal(out.body.value.board.length, 225)
  assert.equal(out.body.value.started, false)
})
ok('缺 sessionId -> 400', async () => {
  const out = await callRoute(fake.routes, '/dsh-gomoku/api/state', {})
  assert.equal(out.status, 400)
  assert.equal(out.body.ok, false)
})
ok('未知会话 -> 404', async () => {
  const out = await callRoute(fake.routes, '/dsh-gomoku/api/state', { sessionId: 'nope' })
  assert.equal(out.status, 404)
})
ok('非 POST -> 405', async () => {
  const out = await callRoute(fake.routes, '/dsh-gomoku/api/state', undefined, { method: 'GET' })
  assert.equal(out.status, 405)
})
ok('非 loopback Host -> 403', async () => {
  const out = await callRoute(fake.routes, '/dsh-gomoku/api/state', { sessionId: 's1' }, { host: 'evil.example.com' })
  assert.equal(out.status, 403)
})
ok('未知接口 -> 404', async () => {
  const out = await callRoute(fake.routes, '/dsh-gomoku/api/nope', { sessionId: 's1' })
  assert.equal(out.status, 404)
})

step('POST /act move')
ok('人落一子：写进对话、棋盘前进、轮到模型', async () => {
  const out = await callRoute(fake.routes, '/dsh-gomoku/api/act', { sessionId: 's1', action: 'move', x: 7, y: 7 })
  assert.equal(out.status, 200, JSON.stringify(out.body))
  const value = out.body.value
  assert.equal(value.moveCount, 1)
  assert.equal(value.status, 'playing')
  assert.equal(value.turn, 2)
  assert.deepEqual(value.lastMove, { x: 7, y: 7, c: 1 })
  assert.equal(value.pending, false, 'followup 同步落日志，不应是乐观值')
  assert.equal(fake.followups.length, 1)
  assert.ok(tagged(fake.followups[0]), '应该是一条【五子棋】用户消息')
  assert.match(fake.followups[0].content[0].text, /我落子 H8/)
  assert.ok(fake.followups[0].id, '消息要有 id')
  assert.equal(fake.followups[0].role, 'user')
  assert.equal(fake.followups[0].source.kind, 'user')
  assert.equal(value.thinking, true, 'followup 之后有一轮在进行')
})
ok('同一格再点 -> 400 且不再写消息', async () => {
  const before = fake.followups.length
  const out = await callRoute(fake.routes, '/dsh-gomoku/api/act', { sessionId: 's1', action: 'move', x: 7, y: 7 })
  assert.equal(out.status, 400)
  assert.equal(out.body.ok, false)
  assert.ok(out.body.error.length > 0)
  assert.equal(fake.followups.length, before, '失败的动作不应写进对话')
})
ok('不是人的回合时点棋盘 -> 400', async () => {
  const out = await callRoute(fake.routes, '/dsh-gomoku/api/act', { sessionId: 's1', action: 'move', x: 0, y: 0 })
  assert.equal(out.status, 400)
  assert.match(out.body.error, /不是你的回合/)
})
ok('非法坐标 -> 400', async () => {
  const out = await callRoute(fake.routes, '/dsh-gomoku/api/act', { sessionId: 's1', action: 'move', x: 99, y: -1 })
  assert.equal(out.status, 400)
})
ok('不认识的 action -> 400', async () => {
  const out = await callRoute(fake.routes, '/dsh-gomoku/api/act', { sessionId: 's1', action: 'dance' })
  assert.equal(out.status, 400)
})

step('模型工具')
ok('tool/call 已入日志后 execute 不会再落一次', async () => {
  fake.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'gomoku_play', arguments: '{"move":"H9"}' })
  const out = await fake.tools.get('gomoku_play').execute({ move: 'H9' }, exec(fake))
  assert.match(out.text, /O/, '棋盘上应有白子')
  const state = await callRoute(fake.routes, '/dsh-gomoku/api/state', { sessionId: 's1' })
  assert.equal(state.body.value.moveCount, 2, '同一手只应算一次')
  assert.equal(state.body.value.turn, 1, '两手后轮到人')
})
ok('轮到人时模型硬走 -> 报错', async () => {
  await assert.rejects(() => fake.tools.get('gomoku_play').execute({ move: 'A1' }, exec(fake)), /不是你的回合/)
})
ok('落子坐标缺失 -> 报错', async () => {
  await assert.rejects(() => fake.tools.get('gomoku_play').execute({}, exec(fake)), /坐标/)
})
ok('gomoku_state 只读', async () => {
  const before = fake.events.length
  const out = await fake.tools.get('gomoku_state').execute({}, exec(fake))
  assert.match(out.text, /状态：/)
  assert.equal(fake.events.length, before)
})

step('悔棋 / 认输 / 新局')
ok('悔棋退回到人的回合', async () => {
  const out = await callRoute(fake.routes, '/dsh-gomoku/api/act', { sessionId: 's1', action: 'undo' })
  assert.equal(out.status, 200, JSON.stringify(out.body))
  assert.equal(out.body.value.moveCount, 0)
  assert.equal(out.body.value.status, 'idle')
  assert.equal(out.body.value.turn, 1)
  assert.match(fake.followups.at(-1).content[0].text, /悔棋/)
})
ok('空盘悔棋 -> 400', async () => {
  const out = await callRoute(fake.routes, '/dsh-gomoku/api/act', { sessionId: 's1', action: 'undo' })
  assert.equal(out.status, 400)
})
ok('没开局认输 -> 400', async () => {
  const out = await callRoute(fake.routes, '/dsh-gomoku/api/act', { sessionId: 's1', action: 'resign' })
  assert.equal(out.status, 400)
})
ok('新局写入一条【五子棋】消息', async () => {
  const out = await callRoute(fake.routes, '/dsh-gomoku/api/act', { sessionId: 's1', action: 'new' })
  assert.equal(out.status, 200)
  assert.match(fake.followups.at(-1).content[0].text, /开新局/)
  assert.equal(out.body.value.status, 'idle')
})

step('胜负与状态')
ok('人连五子 -> human-win', async () => {
  const human = [[0, 7], [1, 7], [2, 7], [3, 7], [4, 7]] // A8..E8
  const model = ['A1', 'B1', 'C1', 'D1']
  for (let i = 0; i < human.length; i += 1) {
    const [x, y] = human[i]
    const out = await callRoute(fake.routes, '/dsh-gomoku/api/act', { sessionId: 's1', action: 'move', x, y })
    assert.equal(out.status, 200, JSON.stringify(out.body))
    if (i < model.length) {
      fake.append('tool/call', { turn: 1, step: 1, callId: `w${i}`, name: 'gomoku_play', arguments: JSON.stringify({ move: model[i] }) })
    }
  }
  const state = await callRoute(fake.routes, '/dsh-gomoku/api/state', { sessionId: 's1' })
  assert.equal(state.body.value.status, 'human-win')
  assert.equal(state.body.value.turn, 0)
  assert.equal(state.body.value.winLine.length, 5)
  assert.equal(state.body.value.moveCount, 9)
})
ok('结束后再落子 -> 400', async () => {
  const out = await callRoute(fake.routes, '/dsh-gomoku/api/act', { sessionId: 's1', action: 'move', x: 10, y: 10 })
  assert.equal(out.status, 400)
  assert.match(out.body.error, /结束/)
})

step('没有 agent 的会话')
ok('只能看不能动（409）', async () => {
  const cold = createFake({ liveAgent: false })
  apply(cold.ctx, {})
  const state = await callRoute(cold.routes, '/dsh-gomoku/api/state', { sessionId: 's1' })
  assert.equal(state.status, 200)
  const act = await callRoute(cold.routes, '/dsh-gomoku/api/act', { sessionId: 's1', action: 'move', x: 7, y: 7 })
  assert.equal(act.status, 409)
})

await chain
console.log(`\n全部通过：${checks} 项检查`)
