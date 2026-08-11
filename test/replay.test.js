import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step } from '../src/engine.js';
import { botInput } from '../src/bot.js';
import {
  IN, encodeLog, decodeLog, createRecorder, replay, stateOf, inputOf, MAX_LOG_CHARS,
} from '../src/replay.js';

/**
 * 玩到死，返回一局完整的样本。
 *
 * 光让机器人跑是死不掉的（它一直往上爬），完全不按键也死不掉
 * （玩家在同一块平台上原地弹跳）。所以先爬一段再一直按同一个方向：
 * 玩家横向漂离平台，而相机只升不降，掉出视野就判死。
 */
function playToDeath(seed, climb = 900, cap = 20000){
  const g = createGame(seed);
  const rec = createRecorder();
  for (let i = 0; i < cap && g.alive; i++){
    const input = i < climb ? botInput(g) : { left: false, right: true };
    rec.push(input);
    step(g, input);
  }
  return { game: g, log: rec.encode() };
}

test('输入三态：左右同时按等于没按', () => {
  assert.equal(stateOf({ left: false, right: false }), IN.NONE);
  assert.equal(stateOf({ left: true,  right: false }), IN.LEFT);
  assert.equal(stateOf({ left: false, right: true  }), IN.RIGHT);
  assert.equal(stateOf({ left: true,  right: true  }), IN.NONE, '方向相消');
  assert.equal(stateOf(undefined), IN.NONE);
  assert.deepEqual(inputOf(IN.LEFT), { left: true, right: false });
});

test('游程编码往返无损', () => {
  const cases = [
    [],
    [0],
    [0, 0, 0, 2, 2],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    Array.from({ length: 300 }, (_, i) => i % 3),
  ];
  for (const c of cases){
    assert.deepEqual(decodeLog(encodeLog(c)), c, '往返后应完全相同: ' + c.length + ' 帧');
  }
});

test('编码确实压缩了长游程', () => {
  const states = new Array(5000).fill(IN.RIGHT);
  const s = encodeLog(states);
  assert.ok(s.length < 12, '5000 帧同一个键应该压到十几个字符，实得 ' + s.length);
  assert.equal(decodeLog(s).length, 5000);
});

test('畸形日志一律抛错，不能悄悄放过', () => {
  assert.throws(() => decodeLog(123), /不是字符串/);
  assert.throws(() => decodeLog('9a'), /未知输入状态/);
  assert.throws(() => decodeLog('0'), /格式错误/);
  assert.throws(() => decodeLog('0z.'), /格式错误/);
  assert.throws(() => decodeLog('0-1'), /长度非法/);
  assert.throws(() => decodeLog('1' + 'z'.repeat(MAX_LOG_CHARS)), /过长/);
  assert.throws(() => decodeLog('0zzzzzzz'), /最大帧数/);
});

test('重放结果与实跑逐字段一致', () => {
  const { game: live, log } = playToDeath(20260811);
  const r = replay(live.seed, log);
  assert.equal(r.score,  live.score,        '分数必须一致');
  assert.equal(r.ticks,  live.ticks,        '帧数必须一致');
  assert.equal(r.jumps,  live.stats.jumps,  '跳跃数必须一致');
  assert.equal(r.alive,  live.alive);
  assert.equal(r.seed,   live.seed);
});

test('一直按同一个方向最终会摔死（样本局构造前提）', () => {
  const { game } = playToDeath(31337);
  assert.equal(game.alive, false, '构造不出「已结束的局」，排行榜断言就没意义');
  assert.ok(game.score > 0, '死之前应该已经爬到一定高度');
});

test('篡改日志或换种子都拿不到原来的分数', () => {
  const { game: live, log } = playToDeath(4242);
  const states = decodeLog(log);

  assert.notEqual(replay(live.seed + 1, log).score, live.score, '同一份操作换张图必然是别的结果');

  // 翻转中段一整块。别只改一个字符,那点位移落在平台容差内，结果不会变，
  // 那不是引擎的问题，是这条测试太弱。
  const mid = states.slice();
  const from = Math.floor(mid.length * 0.3);
  for (let i = from; i < Math.min(mid.length, from + 400); i++){
    mid[i] = mid[i] === 1 ? 2 : 1;
  }
  assert.notEqual(replay(live.seed, encodeLog(mid)).score, live.score);

  // 真正要保证的是这条：截断日志不可能换来更高的分
  const cut = replay(live.seed, encodeLog(states.slice(0, Math.floor(states.length * 0.6)))).score;
  assert.ok(cut <= live.score, '少玩几帧却得了更高分，说明重放不可信');
});

test('空日志重放得零分且玩家还活着', () => {
  const r = replay(7, '');
  assert.equal(r.score, 0);
  assert.equal(r.ticks, 0);
  assert.equal(r.alive, true, '没操作过就不算一局结束');
});

test('记录器与手工编码一致', () => {
  const rec = createRecorder();
  rec.push({ left: false, right: false });
  rec.push({ left: false, right: false });
  rec.push({ left: false, right: true });
  assert.equal(rec.ticks, 3);
  assert.equal(rec.encode(), '02.21');
  rec.reset();
  assert.equal(rec.ticks, 0);
  assert.equal(rec.encode(), '');
});
