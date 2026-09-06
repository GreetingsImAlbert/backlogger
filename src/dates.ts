// Calendar arithmetic uses UTC internally so DST cannot shift selected dates.
export function parseDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Choose a valid calendar date.');
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('Choose a valid calendar date.');
  }
  return date;
}

export function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function shiftDate(value: string, days: number): string {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function weekStart(value: string): string {
  return shiftDate(value, -((parseDate(value).getUTCDay() + 6) % 7));
}

export function dateLabel(value: string): string {
  return parseDate(value).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

export function normalizeDates(values: string[]): string[] {
  values.forEach(parseDate);
  return [...new Set(values)].sort();
}

const weekdayCodes = ['S', 'M', 'T', 'W', 'H', 'F', 'A'];

export function weekdayCode(value: string): string {
  return weekdayCodes[parseDate(value).getUTCDay()];
}

export function compactDate(value: string, reference = localToday()): string {
  const date = parseDate(value);
  const referenceDate = parseDate(reference);
  const start = weekStart(reference);
  const end = shiftDate(start, 6);
  if (value >= start && value <= end) return weekdayCode(value);
  const includeYear = date.getUTCFullYear() !== referenceDate.getUTCFullYear();
  const formatted = date.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', ...(includeYear ? { year: 'numeric' } : {}), timeZone: 'UTC',
  });
  return `${weekdayCode(value)} ${formatted}`;
}

export function compactDateList(values: string[], reference = localToday()): string {
  return normalizeDates(values).map(value => compactDate(value, reference)).join(',');
}
