export function normalizeSearch(value) {
  return String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '')
    .toLocaleLowerCase('pt-BR').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function matchesSearch(event, query) {
  const keywords = normalizeSearch(query).split(' ').filter(Boolean);
  const text = normalizeSearch(`${event.title ?? ''} ${event.description ?? ''}`);
  return keywords.every(keyword => text.includes(keyword));
}
