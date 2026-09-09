import { severity, createDateUtils } from './date-utils.js';

let timezone = 'UTC';
let { dateParts, dateKey, calendarDate, startOfDay, addDays, fromDateKey, dayBounds, overlaps, onDay, timeLabel, dateTimeInput, parseDateTimeInput, formatDay, formatDateTime, weekSegments, daySegment } = createDateUtils(timezone);

const $ = selector => document.querySelector(selector);
const root = $('#root');
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const categories = { maintenance: '점검', instability: '불안정', incident: '장애' };
const paths = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18M8 15h2M14 15h2M8 18h2"/>',
  timeline: '<path d="M4 4v16M10 4v16M16 4v16M22 4v16" opacity=".35"/><path d="M4 7h9M10 12h11M4 17h5" stroke-width="3"/>',
  left: '<path d="m14 6-6 6 6 6"/>', right: '<path d="m9 6 6 6-6 6"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  logout: '<path d="M9 4H5v16h4M12 12h9m-4-4 4 4-4 4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5"/>',
  moon: '<path d="M20.8 13.1A9 9 0 0 1 10.9 3.2a9 9 0 1 0 9.9 9.9Z"/>',
  warning: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5M12 17v.2"/>',
  tool: '<path d="m14 6 4 4 3-3a6 6 0 0 1-8 8l-6 6-4-4 6-6a6 6 0 0 1 8-8l-3 3Z"/>',
  infinity: '<path d="M6 16c5 0 7-8 12-8a4 4 0 0 1 0 8c-5 0-7-8-12-8a4 4 0 1 0 0 8Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  settings: '<path d="M3 7h2m6 0h10M3 17h10m6 0h2"/><circle cx="8" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  shield: '<path d="m12 3 8 3v6c0 4-5 8-8 9-3-1-8-5-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  focus: '<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5"/><circle cx="12" cy="12" r="3"/>',
  check: '<path d="m5 12 4 4L19 6"/>', edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z"/>'
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] ?? paths.calendar}</svg>`;
const state = { authenticated: false, initialized: false, events: [], revision: -1, view: 'calendar', date: dateKey(new Date()), filter: 'all', highlightedId: null, editing: null, deleting: null, syncing: false, syncError: false };
let branding = { name: '', subtitle: '' };
let brandingVersion = null;
let brandingRequest = 0;
let brandingSaving = false;
let toastTimer;
let timelineStart;
let dayWidth = 1000;
let scrollFrame;
let resizeTimer;
let sessionGeneration = 0;

function toast(message, error = false) {
  clearTimeout(toastTimer);
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast${error ? ' error' : ''}`;
  node.hidden = false;
  toastTimer = setTimeout(() => { node.hidden = true; node.textContent = ''; }, error ? 6500 : 3500);
}

async function api(url, options = {}) {
  const requestGeneration = sessionGeneration;
  let response;
  try {
    response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  } catch { throw new Error('서버에 연결할 수 없습니다. 연결 상태를 확인해 주세요.'); }
  let result;
  try { result = await response.json(); }
  catch { throw new Error('서버 응답을 읽을 수 없습니다. 잠시 후 다시 시도해 주세요.'); }
  if (!response.ok) {
    if (response.status === 401 && state.authenticated && requestGeneration === sessionGeneration && !['/api/login', '/api/setup'].includes(url)) {
      endSession();
      toast('로그인이 만료되었습니다. 다시 로그인해 주세요.', true);
    }
    const error = new Error(result.error || '요청을 처리하지 못했습니다.');
    error.status = response.status;
    throw error;
  }
  return result;
}

function brand() {
  return `<div class="brand"><img class="brand-mark" src="/favicon.svg" alt=""><div class="brand-copy"><div class="brand-name" title="${escape(branding.name)}">${escape(branding.name)}</div>${branding.subtitle ? `<div class="brand-caption" title="${escape(branding.subtitle)}">${escape(branding.subtitle)}</div>` : ''}</div></div>`;
}

function applyBranding(labels) {
  branding = labels;
  timezone = branding.timezone ?? 'UTC';
  ({ dateParts, dateKey, calendarDate, startOfDay, addDays, fromDateKey, dayBounds, overlaps, onDay, timeLabel, dateTimeInput, parseDateTimeInput, formatDay, formatDateTime, weekSegments, daySegment } = createDateUtils(timezone));
  document.title = branding.subtitle ? `${branding.name} · ${branding.subtitle}` : branding.name;
  window.timelineTheme.setDefault(branding.defaultTheme);
}

function updateCustomTimezone() {
  const form = $('#branding-form');
  const custom = form.elements.timezone.value === 'custom';
  $('#branding-custom-timezone').hidden = !custom;
  form.elements.customTimezone.disabled = !custom;
  form.elements.customTimezone.required = custom;
}

$('#branding-form').elements.timezone.addEventListener('change', () => {
  updateCustomTimezone();
  if (!$('#branding-custom-timezone').hidden) $('#branding-form').elements.customTimezone.focus();
});

function openBrandingSettings() {
  $('#branding-form').reset();
  updateCustomTimezone();
  brandingVersion = null;
  $('#branding-dialog').showModal();
  loadBrandingSettings();
}

async function loadBrandingSettings() {
  const request = ++brandingRequest;
  const generation = sessionGeneration;
  const form = $('#branding-form');
  $('#branding-fields').disabled = true;
  $('#branding-save').disabled = true;
  $('#branding-loading').hidden = false;
  $('#branding-error').hidden = true;
  $('#branding-reload').hidden = true;
  try {
    const result = await api('/api/settings/branding');
    if (request !== brandingRequest || generation !== sessionGeneration || !$('#branding-dialog').open) return;
    for (const key of ['name', 'subtitle', 'defaultTheme']) form.elements[key].value = result.branding[key];
    const selectedTimezone = result.branding.timezone;
    const preset = Array.from(form.elements.timezone.options).some(option => option.value === selectedTimezone);
    form.elements.timezone.value = preset ? selectedTimezone : 'custom';
    form.elements.customTimezone.value = preset ? '' : selectedTimezone;
    updateCustomTimezone();
    form.elements.showSubtitle.checked = result.branding.showSubtitle;
    brandingVersion = result.version;
    $('#branding-fields').disabled = false;
    $('#branding-save').disabled = false;
    form.elements.name.focus();
  } catch (error) {
    if (request !== brandingRequest || generation !== sessionGeneration || !$('#branding-dialog').open) return;
    $('#branding-error').textContent = error.message;
    $('#branding-error').hidden = false;
    $('#branding-reload').hidden = false;
  } finally {
    if (request === brandingRequest) $('#branding-loading').hidden = true;
  }
}

