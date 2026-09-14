export const EVENT_BODY_MAX_BYTES = 128 * 1024;

export function normalizeEventBody(event) {
  if (!event) return event;
  return { ...event, body: event.body === undefined ? '' : event.body, bodyFormat: event.bodyFormat === undefined ? 'text' : event.bodyFormat };
}
