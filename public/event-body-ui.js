import DOMPurify from './vendor/dompurify/purify.es.js';
import { EVENT_BODY_MAX_BYTES, normalizeEventBody } from './event-content.js';

const tags = ['html', 'head', 'body', 'style', 'p', 'div', 'span', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'small', 'sub', 'sup', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'a', 'font', 'center', 'img'];
const attributes = ['style', 'class', 'href', 'title', 'alt', 'colspan', 'rowspan', 'scope', 'width', 'height', 'align', 'valign', 'bgcolor', 'text', 'border', 'cellpadding', 'cellspacing', 'color', 'face', 'size', 'start', 'type'];
const cssProperties = new Set(['color', 'background-color', 'font-family', 'font-size', 'font-style', 'font-weight', 'text-decoration', 'text-align', 'text-indent', 'vertical-align', 'white-space', 'line-height', 'letter-spacing', 'word-spacing', 'word-break', 'overflow-wrap', 'border', 'border-collapse', 'border-spacing', 'table-layout', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'margin', 'padding', 'display', ...['top', 'right', 'bottom', 'left'].flatMap(side => [`margin-${side}`, `padding-${side}`, `border-${side}`, ...['color', 'style', 'width'].map(part => `border-${side}-${part}`)]), ...['color', 'style', 'width'].map(part => `border-${part}`)]);
const config = { ALLOWED_TAGS: tags, ALLOWED_ATTR: attributes, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false, WHOLE_DOCUMENT: true, RETURN_DOM: true };

function safeDeclarations(style) {
  const clean = document.createElement('span').style;
  for (const property of style) if (cssProperties.has(property)) clean.setProperty(property, style.getPropertyValue(property), style.getPropertyPriority(property));
  return clean.cssText;
}

function safeStylesheet(text) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(text);
  const rules = (items, depth = 0) => [...items].flatMap(rule => {
    if (rule.type === CSSRule.STYLE_RULE) return `${rule.selectorText}{${safeDeclarations(rule.style)}}`;
    if (rule.type === CSSRule.MEDIA_RULE && depth < 4) return `@media ${rule.conditionText}{${rules(rule.cssRules, depth + 1)}}`;
    return [];
  }).join('\n');
  return rules(sheet.cssRules).replaceAll('<', '\\3c ');
}

function htmlDocument(source) {
  const clean = DOMPurify.sanitize(source, config);
  for (const node of [clean, ...clean.querySelectorAll('[style]')]) if (node.hasAttribute('style')) node.setAttribute('style', safeDeclarations(node.style));
  for (const style of clean.querySelectorAll('style')) style.textContent = safeStylesheet(style.textContent);
  for (const anchor of clean.querySelectorAll('a[href]')) {
    let url;
    try { url = new URL(anchor.getAttribute('href')); } catch {}
    if (!url || !['https:', 'http:'].includes(url.protocol)) anchor.removeAttribute('href');
    else anchor.setAttribute('href', url.href);
  }
  for (const image of clean.querySelectorAll('img')) {
    const placeholder = document.createElement('span');
    placeholder.textContent = image.alt ? `[이미지: ${image.alt}]` : '[이미지 생략]';
    image.replaceWith(placeholder);
  }
  // No scripts, forms, frames or resource URLs survive into the isolated document.
  const content = DOMPurify.sanitize(clean.outerHTML, config);
  content.querySelector('head').insertAdjacentHTML('afterbegin', `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><style>html{color-scheme:light;background:#fff}:where(body){margin:16px;font:14px/1.6 sans-serif;overflow-wrap:break-word}:where(body:not([bgcolor])){background:#fff}:where(body:not([text])){color:#202520}:where(pre){white-space:pre-wrap}:where(a[href]){color:#1264a3}</style>`);
  return `<!doctype html>${content.outerHTML}`;
}

export function createEventBodyUI({ openLink }) {
  const form = document.querySelector('#event-form');
  const preview = document.querySelector('#event-body-preview');
  const previewContent = document.querySelector('#event-body-preview-content');
  let timer;
  let originalBody = '', initialBody = '';

  function render(container, event) {
    const { body, bodyFormat } = normalizeEventBody(event);
    container.replaceChildren();
    if (!body || bodyFormat === 'text') {
      const text = document.createElement('div');
      text.className = 'event-body-text';
      text.textContent = body || '등록된 본문이 없습니다.';
      container.append(text);
      return;
    }
    const frame = document.createElement('iframe');
    frame.className = 'event-body-frame';
    frame.title = '이벤트 HTML 본문';
    // Parent access is only for link confirmation; scripts stay disabled in the frame.
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.referrerPolicy = 'no-referrer';
    frame.addEventListener('load', () => {
      const intercept = event => {
        if (event.type === 'auxclick' && event.button !== 1) return;
        const anchor = event.target.closest?.('a[href]');
        if (!anchor) return;
        event.preventDefault();
        openLink(anchor.href, frame);
      };
      frame.contentDocument?.addEventListener('click', intercept, true);
      frame.contentDocument?.addEventListener('auxclick', intercept, true);
    });
    frame.srcdoc = htmlDocument(body);
    container.append(frame);
  }

  function fields() {
    const body = form.elements.body.value === initialBody ? originalBody : form.elements.body.value;
    if (new TextEncoder().encode(body).length > EVENT_BODY_MAX_BYTES) throw new Error('본문은 UTF-8 기준 128KiB까지 입력할 수 있습니다.');
    return { body, bodyFormat: form.elements.bodyFormat.value };
  }
  function updatePreview() {
    clearTimeout(timer);
    if (preview.open) render(previewContent, fields());
  }
  form.addEventListener('input', event => {
    if (!['body', 'bodyFormat'].includes(event.target.name)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { updatePreview(); }
      catch (error) { previewContent.textContent = error.message; }
    }, 200);
  });
  preview.addEventListener('toggle', () => {
    try { updatePreview(); }
    catch (error) { previewContent.textContent = error.message; }
  });
  document.querySelector('#event-dialog').addEventListener('close', event => {
    if (event.target.open) return;
    clearTimeout(timer);
    originalBody = ''; initialBody = '';
    preview.open = false;
    previewContent.replaceChildren();
  });

  function openEditor(event) {
    const { body, bodyFormat } = normalizeEventBody(event ?? {});
    form.elements.body.value = body;
    originalBody = body;
    initialBody = form.elements.body.value;
    form.elements.bodyFormat.value = bodyFormat;
    preview.open = false;
    previewContent.replaceChildren();
  }
  return { openEditor, fields, render };
}