$('#branding-reload').addEventListener('click', loadBrandingSettings);
$('#branding-dialog').addEventListener('cancel', event => { if (brandingSaving) event.preventDefault(); });
$('#branding-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (brandingSaving || !brandingVersion || !state.authenticated) return;
  const form = event.currentTarget;
  const generation = sessionGeneration;
  const settings = Object.fromEntries(['name', 'subtitle', 'defaultTheme', 'timezone'].map(key => [key, form.elements[key].value.trim()]));
  if (settings.timezone === 'custom') settings.timezone = form.elements.customTimezone.value.trim();
  settings.showSubtitle = form.elements.showSubtitle.checked;
  brandingSaving = true;
  $('#branding-fields').disabled = true;
  $('#branding-error').hidden = true;
  $('#branding-reload').hidden = true;
  $('#branding-save').disabled = true;
  $('#branding-save').textContent = '저장 중…';
  for (const button of form.querySelectorAll('[data-close]')) button.disabled = true;
  try {
    const result = await api('/api/settings/branding', { method: 'PUT', body: JSON.stringify({ branding: settings, version: brandingVersion }) });
    if (generation !== sessionGeneration || !state.authenticated) return;
    brandingVersion = result.version;
    applyBranding(result.publicBranding);
    $('#branding-dialog').close();
    renderApp();
    $('[data-action="branding-settings"]').focus({ preventScroll: true });
    toast('브랜딩 설정을 저장했습니다.');
  } catch (error) {
    if (generation !== sessionGeneration || !state.authenticated) return;
    $('#branding-error').textContent = error.message;
    $('#branding-error').hidden = false;
    $('#branding-reload').hidden = error.status !== 409;
  } finally {
    brandingSaving = false;
    $('#branding-fields').disabled = !state.authenticated;
    $('#branding-save').disabled = !state.authenticated;
    $('#branding-save').textContent = '설정 저장';
    for (const button of form.querySelectorAll('[data-close]')) button.disabled = false;
  }
});

function themeButton() {
  const dark = window.timelineTheme.current === 'dark';
  return `<button type="button" class="theme-toggle" data-action="theme-toggle" role="switch" aria-label="다크 모드" aria-checked="${dark}" title="${dark ? '라이트' : '다크'} 모드로 전환">${icon(dark ? 'moon' : 'sun')}<span>${dark ? '다크' : '라이트'}</span></button>`;
}

document.addEventListener('themechange', () => {
  // Update only the control: keep forms, focus, selected dates and scroll intact.
  const template = document.createElement('template');
  template.innerHTML = themeButton();
  const replacement = template.content.firstElementChild;
  for (const button of document.querySelectorAll('[data-action="theme-toggle"]')) {
    button.innerHTML = replacement.innerHTML;
    button.setAttribute('aria-checked', replacement.getAttribute('aria-checked'));
    button.title = replacement.title;
  }
});

function renderAuth() {
  const setup = !state.initialized;
  root.innerHTML = `<div class="auth-page"><header class="auth-header">${brand()}<div class="auth-header-right"><span class="auth-label">우리 서비스의 모든 순간을, 안전하게.</span>${themeButton()}</div></header>
    <main id="main" class="auth-layout"><section class="auth-story"><p class="eyebrow">EVERY MOMENT, IN CONTEXT</p><h1>서비스의 하루를<br>한눈에 기록하세요.</h1><p>작은 점검부터 예기치 못한 장애까지.<br>흩어진 운영 기록을 하나의 시간 위에 모읍니다.</p>
      <div class="auth-visual" aria-hidden="true"><div class="visual-top"><strong>서비스 타임라인</strong><span>09:00　12:00　15:00　18:00</span></div><div class="visual-row"><span>정기 점검</span><div class="visual-track"><span class="visual-bar one">점검 완료</span></div></div><div class="visual-row"><span>API 장애</span><div class="visual-track"><span class="visual-bar two">장애 대응</span></div></div><div class="visual-row"><span>복구 확인</span><div class="visual-track"><span class="visual-bar three">정상화</span></div></div></div>
    </section><section class="auth-card"><div class="auth-key">${icon('lock')}</div><h2>${setup ? '처음 시작하기' : '기록 열기'}</h2><p class="auth-description">${setup ? '서비스 기록을 보호할 암호화 비밀번호를 설정하세요.<br>이 비밀번호로 로그인하고 데이터를 읽고 쓸 수 있습니다.' : '암호화 비밀번호를 입력해 주세요.<br>안전하게 보관한 서비스 기록을 불러옵니다.'}</p>
      <form id="auth-form"><label class="field">암호화 비밀번호<div class="password-wrap"><input name="password" type="password" required minlength="12" maxlength="256" autocomplete="${setup ? 'new-password' : 'current-password'}" placeholder="${setup ? '12자 이상의 비밀번호' : '비밀번호 입력'}"><button type="button" class="password-toggle" data-action="password-toggle" aria-label="비밀번호 표시" aria-pressed="false">${icon('eye')}</button></div></label>
      ${setup ? '<label class="field">비밀번호 확인<input name="confirm" type="password" required minlength="12" maxlength="256" autocomplete="new-password" placeholder="비밀번호를 한 번 더 입력해 주세요"></label>' : ''}
      <p id="auth-error" class="form-error" role="alert" hidden></p><button class="button primary auth-submit" type="submit">${icon(setup ? 'shield' : 'lock')}${setup ? '비밀번호 설정하고 시작' : '로그인'}</button></form>
      <p class="auth-notice">${icon('shield')}<span>${setup ? '비밀번호는 저장되지 않습니다. 분실하면 기존 데이터를 복구할 수 없으니 안전한 곳에 보관해 주세요.' : '복호화 키는 서버 메모리에만 유지됩니다. 서버가 재시작되면 비밀번호를 다시 입력해야 합니다.'}</span></p>
    </section></main><footer class="auth-footer">${escape(branding.name)}</footer></div>`;
  $('#auth-form').addEventListener('submit', signIn);
}

async function signIn(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type=submit]');
  const errorNode = $('#auth-error');
  errorNode.hidden = true;
  if (!state.initialized && form.elements.password.value !== form.elements.confirm.value) {
    errorNode.textContent = '두 비밀번호가 일치하지 않습니다.';
    errorNode.hidden = false;
    form.elements.confirm.focus();
    return;
  }
  button.disabled = true;
  const label = button.innerHTML;
  button.textContent = '암호화된 기록을 확인하고 있습니다…';
  try {
    await api(state.initialized ? '/api/login' : '/api/setup', { method: 'POST', body: JSON.stringify({ password: form.elements.password.value }) });
    form.reset();
    state.initialized = true;
    state.authenticated = true;
    sessionGeneration += 1;
    await loadEvents(false);
    renderApp();
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.hidden = false;
    if (error.status === 409) {
      try { state.initialized = (await api('/api/status')).initialized; renderAuth(); toast(error.message, true); } catch {}
    }
  } finally { button.disabled = false; button.innerHTML = label; }
}

