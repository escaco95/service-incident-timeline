import { randomUUID } from './random-id.js';
const BUSY = new Set(['preparing', 'uploading', 'validating', 'restoring']);
export function createDataTransferUI({ api, authenticated, generation, confirmRestore, onRestored, toast }) {
  const $ = selector => document.querySelector(selector);
  $('#data-transfer-actions').innerHTML = `
    <section class="danger-row"><div><h4>데이터 내보내기</h4><p>비밀 변수를 포함한 복호화 데이터를 ZIP으로 만듭니다. 새로 내보내면 이전 ZIP을 즉시 삭제하며, 준비 완료 후 최대 24시간 보관합니다.</p><p class="transfer-status" id="export-status" role="status" aria-live="polite"></p><progress id="export-progress" aria-label="데이터 내보내기 진행률" hidden></progress></div><div class="transfer-controls"><button type="button" class="button secondary" id="data-export">데이터 내보내기</button><a class="button secondary transfer-file" id="data-download" hidden>ZIP 다운로드</a></div></section>
    <section class="danger-row"><div><h4>데이터 복원하기</h4><p>ZIP을 먼저 검사한 뒤 현재 데이터를 모두 교체합니다. 로그인 비밀번호는 유지합니다.</p><input type="file" id="data-archive" accept=".zip,application/zip" hidden><p class="transfer-status" id="import-status" role="status" aria-live="polite"></p><progress id="import-progress" aria-label="데이터 업로드와 검증 진행률" hidden></progress></div><div class="transfer-controls"><button type="button" class="button secondary" id="data-import">데이터 복원하기</button><button type="button" class="button danger transfer-file" id="data-restore" hidden>데이터로 복원</button></div></section>`;
  let jobs = [], timer, xhr, starting = false, refreshing = false, request = 0;
  const handled = new Set();
  const counts = job => job.counts ? `이벤트 ${job.counts.events.toLocaleString()}건 · 변경 기록 ${job.counts.changes.toLocaleString()}건 · 실행 이력 ${job.counts.workflowRuns.toLocaleString()}건` : '';
  function render() {
    const busy = starting || jobs.some(job => BUSY.has(job.status));
    for (const type of ['export', 'import']) {
      const job = jobs.find(job => job.type === type), node = $(`#${type}-status`), progress = $(`#${type}-progress`), button = $(`#data-${type}`);
      button.disabled = busy;
      const labels = { preparing: '데이터 내보내는 중…', uploading: '업로드 중…', validating: '복원 데이터 검사 중…', restoring: '데이터 복원 중…' };
      button.textContent = labels[job?.status] ?? (type === 'export' ? '데이터 내보내기' : '데이터 복원하기');
      let text = '';
      if (job) {
        if (BUSY.has(job.status)) text = job.status === 'uploading' && job.expectedBytes ? `${job.name} · ${Math.min(100, Math.floor((job.received ?? 0) / job.expectedBytes * 100))}%` : job.progress?.total ? `${labels[job.status]} ${job.progress.done.toLocaleString()} / ${job.progress.total.toLocaleString()}` : labels[job.status];
        else if (job.status === 'ready') text = `${type === 'export' ? '다운로드 준비 완료' : '복원 가능한 데이터입니다'} · ${counts(job)}`;
        else if (job.status === 'failed') text = job.error;
        else if (job.status === 'completed') text = job.warning || '데이터 복원을 완료했습니다.';
      }
      if (node.textContent !== text) node.textContent = text;
      node.classList.toggle('form-error', job?.status === 'failed');
      progress.hidden = !job || !BUSY.has(job.status);
      const total = job?.status === 'uploading' ? job.expectedBytes : job?.progress?.total, done = job?.status === 'uploading' ? job.received : job?.progress?.done;
      if (total) { progress.max = total; progress.value = done ?? 0; } else progress.removeAttribute('value');
    }
    const exported = jobs.find(job => job.type === 'export'), imported = jobs.find(job => job.type === 'import');
    const download = $('#data-download'); download.hidden = exported?.status !== 'ready';
    if (!download.hidden) { download.href = exported.downloadUrl; download.download = exported.name; download.textContent = `${exported.name} 다운로드`; }
    else { download.removeAttribute('href'); download.removeAttribute('download'); }
    const restore = $('#data-restore'); restore.hidden = imported?.status !== 'ready'; restore.disabled = busy;
    if (!restore.hidden) restore.textContent = `${imported.name} 데이터로 복원`;
    for (const button of document.querySelectorAll('[data-reset-target]')) button.disabled = jobs.some(job => job.status === 'restoring');
  }
  function poll() { clearTimeout(timer); if (authenticated() && jobs.some(job => BUSY.has(job.status))) timer = setTimeout(refresh, 1000); }
  async function refresh() {
    if (!authenticated() || refreshing || starting || xhr) { poll(); return; }
    const current = ++request, session = generation(); refreshing = true;
    try {
      const result = await api('/api/settings/transfers');
      if (current !== request || session !== generation()) return;
      jobs = result.jobs; render();
      for (const job of jobs) if (job.status === 'completed' && !handled.has(job.id)) {
        handled.add(job.id); await onRestored(job); toast(job.warning || '데이터를 복원했습니다. 현재 비밀번호로 계속 사용할 수 있습니다.', !!job.warning);
      }
    } catch (error) { if (session === generation()) toast(error.message, true); }
    finally { refreshing = false; poll(); }
  }
  function accept(job) { jobs = [...jobs.filter(item => item.type !== job.type), job]; render(); poll(); }
  $('#data-export').addEventListener('click', async () => {
    if (starting || !authenticated()) return;
    starting = true; const session = generation(); render(); $('#data-export').textContent = '데이터 내보내는 중…';
    try { const job = await api('/api/settings/transfers/export', { method: 'POST', body: JSON.stringify({ requestId: randomUUID() }) }); if (session === generation()) accept(job); }
    catch (error) { if (session === generation()) toast(error.message, true); }
    finally { starting = false; render(); poll(); }
  });
  $('#data-import').addEventListener('click', () => $('#data-archive').click());
  $('#data-archive').addEventListener('change', async () => {
    const file = $('#data-archive').files[0]; $('#data-archive').value = '';
    if (!file || starting || !authenticated()) return;
    if (file.size > 8 * 1024 ** 3 || !file.name.toLowerCase().endsWith('.zip')) { toast('8 GiB 이하의 ZIP 파일을 선택해 주세요.', true); return; }
    starting = true; const session = generation(); render(); $('#data-import').textContent = '업로드 중…';
    try {
      const job = await api('/api/settings/transfers/import', { method: 'POST', body: JSON.stringify({ name: file.name, bytes: file.size, requestId: randomUUID() }) });
      if (session !== generation()) return;
      accept(job);
      const result = await new Promise((resolve, reject) => {
        xhr = new XMLHttpRequest(); xhr.open('PUT', `/api/settings/transfers/${job.id}/upload`); xhr.setRequestHeader('Content-Type', 'application/zip'); xhr.timeout = 2 * 60 * 60 * 1000;
        xhr.upload.onprogress = event => { if (session === generation()) { job.received = event.loaded; render(); } };
        xhr.onload = () => { let result; try { result = JSON.parse(xhr.responseText); } catch { reject(Error('업로드 응답을 읽지 못했습니다. 다시 시도해 주세요.')); return; } xhr.status >= 200 && xhr.status < 300 ? resolve(result) : reject(Error(result.error || '파일 업로드에 실패했습니다.')); };
        xhr.onerror = xhr.ontimeout = () => reject(Error('파일 업로드가 중단되었습니다. 연결 상태를 확인하고 다시 선택해 주세요.'));
        xhr.onabort = () => reject(Error('파일 업로드를 취소했습니다.'));
        xhr.send(file);
      });
      if (session === generation()) accept(result);
    } catch (error) { if (session === generation()) { const job = jobs.find(job => job.type === 'import'); if (job) { job.status = 'failed'; job.error = error.message; } toast(error.message, true); } }
    finally { xhr = null; starting = false; render(); poll(); }
  });
  $('#data-restore').addEventListener('click', () => { const job = jobs.find(job => job.type === 'import' && job.status === 'ready'); if (job) confirmRestore(job, accept); });
  $('#data-download').addEventListener('click', async event => {
    event.preventDefault();
    const job = jobs.find(job => job.type === 'export'), session = generation(); if (!job) return;
    try {
      const current = await api(`/api/settings/transfers/${job.id}`);
      if (session !== generation()) return;
      if (current.status !== 'ready') { accept(current); return; }
      const link = document.createElement('a'); link.href = current.downloadUrl; link.download = current.name;
      document.body.append(link); link.click(); link.remove();
    } catch (error) { if (session === generation()) { toast(error.message, true); refresh(); } }
  });
  $('#danger-zone-tab').addEventListener('click', refresh);
  return { refresh, clear() { ++request; clearTimeout(timer); xhr?.abort(); xhr = null; jobs = []; handled.clear(); starting = false; render(); } };
}
