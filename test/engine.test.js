import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, step, run, fingerprint, wrapDelta, wrap,
  W, G, JUMP_V, MAX_JUMP_H, PLAT, VIEW_H,
} from '../src/engine.js';
import { botInput } from '../src/bot.js';

test('环形横向距离取最短路径', () => {
  assert.equal(wrapDelta(1, 3), 2);
  assert.equal(wrapDelta(3, 1), -2);
  assert.equal(wrapDelta(1, W - 1), -2);      // 穿过接缝更近
  assert.equal(wrapDelta(W - 1, 1), 2);
  assert.equal(wrap(-1), W - 1);
  assert.equal(wrap(W + 3), 3);
});

test('开局站在中间的平台上并且活着', () => {
  const s = createGame(7);
  assert.equal(s.alive, true);
  assert.equal(s.player.x, W / 2);
  assert.equal(s.platforms[0].y, 0);
  assert.ok(s.platforms.length > 5, '相机上方应预生成若干平台');
});

test('相机只升不降', () => {
  const s = createGame(11);
  let prev = s.cam;
  for (let i = 0; i < 3000 && s.alive; i++){
    step(s, botInput(s));
    assert.ok(s.cam >= prev, `第 ${i} 步相机回退了`);
    prev = s.cam;
  }
});

test('落地会自动起跳，弹簧更高', () => {
  const s = createGame(3);
  // 手动造一次普通落地
  s.platforms = [{ id: 1, x: s.player.x, y: 0, type: PLAT.NORMAL, broken: false, baseX: s.player.x, amp: 0, speed: 0, phase: 0 }];
  s.player.y = 0.2; s.player.vy = -5;
  step(s, {});
  assert.equal(s.player.vy, JUMP_V);

  const t = createGame(3);
  t.platforms = [{ id: 1, x: t.player.x, y: 0, type: PLAT.SPRING, broken: false, baseX: t.player.x, amp: 0, speed: 0, phase: 0 }];
  t.player.y = 0.2; t.player.vy = -5;
  step(t, {});
  assert.ok(t.player.vy > JUMP_V, '弹簧应给出更大初速度');
});

test('易碎平台踩一次后失效', () => {
  const s = createGame(5);
  const pl = { id: 1, x: s.player.x, y: 0, type: PLAT.FRAGILE, broken: false, baseX: s.player.x, amp: 0, speed: 0, phase: 0 };
  s.platforms = [pl];
  s.player.y = 0.2; s.player.vy = -5;
  step(s, {});
  assert.equal(pl.broken, true, '踩过应标记为碎');
  assert.equal(s.player.vy, JUMP_V, '碎之前仍应给一次弹跳');
});

test('高速下落不会穿过平台', () => {
  const s = createGame(9);
  s.platforms = [{ id: 1, x: 20, y: 0, type: PLAT.NORMAL, broken: false, baseX: 20, amp: 0, speed: 0, phase: 0 }];
  s.player.x = 20; s.player.y = 3; s.player.vy = -400;   // 远超正常速度
  step(s, {});
  assert.ok(s.player.vy > 0, '应被平台接住而不是穿过去');
  assert.equal(s.player.y, 0);
});

test('同种子完全可复现，异种子生成不同地图', () => {
  const a = run(createGame(1234), 1800, botInput);
  const b = run(createGame(1234), 1800, botInput);
  assert.equal(fingerprint(a), fingerprint(b));

  const c = run(createGame(5678), 1800, botInput);
  assert.notEqual(fingerprint(a), fingerprint(c));
});

test('生成的相邻平台垂直间距始终可达', () => {
  for (const seed of [1, 42, 777, 20260811]){
    const s = createGame(seed);
    run(s, 6000, botInput);
    // 只检查生成顺序上的相邻关系
    for (let i = 1; i < s.platforms.length; i++){
      const gap = s.platforms[i].y - s.platforms[i - 1].y;
      assert.ok(gap > 0, '平台必须严格递增');
      assert.ok(gap < MAX_JUMP_H - 0.8,
        `seed ${seed} 出现了 ${gap.toFixed(2)} 的间距，超过可跳高度余量`);
    }
  }
});

test('平台数组不随时间无限增长', () => {
  const s = createGame(31);
  run(s, 600, botInput);
  const early = s.platforms.length;
  run(s, 12000, botInput);
  assert.ok(s.platforms.length <= early + 4,
    `平台数从 ${early} 涨到 ${s.platforms.length}，裁剪没生效`);
  assert.ok(s.generated > early, '同时确认确实一直在生成新平台');
});

test('掉出视野下沿判定死亡', () => {
  const s = createGame(13);
  s.platforms = [];
  s.player.y = s.cam + 1; s.player.vy = -50;
  for (let i = 0; i < 60 && s.alive; i++) step(s, {});
  assert.equal(s.alive, false);
});

test('死亡后 step 不再改变状态', () => {
  const s = createGame(17);
  s.alive = false;
  const before = fingerprint(s);
  step(s, { left: true });
  assert.equal(fingerprint(s), before);
});