function endSession() {
  sessionGeneration += 1;
  brandingRequest += 1;
  brandingVersion = null;
  $('#branding-form').reset();
  $('#branding-fields').disabled = true;
  state.authenticated = false;
  state.events = [];
  state.revision = -1;
  state.syncError = false;
  state.editing = null;
  state.deleting = null;
  state.highlightedId = null;
  for (const dialog of document.querySelectorAll('dialog')) dialog.close();
  $('#event-form').reset();
  $('#event-error').textContent = '';
  $('#detail-content').replaceChildren();
  $('#overflow-content').replaceChildren();
  $('#delete-description').textContent = '';
  $('#toast').hidden = true;
  renderAuth();
}

function filteredEvents() { return state.events.filter(event => state.filter === 'all' || event.category === state.filter); }
function scopeEvents() {
  if (state.view === 'timeline') return onDay(state.events, state.date);
  const { year, month } = dateParts(state.date);
  const start = startOfDay(calendarDate(year, month - 1));
  const end = startOfDay(calendarDate(year, month));
  return state.events.filter(event => overlaps(event, start, end));
}

function formatHeaderDate(date, includeDay = true) {
  const { year, month, day } = dateParts(date);
  return `${year}.${month}${includeDay ? `.${day}` : ''}`;
}

function summary() {
  const events = scopeEvents();
  const period = formatHeaderDate(state.date, state.view === 'timeline');
  const cards = [
    ['', 'calendar', '전체 이벤트', events.length],
    ['incident', 'warning', '장애', events.filter(event => event.category === 'incident').length],
    ['warning', 'tool', '점검 · 불안정', events.filter(event => event.category !== 'incident').length],
    ['ongoing', 'infinity', '종료 시각 미정', events.filter(event => event.end === null).length]
  ];
  return `<span class="summary-period">${period}</span><div class="summary-items">${cards.map(([color, image, label, count]) => `<div class="summary-card ${color}"><span class="summary-icon">${icon(image)}</span><span class="summary-label">${label}</span><span class="summary-value">${count}<small>건</small></span></div>`).join('')}</div>`;
}

function navigation() {
  if (state.view === 'calendar') {
    return `<div class="date-navigation"><div class="date-group"><button class="icon-button" data-action="previous-year" aria-label="이전 년도">${icon('left')}</button><input id="calendar-year" class="year-input" type="number" min="1900" max="9998" value="${dateParts(state.date).year}" aria-label="년도"><span class="year-suffix">년</span><button class="icon-button" data-action="next-year" aria-label="다음 년도">${icon('right')}</button></div><span class="date-divider"></span><div class="date-group"><button class="icon-button" data-action="previous-month" aria-label="이전 달">${icon('left')}</button><select class="month-select" id="calendar-month" aria-label="월">${Array.from({ length: 12 }, (_, month) => `<option value="${month}" ${month === (dateParts(state.date).month - 1) ? 'selected' : ''}>${month + 1}월</option>`).join('')}</select><button class="icon-button" data-action="next-month" aria-label="다음 달">${icon('right')}</button></div><button class="button secondary today-button" data-action="today">오늘</button></div>`;
  }
  return `<div class="date-navigation"><button class="icon-button" data-action="previous-day" aria-label="이전 날짜">${icon('left')}</button><div class="timeline-date"><span class="timeline-date-label" id="timeline-date-label">${timelineDateLabel()}</span><input id="timeline-date-input" type="date" min="1900-01-01" max="9998-12-31" value="${dateKey(state.date)}" aria-label="타임라인 날짜"></div><button class="icon-button" data-action="next-day" aria-label="다음 날짜">${icon('right')}</button><button class="button secondary today-button" data-action="today">오늘</button></div>`;
}

function timelineDateLabel() {
  const { year, month, day, weekday } = dateParts(state.date);
  return `${year}년 ${month}월 ${day}일<span class="weekday-label${[0, 6].includes(weekday) ? ' weekend' : ''}">${['일', '월', '화', '수', '목', '금', '토'][weekday]}요일</span>`;
}

function updateSyncStatus() {
  const badge = $('#sync-status');
  if (!badge) return;
  badge.classList.toggle('error', state.syncError);
  badge.title = state.syncError ? '서버 연결을 확인해 주세요. 연결되면 자동으로 다시 동기화합니다.' : '저장된 기록과 동기화됨';
  badge.innerHTML = `<i class="dot${state.syncError ? '' : ' green'}" aria-hidden="true"></i>${state.syncError ? '연결 확인 필요' : '동기화됨'}`;
}

function renderApp() {
  if (!state.authenticated) return;
  root.innerHTML = `<header class="header">${brand()}<nav class="view-tabs" aria-label="보기 방식"><button class="view-tab ${state.view === 'calendar' ? 'active' : ''}" data-action="view" data-view="calendar" aria-pressed="${state.view === 'calendar'}">${icon('calendar')}캘린더 뷰</button><button class="view-tab ${state.view === 'timeline' ? 'active' : ''}" data-action="view" data-view="timeline" aria-pressed="${state.view === 'timeline'}">${icon('timeline')}타임라인 뷰</button></nav><div class="header-status" role="group" aria-label="시간대와 동기화 상태"><span class="status-badge timezone-badge" title="표시 시간대: ${escape(timezone)}" aria-label="표시 시간대: ${escape(timezone)}">${icon('clock')}<span>${escape(timezone)}</span></span><span class="status-badge sync-status" id="sync-status" role="status" aria-atomic="true"></span></div><div class="header-right"><button class="settings-button" data-action="branding-settings" aria-label="브랜딩 설정" title="브랜딩 설정">${icon('settings')}<span>설정</span></button>${themeButton()}<button class="logout" data-action="logout">${icon('logout')}로그아웃</button></div></header>
    <main id="main" class="main">
    <div class="overview"><section class="summary" id="summary" aria-label="이벤트 요약">${summary()}</section></div>
    <section class="workspace" aria-label="${state.view === 'calendar' ? '이벤트 캘린더' : '하루 타임라인'}"><div class="toolbar"><div id="date-controls">${navigation()}</div><div class="toolbar-actions"><div class="filter-row" aria-label="이벤트 유형 필터">${[['all', '전체'], ...Object.entries(categories)].map(([value, label]) => `<button class="filter ${state.filter === value ? 'active' : ''}" data-action="filter" data-filter="${value}" aria-pressed="${state.filter === value}">${value === 'all' ? '' : `<span class="dot ${value}"></span>`}${label}</button>`).join('')}</div><button class="button primary" data-action="new-event">${icon('plus')}이벤트 추가</button></div></div><div id="view-content"></div></section></main>`;
  updateSyncStatus();
  renderView();
}

