// Optional browser verification with an already-installed Chromium browser.
// Uses Node's built-in WebSocket; downloads no browser or package.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = path.join(root, '.tmp');
await fs.mkdir(temporaryRoot, { recursive: true });
const runDir = await fs.mkdtemp(path.join(temporaryRoot, 'browser-'));
const output = path.join(temporaryRoot, 'screenshots');
await fs.mkdir(output, { recursive: true });
const executable = process.env.BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
await fs.access(executable);
const branding = { name: 'Payment & Ops', subtitle: '결제 서비스 운영 기록', defaultTheme: 'dark', timezone: 'Asia/Seoul' };
const brandingFile = path.join(runDir, 'branding.json');
await fs.writeFile(brandingFile, JSON.stringify(branding));
const app = await createApp({ dataDir: path.join(runDir, 'data'), brandingFile });
const address = await app.listen(0);
const base = `http://127.0.0.1:${address.port}`;
const password = 'browser-test-only-2026-암호';
const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${path.join(runDir, 'profile')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let socket;
let requestId = 0;
const pending = new Map();
const errors = [];
const mutations = [];
async function until(check, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(70); }
  throw new Error(`Timed out: ${message}`);
}
function command(method, params = {}) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function waitFor(expression, message) { await until(() => evaluate(expression), message); }
async function screenshot(name, full = false) {
  const metrics = await command('Page.getLayoutMetrics');
  const clip = full ? { x: 0, y: 0, width: metrics.cssContentSize.width, height: metrics.cssContentSize.height, scale: 1 } : undefined;
  const image = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, ...(clip ? { clip } : {}) });
  await fs.writeFile(path.join(output, name + '.png'), Buffer.from(image.data, 'base64'));
}
async function click(expression) { await evaluate(`(${expression}).click()`); }

async function pressKey(key, keyCode) {
  await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: keyCode });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: keyCode });
}

async function timelinePosition() {
  return evaluate(`(() => {
    const first = document.querySelector('.time-header-cell');
    const [year, month, day] = first.querySelector('.axis-date').textContent.split(' · ')[0].split('.').map(Number);
    return Date.UTC(year, month - 1, day) / 86400000 + document.querySelector('#timeline-scroller').scrollLeft / first.getBoundingClientRect().width;
  })()`);
}

async function dragTimeline(fraction, releaseOutside = false) {
  const before = await timelinePosition();
  const point = await evaluate(`(() => {
    const scroller = document.querySelector('#timeline-scroller');
    const rect = scroller.getBoundingClientRect();
    const header = document.querySelector('.timeline-header').getBoundingClientRect();
    const labelWidth = document.querySelector('.timeline-header .timeline-label').getBoundingClientRect().width;
    return { x: rect.left + labelWidth + (scroller.clientWidth - labelWidth) * ${fraction > 0 ? 0.9 : 0.1}, y: header.top + header.height / 2, width: document.querySelector('.time-header-cell').getBoundingClientRect().width };
  })()`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 8; step++) {
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x - fraction * point.width * step / 8, y: point.y, buttons: 1 });
    await delay(35);
    assert.ok(Math.abs(await timelinePosition() - before - fraction * step / 8) < 0.01, 'drag must follow the pointer continuously, including across date rebases');
    assert.ok(await evaluate('document.querySelector("#timeline-scroller").classList.contains("is-dragging")'));
  }
  const x = point.x - fraction * point.width;
  const y = point.y + (releaseOutside ? 130 : 0);
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await delay(80);
  assert.equal(await evaluate('document.querySelector("#timeline-scroller").classList.contains("is-dragging")'), false);
  assert.equal(await evaluate('!!document.querySelector("dialog[open]")'), false, 'releasing over an event must not open it');
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 20, y, buttons: 0 });
  assert.ok(Math.abs(await timelinePosition() - before - fraction) < 0.01, 'scrolling must stop on release');
}

async function selectMonth(year, month) {
  await evaluate(`(() => { const year = document.querySelector('#calendar-year'); year.value = '${year}'; year.dispatchEvent(new Event('change', { bubbles: true })); const month = document.querySelector('#calendar-month'); month.value = '${month - 1}'; month.dispatchEvent(new Event('change', { bubbles: true })); })()`);
}

async function setClock(instant, refresh = true) {
  await evaluate(`window.testNow = Date.parse('${instant}'); ${refresh ? "document.dispatchEvent(new Event('visibilitychange'));" : ''}`);
}

async function checkCurrentTime(date, time, fraction, popup = false) {
  const markers = await evaluate(`(() => {
    const cell = document.querySelector('.day-cell.today');
    const marker = cell?.querySelector('.calendar-now-line');
    const label = cell?.querySelector('.today-label');
    const dateBox = cell?.querySelector('.day-number').getBoundingClientRect();
    const labelBox = label?.getBoundingClientRect();
    const lines = ${popup} ? Array.from(document.querySelectorAll('.overflow-now-line:not([hidden])')) : (marker ? [marker] : []);
    return { date: cell?.dataset.date, label: label?.textContent, count: document.querySelectorAll('.calendar-now-line').length,
      labelFits: labelBox && labelBox.left >= dateBox.right && labelBox.right <= cell.getBoundingClientRect().right,
      popupRows: document.querySelectorAll('.overflow-item').length, popupLabel: document.querySelector('#overflow-now-text')?.textContent,
      lines: lines.map(line => {
        const box = line.getBoundingClientRect(), parent = line.parentElement.getBoundingClientRect(), style = getComputedStyle(line);
        return { x: box.left + box.width / 2 - parent.left - parseFloat(getComputedStyle(line.parentElement).borderLeftWidth), width: line.parentElement.clientWidth, height: box.height,
          inBounds: box.left >= parent.left && box.right <= parent.right && box.top >= parent.top && box.bottom <= parent.bottom,
          pointerEvents: style.pointerEvents, color: style.backgroundColor, expectedColor: getComputedStyle(document.documentElement).getPropertyValue('--red').trim() };
      }) };
  })()`);
  assert.equal(markers.date, date);
  assert.equal(markers.label, `현재 ${time}`);
  assert.equal(markers.count, 1, 'exactly one calendar cell shows the current time');
  assert.ok(markers.labelFits, 'the current time label must fit beside the date');
  assert.equal(markers.lines.length, popup ? markers.popupRows : 1);
  if (popup) assert.equal(markers.popupLabel, ` · 현재 ${time}`);
  for (const line of markers.lines) {
    assert.ok(Math.abs(line.x - fraction * line.width) < 3.5, JSON.stringify(line));
    assert.ok(line.inBounds && line.height > 20, JSON.stringify(line));
    assert.equal(line.pointerEvents, 'none', 'time indicators must allow clicks through');
    const expected = line.expectedColor.match(/\w\w/g).map(value => parseInt(value, 16));
    assert.equal(line.color, `rgb(${expected.join(', ')})`, 'markers use the red color for the active theme');
  }
}

