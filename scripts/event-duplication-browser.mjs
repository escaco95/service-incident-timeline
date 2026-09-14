import assert from 'node:assert/strict';

export async function checkEventDuplication({ app, evaluate, click, waitFor, command, screenshot, pressKey }) {
  const catalog = app.vault.readServices();
  const [active, inactive] = catalog.services;
  const fixtures = [];
  const copies = [];
  try {
    for (const end of ['2026-09-09T02:03:45.678Z', null]) {
      const { event } = await app.vault.add({
        title: '반복'.repeat(60), category: 'incident', start: '2026-09-09T02:03:04.567Z', end,
        description: '<img src=x onerror="window.duplicateXss=true">\n복제할 상세 내용 & 조치',
        services: [{ kind: 'catalog', id: active.id }, { kind: 'catalog', id: inactive.id }, { kind: 'custom', label: '직접 입력 서비스' }]
      });
      fixtures.push((await app.vault.update(event.id, { ...event, description: event.description + '\n확인 완료' })).event);
    }
    await app.vault.saveServices({ version: catalog.version, services: catalog.services.map(service => ({ ...service, name: service.id === active.id ? '현재 서비스 이름' : service.name, active: service.id !== inactive.id })) });
    await evaluate('document.dispatchEvent(new Event("visibilitychange"))');
    await waitFor(`!!document.querySelector('.timeline-label[data-id="${fixtures[0].id}"]')`, 'duplication fixtures loaded');
    for (const [index, source] of fixtures.entries()) {
      const before = await app.vault.snapshot();
      const openSource = async () => {
        if (index === 0) {
          await click('document.querySelector("[data-view=calendar]")');
          await click(`document.querySelector('.day-number[data-date="2026-09-09"]')`);
          await click(`document.querySelector('[data-action="overflow-event"][data-id="${source.id}"]')`);
        } else {
          await click(`document.querySelector('.timeline-label[data-id="${source.id}"]')`);
        }
      };
      await openSource();
      await command('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
      assert.ok(await evaluate('document.querySelector("#detail-dialog").scrollWidth <= document.querySelector("#detail-dialog").clientWidth'), 'detail actions fit a narrow mobile dialog');
      await screenshot('event-duplicate-detail-mobile');
      await click('document.querySelector("[data-action=duplicate-event]")');
      await waitFor('!document.querySelector("#event-save").disabled', 'duplicate service selections loaded');
      assert.equal(await evaluate('document.querySelector("#event-dialog-title").textContent'), '이벤트 복제');
      assert.equal(await evaluate('document.querySelector("#event-save").textContent'), '새 이벤트로 저장');
      assert.equal(await evaluate('document.activeElement.name'), 'title');
      assert.deepEqual(await evaluate(`(() => { const form = document.querySelector('#event-form'); return [form.elements.title.value, form.elements.category.value, form.elements.description.value, form.elements.openEnded.checked, document.querySelector('#end-fields').disabled]; })()`), [source.title, 'incident', source.description, source.end === null, source.end === null]);
      assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".service-tag > span")).map(node => node.firstChild.textContent)'), ['현재 서비스 이름', inactive.name, '직접 입력 서비스']);
      assert.equal(await evaluate('document.querySelectorAll(".service-tag small").length'), 2);
      assert.ok(await evaluate('document.querySelector("#event-dialog").scrollWidth <= document.querySelector("#event-dialog").clientWidth'), 'duplicate editor fits a narrow mobile dialog');
      await screenshot('event-duplicate-editor-mobile');
      await evaluate('document.querySelector("#event-form").elements.title.value = "취소할 복제본"');
      await click(`document.querySelector('[data-service-remove="0"]')`);
      if (index === 0) await click('document.querySelector("#event-form .dialog-actions [data-close]")');
      else await pressKey('Escape', 27);
      assert.equal(await evaluate('document.querySelector("#event-dialog").open'), false);
      const cancelled = await app.vault.snapshot();
      assert.deepEqual(cancelled.events, before.events, 'cancel leaves every event unchanged');
      assert.deepEqual(cancelled.changes, before.changes, 'cancel creates no audit record');
      await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
      await openSource();
      await click('document.querySelector("[data-action=duplicate-event]")');
      await waitFor('!document.querySelector("#event-save").disabled', 'fresh duplicate draft loaded');
      assert.equal(await evaluate('document.querySelector("#event-form").elements.title.value'), source.title);
      assert.equal(await evaluate('document.querySelectorAll(".service-tag").length'), 3);
      if (index === 1) await evaluate(`(() => { const form = document.querySelector('#event-form'); form.elements.title.value = '다음 날 장애 기록'; form.elements.startDate.value = '2026-09-10'; form.elements.category.value = 'maintenance'; })()`);
      await click('document.querySelector("#event-save")');
      await waitFor('!document.querySelector("#event-dialog").open', 'duplicate saved as a new event');
      const after = await app.vault.snapshot();
      assert.equal(after.events.length, before.events.length + 1);
      assert.deepEqual(after.events.find(event => event.id === source.id), source, 'saving a duplicate preserves the original version and content');
      const copy = after.events.find(event => !before.events.some(eventBefore => eventBefore.id === event.id));
      copies.push(copy);
      assert.notEqual(copy.id, source.id);
      assert.equal(copy.version, 1);
      assert.notEqual(copy.createdAt, source.createdAt);
      assert.equal(copy.updatedAt, copy.createdAt);
      assert.equal(copy.title, index === 0 ? source.title : '다음 날 장애 기록');
      assert.equal(copy.category, index === 0 ? 'incident' : 'maintenance');
      assert.equal(copy.description, source.description);
      assert.equal(copy.start, index === 0 ? '2026-09-09T02:03:04.567Z' : '2026-09-10T02:03:00.000Z');
      assert.equal(copy.end, source.end);
      assert.deepEqual(copy.services, [{ kind: 'catalog', id: active.id, label: '현재 서비스 이름' }, { kind: 'custom', label: inactive.name }, { kind: 'custom', label: '직접 입력 서비스' }]);
      const changes = after.changes.filter(row => !before.changes.some(old => old.id === row.id));
      assert.equal(changes.length, 1);
      assert.equal(changes[0].action, 'event-created');
      assert.equal(changes[0].before, null);
      assert.equal(changes[0].after.id, copy.id);
      assert.equal(await evaluate('!!window.duplicateXss'), false);
      await waitFor('!document.querySelector("#event-save").disabled', 'duplicate save refresh finished');
      await click('document.querySelector("[data-view=timeline]")');
      await waitFor(`!!document.querySelector('.timeline-label[data-id="${copy.id}"]')`, 'saved duplicate visible');
    }
    await click('document.querySelector("[data-action=new-event]")');
    await waitFor('!document.querySelector("#event-save").disabled', 'empty editor after duplication');
    assert.equal(await evaluate('document.querySelector("#event-dialog-title").textContent'), '이벤트 추가');
    assert.equal(await evaluate('document.querySelector("#event-form").elements.title.value'), '');
    assert.equal(await evaluate('document.querySelectorAll(".service-tag").length'), 0);
    await click('document.querySelector("#event-form .dialog-actions [data-close]")');
  } finally {
    await app.vault.saveServices({ ...catalog, version: app.vault.readServices().version });
    for (const event of [...fixtures, ...copies]) await app.vault.remove(event.id, event.version);
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  }
  await evaluate(`(() => { const input = document.querySelector('#timeline-date-input'); input.value = '2026-09-09'; input.dispatchEvent(new Event('change', { bubbles: true })); document.dispatchEvent(new Event('visibilitychange')); })()`);
  await waitFor(`!document.querySelector('.timeline-label[data-id="${fixtures[0].id}"]')`, 'duplication fixtures removed');
}