function renderView() {
  if (state.view === 'calendar') renderCalendar();
  else renderTimeline();
}

function renderCalendar() {
  const scrollLeft = $('.calendar-scroll')?.scrollLeft ?? 0;
  $('#view-content').innerHTML = `<div class="calendar-scroll"><div class="calendar" data-visible-lanes="1"><div class="weekdays">${['일', '월', '화', '수', '목', '금', '토'].map((name, index) => `<span class="${[0, 6].includes(index) ? 'weekend' : ''}">${name}</span>`).join('')}</div><div class="calendar-weeks">${renderCalendarWeeks(1)}</div></div></div>`;
  fitCalendar();
  $('.calendar-scroll').scrollLeft = scrollLeft;
}

function fitCalendar() {
  const calendar = $('.calendar');
  if (!calendar) return;
  const weeks = $('.calendar-weeks');
  const weekCount = weeks.children.length;
  const style = getComputedStyle(calendar);
  const pixels = name => parseFloat(style.getPropertyValue(name));
  // Measure all surrounding content, including wrapped controls and the status area.
  // Add scrollY so scrolling the page cannot change the available calendar height.
  const surroundingHeight = $('.main').getBoundingClientRect().bottom + window.scrollY - weeks.getBoundingClientRect().height;
  const weekHeight = Math.max(pixels('--calendar-week-min-height'), Math.floor((window.innerHeight - surroundingHeight) / weekCount));
  calendar.style.setProperty('--calendar-week-height', `${weekHeight}px`);
  const gap = pixels('--calendar-event-gap');
  const visibleLanes = Math.max(1, Math.min(3, Math.floor((weekHeight - pixels('--calendar-event-top') - pixels('--calendar-more-space') + gap) / (pixels('--calendar-event-height') + gap))));
  if (Number(calendar.dataset.visibleLanes) !== visibleLanes) {
    const focused = weeks.contains(document.activeElement) ? { ...document.activeElement.dataset } : null;
    weeks.innerHTML = renderCalendarWeeks(visibleLanes);
    calendar.dataset.visibleLanes = visibleLanes;
    if (focused) {
      Array.from(weeks.querySelectorAll('button')).find(button => Object.entries(focused).every(([key, value]) => button.dataset[key] === value))?.focus({ preventScroll: true });
    }
  }
  updateCalendarNow(new Date());
}

function updateCalendarNow(now) {
  const calendar = $('.calendar');
  if (!calendar) return;
  const today = dateKey(now);
  const cell = calendar.querySelector(`.day-cell[data-date="${today}"]`);
  const previous = calendar.querySelector('.day-cell.today');
  if (previous && previous !== cell) {
    previous.classList.remove('today');
    previous.querySelector('.today-label')?.remove();
    previous.querySelector('.calendar-now-line')?.remove();
  }
  if (!cell) return;
  cell.classList.add('today');
  let label = cell.querySelector('.today-label');
  if (!label) {
    label = document.createElement('span');
    label.className = 'today-label';
    cell.querySelector('.day-hit').append(label);
  }
  label.textContent = `현재 ${timeLabel(now)}`;
  label.title = `오늘, ${label.textContent} (${timezone})`;
  let line = cell.querySelector('.calendar-now-line');
  if (!line) {
    line = document.createElement('div');
    line.className = 'calendar-now-line';
    line.setAttribute('aria-hidden', 'true');
    cell.append(line);
  }
  line.style.setProperty('--now-position', currentDayPosition(now));
}

function currentDayPosition(now) {
  // Use the same civil-day boundaries as event fills, including DST changes.
  const [start, end] = dayBounds(dateKey(now));
  return `${(+now - start) / (end - start) * 100}%`;
}

function updateOverflowNow(now) {
  const dialog = $('#overflow-dialog');
  if (!dialog.open) return;
  const isToday = dialog.dataset.date === dateKey(now);
  const label = $('#overflow-now-text');
  label.hidden = !isToday;
  label.textContent = isToday ? ` · 현재 ${timeLabel(now)}` : '';
  for (const line of dialog.querySelectorAll('.overflow-now-line')) {
    line.hidden = !isToday;
    if (isToday) line.style.setProperty('--now-position', currentDayPosition(now));
  }
}

function renderEventTimeDay(event, day) {
  // Share timezone-aware boundaries across calendar badges, popup rows and the timeline.
  const portion = daySegment(event, day);
  return `<span class="event-time-day" data-date="${day}"><span class="event-time-active" style="left:${(portion?.left ?? 0) * 100}%;width:${(portion?.width ?? 0) * 100}%"></span></span>`;
}

