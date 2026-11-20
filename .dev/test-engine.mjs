/**
 * 引擎单测（不属于插件包；只验证 lib/game.js 的纯函数）。
 *   node .dev/test-engine.mjs
 */
import assert from 'node:assert/strict'
import {
  BLACK, HUMAN, MODEL, SIZE, WHITE,
  applyEvent, applyUserMessage, coordLabel, initialState, isOver, parseCoordText,
  placeMove, renderBoard, resign, resolveArgs, snapshotOf, statusLabel, turnOf, undoMove,
} from '../lib/game.js'

let checks = 0
const ok = (label, fn) => {
  fn()
  checks += 1
  console.log(`  ok  ${label}`)
}

const play = (state, ...coords) => {
  let current = state
  for (const coord of coords) {
    const cell = parseCoordText(coord)
    const color = turnOf(current)
    current = placeMove(current, cell.x, cell.y, color)
  }
  return current
}
const userMsg = (text) => ({ content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user' })

console.log('坐标')
ok('H8 是正中', () => {
  assert.deepEqual(parseCoordText('H8'), { x: 7, y: 7 })
  assert.equal(coordLabel(7, 7), 'H8')
  assert.equal(coordLabel(0, 14), 'A1')
  assert.equal(coordLabel(14, 0), 'O15')
})
ok('非法坐标返回 null', () => {
  for (const bad of ['', 'Z9', 'A0', 'A16', 'HH8', '8H', null, undefined, 'A 1 2']) {
    assert.equal(parseCoordText(bad), null, `应拒绝 ${String(bad)}`)
  }
  assert.deepEqual(parseCoordText(' a1 '), { x: 0, y: 14 })
})
ok('工具参数两种写法', () => {
  assert.deepEqual(resolveArgs({ move: 'H8' }), { x: 7, y: 7 })
  assert.deepEqual(resolveArgs({ x: 3, y: 11 }), { x: 3, y: 11 })
  assert.equal(resolveArgs({ x: 3.5, y: 11 }), null)
  assert.equal(resolveArgs({ x: 15, y: 0 }), null)
  assert.equal(resolveArgs({ move: 'nope' }), null)
  assert.equal(resolveArgs(null), null)
})

console.log('落子规则')
ok('黑先，白不能抢先', () => {
  const s = initialState()
  assert.equal(turnOf(s), BLACK)
  const white = placeMove(s, 7, 7, WHITE)
  assert.equal(white, s, '白先手应原样返回')
  const black = placeMove(s, 7, 7, BLACK)
  assert.notEqual(black, s)
  assert.equal(turnOf(black), WHITE)
  assert.equal(black.moves.length, 1)
})
ok('已占的交叉点不能落', () => {
  const s = play(initialState(), 'H8')            // 黑 H8
  const again = placeMove(s, 7, 7, WHITE)
  assert.equal(again, s)
})
ok('越界不能落', () => {
  const s = initialState()
  assert.equal(placeMove(s, -1, 0, BLACK), s)
  assert.equal(placeMove(s, 0, 15, BLACK), s)
  assert.equal(placeMove(s, 1.2, 3, BLACK), s)
})

console.log('胜负判定')
ok('横向五连', () => {
  // 黑 A8..E8，白随便挡
  let s = initialState()
  s = play(s, 'A8', 'A1', 'B8', 'B1', 'C8', 'C1', 'D8', 'D1')
  s = play(s, 'E8')
  assert.equal(s.status, 'human-win')
  assert.equal(s.winLine.length, 5)
  assert.ok(isOver(s))
  assert.equal(placeMove(s, 0, 0, WHITE), s, '结束后不能再落')
})
ok('纵向五连（模型赢）', () => {
  let s = initialState()
  s = play(s, 'A15', 'H5', 'B15', 'H6', 'C15', 'H7', 'D15', 'H8')
  // 现在白连着 H5..H8 = 4 子，轮到黑
  s = play(s, 'M1')
  s = play(s, 'H9')
  assert.equal(s.status, 'model-win')
  assert.equal(s.winLine.length, 5)
})
ok('斜向五连', () => {
  let s = initialState()
  s = play(s, 'A1', 'O15', 'B2', 'O14', 'C3', 'O13', 'D4', 'O12')
  s = play(s, 'E5')
  assert.equal(s.status, 'human-win')
})
ok('反斜向五连', () => {
  let s = initialState()
  s = play(s, 'O1', 'A15', 'N2', 'A14', 'M3', 'A13', 'L4', 'A12')
  s = play(s, 'K5')
  assert.equal(s.status, 'human-win')
})
ok('长连（六子）也算赢', () => {
  // 黑 A8 B8 C8 + E8 F8，最后补 D8 -> A–F 连成六子（补之前并没有五连）
  let s = play(initialState(), 'A8', 'A1', 'B8', 'B1', 'C8', 'C1', 'E8', 'E1', 'F8', 'F1')
  assert.equal(s.status, 'playing', '补 D8 之前还没赢')
  s = play(s, 'D8')
  assert.equal(s.status, 'human-win')
  assert.ok(s.winLine.length >= 6, `winLine=${JSON.stringify(s.winLine)}`)
})
ok('四子还不算赢', () => {
  let s = play(initialState(), 'A8', 'A1', 'B8', 'B1', 'C8', 'C1', 'D8')
  assert.equal(s.status, 'playing')
  assert.equal(s.winLine, null)
})
ok('statusLabel 有话说', () => {
  let s = play(initialState(), 'A8', 'A1', 'B8', 'B1', 'C8', 'C1', 'D8', 'D1', 'E8')
  assert.match(statusLabel(s), /人.*获胜/)
  assert.match(statusLabel(initialState()), /还没开始/)
})

console.log('悔棋 / 认输 / 开新局')
ok('模型落子后悔两手，回到人的回合', () => {
  const s = play(initialState(), 'H8', 'H9')
  assert.equal(s.moves.length, 2)
  const back = undoMove(s)
  assert.equal(back.moves.length, 0)
  assert.equal(back.status, 'idle')
  assert.equal(turnOf(back), BLACK)
})
ok('只落了一手就悔棋 -> 退一手', () => {
  const s = play(initialState(), 'H8')
  const back = undoMove(s)
  assert.equal(back.moves.length, 0)
  assert.equal(turnOf(back), BLACK)
})
ok('空棋盘悔棋是 no-op（同一引用）', () => {
  const s = initialState()
  assert.equal(undoMove(s), s)
})
ok('认输', () => {
  const s = resign(play(initialState(), 'H8'))
  assert.equal(s.status, 'human-resign')
  assert.ok(isOver(s))
  assert.equal(resign(s), s, '已结束再认输是 no-op')
})

console.log('日志折叠')
ok('用户消息：落子 / 开新局 / 悔棋 / 认输', () => {
  let s = initialState()
  s = applyUserMessage(s, userMsg('【五子棋】我落子 H8（第 1 手）。\n\n```\n...\n```'))
  assert.deepEqual(s.moves[0], { x: 7, y: 7, c: HUMAN })
  s = applyUserMessage(s, userMsg('【五子棋】我认输，这局你赢了。'))
  assert.equal(s.status, 'human-resign')
  s = applyUserMessage(s, userMsg('【五子棋】开新局，我执黑先行。'))
  assert.equal(s.moves.length, 0)
  assert.equal(s.status, 'idle')
  s = applyUserMessage(s, userMsg('【五子棋】我落子 A1（第 1 手）。'))
  assert.equal(s.moves.length, 1)
  s = applyUserMessage(s, userMsg('【五子棋】悔棋：撤销上一手。'))
  assert.equal(s.moves.length, 0)
})
ok('普通聊天消息不动棋盘', () => {
  const s = play(initialState(), 'H8')
  assert.equal(applyUserMessage(s, userMsg('你好，随便聊聊 H8')), s)
  assert.equal(applyUserMessage(s, userMsg('Current runtime context. 我落子 H8')), s)
  assert.equal(applyUserMessage(s, null), s)
})
ok('模型的 tool/call 落白子；重复/非法调用被忽略', () => {
  let s = play(initialState(), 'H8')
  s = applyEvent(s, { type: 'tool/call', data: { name: 'gomoku_play', arguments: '{"move":"H9"}' } })
  assert.deepEqual(s.moves[1], { x: 7, y: 6, c: MODEL })
  const before = s
  // 同一位置再落一次：忽略
  assert.equal(applyEvent(s, { type: 'tool/call', data: { name: 'gomoku_play', arguments: '{"move":"H9"}' } }), before)
  // 坏参数：忽略
  assert.equal(applyEvent(s, { type: 'tool/call', data: { name: 'gomoku_play', arguments: 'not json' } }), before)
  // 别的工具：忽略
  assert.equal(applyEvent(s, { type: 'tool/call', data: { name: 'bash', arguments: '{"move":"A1"}' } }), before)
  // 两手之后重新轮到人；人再落一手，模型用 x/y 写法应一手
  assert.equal(turnOf(s), BLACK)
  s = applyEvent(s, { type: 'user/message', data: userMsg('【五子棋】我落子 M8（第 3 手）。') })
  const s2 = applyEvent(s, { type: 'tool/call', data: { name: 'gomoku_play', arguments: '{"x":3,"y":11}' } })
  assert.deepEqual(s2.moves[3], { x: 3, y: 11, c: MODEL })
})
ok('完整对局回放：人五连获胜', () => {
  const script = ['【五子棋】开新局，我执黑先行。', '【五子棋】我落子 A8（第 1 手）。']
  let s = initialState()
  for (const text of script) s = applyUserMessage(s, userMsg(text))
  s = applyEvent(s, { type: 'tool/call', data: { name: 'gomoku_play', arguments: '{"move":"A1"}' } })
  s = applyUserMessage(s, userMsg('【五子棋】我落子 B8（第 3 手）。'))
  s = applyEvent(s, { type: 'tool/call', data: { name: 'gomoku_play', arguments: '{"move":"B1"}' } })
  s = applyUserMessage(s, userMsg('【五子棋】我落子 C8（第 5 手）。'))
  s = applyEvent(s, { type: 'tool/call', data: { name: 'gomoku_play', arguments: '{"move":"C1"}' } })
  s = applyUserMessage(s, userMsg('【五子棋】我落子 D8（第 7 手）。'))
  s = applyEvent(s, { type: 'tool/call', data: { name: 'gomoku_play', arguments: '{"move":"D1"}' } })
  s = applyUserMessage(s, userMsg('【五子棋】我落子 E8（第 9 手）。'))
  assert.equal(s.status, 'human-win')
  assert.equal(s.moves.length, 9)
})

console.log('快照 / 棋盘渲染')
ok('snapshotOf 字段完整', () => {
  const s = play(initialState(), 'H8')
  const snap = snapshotOf(s, [{ type: 'turn/start' }, { type: 'step/start' }])
  assert.equal(snap.size, SIZE)
  assert.equal(snap.board.length, SIZE * SIZE)
  assert.equal(snap.turn, WHITE)
  assert.equal(snap.status, 'playing')
  assert.deepEqual(snap.lastMove, { x: 7, y: 7, c: HUMAN })
  assert.equal(snap.thinking, true)
  assert.equal(snap.started, true)
  assert.equal(snap.human, BLACK)
  assert.equal(snapshotOf(s, [{ type: 'turn/start' }, { type: 'turn/end' }]).thinking, false)
  assert.equal(snapshotOf(initialState(), []).turn, BLACK)
  assert.equal(snapshotOf(initialState(), []).started, false)
})
ok('snapshot.board 是拷贝，不会被改写', () => {
  const s = play(initialState(), 'H8')
  const snap = snapshotOf(s, [])
  snap.board[0] = 99
  assert.equal(s.board[0], 0)
})
ok('ASCII 棋盘 17 行、标注齐全', () => {
  const s = play(initialState(), 'H8', 'H9')
  const lines = renderBoard(s).split('\n')
  assert.equal(lines.length, 17)
  assert.match(lines[0], /A B C D E F G H I J K L M N O/)
  assert.match(lines[8], /^ ?8 /)
  assert.match(lines[8], /X/)
  assert.match(lines[7], /O/)
})

console.log(`\n全部通过：${checks} 项检查`)
