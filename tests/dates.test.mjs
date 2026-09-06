import test from 'node:test';
import assert from 'node:assert/strict';
import { compactDate, compactDateList, dateLabel, normalizeDates, parseDate, shiftDate, weekStart } from '../src/dates.ts';

test('calendar navigation crosses months, leap days, and years without skipping days', () => {
  assert.equal(shiftDate('2028-02-28', 1), '2028-02-29');
  assert.equal(shiftDate('2028-02-29', 1), '2028-03-01');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(weekStart('2027-01-03'), '2026-12-28');
  assert.equal(weekStart('2027-01-04'), '2027-01-04');
});

test('rejects impossible dates instead of silently rolling to another month', () => {
  for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', 'Friday', '2026-1-01']) {
    assert.throws(() => parseDate(value));
  }
});

test('selected dates from multiple weeks remain distinct, ordered and deduplicated', () => {
  assert.deepEqual(normalizeDates(['2026-09-14', '2026-09-07', '2026-09-14']), ['2026-09-07', '2026-09-14']);
  assert.deepEqual(normalizeDates([]), []);
});

test('calendar labels and DST-boundary navigation do not depend on local time zone', () => {
  const original = process.env.TZ;
  try {
    for (const zone of ['Asia/Manila', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      process.env.TZ = zone;
      assert.equal(dateLabel('2026-03-08'), 'Sun, Mar 8, 2026');
      assert.equal(shiftDate('2026-03-08', 1), '2026-03-09');
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test('compact task notation keeps the current week familiar and disambiguates other weeks', () => {
  assert.equal(compactDateList(['2026-09-01', '2026-09-04'], '2026-09-06'), 'T,F');
  assert.equal(compactDateList(['2026-08-31', '2026-09-14'], '2026-09-06'), 'M,M Sep 14');
  assert.equal(compactDate('2027-01-04', '2026-12-31'), 'M Jan 4, 2027');
});