function renderCalendarWeeks(visibleLanes) {
  const { year, month } = dateParts(state.date);
  let start = calendarDate(year, month - 1, 1);
  const daysInMonth = dateParts(calendarDate(year, month, 0)).day;
  const weekCount = Math.ceil((dateParts(start).weekday + daysInMonth) / 7);
  start = addDays(start, -dateParts(start).weekday);
  const events = filteredEvents();
  const today = dateKey(new Date());
  const weeks = [];
  for (let week = 0; week < weekCount; week++) {
    const weekStart = addDays(start, week * 7);
    const segments = weekSegments(events, weekStart);
    const cells = Array.from({ length: 7 }, (_, index) => {
      const day = addDays(weekStart, index);
      const key = dateKey(day);
      const dayEvents = onDay(events, day);
      const hidden = segments.filter(segment => segment.lane >= visibleLanes && segment.start <= index && segment.end >= index).length;
      return `<div class="day-cell ${(dateParts(day).month - 1) !== (dateParts(state.date).month - 1) ? 'outside' : ''} ${key === today ? 'today' : ''} ${key === dateKey(state.date) ? 'selected' : ''} severity-${severity(dayEvents)}" data-date="${key}"><button class="day-hit" data-action="add-on-day" data-date="${key}" title="${key} · 날짜를 눌러 이벤트 추가" aria-label="${key}, 이벤트 ${dayEvents.length}건. 새 이벤트 추가" ${dateParts(day).year < 1900 || dateParts(day).year > 9998 ? 'disabled' : ''}><span class="day-number ${[0, 6].includes(dateParts(day).weekday) ? 'weekend' : ''}">${dateParts(day).day}</span>${key === today ? '<span class="today-label">오늘</span>' : ''}<span class="day-add" aria-hidden="true">+</span></button>${hidden ? `<button class="day-more" data-action="overflow" data-date="${key}" aria-label="${key}, 숨겨진 이벤트 ${hidden}건 포함 전체 목록">+${hidden} 더 보기</button>` : ''}</div>`;
    }).join('');
    const badges = segments.filter(segment => segment.lane < visibleLanes).map(segment => {
      const event = segment.event;
      const description = `${categories[event.category]} · ${event.title} · ${formatDateTime(event.start)} ~ ${formatDateTime(event.end)}`;
      const dayCount = segment.end - segment.start + 1;
      const fills = Array.from({ length: dayCount }, (_, index) => renderEventTimeDay(event, addDays(weekStart, segment.start + index))).join('');
      return `<button class="event-badge ${event.category}${!segment.startsHere ? ' continues-left' : ''}${!segment.endsHere ? ' continues-right' : ''}" style="grid-column:${segment.start + 1}/span ${dayCount};grid-row:${segment.lane + 1}" data-action="calendar-event" data-id="${event.id}" data-week="${dateKey(weekStart)}" data-start="${segment.start}" data-end="${segment.end}" title="이벤트를 눌러 타임라인 보기&#10;${escape(description)}&#10;밝은 영역: 이벤트 진행 시간 · 어두운 영역: 진행 시간 외" aria-label="${escape(description)}. 타임라인 보기"><span class="event-time-fill" style="--event-days:${dayCount}" aria-hidden="true">${fills}</span>${!segment.startsHere ? '<span class="edge-marker">‹</span>' : '<span class="dot"></span>'}<span class="event-name">${escape(event.title)}</span>${event.end === null ? '<span class="infinity" aria-label="종료 시각 미정">∞</span>' : !segment.endsHere ? '<span class="edge-marker">›</span>' : ''}</button>`;
    }).join('');
    weeks.push(`<div class="calendar-week" data-week="${dateKey(weekStart)}"><div class="day-cells">${cells}</div><div class="week-events">${badges}</div></div>`);
  }
  return weeks.join('');
}

function renderTimeline() {
  const selectedEvent = state.events.find(event => event.id === state.highlightedId);
  $('#view-content').innerHTML = `${selectedEvent ? `<div class="highlight-note">${icon('focus')}<span>선택한 이벤트: ${escape(selectedEvent.title)}</span><button data-action="clear-highlight" aria-label="이벤트 강조 해제">×</button></div>` : ''}<div class="timeline-scroller" id="timeline-scroller" tabindex="0" role="region" aria-label="시간 눈금 드래그 또는 좌우 스크롤로 날짜를 이동하는 타임라인"><div class="timeline-grid" id="timeline-grid"><div class="timeline-header"><div class="timeline-label">이벤트<span class="timeline-label-count" id="timeline-count">0</span></div><div class="time-headers" id="time-headers" title="시간 눈금을 좌우로 드래그하여 날짜 이동"></div></div><div id="timeline-rows"></div><div class="now-line" id="now-line" aria-hidden="true"><span class="now-text" id="now-text"></span></div></div></div>`;
  const scroller = $('#timeline-scroller');
  const labelWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--label-width'));
  dayWidth = Math.max(320, scroller.clientWidth - labelWidth);
  timelineStart = addDays(state.date, -3);
  $('#timeline-grid').style.width = `${labelWidth + 7 * dayWidth}px`;
  $('#timeline-grid').style.setProperty('--hour-width', `${dayWidth / 8}px`);
  renderTimelineHeaders();
  renderTimelineRows();
  scroller.scrollLeft = 3 * dayWidth;
  scroller.addEventListener('scroll', onTimelineScroll, { passive: true });
  bindTimelineDrag(scroller);
  focusHighlighted();
}

function bindTimelineDrag(scroller) {
  let drag = null;
  const finish = event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    scroller.classList.remove('is-dragging');
    if (scroller.hasPointerCapture(event.pointerId)) scroller.releasePointerCapture(event.pointerId);
  };
  scroller.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || !event.target.closest('.time-headers')) return;
    event.preventDefault();
    scroller.focus({ preventScroll: true });
    drag = { pointerId: event.pointerId, x: event.clientX };
    // Capture on the scroller: the time cells are replaced when dates are rebased.
    scroller.setPointerCapture(event.pointerId);
    scroller.classList.add('is-dragging');
  });
  scroller.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (event.buttons === 0) { finish(event); return; }
    event.preventDefault();
    // Incremental movement preserves any scroll correction made by infinite scrolling.
    scroller.scrollLeft += drag.x - event.clientX;
    drag.x = event.clientX;
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) scroller.addEventListener(type, finish);
}

function renderTimelineHeaders() {
  if (!$('#time-headers')) return;
  $('#time-headers').innerHTML = Array.from({ length: 7 }, (_, index) => {
    const day = addDays(timelineStart, index);
    const [dayStart, dayEnd] = dayBounds(day);
    const duration = dayEnd - dayStart;
    const ticks = [];
    for (let hour = 0; hour * 3600000 < duration; hour += dayWidth < 600 ? 6 : 3) {
      ticks.push(`<span class="axis-tick" style="left:${hour * 3600000 / duration * 100}%">${timeLabel(dayStart + hour * 3600000)}</span>`);
    }
    return `<div class="time-header-cell" style="width:${dayWidth}px"><span class="axis-date ${dateKey(day) === dateKey(new Date()) ? 'is-today' : ''}">${formatHeaderDate(day)} · ${formatDay(day)}${dateKey(day) === dateKey(new Date()) ? ' · 오늘' : ''}</span><div class="axis-ticks">${ticks.join('')}<span class="axis-end">23:59</span></div></div>`;
  }).join('');
}

function timelineEvents() {
  return onDay(filteredEvents(), state.date).sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title, 'ko'));
}

