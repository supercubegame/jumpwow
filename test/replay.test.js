import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, step } from '../src/engine.js';
import { botInput } from '../src/bot.js';
import {
  IN, encodeLog, decodeLog, createRecorder, replay, stateOf, inputOf, MAX_LOG_CHARS,
} from '../src/replay.js';

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
  // 实跑一局并记录
  const live = createGame(20260811);
  const rec = createRecorder();
  for (let i = 0; i < 3000 && live.alive; i++){
    const input = botInput(live);
    rec.push(input);
    step(live, input);
  }

  const r = replay(live.seed, rec.encode());
  assert.equal(r.score,  live.score,        '分数必须一致');
  assert.equal(r.ticks,  live.ticks,        '帧数必须一致');
  assert.equal(r.jumps,  live.stats.jumps,  '跳跃数必须一致');
  assert.equal(r.alive,  live.alive);
  assert.equal(r.seed,   live.seed);
});

test('改一个字节，重放分数就对不上（反作弊的根据）', () => {
  const live = createGame(4242);
  const rec = createRecorder();
  for (let i = 0; i < 2400 && live.alive; i++){
    const input = botInput(live);
    rec.push(input);
    step(live, input);
  }
  const honest = rec.encode();
  assert.equal(replay(live.seed, honest).score, live.score);

  // 换个种子：同一份操作在别的地图上必然是另一个结果
  assert.notEqual(replay(live.seed + 1, honest).score, live.score);

  // 篡改日志本身
  const tampered = honest.replace(/^./, c => (c === '0' ? '1' : '0'));
  if (tampered !== honest){
    assert.notEqual(replay(live.seed, tampered).score, live.score);
  }
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
