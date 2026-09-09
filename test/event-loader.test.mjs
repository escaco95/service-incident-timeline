import test from 'node:test';
import assert from 'node:assert/strict';
import { EventLoader } from '../public/event-loader.js';

const period = (month, generation = 1) => ({ from: `2026-${month}-01T00:00:00.000Z`, until: `2026-${month}-28T00:00:00.000Z`, generation });
const result = (id, revision = 1, pages = 1) => ({ events: [{ id }], revision, pages });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('늦게 도착한 이전 기간 응답은 현재 기간을 덮어쓰지 않는다', async () => {
  const calls = [], loader = new EventLoader((query, options) => { const pending = deferred(); calls.push({ query, ...options, ...pending }); return pending.promise; });
  const older = loader.load(period('01')), newer = loader.load(period('02'));
  assert.equal(calls[0].signal.aborted, true);
  calls[1].resolve(result('february')); assert.equal((await newer).data.events[0].id, 'february');
  calls[0].resolve(result('january')); assert.equal(await older, null);
  assert.equal(loader.loaded.from, period('02').from);
});

test('조회 도중 이미 읽은 기간으로 돌아오면 진행 중 요청을 취소하고 기존 기간을 유지한다', async () => {
  const pending = deferred(); let calls = 0, activeSignal;
  const loader = new EventLoader((query, { signal }) => { activeSignal = signal; return ++calls === 1 ? Promise.resolve(result('january')) : pending.promise; });
  await loader.load(period('01'));
  const far = loader.load(period('12')); assert.equal(loader.needs(period('12')), false);
  assert.equal(loader.needs(period('01')), false); assert.equal(activeSignal.aborted, true);
  pending.resolve(result('december')); assert.equal(await far, null);
  assert.equal(loader.loaded.from, period('01').from); assert.equal(loader.pending, null);
});

test('여러 페이지는 같은 revision으로 결합하고 충돌하면 첫 페이지부터 한 번 재시도한다', async () => {
  const queries = [], responses = [result('stale', 1, 2), Object.assign(new Error('conflict'), { status: 409 }), result('first', 2, 2), result('second', 2, 2)];
  const loader = new EventLoader(async query => { queries.push(new URLSearchParams(query)); const next = responses.shift(); if (next instanceof Error) throw next; return next; });
  const { data } = await loader.load(period('01'));
  assert.deepEqual(data.events.map(row => row.id), ['first', 'second']);
  assert.deepEqual(queries.map(query => [query.get('page'), query.get('revision')]), [[null, null], ['2', '1'], [null, null], ['2', '2']]);
  assert.ok(queries.every(query => query.get('from') === period('01').from && query.get('limit') === '1000'));
});

test('재시도도 실패하면 기존 데이터를 유지하고 다음 요청을 허용한다', async () => {
  let fail = false, calls = 0;
  const loader = new EventLoader(async () => { calls++; if (fail) throw Object.assign(new Error('conflict'), { status: 409 }); return result('saved'); });
  await loader.load(period('01')); fail = true;
  await assert.rejects(loader.load(period('02')), { status: 409 });
  assert.equal(calls, 3); assert.equal(loader.pending, null); assert.equal(loader.loaded.from, period('01').from);
  assert.equal(loader.needs(period('02')), true); fail = false; assert.equal((await loader.load(period('02'))).data.events[0].id, 'saved');
});

test('로그아웃·초기화 후 응답과 이전 세션의 기간 캐시를 재사용하지 않는다', async () => {
  const pending = deferred(), loader = new EventLoader(() => pending.promise);
  const request = loader.load(period('01')); loader.clear(); pending.resolve(result('private'));
  assert.equal(await request, null); assert.equal(loader.loaded, null); assert.equal(loader.pending, null);
  assert.equal(loader.needs(period('01', 2)), true);
});