function renderTimelineRows() {
  if (!$('#timeline-rows')) return;
  const events = timelineEvents();
  $('#timeline-count').textContent = events.length;
  const labelWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--label-width'));
  if (!events.length) {
    const width = Math.min(dayWidth, $('#timeline-scroller').clientWidth - labelWidth);
    $('#timeline-rows').innerHTML = `<div class="timeline-empty-row"><div class="timeline-label" aria-hidden="true"></div><div class="timeline-empty-lane"><div class="empty-message" style="width:${width}px">${icon('calendar')}<strong>이날의 기록이 없습니다.</strong><p>${state.filter === 'all' ? '첫 이벤트를 기록해 보세요.' : '다른 유형도 확인해 보세요.'}</p><button class="button secondary" data-action="new-event">${icon('plus')}이벤트 추가</button></div></div></div>`;
  } else {
    $('#timeline-rows').innerHTML = events.map(event => {
      const segments = Array.from({ length: 7 }, (_, index) => {
        const day = addDays(timelineStart, index);
        const segment = daySegment(event, day);
        const [dayStart, dayEnd] = dayBounds(day);
        const duration = dayEnd - dayStart;
        const grid = `<div class="timeline-day-segment" style="left:${index * dayWidth}px;width:${dayWidth}px;background-image:linear-gradient(to right,var(--grid-line) 1px,transparent 1px);background-size:${duration ? 3 * 3600000 / duration * dayWidth : dayWidth}px 100%"></div>`;
        if (!segment) return grid;
        return `${grid}<button class="timeline-bar ${event.category}${!segment.startsHere ? ' continues-left' : ''}${!segment.endsHere ? ' continues-right' : ''}" style="left:${(index + segment.left) * dayWidth}px;width:${segment.width * dayWidth}px" data-action="detail" data-id="${event.id}" title="이벤트를 눌러 상세 보기&#10;${escape(`${event.title} · ${formatDateTime(event.start)} ~ ${formatDateTime(event.end)}`)}" aria-label="${escape(event.title)} 상세 보기"><span class="bar-label">${escape(event.title)}</span>${segment.startsHere ? `<span class="bar-time">${timeLabel(event.start)}</span>` : ''}${segment.open ? '<span class="infinity" aria-label="종료 시각 미정">∞</span>' : !segment.endsHere ? '<span class="edge-marker">›</span>' : ''}</button>`;
      }).join('');
      return `<div class="timeline-row${event.id === state.highlightedId ? ' highlighted' : ''}" data-event-id="${event.id}"><button class="timeline-label" data-action="detail" data-id="${event.id}" title="이벤트를 눌러 상세 보기&#10;${escape(event.title)}" aria-label="${escape(event.title)} 상세 보기"><span class="timeline-event-title"><i class="dot ${event.category}"></i><span>${escape(event.title)}</span></span><span class="timeline-service">${escape(event.service || categories[event.category])}${event.end === null ? ' · 종료 미정 ∞' : ''}</span></button><div class="timeline-lane" style="width:${7 * dayWidth}px;background-image:none">${segments}</div></div>`;
    }).join('');
  }
  updateNow();
}

function updateNow() {
  const now = new Date();
  updateCalendarNow(now);
  updateOverflowNow(now);
  const line = $('#now-line');
  if (!line || !timelineStart) return;
  let dayIndex = -1;
  for (let index = 0; index < 7; index++) if (dateKey(now) === addDays(timelineStart, index)) dayIndex = index;
  line.hidden = dayIndex === -1;
  if (dayIndex === -1) return;
  const [start, end] = dayBounds(addDays(timelineStart, dayIndex));
  const fraction = (+now - start) / (end - start);
  const labelWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--label-width'));
  line.style.left = `${labelWidth + (dayIndex + fraction) * dayWidth}px`;
  $('#now-text').textContent = timeLabel(now);
}

function onTimelineScroll() {
  cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(() => {
    const scroller = $('#timeline-scroller');
    if (!scroller) return;
    const labelWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--label-width'));
    const index = Math.min(6, Math.max(0, Math.floor((scroller.scrollLeft + (scroller.clientWidth - labelWidth) / 2) / dayWidth)));
    const day = addDays(timelineStart, index);
    if (dateParts(day).year < 1900 || dateParts(day).year > 9998) { scroller.scrollLeft = 3 * dayWidth; return; }
    const changed = dateKey(state.date) !== dateKey(day);
    state.date = day;
    let rebase = false;
    if (scroller.scrollLeft < dayWidth) {
      timelineStart = addDays(timelineStart, -3);
      scroller.scrollLeft += 3 * dayWidth;
      rebase = true;
    } else if (scroller.scrollLeft > dayWidth * 5) {
      timelineStart = addDays(timelineStart, 3);
      scroller.scrollLeft -= 3 * dayWidth;
      rebase = true;
    }
    if (rebase) renderTimelineHeaders();
    if (changed || rebase) {
      renderTimelineRows();
      $('#timeline-date-label').innerHTML = timelineDateLabel();
      $('#timeline-date-input').value = dateKey(state.date);
      $('#summary').innerHTML = summary();
    }
  });
}

function focusHighlighted() {
  if (!state.highlightedId) return;
  const index = timelineEvents().findIndex(event => event.id === state.highlightedId);
  if (index >= 0) $('#timeline-scroller').scrollTop = Math.max(0, index * 76 - 100);
}

function chooseDate(day) {
  if (!day || !fromDateKey(dateKey(day))) { toast('1900년부터 9998년까지 선택할 수 있습니다.', true); renderApp(); return; }
  state.date = dateKey(day);
  state.highlightedId = null;
  renderApp();
}

function calendarToTimeline(id, day) {
  state.view = 'timeline';
  state.date = dateKey(day);
  state.highlightedId = id;
  renderApp();
}

function setEditorDateTime(form, prefix, instant) {
  const value = dateTimeInput(instant);
  form.elements[`${prefix}Date`].value = value.slice(0, 10);
  form.elements[`${prefix}Hour`].value = value.slice(11, 13);
  form.elements[`${prefix}Minute`].value = value.slice(14, 16);
}

function editorDateTime(form, prefix) {
  return `${form.elements[`${prefix}Date`].value}T${form.elements[`${prefix}Hour`].value}:${form.elements[`${prefix}Minute`].value}`;
}

function openEditor(event = null, day = state.date) {
  if (!event) {
    const [start, end] = dayBounds(day);
    if (start === end) { toast(`${timezone}에서는 시간대 변경으로 건너뛴 날짜입니다. 다른 날짜를 선택해 주세요.`, true); return; }
  }
  state.editing = event ? structuredClone(event) : null;
  const form = $('#event-form');
  form.reset();
  $('#event-error').hidden = true;
  $('#event-error').textContent = '';
  form.elements.endDate.setCustomValidity('');
  $('#event-dialog-title').textContent = event ? '이벤트 편집' : '이벤트 추가';
  $('#event-save').textContent = event ? '변경 내용 저장' : '이벤트 저장';
  $('#event-save').disabled = false;
  const start = dateKey(day) === dateKey(new Date()) ? new Date() : new Date(parseDateTimeInput(`${dateKey(day)}T09:00`) ?? startOfDay(day));
  form.elements.title.value = event?.title ?? '';
  form.elements.service.value = event?.service ?? '';
  form.elements.description.value = event?.description ?? '';
  form.elements.category.value = event?.category ?? (state.filter !== 'all' ? state.filter : 'maintenance');
  setEditorDateTime(form, 'start', event?.start ?? start);
  setEditorDateTime(form, 'end', event?.end ?? new Date(+(event ? new Date(event.start) : start) + 3600000));
  form.elements.openEnded.checked = event?.end === null;
  $('#end-fields').disabled = form.elements.openEnded.checked;
  $('#event-timezone').textContent = `${timezone} 기준 · 24시간제 (00:00~23:59)`;
  $('#event-dialog').showModal();
  form.elements.title.focus();
}