async function checkCalendarLayout({ weeks, fits, september = false }) {
  const layout = await evaluate(`(() => {
    const calendar = document.querySelector('.calendar');
    const weeks = Array.from(calendar.querySelectorAll('.calendar-week'));
    const collisions = [];
    for (const week of weeks) {
      const cells = Array.from(week.querySelectorAll('.day-cell'));
      for (const badge of week.querySelectorAll('.event-badge')) {
        const bar = badge.getBoundingClientRect();
        for (let index = Number(badge.dataset.start); index <= Number(badge.dataset.end); index++) {
          const cell = cells[index];
          const top = cell.querySelector('.day-number').getBoundingClientRect().bottom;
          const bottom = (cell.querySelector('.day-more') || cell).getBoundingClientRect();
          if (bar.top < top || bar.bottom > (cell.querySelector('.day-more') ? bottom.top : bottom.bottom)) collisions.push(badge.textContent);
        }
      }
    }
    const day = calendar.querySelector('.day-cell[data-date="2026-09-09"]');
    const index = day ? Array.from(day.parentElement.children).indexOf(day) : -1;
    const visible = day ? Array.from(day.closest('.calendar-week').querySelectorAll('.event-badge')).filter(badge => Number(badge.dataset.start) <= index && Number(badge.dataset.end) >= index).length : 0;
    const hidden = Number(day?.querySelector('.day-more')?.textContent.match(/\\d+/)?.[0] || 0);
    return { weeks: weeks.length, cells: calendar.querySelectorAll('.day-cell').length, height: weeks[0].getBoundingClientRect().height, page: document.documentElement.scrollHeight, viewport: innerHeight, width: document.documentElement.scrollWidth, viewportWidth: innerWidth, collisions, visible, hidden, lanes: Number(calendar.dataset.visibleLanes) };
  })()`);
  assert.equal(layout.weeks, weeks);
  assert.equal(layout.cells, weeks * 7);
  assert.ok(layout.height >= 80, JSON.stringify(layout));
  assert.ok(layout.lanes >= 1 && layout.lanes <= 3);
  assert.deepEqual(layout.collisions, [], 'event badges must not overlap dates or overflow controls');
  assert.ok(layout.width <= layout.viewportWidth + 1, 'only the calendar may scroll horizontally');
  if (fits) assert.ok(layout.page <= layout.viewport + 1, JSON.stringify(layout));
  else assert.ok(layout.page > layout.viewport, 'short screens should retain readable cells and scroll');
  if (september) assert.equal(layout.visible + layout.hidden, 5, 'all events remain reachable at every density');
  console.log(`Calendar ${layout.viewportWidth}x${layout.viewport}: ${weeks} weeks, ${layout.height}px cells, ${layout.lanes} lanes, ${layout.page}px page`);
  return layout;
}

async function checkCalendarTimeFills() {
  const fills = await evaluate(`Array.from(document.querySelectorAll('.calendar .event-time-day')).map(day => {
    const badge = day.closest('.event-badge');
    const cell = badge.closest('.calendar-week').querySelector('.day-cell[data-date="' + day.dataset.date + '"]');
    const active = day.querySelector('.event-time-active');
    const box = day.getBoundingClientRect(), color = active.getBoundingClientRect();
    const bounds = badge.getBoundingClientRect(), date = cell.getBoundingClientRect();
    return { title: badge.querySelector('.event-name').textContent, date: day.dataset.date,
      left: (color.left - box.left) / box.width, width: color.width / box.width,
      alignment: Math.max(Math.abs(box.left - Math.max(date.left, bounds.left)), Math.abs(box.right - Math.min(date.right, bounds.right))) };
  })`);
  assert.ok(fills.length > 0, 'calendar badges must display daily time spans');
  for (const fill of fills) assert.ok(fill.alignment < 0.1, `fill must align with its calendar date: ${JSON.stringify(fill)}`);
  const expected = [
    ['시간 비율 확인', '2026-09-03', 9 / 24, 9 / 24],
    ['데이터베이스 정기 점검', '2026-09-07', 22 / 24, 2 / 24],
    ['데이터베이스 정기 점검', '2026-09-08', 0, 1],
    ['데이터베이스 정기 점검', '2026-09-09', 0, 1],
    ['데이터베이스 정기 점검', '2026-09-10', 0, 11 / 24],
    ['인증 서비스 불안정', '2026-09-09', 15 / 24, 9 / 24],
    ['인증 서비스 불안정', '2026-09-13', 0, 1],
    ['주 경계 점검', '2026-09-05', 23 / 24, 1 / 24],
    ['주 경계 점검', '2026-09-06', 0, 1],
    ['월 경계 점검', '2026-08-31', 18 / 24, 6 / 24],
    ['월 경계 점검', '2026-09-01', 0, 1],
    ['월 경계 점검', '2026-09-02', 0, 12 / 24]
  ];
  for (const [title, date, left, width] of expected) {
    const fill = fills.find(item => item.title === title && item.date === date);
    assert.ok(fill, `missing daily fill: ${title}, ${date}`);
    assert.ok(Math.abs(fill.left - left) < 0.001 && Math.abs(fill.width - width) < 0.001, JSON.stringify(fill));
  }
  assert.ok(!fills.some(item => item.title === '주 경계 점검' && item.date === '2026-09-07'), 'midnight ending must not paint the following day');
  const colors = await evaluate(`Array.from(document.querySelectorAll('.event-badge')).map(badge => {
    const style = element => getComputedStyle(element);
    return { text: style(badge).color, active: style(badge.querySelector('.event-time-active')).backgroundColor,
      inactive: style(badge.querySelector('.event-time-day')).backgroundColor, titleOnTop: style(badge.querySelector('.event-name')).position !== 'static' };
  })`);
  const luminance = rgb => rgb.match(/[0-9.]+/g).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  for (const color of colors) {
    assert.ok(luminance(color.active) > luminance(color.inactive), 'time outside the event must be darker in both themes');
    for (const background of [color.active, color.inactive]) {
      const a = luminance(color.text), b = luminance(background);
      assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5, `badge text must remain readable: ${JSON.stringify(color)}`);
    }
    assert.ok(color.titleOnTop, 'the duration fill must not cover the title');
  }
}

