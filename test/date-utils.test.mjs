import test from 'node:test';
import assert from 'node:assert/strict';
import { createDateUtils, dateKey, addDays, fromDateKey, overlaps, onDay, weekSegments, daySegment, parseDateTimeInput } from '../public/date-utils.js';

const at = (day, time = '00:00') => `${day}T${time}:00.000Z`;
const event = (id, start, end, category = 'maintenance') => ({ id, start, end, title: id, category });

test('날짜 이동: 윤년, 연도 경계, 유효하지 않은 날짜', () => {
  assert.equal(dateKey(addDays(fromDateKey('2024-02-28'), 1)), '2024-02-29');
  assert.equal(dateKey(addDays(fromDateKey('2025-12-31'), 1)), '2026-01-01');
  assert.equal(fromDateKey('2025-02-29'), null);
  assert.equal(fromDateKey('2026-13-01'), null);
  assert.equal(fromDateKey('1899-12-31'), null);
  assert.equal(parseDateTimeInput('2026-02-30T12:00'), null);
});

test('이벤트 종료는 exclusive: 자정 종료 이벤트는 다음 날 표시하지 않음', () => {
  const record = event('midnight', at('2026-09-08', '23:00'), at('2026-09-09'));
  assert.equal(overlaps(record, fromDateKey('2026-09-08')), true);
  assert.equal(overlaps(record, fromDateKey('2026-09-09')), false);
  assert.equal(onDay([record], fromDateKey('2026-09-09')).length, 0);
});

test('여러 날과 종료 미정 이벤트는 표시 날짜의 양 끝에서 잘림', () => {
  const day = fromDateKey('2026-09-09');
  const ongoing = daySegment(event('open', at('2026-09-01'), null), day);
  assert.deepEqual(ongoing, { left: 0, width: 1, startsHere: false, endsHere: false, open: true });
  const ending = daySegment(event('ending', at('2026-09-08'), at('2026-09-09', '12:00')), day);
  assert.equal(ending.left, 0);
  assert.equal(ending.endsHere, true);
  assert.equal(ending.startsHere, false);
  const starting = daySegment(event('starting', at('2026-09-09', '12:00'), at('2026-09-10')), day);
  assert.equal(starting.startsHere, true);
  assert.equal(starting.endsHere, true);
  assert.equal(daySegment(event('future', at('2026-09-10'), null), day), null);
});

test('주간 막대: 이어지는 구간과 겹치지 않는 레인, 숨겨진 이벤트 수', () => {
  const start = fromDateKey('2026-09-06');
  const events = [
    event('long', at('2026-09-01'), at('2026-09-20')),
    event('one', at('2026-09-07'), at('2026-09-08')),
    event('two', at('2026-09-07', '02:00'), at('2026-09-07', '03:00')),
    event('three', at('2026-09-07', '04:00'), at('2026-09-07', '05:00')),
    event('next', at('2026-09-08'), at('2026-09-09'))
  ];
  const segments = weekSegments(events, start);
  const long = segments.find(segment => segment.event.id === 'long');
  assert.deepEqual([long.start, long.end, long.startsHere, long.endsHere], [0, 6, false, false]);
  const hidden = segments.filter(segment => segment.lane >= 3 && segment.start <= 1 && segment.end >= 1);
  assert.equal(hidden.length, 1);
  for (const a of segments) for (const b of segments) {
    if (a !== b && a.lane === b.lane) assert.ok(a.end < b.start || b.end < a.start);
  }
});

test('UTC 기본값과 브랜딩 시간대의 날짜 경계·입력 변환', () => {
  const utc = createDateUtils();
  const seoul = createDateUtils('Asia/Seoul');
  const instant = '2026-12-31T16:30:00.000Z';
  assert.equal(utc.dateTimeInput(instant), '2026-12-31T16:30');
  assert.equal(seoul.dateTimeInput(instant), '2027-01-01T01:30');
  assert.equal(seoul.parseDateTimeInput('2027-01-01T01:30'), instant);
  assert.equal(utc.parseDateTimeInput('2027-01-01T01:30'), '2027-01-01T01:30:00.000Z');
  assert.equal(seoul.dateParts(instant).weekday, 5);
  const record = event('boundary', instant, '2026-12-31T17:30:00.000Z');
  assert.equal(utc.onDay([record], '2026-12-31').length, 1);
  assert.equal(seoul.onDay([record], '2026-12-31').length, 0);
  assert.equal(seoul.onDay([record], '2027-01-01').length, 1);
  assert.equal(seoul.daySegment(record, '2027-01-01').left, 1.5 / 24);
  assert.equal(seoul.weekSegments([record], '2026-12-27')[0].start, 5);
  const midnight = event('midnight', '2026-09-09T14:00:00.000Z', '2026-09-09T15:00:00.000Z');
  assert.equal(seoul.onDay([midnight], '2026-09-10').length, 0);
  assert.equal(createDateUtils('Asia/Kathmandu').parseDateTimeInput('2026-09-09T09:00'), '2026-09-09T03:15:00.000Z');
});

test('서머타임의 23·25시간 날짜와 존재하지 않거나 중복되는 입력', () => {
  const ny = createDateUtils('America/New_York');
  const spring = ny.dayBounds('2026-03-08');
  const autumn = ny.dayBounds('2026-11-01');
  assert.deepEqual(spring.map(stamp => new Date(stamp).toISOString()), ['2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z']);
  assert.equal(spring[1] - spring[0], 23 * 3600000);
  assert.equal(autumn[1] - autumn[0], 25 * 3600000);
  assert.equal(ny.addDays('2026-03-08', 1), '2026-03-09');
  assert.equal(ny.addDays('2026-11-01', 1), '2026-11-02');
  assert.equal(ny.parseDateTimeInput('2026-03-08T02:30'), null);
  assert.equal(ny.parseDateTimeInput('2026-11-01T01:30'), null);
  assert.equal(ny.parseDateTimeInput('2026-03-08T03:30'), '2026-03-08T07:30:00.000Z');
  const original = '2026-11-01T06:30:12.345Z';
  assert.equal(ny.parseDateTimeInput('2026-11-01T01:30', original), original);
  const record = event('spring', '2026-03-08T06:30:00.000Z', '2026-03-08T07:30:00.000Z');
  assert.equal(ny.daySegment(record, '2026-03-08').width, 1 / 23);
  const lordHowe = createDateUtils('Australia/Lord_Howe');
  const [start, end] = lordHowe.dayBounds('2026-10-04');
  assert.equal(end - start, 23.5 * 3600000);
  assert.equal(lordHowe.parseDateTimeInput('2026-10-04T02:15'), null);
});

test('자정 또는 하루가 건너뛰어도 달력 날짜와 이벤트 구간은 일관됨', () => {
  const saoPaulo = createDateUtils('America/Sao_Paulo');
  assert.equal(saoPaulo.startOfDay('2018-11-04').toISOString(), '2018-11-04T03:00:00.000Z');
  assert.equal(saoPaulo.parseDateTimeInput('2018-11-04T00:30'), null);
  const apia = createDateUtils('Pacific/Apia');
  assert.equal(apia.addDays('2011-12-29', 1), '2011-12-30');
  assert.equal(apia.addDays('2011-12-30', 1), '2011-12-31');
  const [start, end] = apia.dayBounds('2011-12-30');
  assert.equal(start, end);
  assert.equal(apia.daySegment(event('ongoing', '2011-01-01T00:00:00.000Z', null), '2011-12-30'), null);
  assert.equal(apia.parseDateTimeInput('2011-12-30T12:00'), null);
});
