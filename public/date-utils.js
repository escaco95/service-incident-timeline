export const DAY = 86400000;
export const pad = value => String(value).padStart(2, '0');
export const severity = events => events.some(event => event.category === 'incident') ? 'incident' : events.length ? 'warning' : '';
const DATE_KEY = /^\d{4}-\d\d-\d\d$/;

// Calendar days are YYYY-MM-DD strings, distinct from UTC instants. Calendar
// arithmetic must not depend on the browser zone or assume every day is 24 hours.
function civilStamp({ year, month, day, hour = 0, minute = 0, second = 0 }) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return +date;
}
const civilKey = ({ year, month, day }) => `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;

export function createDateUtils(timezone = 'UTC') {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, calendar: 'iso8601', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const dayFormatter = new Intl.DateTimeFormat('ko-KR', { timeZone: 'UTC', month: 'long', day: 'numeric', weekday: 'long' });
  const boundaries = new Map();

  function dateParts(value) {
    let parts;
    if (typeof value === 'string' && DATE_KEY.test(value)) {
      const [year, month, day] = value.split('-').map(Number);
      parts = { year, month, day, hour: 0, minute: 0, second: 0 };
    } else {
      parts = Object.fromEntries(formatter.formatToParts(new Date(value)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    }
    return { ...parts, weekday: new Date(civilStamp(parts)).getUTCDay() };
  }

  const dateKey = value => civilKey(dateParts(value));
  // Like the Date constructor, monthIndex is zero-based and overflow is normalized.
  function calendarDate(year, monthIndex, day = 1) {
    const date = new Date(civilStamp({ year, month: monthIndex + 1, day }));
    return civilKey({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() });
  }
  function addDays(value, amount) {
    const parts = dateParts(value);
    return calendarDate(parts.year, parts.month - 1, parts.day + amount);
  }
  function fromDateKey(value) {
    if (!DATE_KEY.test(value ?? '')) return null;
    const [year, month, day] = value.split('-').map(Number);
    return year >= 1900 && year <= 9998 && calendarDate(year, month - 1, day) === value ? value : null;
  }

  function offsetAt(stamp) {
    return civilStamp(dateParts(stamp)) - Math.floor(stamp / 1000) * 1000;
  }
  function matchingInstants(parts) {
    const wall = civilStamp(parts);
    // Check offsets on both sides of clock changes and verify by round-tripping.
    const offsets = new Set([-2, -1, 0, 1, 2].map(days => offsetAt(wall + days * DAY)));
    return [...offsets].map(offset => wall - offset)
      .filter(stamp => civilStamp(dateParts(stamp)) === wall).sort((a, b) => a - b);
  }
  function startOfDay(value) {
    const key = dateKey(value);
    if (!boundaries.has(key)) {
      const parts = dateParts(key);
      const matches = matchingInstants(parts);
      let stamp = matches[0];
      if (stamp === undefined) {
        // Midnight can be skipped. Find the first instant of this civil day;
        // an entirely skipped date has the same boundary as the following date.
        let low = civilStamp(parts) - 2 * DAY;
        let high = civilStamp(parts) + 2 * DAY;
        while (high - low > 1) {
          const middle = Math.floor((low + high) / 2);
          if (dateKey(middle) < key) low = middle;
          else high = middle;
        }
        stamp = high;
      }
      if (boundaries.size >= 1024) boundaries.delete(boundaries.keys().next().value);
      boundaries.set(key, stamp);
    }
    return new Date(boundaries.get(key));
  }
  const dayBounds = day => [+startOfDay(day), +startOfDay(addDays(day, 1))];
  const instant = value => typeof value === 'string' && DATE_KEY.test(value) ? +startOfDay(value) : +new Date(value);
  function overlaps(event, start, end = addDays(start, 1)) {
    const lower = instant(start), upper = instant(end);
    return upper > lower && Date.parse(event.start) < upper && (event.end === null || Date.parse(event.end) > lower);
  }
  function onDay(events, day) {
    const [start, end] = dayBounds(day);
    return events.filter(event => overlaps(event, start, end));
  }
  const timeLabel = value => { const parts = dateParts(value); return `${pad(parts.hour)}:${pad(parts.minute)}`; };
  const dateTimeInput = value => `${dateKey(value)}T${timeLabel(value)}`;
  function parseDateTimeInput(value, original = null) {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value ?? '') || !fromDateKey(value.slice(0, 10))) return null;
    const [hour, minute] = value.slice(11).split(':').map(Number);
    if (hour > 23 || minute > 59) return null;
    // Preserve an unchanged instant, including seconds and a repeated DST hour.
    if (original && Number.isFinite(Date.parse(original)) && dateTimeInput(original) === value) return original;
    const matches = matchingInstants({ ...dateParts(value.slice(0, 10)), hour, minute });
    // A skipped or repeated clock time cannot identify a unique instant.
    return matches.length === 1 ? new Date(matches[0]).toISOString() : null;
  }
  const formatDay = value => dayFormatter.format(civilStamp(dateParts(dateKey(value))));
  const formatDateTime = value => value === null ? '종료 시각 미정' : `${dateKey(value).replaceAll('-', '.')} ${timeLabel(value)}`;

  // Half-open intervals: an event ending at midnight is absent from the next day.
  function weekSegments(events, weekStart) {
    const days = Array.from({ length: 7 }, (_, index) => dayBounds(addDays(weekStart, index)));
    const startOfWeek = days[0][0], endOfWeek = days[6][1];
    const segments = events.filter(event => overlaps(event, startOfWeek, endOfWeek)).map(event => {
      const active = days.map(([start, end]) => overlaps(event, start, end));
      const start = active.indexOf(true), end = active.lastIndexOf(true);
      return { event, start, end, startsHere: Date.parse(event.start) >= startOfWeek, endsHere: event.end !== null && Date.parse(event.end) <= endOfWeek };
    }).sort((a, b) => a.start - b.start || b.end - a.end || a.event.start.localeCompare(b.event.start) || a.event.id.localeCompare(b.event.id));
    const laneEnds = [];
    for (const segment of segments) {
      let lane = laneEnds.findIndex(end => end < segment.start);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = segment.end;
      segment.lane = lane;
    }
    return segments;
  }
  function daySegment(event, day) {
    const [start, end] = dayBounds(day);
    if (!overlaps(event, start, end)) return null;
    const eventStart = Date.parse(event.start), eventEnd = event.end === null ? Infinity : Date.parse(event.end);
    return {
      left: (Math.max(start, eventStart) - start) / (end - start),
      width: (Math.min(end, eventEnd) - Math.max(start, eventStart)) / (end - start),
      startsHere: eventStart >= start, endsHere: eventEnd <= end, open: event.end === null
    };
  }
  return { dateParts, dateKey, calendarDate, startOfDay, addDays, fromDateKey, dayBounds, overlaps, onDay, timeLabel, dateTimeInput, parseDateTimeInput, formatDay, formatDateTime, weekSegments, daySegment };
}

// Default helpers are explicitly UTC, even when Node or the browser uses another zone.
export const { dateParts, dateKey, calendarDate, startOfDay, addDays, fromDateKey, dayBounds, overlaps, onDay, timeLabel, dateTimeInput, parseDateTimeInput, formatDay, formatDateTime, weekSegments, daySegment } = createDateUtils();