async function checkOverflowTimeFills(date, expected) {
  const rows = await evaluate(`Array.from(document.querySelectorAll('.overflow-item')).map(row => {
    const day = row.querySelector('.event-time-day'), active = row.querySelector('.event-time-active');
    const cell = day.getBoundingClientRect(), fill = active.getBoundingClientRect(), box = row.getBoundingClientRect();
    const body = row.querySelector('.overflow-item-body').getBoundingClientRect();
    return { title: row.querySelector('strong').textContent, date: day.dataset.date,
      left: (fill.left - cell.left) / cell.width, width: fill.width / cell.width,
      fullWidth: Math.abs(cell.width - row.clientWidth) < 0.1,
      textFits: body.top >= box.top && body.bottom <= box.bottom && row.scrollHeight <= row.clientHeight + 1,
      hatched: getComputedStyle(day).backgroundImage.includes('repeating-linear-gradient'),
      activePlain: getComputedStyle(active).backgroundImage === 'none' };
  })`);
  assert.equal(rows.length, expected.length);
  for (const [title, left, width] of expected) {
    const row = rows.find(item => item.title === title);
    assert.ok(row, `missing popup row: ${title}`);
    assert.equal(row.date, date, 'popup background must use its own selected date');
    assert.ok(Math.abs(row.left - left) < 0.001 && Math.abs(row.width - width) < 0.001, JSON.stringify(row));
    assert.ok(row.fullWidth && row.textFits && row.hatched && row.activePlain, JSON.stringify(row));
  }
}

