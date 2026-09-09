import test from 'node:test';
import assert from 'node:assert/strict';
import { auditDateRange } from '../public/audit-ui.js';
import { createDateUtils } from '../public/date-utils.js';

test('간편 조회 기간: 오늘 포함 일·주와 달력 기준 월·년', () => {
  for (const [period, start] of [['1d', '2026-09-10'], ['1w', '2026-09-04'], ['2w', '2026-08-28'], ['1m', '2026-08-10'], ['3m', '2026-06-10'], ['6m', '2026-03-10'], ['1y', '2025-09-10']]) {
    assert.deepEqual(auditDateRange(period, '2026-09-10'), { fromDate: start, untilDate: '2026-09-10' });
  }
  assert.deepEqual(auditDateRange('1w', '2026-01-02'), { fromDate: '2025-12-27', untilDate: '2026-01-02' });
});

test('달력 기간은 월말·윤년·연도 경계를 보정한다', () => {
  for (const [period, today, start] of [
    ['1m', '2026-03-31', '2026-02-28'], ['1m', '2024-03-31', '2024-02-29'],
    ['3m', '2026-05-31', '2026-02-28'], ['6m', '2026-08-31', '2026-02-28'],
    ['1y', '2024-02-29', '2023-02-28'], ['1m', '2026-01-31', '2025-12-31']
  ]) assert.deepEqual(auditDateRange(period, today), { fromDate: start, untilDate: today });
  assert.throws(() => auditDateRange('unknown', '2026-09-10'));
});

test('앱 시간대의 오늘을 사용하고 종료일 전체와 DST 날짜를 포함한다', () => {
  const seoul = createDateUtils('Asia/Seoul');
  const range = auditDateRange('1m', seoul.dateKey('2026-09-09T16:00:00.000Z'));
  assert.deepEqual(range, { fromDate: '2026-08-10', untilDate: '2026-09-10' });
  assert.equal(seoul.startOfDay(range.fromDate).toISOString(), '2026-08-09T15:00:00.000Z');
  assert.equal(seoul.startOfDay(seoul.addDays(range.untilDate, 1)).toISOString(), '2026-09-10T15:00:00.000Z');
  const ny = createDateUtils('America/New_York');
  for (const [today, hours] of [['2026-03-08', 23], ['2026-11-01', 25]]) {
    const day = auditDateRange('1d', today);
    assert.equal((ny.startOfDay(ny.addDays(day.untilDate, 1)) - ny.startOfDay(day.fromDate)) / 3600000, hours);
  }
});
