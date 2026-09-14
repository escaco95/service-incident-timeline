import assert from 'node:assert/strict';

export async function checkEventBody({ app, evaluate, click, waitFor, command, screenshot, resourceRequests }) {
  const body = `  <!doctype html>\r\n<html style="background-image:url('/event-body-probe');position:fixed"><head><style>
    @import url('https://event-body-probe.test/import.css');
    .proof { border-collapse:collapse; width:600px; }
    .proof td { border:1px solid #123456; padding:12px; color:rgb(12, 34, 56); }
    .proof th { background-color:rgb(220, 230, 240); }
    @media (max-width:400px) { .proof td { font-size:13px; } }
    body { background-image:url('https://event-body-probe.test/background'); }
  </style><base href="https://event-body-probe.test/"><meta http-equiv="refresh" content="0;url=https://event-body-probe.test/redirect"></head><body style="font-family:serif" bgcolor="#fff7ed" text="#303030">
    <p><strong>협력사 점검 안내</strong></p>
    <table class="proof"><tr><th colspan="2">서비스 점검</th></tr><tr><td rowspan="2">서비스 A</td><td>09:00~10:00</td></tr><tr><td style="text-align:right;font-weight:bold">정상화 완료</td></tr></table>
    <a href="https://evidence.example/notice?id=1&amp;lang=ko">안내 원문</a>
    <a href="javascript:parent.bodyInjected=true">잘못된 링크</a><a href="/event-body-probe">상대 링크</a>
    <img src="https://event-body-probe.test/tracker" srcset="/event-body-probe 2x" alt="협력사 로고" onerror="parent.bodyInjected=true">
    <script>parent.bodyInjected=true;fetch('/event-body-probe')</script>
    <form action="/event-body-probe"><input name="password"><button>전송</button></form>
    <iframe src="/event-body-probe"></iframe><object data="/event-body-probe"></object>
    <svg onload="parent.bodyInjected=true"><image href="/event-body-probe"/></svg>
    <div style="position:fixed;inset:0;background-image:url('/event-body-probe')">본문 끝</div>
  </body></html>\r\n  `;
  const ids = [];
  const base = { title: '기존 설명 호환', description: '기존 설명은 메모입니다.', category: 'maintenance', services: [], start: '2026-09-09T01:00:00.000Z', end: null };
  const open = async id => {
    await evaluate('document.dispatchEvent(new Event("visibilitychange"))');
    await waitFor(`!!document.querySelector('.timeline-label[data-id="${id}"]')`, 'body event visible');
    await click(`document.querySelector('.timeline-label[data-id="${id}"]')`);
  };
  const editorReady = () => waitFor('!document.querySelector("#event-save").disabled', 'body editor ready');
  const saved = async () => { await waitFor('!document.querySelector("#event-dialog").open', 'body saved'); await editorReady(); };
  const frameDocument = 'document.querySelector("#detail-body iframe").contentDocument';
  try {
    const legacy = (await app.vault.add(base)).event; ids.push(legacy.id);
    await app.vault.mutate(state => { const event = state.events.find(item => item.id === legacy.id); delete event.body; delete event.bodyFormat; });
    await open(legacy.id);
    assert.equal(await evaluate('document.querySelector(".detail-description").textContent'), base.description);
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll(".detail-section-title")).map(node => node.textContent)'), ['메모', '본문']);
    assert.equal(await evaluate('document.querySelector("#detail-body").textContent'), '등록된 본문이 없습니다.');
    await click('document.querySelector("[data-action=edit-event]")'); await editorReady();
    assert.equal(await evaluate('document.querySelector("#event-form").elements.body.value'), '');
    assert.equal(await evaluate('document.querySelector("#event-form").elements.bodyFormat.value'), 'text');
    assert.ok(await evaluate('document.querySelector("#event-form").elements.description.closest("label").textContent.includes("메모")'));
    await click('document.querySelector("#event-save")'); await saved();
    const raw = (await app.vault.daily.readBucket(app.vault.daily.refs().find(ref => ref.kind === 'events-open'))).events.find(event => event.id === legacy.id);
    assert.equal(raw.body, ''); assert.equal(raw.bodyFormat, 'text');

    const html = (await app.vault.add({ ...base, title: '협력사 이메일 증빙', body, bodyFormat: 'html' })).event; ids.push(html.id);
    await open(html.id);
    await waitFor(`${frameDocument}?.querySelectorAll('.proof tr').length === 3`, 'email table rendered');
    assert.equal(await evaluate(`${frameDocument}.querySelector('th').colSpan`), 2);
    assert.equal(await evaluate(`${frameDocument}.querySelector('td').rowSpan`), 2);
    assert.deepEqual(await evaluate(`(() => { const doc = ${frameDocument}, style = doc.defaultView.getComputedStyle(doc.body); return [style.backgroundColor, style.color, style.fontFamily]; })()`), ['rgb(255, 247, 237)', 'rgb(48, 48, 48)', 'serif']);
    assert.deepEqual(await evaluate(`(() => { const doc = ${frameDocument}, style = doc.defaultView.getComputedStyle(doc.querySelector('td')); return [style.paddingTop, style.borderTopWidth, style.color]; })()`), ['12px', '1px', 'rgb(12, 34, 56)']);
    assert.equal(await evaluate(`${frameDocument}.querySelectorAll('script,form,input,button,iframe,object,svg,img,base,meta[http-equiv=refresh]').length`), 0);
    assert.equal(await evaluate(`${frameDocument}.querySelectorAll('[src],[srcset],[onerror],[onload]').length`), 0);
    assert.equal(await evaluate(`${frameDocument}.documentElement.getAttribute('style')`), '');
    assert.equal(await evaluate(`${frameDocument}.querySelectorAll('a[href]').length`), 1);
    assert.equal(await evaluate('document.querySelector("#detail-body iframe").sandbox.value'), 'allow-same-origin');
    assert.equal(await evaluate('!!window.bodyInjected'), false);
    await screenshot('event-body-html-desktop');
    await command('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
    assert.ok(await evaluate('document.querySelector("#detail-dialog").scrollWidth <= document.querySelector("#detail-dialog").clientWidth'), 'wide email table stays inside its mobile viewer');
    assert.ok(await evaluate(`${frameDocument}.documentElement.scrollWidth > ${frameDocument}.documentElement.clientWidth`), 'wide tables scroll without shrinking the email layout');
    await evaluate('document.querySelector("#detail-body").scrollIntoView()');
    await screenshot('event-body-html-mobile');
    await evaluate('window.eventBodyOriginalOpen = window.open; window.eventBodyOpens = []; window.open = (...args) => window.eventBodyOpens.push(args)');
    try {
      await click(`${frameDocument}.querySelector('a[href]')`);
      assert.equal(await evaluate('document.querySelector("#external-link-dialog").open'), true);
      assert.equal(await evaluate('window.eventBodyOpens.length'), 0);
      await click('document.querySelector("#external-link-dialog [data-close]")');
      await waitFor('document.activeElement.tagName === "IFRAME"', 'focus returns to the email viewer');
      await click(`${frameDocument}.querySelector('a[href]')`);
      await click('document.querySelector("#external-link-confirm")');
      assert.deepEqual(await evaluate('window.eventBodyOpens'), [['https://evidence.example/notice?id=1&lang=ko', '_blank', 'noopener,noreferrer']]);
    } finally { await evaluate('window.open = window.eventBodyOriginalOpen; delete window.eventBodyOriginalOpen; delete window.eventBodyOpens'); }
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });

    await click('document.querySelector("[data-action=edit-event]")'); await editorReady();
    await evaluate(`(() => { const form = document.querySelector('#event-form'); form.elements.bodyFormat.value = 'text'; form.elements.bodyFormat.dispatchEvent(new Event('input', { bubbles:true })); })()`);
    assert.equal(await evaluate('document.querySelector("#event-form").elements.body.value'), body.replaceAll('\r\n', '\n'));
    await click('document.querySelector("#event-body-preview summary")');
    await waitFor('!!document.querySelector("#event-body-preview-content .event-body-text")', 'text preview');
    assert.equal(await evaluate('document.querySelector("#event-body-preview-content").textContent'), body);
    await evaluate(`(() => { const form = document.querySelector('#event-form'); form.elements.bodyFormat.value = 'html'; form.elements.bodyFormat.dispatchEvent(new Event('input', { bubbles:true })); form.elements.description.value = '메모만 수정'; })()`);
    await waitFor('document.querySelector("#event-body-preview-content iframe")?.contentDocument?.querySelectorAll(".proof tr").length === 3', 'HTML preview');
    await screenshot('event-body-editor-preview');
    await click('document.querySelector("#event-save")'); await saved();
    assert.equal((await app.vault.getRecord('events', html.id)).body, body, 'memo edits preserve original CRLF and surrounding whitespace');

    await open(html.id); await click('document.querySelector("[data-action=duplicate-event]")'); await editorReady();
    await evaluate('document.querySelector("#event-form").elements.title.value = "본문 복제본"');
    await click('document.querySelector("#event-save")'); await saved();
    const copy = (await app.vault.read()).events.find(event => event.title === '본문 복제본'); ids.push(copy.id);
    assert.equal(copy.body, body); assert.equal(copy.bodyFormat, 'html');
    await open(copy.id); await click('document.querySelector("[data-action=edit-event]")'); await editorReady();
    await evaluate('document.querySelector("#event-form").elements.bodyFormat.value = "text"');
    await click('document.querySelector("#event-save")'); await saved();
    await open(copy.id);
    assert.equal(await evaluate('document.querySelectorAll("#detail-body iframe, #detail-body table").length'), 0);
    assert.equal(await evaluate('document.querySelector("#detail-body").textContent'), body);
    await click('document.querySelector("[data-action=edit-event]")'); await editorReady();
    await evaluate('document.querySelector("#event-form").elements.body.value = "한".repeat(43691)');
    await click('document.querySelector("#event-save")');
    await waitFor('!document.querySelector("#event-error").hidden', 'body byte limit');
    assert.ok(await evaluate('document.querySelector("#event-error").textContent.includes("128KiB")'));
    assert.equal((await app.vault.getRecord('events', copy.id)).version, 2);
    await click('document.querySelector("#event-form .dialog-actions [data-close]")');
    assert.deepEqual(resourceRequests, [], 'viewing and previewing HTML never fetch email resources');
    assert.equal(await evaluate('!!window.bodyInjected'), false);
  } finally {
    for (const id of ids) { const event = await app.vault.getRecord('events', id); await app.vault.remove(id, event.version); }
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  }
  await evaluate('document.dispatchEvent(new Event("visibilitychange"))');
  await waitFor(`!document.querySelector('.timeline-label[data-id="${ids[0]}"]')`, 'body fixtures removed');
}