try {
  let port;
  await until(async () => {
    try { port = Number((await fs.readFile(path.join(runDir, 'profile', 'DevToolsActivePort'), 'utf8')).split('\n')[0]); return port > 0; }
    catch { return false; }
  }, 'browser debug port');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(item => item.type === 'page');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.id) {
      const item = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) item?.reject(new Error(data.error.message));
      else item?.resolve(data.result);
    }
    if (data.method === 'Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text);
    if (data.method === 'Network.requestWillBeSent' && !['GET', 'HEAD'].includes(data.params.request.method)) mutations.push(data.params.request.url);
  });
  await command('Runtime.enable');
  await command('Page.enable');
  await command('Emulation.setLocaleOverride', { locale: 'en-US' });
  await command('Emulation.setTimezoneOverride', { timezoneId: 'America/Los_Angeles' });
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `
    const NativeDate = window.Date;
    window.testNow = NativeDate.parse('2026-09-09T03:00:00Z');
    window.Date = class extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [window.testNow])); }
      static now() { return window.testNow; }
    };
  ` });
  await command('Network.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await command('Page.navigate', { url: base });
  await waitFor('!!document.querySelector("#auth-form")', 'setup page');
  assert.equal(await evaluate('document.querySelector(".brand-name").textContent'), branding.name);
  assert.equal(await evaluate('document.title'), `${branding.name} · ${branding.subtitle}`);
  assert.ok(await evaluate(`document.querySelector('.auth-footer').textContent.startsWith(${JSON.stringify(branding.name)})`));
  const themeKey = 'service-incident-timeline.theme';
  const themeControl = `document.querySelector('[data-action="theme-toggle"]')`;
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
  assert.equal(await evaluate(`localStorage.getItem('${themeKey}')`), null, 'branding default must not become a saved preference');
  assert.equal(await evaluate('getComputedStyle(document.documentElement).colorScheme'), 'dark');
  await screenshot('setup-dark');
  await evaluate(`document.querySelector('#auth-form').elements.password.value = 'unsaved-form-input'`);
  await click(themeControl);
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
  assert.equal(await evaluate(`localStorage.getItem('${themeKey}')`), 'light');
  assert.equal(await evaluate(`document.querySelector('#auth-form').elements.password.value`), 'unsaved-form-input');
  assert.equal(await evaluate(`${themeControl}.getAttribute('aria-checked')`), 'false');
  await command('Page.reload');
  await waitFor('!!document.querySelector("#auth-form") && document.documentElement.dataset.theme === "light"', 'saved preference overrides dark branding after reload');

  // A second window of the same origin shares the preference with this window.
  await evaluate(`window.themeTestTab = window.open('${base}', 'theme-check'); true`);
  await waitFor('!!window.themeTestTab?.document.querySelector("#auth-form")', 'second theme window');
  await evaluate(`window.themeTestTab.localStorage.setItem('${themeKey}', 'dark')`);
  await waitFor('document.documentElement.dataset.theme === "dark"', 'theme preference sync across windows');
  await evaluate('window.themeTestTab.close(); delete window.themeTestTab');
  await evaluate(`localStorage.setItem('${themeKey}', 'invalid-theme')`);
  await command('Page.reload');
  await waitFor('!!document.querySelector("#auth-form") && document.documentElement.dataset.theme === "dark"', 'invalid preference falls back to branding');

  const blockedStorage = await command('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage blocked', 'SecurityError'); } });" });
  await command('Page.reload');
  await waitFor('!!document.querySelector("#auth-form")', 'storage blocked setup');
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
  await click(themeControl);
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light', 'theme switching works with storage disabled');
  await command('Page.removeScriptToEvaluateOnNewDocument', { identifier: blockedStorage.identifier });
  await command('Page.reload');
  await waitFor('!!document.querySelector("#auth-form") && document.documentElement.dataset.theme === "dark"', 'restore browser storage');
  await click(themeControl);
  assert.equal(mutations.length, 0, 'theme changes do not write to the server');
  await screenshot('setup');
  await evaluate(`(() => { const form = document.querySelector('#auth-form'); form.elements.password.value = ${JSON.stringify(password)}; form.elements.confirm.value = ${JSON.stringify(password)}; form.requestSubmit(); })()`);
  await waitFor('!!document.querySelector(".calendar")', 'setup and first calendar');
  assert.equal(await evaluate('document.querySelector(".brand-name").textContent'), branding.name);
  assert.equal(await evaluate('document.querySelector(".brand-caption").textContent'), branding.subtitle);
  assert.equal(await evaluate('Intl.DateTimeFormat().resolvedOptions().timeZone'), 'America/Los_Angeles');
  const seeds = [
    { title: '시간 비율 확인', service: 'Schedule', category: 'maintenance', start: '2026-09-03T00:00:00.000Z', end: '2026-09-03T09:00:00.000Z', description: '09:00~18:00 구간을 배지의 가운데에 표시합니다.' },
    { title: '주 경계 점검', service: 'Schedule', category: 'maintenance', start: '2026-09-05T14:00:00.000Z', end: '2026-09-06T15:00:00.000Z', description: '' },
    { title: '월 경계 점검', service: 'Schedule', category: 'incident', start: '2026-08-31T09:00:00.000Z', end: '2026-09-02T03:00:00.000Z', description: '' },
    { title: '결제 API 응답 지연', service: 'Payment API', category: 'incident', start: '2026-09-09T01:20:00.000Z', end: '2026-09-09T04:45:00.000Z', description: '오류율 증가 확인 후 트래픽을 우회했습니다.\n13:45 정상 응답 확인.' },
    { title: '데이터베이스 정기 점검', service: 'Primary DB', category: 'maintenance', start: '2026-09-07T13:00:00.000Z', end: '2026-09-10T02:00:00.000Z', description: '여러 날짜에 걸친 정기 점검입니다.' },
    { title: '인증 서비스 불안정', service: 'Identity', category: 'instability', start: '2026-09-09T06:00:00.000Z', end: null, description: '원인을 확인하고 있습니다.' },
    { title: '검색 인덱스 재구성', service: 'Search', category: 'maintenance', start: '2026-09-09T09:00:00.000Z', end: '2026-09-09T11:00:00.000Z', description: '' },
    { title: '네트워크 점검', service: 'Network', category: 'maintenance', start: '2026-09-09T12:00:00.000Z', end: '2026-09-09T14:00:00.000Z', description: '' },
    { title: '캐시 클러스터 교체', service: 'Cache', category: 'maintenance', start: '2026-09-15T00:00:00.000Z', end: '2026-09-15T04:00:00.000Z', description: '' },
    { title: '배포 중 서비스 연결 오류', service: 'Gateway', category: 'incident', start: '2026-09-18T07:00:00.000Z', end: '2026-09-18T08:20:00.000Z', description: '' },
    { title: '스토리지 정기 점검', service: 'Storage', category: 'maintenance', start: '2026-09-22T12:00:00.000Z', end: '2026-09-24T02:00:00.000Z', description: '' },
    { title: '<img src=x onerror="window.injected=true">', service: 'XSS fixture', category: 'maintenance', start: '2026-09-02T00:00:00.000Z', end: '2026-09-02T01:00:00.000Z', description: '<script>window.injected=true</script>' }
  ];
  await evaluate(`(async () => { for (const event of ${JSON.stringify(seeds)}) { const response = await fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event) }); if (!response.ok) throw new Error(await response.text()); } location.reload(); })()`);
  await waitFor('document.querySelectorAll(".event-badge").length > 0', 'seed calendar');
  await evaluate(`(() => { const year = document.querySelector('#calendar-year'); year.value = '2026'; year.dispatchEvent(new Event('change', { bubbles: true })); const month = document.querySelector('#calendar-month'); month.value = '8'; month.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.ok(await evaluate('document.querySelectorAll(".day-more").length > 0'));
  assert.equal(await evaluate('!!window.injected'), false);
  assert.equal(await evaluate('!!document.querySelector(".event-badge img")'), false);
  // Remove the deliberately hostile title before saving a clean product preview.
  await evaluate(`(async () => { const data = await (await fetch('/api/events')).json(); const record = data.events.find(event => event.service === 'XSS fixture'); const response = await fetch('/api/events/' + record.id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: record.version }) }); if (!response.ok) throw new Error('Fixture deletion failed'); location.reload(); })()`);
  await waitFor('!!document.querySelector(".calendar")', 'calendar reload');
  await evaluate(`(() => { const year = document.querySelector('#calendar-year'); year.value = '2026'; year.dispatchEvent(new Event('change', { bubbles: true })); const month = document.querySelector('#calendar-month'); month.value = '8'; month.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await checkCalendarLayout({ weeks: 5, fits: true, september: true });
  await checkCalendarTimeFills();
  await checkCurrentTime('2026-09-09', '12:00', 0.5);
  await click(`document.querySelector('.day-cell.today .day-more')`);
  await checkCurrentTime('2026-09-09', '12:00', 0.5, true);
  await screenshot('current-time-popup-light');
  await setClock('2026-09-09T09:00:00Z');
  await checkCurrentTime('2026-09-09', '18:00', 0.75, true);
  await setClock('2026-09-09T14:59:00Z');
  await checkCurrentTime('2026-09-09', '23:59', 1439 / 1440, true);
  // Let the real 15-second timer handle midnight with the popup still open.
  await setClock('2026-09-09T15:00:00Z', false);
  await until(() => evaluate(`document.querySelector('.day-cell.today')?.dataset.date === '2026-09-10'`), 'calendar midnight rollover', 20000);
  await checkCurrentTime('2026-09-10', '00:00', 0);
  assert.equal(await evaluate('document.querySelectorAll(".overflow-now-line:not([hidden])").length'), 0, 'yesterday popup loses its current time markers at midnight');
  assert.equal(await evaluate('document.querySelector("#overflow-now-text").hidden'), true);
  // Moving the clock back makes the still-open selected date become today again.
  await setClock('2026-09-08T15:00:00Z');
  await checkCurrentTime('2026-09-09', '00:00', 0, true);
  await setClock('2026-09-07T15:00:00Z');
  assert.equal(await evaluate('document.querySelectorAll(".overflow-now-line:not([hidden])").length'), 0, 'future popup dates have no current time markers');
  await setClock('2026-09-09T03:00:00Z');
  // Use an actual pointer exactly on a row's marker to check event navigation.
  const popupPoint = await evaluate(`(() => { const line = document.querySelector('.overflow-now-line').getBoundingClientRect(); return { x: line.left + line.width / 2, y: line.top + line.height / 2 }; })()`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...popupPoint, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...popupPoint, button: 'left', clickCount: 1 });
  assert.equal(await evaluate('document.querySelector("#overflow-dialog").open'), false);
  assert.equal(await evaluate('document.querySelector("#timeline-date-input").value'), '2026-09-09');
  assert.equal(await evaluate('document.querySelector("#now-text").textContent'), '12:00');
  await click(`document.querySelector('[data-view="calendar"]')`);
  // Month rollover updates adjacent-month cells without changing the chosen month.
  await setClock('2026-09-30T14:59:00Z');
  await checkCurrentTime('2026-09-30', '23:59', 1439 / 1440);
  await setClock('2026-09-30T15:00:00Z');
  await checkCurrentTime('2026-10-01', '00:00', 0);
  assert.equal(await evaluate('document.querySelector("#calendar-month").value'), '8');
  await setClock('2026-09-09T03:00:00Z');
  for (const [year, month, weeks, first, last] of [
    [2026, 2, 4, '2026-02-01', '2026-02-28'],
    [2024, 2, 5, '2024-01-28', '2024-03-02'],
    [2026, 8, 6, '2026-07-26', '2026-09-05'],
    [2026, 12, 5, '2026-11-29', '2027-01-02']
  ]) {
    await selectMonth(year, month);
    await checkCalendarLayout({ weeks, fits: true });
    assert.equal(await evaluate('document.querySelectorAll(".calendar-now-line").length'), 0, 'months without today have no current time marker');
    assert.equal(await evaluate('document.querySelector(".day-cell").dataset.date'), first);
    assert.equal(await evaluate('Array.from(document.querySelectorAll(".day-cell")).at(-1).dataset.date'), last);
  }
  await click(`document.querySelector('[data-action="next-month"]')`);
  assert.equal(await evaluate('document.querySelector(".summary-period").textContent'), '2027.1');
  await selectMonth(2026, 9);
  const densities = new Set();
  for (const [width, height, fits] of [[1920, 1080, true], [1440, 900, true], [1366, 768, true], [1280, 600, false], [900, 900, true]]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await delay(300);
    const layout = await checkCalendarLayout({ weeks: 5, fits, september: true });
    await checkCurrentTime('2026-09-09', '12:00', 0.5);
    densities.add(layout.lanes);
    await screenshot(`calendar-${width}x${height}`);
  }
  assert.deepEqual([...densities].sort(), [1, 2, 3]);
  // Resizing from a scrolled short screen must not add the scroll offset to the calendar.
  await evaluate('window.scrollTo(0, document.documentElement.scrollHeight)');
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await delay(300);
  await selectMonth(2026, 8);
  await checkCalendarLayout({ weeks: 6, fits: true });
  await selectMonth(2026, 9);
  await click(`document.querySelector('[data-action="theme-toggle"]')`);
  await checkCalendarLayout({ weeks: 5, fits: true, september: true });
  await screenshot('calendar-dark');
  await checkCurrentTime('2026-09-09', '12:00', 0.5);
  await click(`document.querySelector('[data-action="theme-toggle"]')`);
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await delay(300);
  await screenshot('calendar', true);
  const encryptedBeforeTheme = await fs.readFile(path.join(runDir, 'data', 'store.json'), 'utf8');
  const mutationsBeforeTheme = mutations.length;
  await click(themeControl);
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
  assert.equal(await evaluate('document.querySelector("#calendar-month").value'), '8');
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".workspace")).backgroundColor'), 'rgb(27, 40, 34)');
  await screenshot('calendar-dark', true);
  await checkCalendarTimeFills();
  assert.equal(await fs.readFile(path.join(runDir, 'data', 'store.json'), 'utf8'), encryptedBeforeTheme);
  assert.equal(mutations.length, mutationsBeforeTheme);
  // Click the middle day of a multi-day badge with an actual pointer event.
  const point = await evaluate(`(() => { const day = document.querySelector('.day-cell[data-date="2026-09-09"]'); const week = day.closest('.calendar-week'); const badge = Array.from(week.querySelectorAll('.event-badge')).find(button => button.textContent.includes('데이터베이스')); const cell = day.getBoundingClientRect(); const bar = badge.getBoundingClientRect(); return { x: cell.left + cell.width / 2, y: bar.top + bar.height / 2 }; })()`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await waitFor('!!document.querySelector(".timeline-row.highlighted")', 'multi-day pointer navigation');
  assert.equal(await evaluate('document.querySelector("#timeline-date-input").value'), '2026-09-09');
  assert.ok(await evaluate('document.querySelector(".timeline-row.highlighted").textContent.includes("데이터베이스")'));
  await click(`document.querySelector('[data-action="view"][data-view="calendar"]')`);
  await selectMonth(2026, 9); // The calendar selection is now Sep 1; open the Sep 9 popup.
  await click(`document.querySelector('.day-cell[data-date="2026-09-09"] .day-more')`);
  assert.equal(await evaluate('document.querySelectorAll(".overflow-item").length'), 5);
  const popupTimes = await evaluate(`Object.fromEntries(Array.from(document.querySelectorAll('.overflow-item')).map(button => [button.querySelector('strong').textContent, Array.from(button.querySelector('.overflow-times').children).map(child => child.textContent)]))`);
  assert.deepEqual(popupTimes['데이터베이스 정기 점검'], ['시작', '2026.09.07 22:00', '종료', '2026.09.10 11:00']);
  assert.deepEqual(popupTimes['결제 API 응답 지연'], ['시작', '당일 10:20', '종료', '당일 13:45']);
  assert.deepEqual(popupTimes['인증 서비스 불안정'], ['시작', '당일 15:00', '종료', '미정 ∞']);
  assert.ok(await evaluate('document.querySelector(".overflow-context").textContent.includes("Asia/Seoul")'));
  assert.ok(await evaluate('document.querySelector("#overflow-title").textContent.includes("2026년")'));
  const popupTimeFills = [
    ['데이터베이스 정기 점검', 0, 1],
    ['결제 API 응답 지연', (10 + 20 / 60) / 24, (3 + 25 / 60) / 24],
    ['인증 서비스 불안정', 15 / 24, 9 / 24],
    ['검색 인덱스 재구성', 18 / 24, 2 / 24],
    ['네트워크 점검', 21 / 24, 2 / 24]
  ];
  await checkOverflowTimeFills('2026-09-09', popupTimeFills);
  await checkCurrentTime('2026-09-09', '12:00', 0.5, true);
  await screenshot('event-list-dark');
  await click(themeControl);
  await checkOverflowTimeFills('2026-09-09', popupTimeFills);
  await screenshot('event-list-light');
  await click(themeControl);
  await click(`Array.from(document.querySelectorAll('.overflow-item')).find(button => button.textContent.includes('결제 API'))`);
  await waitFor('!!document.querySelector(".timeline-row.highlighted")', 'calendar to timeline highlighting');
  assert.equal(await evaluate('document.querySelector("#timeline-date-input").value'), '2026-09-09');
  await screenshot('timeline-dark');
  const scrollBeforeTheme = await evaluate('document.querySelector("#timeline-scroller").scrollLeft');
  await click(themeControl);
  assert.equal(await evaluate('document.querySelector("#timeline-scroller").scrollLeft'), scrollBeforeTheme);
  assert.ok(await evaluate('!!document.querySelector(".timeline-row.highlighted")'));
  await screenshot('timeline');

  assert.equal(await evaluate('!!document.querySelector(".page-footer,.workspace-footer")'), false);
  assert.ok(await evaluate('document.querySelector(".header .timezone-badge").textContent.includes("Asia/Seoul")'));
  assert.ok(await evaluate('document.querySelector(".header-status").getBoundingClientRect().bottom <= document.querySelector(".header").getBoundingClientRect().bottom'));
  assert.ok(await evaluate('document.querySelector("#time-headers").title.includes("드래그")'));
  assert.ok(await evaluate('document.querySelector(".timeline-bar").title.includes("상세 보기")'));
  await dragTimeline(0.65, true);
  assert.equal(await evaluate('document.querySelector("#timeline-date-input").value'), '2026-09-10');
  await dragTimeline(-0.65);
  assert.equal(await evaluate('document.querySelector("#timeline-date-input").value'), '2026-09-09');
  for (const [position, movement] of [[1.15, -0.4], [4.85, 0.4]]) {
    await evaluate(`document.querySelector('#timeline-scroller').scrollLeft = document.querySelector('.time-header-cell').getBoundingClientRect().width * ${position}`);
    await delay(100);
    await dragTimeline(movement);
  }
  // A cancelled gesture must not leave a stuck grab state.
  const cancelPoint = await evaluate(`(() => {
    const header = document.querySelector('.timeline-header').getBoundingClientRect();
    const label = document.querySelector('.timeline-header .timeline-label').getBoundingClientRect();
    return { x: label.right + 80, y: header.top + 30 };
  })()`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...cancelPoint, button: 'left', buttons: 1, clickCount: 1 });
  await evaluate('document.querySelector("#timeline-scroller").dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }))');
  assert.equal(await evaluate('document.querySelector("#timeline-scroller").classList.contains("is-dragging")'), false);
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...cancelPoint, button: 'left', buttons: 0, clickCount: 1 });
  await evaluate(`(() => { const input = document.querySelector('#timeline-date-input'); input.value = '2026-09-09'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  // The moved status remains live during both failures and recovery.
  await command('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await evaluate('document.dispatchEvent(new Event("visibilitychange"))');
  await waitFor('document.querySelector(".header-status #sync-status").classList.contains("error")', 'top sync error state');
  await click(`document.querySelector('[data-action="view"][data-view="calendar"]')`);
  assert.equal(await evaluate('document.querySelector(".header #sync-status").textContent'), '연결 확인 필요', 'view changes preserve connection errors');
  await click(`document.querySelector('[data-action="view"][data-view="timeline"]')`);
  await screenshot('header-connection-error');
  await command('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await evaluate('document.dispatchEvent(new Event("visibilitychange"))');
  await waitFor('!document.querySelector(".header-status #sync-status").classList.contains("error")', 'top sync status recovery');
  assert.equal(await evaluate('document.querySelector(".header #sync-status").textContent'), '동기화됨');

  for (let index = 0; index < 8; index++) {
    await evaluate(`document.querySelector('#timeline-scroller').scrollLeft += document.querySelector('.time-header-cell').getBoundingClientRect().width`);
    await delay(110);
  }
  assert.equal(await evaluate('document.querySelector("#timeline-date-input").value'), '2026-09-17');
  for (let index = 0; index < 16; index++) {
    await evaluate(`document.querySelector('#timeline-scroller').scrollLeft -= document.querySelector('.time-header-cell').getBoundingClientRect().width`);
    await delay(110);
  }
  assert.equal(await evaluate('document.querySelector("#timeline-date-input").value'), '2026-09-01');
  await evaluate(`(() => { const input = document.querySelector('#timeline-date-input'); input.value = '2026-09-09'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await click(`document.querySelector('[data-action="new-event"]')`);
  await click(themeControl);
  assert.equal(await evaluate('getComputedStyle(document.querySelector("#event-dialog")).backgroundColor'), 'rgb(27, 40, 34)');
  await screenshot('event-dialog-dark');
  await evaluate(`(() => {
    const form = document.querySelector('#event-form');
    form.elements.title.value = 'UI 테스트 이벤트';
    form.elements.startDate.value = '2026-09-09';
    form.elements.startHour.value = '23';
    form.elements.startMinute.value = '59';
    form.elements.endDate.value = '2026-09-09';
    form.elements.endHour.value = '00';
    form.elements.endMinute.value = '00';
    form.requestSubmit();
  })()`);
  assert.equal(await evaluate('document.querySelector("#event-form").elements.endDate.validity.customError'), true, 'earlier end time must be rejected');
  await evaluate(`(() => {
    const form = document.querySelector('#event-form');
    form.elements.endDate.value = '2026-09-10';
    form.elements.endDate.dispatchEvent(new Event('input', { bubbles: true }));
    form.elements.startHour.focus();
  })()`);
  assert.equal(await evaluate('!!document.querySelector("#event-form input[type=datetime-local], #event-form input[type=time]")'), false, 'clock display must not depend on native AM/PM formatting');
  await screenshot('event-24-hour');
  await evaluate('document.querySelector("#event-form").requestSubmit()');
  await waitFor('!document.querySelector("#event-dialog").open && document.querySelector("#timeline-rows").textContent.includes("UI 테스트 이벤트")', 'manual creation');
  const savedClock = await evaluate(`(async () => { const event = (await (await fetch('/api/events')).json()).events.find(event => event.title === 'UI 테스트 이벤트'); return { start: event.start, end: event.end }; })()`);
  assert.deepEqual(savedClock, { start: '2026-09-09T14:59:00.000Z', end: '2026-09-09T15:00:00.000Z' });
  await click(`Array.from(document.querySelectorAll('.timeline-label[data-action="detail"]')).find(button => button.textContent.includes('UI 테스트 이벤트'))`);
  await click(`document.querySelector('[data-action="edit-event"]')`);
  assert.deepEqual(await evaluate(`(() => { const fields = document.querySelector('#event-form').elements; return ['startDate', 'startHour', 'startMinute', 'endDate', 'endHour', 'endMinute'].map(name => fields[name].value); })()`), ['2026-09-09', '23', '59', '2026-09-10', '00', '00']);
  assert.ok(await evaluate('document.querySelector("#event-timezone").textContent.includes("Asia/Seoul")'));
  await evaluate(`(() => { const form = document.querySelector('#event-form'); form.elements.title.value = 'UI 수정 이벤트'; form.elements.openEnded.checked = true; form.elements.openEnded.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.equal(await evaluate('Array.from(document.querySelectorAll("#end-fields input, #end-fields select")).every(field => field.matches(":disabled"))'), true);
  await evaluate(`(() => { const form = document.querySelector('#event-form'); form.elements.openEnded.checked = false; form.elements.openEnded.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.equal(await evaluate('document.querySelector("#event-form").elements.endHour.value'), '00');
  assert.equal(await evaluate('document.querySelector("#event-form").elements.endDate.matches(":disabled")'), false);
  await evaluate(`(() => { const form = document.querySelector('#event-form'); form.elements.openEnded.checked = true; form.elements.openEnded.dispatchEvent(new Event('change', { bubbles: true })); form.requestSubmit(); })()`);
  await waitFor('!document.querySelector("#event-dialog").open && document.querySelector("#timeline-rows").textContent.includes("UI 수정 이벤트")', 'manual editing');
  await click(`Array.from(document.querySelectorAll('.timeline-label[data-action="detail"]')).find(button => button.textContent.includes('UI 수정 이벤트'))`);
  assert.ok(await evaluate('document.querySelector("#detail-content").textContent.includes("종료 시각 미정")'));
  await click(`document.querySelector('[data-action="request-delete"]')`);
  await click(`document.querySelector('#delete-confirm')`);
  await waitFor('!document.querySelector("#delete-dialog").open && !document.querySelector("#timeline-rows").textContent.includes("UI 수정 이벤트")', 'manual deletion');

  // Branding edits persist independently of encrypted event data and apply immediately.
  const beforeBrandingSave = await fs.readFile(path.join(runDir, 'data', 'store.json'), 'utf8');
  await click(`document.querySelector('[data-action="branding-settings"]')`);
  await waitFor('!document.querySelector("#branding-fields").disabled', 'branding settings loaded');
  // An existing selection must not filter out other zones when using the dropdown.
  await evaluate('document.querySelector("#branding-form").elements.timezone.focus()');
  await pressKey('Home', 36);
  await pressKey('ArrowDown', 40);
  await pressKey('ArrowDown', 40);
  assert.equal(await evaluate('document.querySelector("#branding-form").elements.timezone.value'), 'Asia/Tokyo', 'another timezone must be reachable without clearing the current value');
  await pressKey('Home', 36);
  assert.equal(await evaluate('document.querySelector("#branding-form").elements.timezone.value'), 'UTC');
  await screenshot('branding-settings-dark');
  await evaluate(`(() => {
    const fields = document.querySelector('#branding-form').elements;
    fields.name.value = '운영 <Ops> & UI'; fields.subtitle.value = '숨겨도 유지되는 부제';
    fields.showSubtitle.checked = false; fields.defaultTheme.value = 'light'; fields.timezone.value = 'UTC';
    document.querySelector('#branding-form').requestSubmit();
  })()`);
  await waitFor('!document.querySelector("#branding-dialog").open', 'branding saved');
  assert.equal(await evaluate('document.querySelector(".brand-name").textContent'), '운영 <Ops> & UI');
  assert.equal(await evaluate('document.title'), '운영 <Ops> & UI');
  assert.equal(await evaluate('!!document.querySelector(".brand-caption")'), false);
  assert.ok(await evaluate('document.querySelector(".header .timezone-badge").textContent.includes("UTC")'));
  assert.equal(await evaluate('document.querySelector("#timeline-date-input").value'), '2026-09-09');
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark', 'personal theme overrides a new default');
  assert.equal((await fs.readFile(path.join(runDir, 'data', 'store.json'), 'utf8')), beforeBrandingSave);
  assert.equal(JSON.parse(await fs.readFile(brandingFile, 'utf8')).showSubtitle, false);
  await command('Page.reload');
  await waitFor('!!document.querySelector(".calendar")', 'saved branding after reload');
  await checkCurrentTime('2026-09-09', '03:00', 3 / 24);
  assert.equal(await evaluate('document.querySelector(".brand-name").textContent'), '운영 <Ops> & UI');
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
  await click(`document.querySelector('[data-action="branding-settings"]')`);
  await waitFor('!document.querySelector("#branding-fields").disabled', 'saved settings loaded');
  assert.equal(await evaluate('document.querySelector("#branding-form").elements.subtitle.value'), '숨겨도 유지되는 부제');
  await evaluate('document.querySelector("#branding-form").elements.timezone.focus()');
  await pressKey('End', 35);
  assert.equal(await evaluate('document.activeElement.name'), 'customTimezone');
  assert.equal(await evaluate('document.querySelector("#branding-form").checkValidity()'), false, 'custom timezone cannot be empty');
  await command('Input.insertText', { text: 'Not/A_Zone' });
  await evaluate('document.querySelector("#branding-form").requestSubmit()');
  await waitFor('!document.querySelector("#branding-error").hidden', 'invalid timezone feedback');
  assert.equal(await evaluate('document.querySelector("#branding-dialog").open'), true);
  assert.equal(JSON.parse(await fs.readFile(brandingFile, 'utf8')).timezone, 'UTC');
  await evaluate('document.querySelector("#branding-form").elements.customTimezone.select()');
  await command('Input.insertText', { text: 'Australia/Sydney' });
  await evaluate('document.querySelector("#branding-form").requestSubmit()');
  await waitFor('!document.querySelector("#branding-dialog").open', 'custom timezone saved');
  assert.equal(JSON.parse(await fs.readFile(brandingFile, 'utf8')).timezone, 'Australia/Sydney');
  assert.ok(await evaluate('document.querySelector(".header .timezone-badge").textContent.includes("Australia/Sydney")'));
  await checkCurrentTime('2026-09-09', '13:00', 13 / 24);
  await click(`document.querySelector('[data-action="branding-settings"]')`);
  await waitFor('!document.querySelector("#branding-fields").disabled', 'custom timezone reloaded');
  assert.equal(await evaluate('document.querySelector("#branding-form").elements.timezone.value'), 'custom');
  assert.equal(await evaluate('document.querySelector("#branding-form").elements.customTimezone.value'), 'Australia/Sydney');
  assert.equal(await evaluate('document.querySelector("#branding-custom-timezone").hidden'), false);
  await screenshot('branding-custom-timezone');
  // Another editor saves while this form is open; retain the draft and offer a reload.
  await evaluate(`(async () => {
    const current = await (await fetch('/api/settings/branding')).json();
    const result = await fetch('/api/settings/branding', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...current, branding: { ...current.branding, name: '다른 화면의 이름' } }) });
    if (!result.ok) throw new Error('Concurrent branding save failed');
    const form = document.querySelector('#branding-form');
    form.elements.name.value = '저장되지 않은 초안'; form.elements.timezone.value = 'UTC';
    form.elements.timezone.dispatchEvent(new Event('change', { bubbles: true })); form.requestSubmit();
  })()`);
  await waitFor('!document.querySelector("#branding-reload").hidden', 'branding conflict feedback');
  assert.equal(await evaluate('document.querySelector("#branding-form").elements.name.value'), '저장되지 않은 초안');
  await click('document.querySelector("#branding-reload")');
  await waitFor('!document.querySelector("#branding-fields").disabled', 'reload latest branding');
  assert.equal(await evaluate('document.querySelector("#branding-form").elements.name.value'), '다른 화면의 이름');
  await click(`document.querySelector('[data-close="branding-dialog"]')`);
  await evaluate(`localStorage.removeItem('${themeKey}')`);
  await command('Page.reload');
  await waitFor('!!document.querySelector(".calendar")', 'branding default without personal preference');
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'light');
  await click(`document.querySelector('[data-action="branding-settings"]')`);
  await waitFor('!document.querySelector("#branding-fields").disabled', 'restore branding settings');
  await screenshot('branding-settings-light');
  await evaluate(`(() => {
    const form = document.querySelector('#branding-form');
    for (const [key, value] of Object.entries(${JSON.stringify(branding)})) form.elements[key].value = value;
    form.elements.timezone.dispatchEvent(new Event('change', { bubbles: true }));
    form.elements.showSubtitle.checked = true; form.requestSubmit();
  })()`);
  await waitFor('!document.querySelector("#branding-dialog").open', 'restored branding saved');
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark', 'new default immediately applies without a personal preference');
  assert.equal(await evaluate(`localStorage.getItem('${themeKey}')`), null, 'saving a default must not create a personal preference');
  assert.equal(await evaluate('document.querySelector(".brand-caption").textContent'), branding.subtitle);
  assert.equal((await fs.readFile(path.join(runDir, 'data', 'store.json'), 'utf8')), beforeBrandingSave);
  await click(`document.querySelector('[data-view="timeline"]')`);
  await evaluate(`(() => { const input = document.querySelector('#timeline-date-input'); input.value = '2026-09-09'; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);

  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await delay(300);
  await evaluate('document.querySelector("#toast").hidden = true');
  assert.ok(await evaluate('document.documentElement.scrollWidth <= 391'), 'mobile layout must not overflow the page');
  await screenshot('mobile-timeline');
  await click(`document.querySelector('[data-action="new-event"]')`);
  assert.ok(await evaluate('document.querySelector("#event-dialog").scrollWidth <= document.querySelector("#event-dialog").clientWidth'), '24-hour controls must fit the mobile dialog');
  await screenshot('mobile-event-24-hour');
  await click(`document.querySelector('[data-close="event-dialog"]')`);
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
  await click(themeControl);
  await screenshot('mobile-timeline-light');
  await click(themeControl);
  await click(`document.querySelector('[data-action="view"][data-view="calendar"]')`);
  await checkCalendarLayout({ weeks: 5, fits: false, september: true });
  await evaluate('document.querySelector(".calendar-scroll").scrollLeft = 150');
  const calendarScroll = await evaluate('document.querySelector(".calendar-scroll").scrollLeft');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 700, deviceScaleFactor: 1, mobile: true });
  await delay(300);
  assert.equal(await evaluate('document.querySelector(".calendar-scroll").scrollLeft'), calendarScroll);
  await checkCalendarLayout({ weeks: 5, fits: false, september: true });
  await evaluate('document.querySelector(".calendar-scroll").scrollLeft = 0');
  await screenshot('mobile-calendar');
  await checkCurrentTime('2026-09-09', '12:00', 0.5);
  await click(`document.querySelector('[data-action="branding-settings"]')`);
  await waitFor('!document.querySelector("#branding-fields").disabled', 'mobile branding settings');
  assert.ok(await evaluate('document.querySelector("#branding-dialog").scrollWidth <= document.querySelector("#branding-dialog").clientWidth'));
  await screenshot('branding-settings-mobile');
  await evaluate(`(() => { const form = document.querySelector('#branding-form'); form.elements.timezone.value = 'custom'; form.elements.timezone.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  assert.ok(await evaluate('document.querySelector("#branding-dialog").scrollWidth <= document.querySelector("#branding-dialog").clientWidth'), 'custom timezone must fit the mobile dialog');
  await screenshot('branding-custom-timezone-mobile');
  await click(`document.querySelector('[data-close="branding-dialog"]')`);
  await click(`document.querySelector('.day-cell[data-date="2026-09-09"] .day-more')`);
  assert.ok(await evaluate('document.querySelector("#overflow-dialog").scrollWidth <= document.querySelector("#overflow-dialog").clientWidth'), 'event dates must fit the mobile popup');
  await screenshot('mobile-event-list');
  await checkOverflowTimeFills('2026-09-09', popupTimeFills);
  await checkCurrentTime('2026-09-09', '12:00', 0.5, true);
  await click(`document.querySelector('[data-close="overflow-dialog"]')`);
  await click(`document.querySelector('.day-cell[data-date="2026-09-10"] .day-more')`);
  await checkOverflowTimeFills('2026-09-10', [['데이터베이스 정기 점검', 0, 11 / 24], ['인증 서비스 불안정', 0, 1]]);
  assert.equal(await evaluate('document.querySelectorAll(".overflow-now-line:not([hidden])").length'), 0);
  await click(`document.querySelector('[data-close="overflow-dialog"]')`);
  await click(`document.querySelector('[data-action="logout"]')`);
  await waitFor('!!document.querySelector("#auth-form")', 'logout');
  assert.equal(await evaluate('document.documentElement.dataset.theme'), 'dark');
  await screenshot('mobile-login-dark');
  assert.equal(await evaluate('document.querySelector(".brand-name").textContent'), branding.name);
  assert.equal(await evaluate('document.querySelector("#detail-content").textContent'), '');
  assert.equal(await evaluate('document.querySelector("#auth-form").elements.password.value'), '');
  await evaluate(`(() => { const form = document.querySelector('#auth-form'); form.elements.password.value = ${JSON.stringify(password)}; form.requestSubmit(); })()`);
  await waitFor('!!document.querySelector(".calendar")', 'login again');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Browser checks passed: branding, default theme, browser preference persistence, cross-window sync, blocked storage, theme changes without server writes, setup, session, calendar overflow, timeline highlight, bidirectional infinite scroll, manual CRUD, mobile layout, XSS rendering, logout and login.');
  console.log(`Screenshots: ${output}`);
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN) await screenshot('failure').catch(() => {});
  throw error;
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await command('Browser.close').catch(() => {});
    socket.close();
  }
  browser.kill();
  await app.close();
  // Only remove the unique browser-test directory inside this workspace's .tmp.
  const resolved = path.resolve(runDir);
  assert.equal(path.dirname(resolved), temporaryRoot);
  assert.ok(path.basename(resolved).startsWith('browser-'));
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