function openDetail(id) {
  const event = state.events.find(event => event.id === id);
  if (!event) { toast('이미 삭제된 이벤트입니다.', true); return; }
  $('#detail-content').innerHTML = `<div class="dialog-heading"><div><span class="detail-type ${event.category}"><i class="dot ${event.category}"></i>${categories[event.category]}</span><h2 id="detail-title">${escape(event.title)}</h2></div><button class="icon-button" data-close="detail-dialog" aria-label="닫기">×</button></div><dl class="detail-meta"><dt>서비스</dt><dd>${escape(event.service || '지정하지 않음')}</dd><dt>시작 시각</dt><dd>${formatDateTime(event.start)}</dd><dt>종료 시각</dt><dd>${event.end === null ? '종료 시각 미정 <span class="infinity">∞</span>' : formatDateTime(event.end)}</dd><dt>시간대</dt><dd>${escape(timezone)}</dd></dl><div class="detail-description">${escape(event.description || '추가로 기록된 내용이 없습니다.')}</div><div class="detail-bottom">마지막 수정 ${formatDateTime(event.updatedAt)}</div><div class="dialog-actions"><button class="text-danger" data-action="request-delete" data-id="${event.id}">이벤트 삭제</button><div class="detail-right"><button class="button secondary" data-close="detail-dialog">닫기</button><button class="button primary" data-action="edit-event" data-id="${event.id}">${icon('edit')}편집</button></div></div>`;
  $('#detail-dialog').showModal();
}

function openOverflow(day) {
  const events = onDay(filteredEvents(), day).sort((a, b) => a.start.localeCompare(b.start));
  const selectedDate = dateKey(day);
  const endpoint = value => value === null
    ? '<span>미정 <span class="infinity" aria-label="종료 시각 미정">∞</span></span>'
    : `<time datetime="${escape(value)}" title="${escape(formatDateTime(value))}">${dateKey(value) === selectedDate ? `당일 ${timeLabel(value)}` : formatDateTime(value)}</time>`;
  $('#overflow-content').innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">DAY RECORDS · ${events.length} EVENTS</p><h2 id="overflow-title">${dateParts(day).year}년 ${formatDay(day)}의 이벤트</h2><p class="overflow-context">${escape(timezone)} 기준<span id="overflow-now-text" hidden></span></p></div><button class="icon-button" data-close="overflow-dialog" aria-label="닫기">×</button></div><div class="overflow-list">${events.map(event => `<button class="overflow-item ${event.category}" data-action="overflow-event" data-id="${event.id}" data-date="${selectedDate}"><span class="event-time-fill" style="--event-days:1" aria-hidden="true">${renderEventTimeDay(event, selectedDate)}</span><i class="dot ${event.category}"></i><span class="overflow-item-body"><strong>${escape(event.title)}</strong><small>${categories[event.category]} · ${escape(event.service || '전체 서비스')}</small><span class="overflow-times"><span class="overflow-time-label">시작</span> ${endpoint(event.start)}<span class="overflow-time-label">종료</span> ${endpoint(event.end)}</span></span>${icon('right')}<span class="overflow-now-line" aria-hidden="true" hidden></span></button>`).join('')}</div>`;
  $('#overflow-dialog').dataset.date = selectedDate;
  $('#overflow-dialog').showModal();
  updateOverflowNow(new Date());
}

async function loadEvents(render = true) {
  const generation = sessionGeneration;
  state.syncing = true;
  try {
    const data = await api('/api/events');
    if (!state.authenticated || generation !== sessionGeneration || data.revision < state.revision) return;
    const changed = data.revision !== state.revision;
    state.events = data.events;
    state.revision = data.revision;
    if (render && changed && state.authenticated) {
      if (state.view === 'calendar') renderCalendar();
      else renderTimelineRows();
      if ($('#summary')) $('#summary').innerHTML = summary();
    }
    state.syncError = false;
    updateSyncStatus();
  } catch (error) {
    if (generation === sessionGeneration && state.authenticated) {
      state.syncError = true;
      updateSyncStatus();
    }
    throw error;
  } finally { state.syncing = false; }
}

// Numeric option labels keep the clock in 24-hour format in every browser locale.
for (const prefix of ['start', 'end']) {
  for (const [part, count] of [['Hour', 24], ['Minute', 60]]) {
    $('#event-form').elements[`${prefix}${part}`].innerHTML = Array.from({ length: count }, (_, number) => {
      const value = String(number).padStart(2, '0');
      return `<option value="${value}">${value}</option>`;
    }).join('');
  }
}

$('#event-form').addEventListener('input', () => { $('#event-form').elements.endDate.setCustomValidity(''); });
$('#event-form').elements.openEnded.addEventListener('change', event => {
  $('#end-fields').disabled = event.target.checked;
  $('#event-form').elements.endDate.setCustomValidity('');
});

$('#event-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const start = parseDateTimeInput(editorDateTime(form, 'start'), state.editing?.start);
  const end = form.elements.openEnded.checked ? null : parseDateTimeInput(editorDateTime(form, 'end'), state.editing?.end);
  const errorNode = $('#event-error');
  errorNode.hidden = true;
  if (!start || (!form.elements.openEnded.checked && !end)) { errorNode.textContent = `${timezone} 기준의 유효하고 중복되지 않는 시각을 입력해 주세요. 서머타임 전환으로 건너뛰거나 두 번 나타나는 시각은 새로 지정할 수 없습니다.`; errorNode.hidden = false; return; }
  if (end && end <= start) { form.elements.endDate.setCustomValidity('종료 시각은 시작 시각보다 늦어야 합니다.'); form.elements.endDate.reportValidity(); return; }
  const fields = { title: form.elements.title.value, service: form.elements.service.value, category: form.elements.category.value, description: form.elements.description.value, start, end };
  const editing = state.editing;
  if (editing) fields.version = editing.version;
  $('#event-save').disabled = true;
  try {
    const result = await api(editing ? `/api/events/${editing.id}` : '/api/events', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(fields) });
    // Keep a just-saved event visible, even when a category filter was active.
    if (state.filter !== 'all' && state.filter !== result.event.category) state.filter = 'all';
    if (!overlaps(result.event, state.date)) state.date = dateKey(result.event.start);
    $('#event-dialog').close();
    form.reset();
    await loadEvents(false);
    renderApp();
    toast(editing ? '변경 내용을 암호화하여 저장했습니다.' : '새 이벤트를 암호화하여 저장했습니다.');
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.hidden = false;
    if (error.status === 409) loadEvents().catch(() => {});
  } finally { $('#event-save').disabled = false; }
});

$('#delete-confirm').addEventListener('click', async () => {
  const event = state.deleting;
  if (!event) return;
  $('#delete-confirm').disabled = true;
  try {
    await api(`/api/events/${event.id}`, { method: 'DELETE', body: JSON.stringify({ version: event.version }) });
    $('#delete-dialog').close();
    $('#detail-dialog').close();
    state.deleting = null;
    if (state.highlightedId === event.id) state.highlightedId = null;
    await loadEvents(false);
    renderApp();
    toast('이벤트를 삭제했습니다.');
  } catch (error) {
    $('#delete-error').textContent = error.message;
    $('#delete-error').hidden = false;
    if (error.status === 409 || error.status === 404) loadEvents().catch(() => {});
  } finally { $('#delete-confirm').disabled = false; }
});

for (const dialog of document.querySelectorAll('dialog')) {
  let pressedOutside = false;
  const isOutside = event => {
    if (event.target !== dialog) return false;
    const rect = dialog.getBoundingClientRect();
    return event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
  };
  // Require both ends of the click to be outside; padding and drags stay inside.
  dialog.addEventListener('pointerdown', event => { pressedOutside = event.button === 0 && isOutside(event); });
  dialog.addEventListener('pointercancel', () => { pressedOutside = false; });
  dialog.addEventListener('close', () => { pressedOutside = false; });
  dialog.addEventListener('click', event => {
    const shouldCancel = pressedOutside && isOutside(event);
    pressedOutside = false;
    // Honor the same cancellation guards as Escape (e.g. while saving settings).
    if (shouldCancel && dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
  });
}

document.addEventListener('click', async click => {
  const closer = click.target.closest('[data-close]');
  if (closer) { document.getElementById(closer.dataset.close).close(); return; }
  const button = click.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'theme-toggle') { window.timelineTheme.toggle(); return; }
  if (action === 'password-toggle') {
    const input = button.parentElement.querySelector('input');
    input.type = input.type === 'password' ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(input.type === 'text'));
    button.setAttribute('aria-label', input.type === 'text' ? '비밀번호 숨기기' : '비밀번호 표시');
    return;
  }
  if (!state.authenticated) return;
  switch (action) {
    case 'branding-settings': openBrandingSettings(); break;
    case 'view': state.view = button.dataset.view; renderApp(); break;
    case 'filter': state.filter = button.dataset.filter; state.highlightedId = null; renderApp(); break;
    case 'today': chooseDate(new Date()); break;
    case 'previous-year': chooseDate(calendarDate(dateParts(state.date).year - 1, (dateParts(state.date).month - 1), 1)); break;
    case 'next-year': chooseDate(calendarDate(dateParts(state.date).year + 1, (dateParts(state.date).month - 1), 1)); break;
    case 'previous-month': chooseDate(calendarDate(dateParts(state.date).year, (dateParts(state.date).month - 1) - 1, 1)); break;
    case 'next-month': chooseDate(calendarDate(dateParts(state.date).year, (dateParts(state.date).month - 1) + 1, 1)); break;
    case 'previous-day': chooseDate(addDays(state.date, -1)); break;
    case 'next-day': chooseDate(addDays(state.date, 1)); break;
    case 'new-event': openEditor(); break;
    case 'add-on-day': openEditor(null, fromDateKey(button.dataset.date)); break;
    case 'overflow': openOverflow(fromDateKey(button.dataset.date)); break;
    case 'calendar-event': {
      const week = button.closest('.calendar-week').getBoundingClientRect();
      const dayIndex = click.detail === 0 ? Number(button.dataset.start) : Math.max(Number(button.dataset.start), Math.min(Number(button.dataset.end), Math.floor((click.clientX - week.left) / (week.width / 7))));
      calendarToTimeline(button.dataset.id, addDays(fromDateKey(button.dataset.week), dayIndex));
      break;
    }
    case 'overflow-event': $('#overflow-dialog').close(); calendarToTimeline(button.dataset.id, fromDateKey(button.dataset.date)); break;
    case 'detail': openDetail(button.dataset.id); break;
    case 'clear-highlight': state.highlightedId = null; renderView(); break;
    case 'edit-event': {
      const event = state.events.find(event => event.id === button.dataset.id);
      $('#detail-dialog').close();
      if (event) openEditor(event);
      else toast('이미 삭제된 이벤트입니다.', true);
      break;
    }
    case 'request-delete': {
      const event = state.events.find(event => event.id === button.dataset.id);
      if (!event) { $('#detail-dialog').close(); toast('이미 삭제된 이벤트입니다.', true); break; }
      state.deleting = structuredClone(event);
      $('#delete-description').textContent = event.title;
      $('#delete-error').hidden = true;
      $('#delete-confirm').disabled = false;
      $('#delete-dialog').showModal();
      break;
    }
    case 'logout':
      button.disabled = true;
      try { await api('/api/logout', { method: 'POST', body: '{}' }); endSession(); }
      catch (error) { toast(error.message, true); button.disabled = false; }
      break;
  }
});

document.addEventListener('change', event => {
  if (event.target.id === 'calendar-year') {
    const year = Number(event.target.value);
    if (!Number.isInteger(year) || year < 1900 || year > 9998) { toast('년도는 1900~9998 사이로 입력해 주세요.', true); event.target.value = dateParts(state.date).year; return; }
    chooseDate(calendarDate(year, (dateParts(state.date).month - 1), 1));
  }
  if (event.target.id === 'calendar-month') chooseDate(calendarDate(dateParts(state.date).year, Number(event.target.value), 1));
  if (event.target.id === 'timeline-date-input') chooseDate(fromDateKey(event.target.value));
});

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!state.authenticated) return;
    if (state.view === 'calendar') fitCalendar();
    else renderTimeline();
  }, 150);
});
setInterval(updateNow, 15000);
setInterval(() => { if (state.authenticated && !document.hidden) loadEvents().catch(() => {}); }, 20000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.authenticated) { updateNow(); loadEvents().catch(() => {}); }
});

try {
  const [status, labels] = await Promise.all([api('/api/status'), api('/api/branding')]);
  applyBranding(labels);
  state.date = dateKey(new Date());
  state.initialized = status.initialized;
  state.authenticated = status.authenticated;
  if (status.authenticated) { await loadEvents(false); renderApp(); }
  else renderAuth();
} catch (error) {
  root.innerHTML = `<main id="main" class="boot-screen">${icon('warning')}<p>${escape(error.message)}</p><button class="button secondary" id="retry">다시 연결</button></main>`;
  $('#retry').addEventListener('click', () => location.reload());
}
