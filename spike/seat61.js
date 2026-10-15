// JS port of sections() from travel_research_skills journey-planner/scripts/seat61.py, for CPU estimates.
const entities = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
const unescape = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : entities[e.toLowerCase()] ?? m);
const clean = s => unescape(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
export function sections(raw) {
  let page = new TextDecoder('windows-1252').decode(raw);
  page = page.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  const parts = page.split(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/i);
  const out = [['(top)', parts[0]]];
  for (let i = 1; i < parts.length; i += 3) out.push([parts[i + 1], parts[i + 2]]);
  return out.map(([h, t]) => [clean(h), clean(t)]).filter(([, t]) => t);
}

// Cheaper variant: split on headings without cleaning every body, then clean only the headings
// and the sections whose raw HTML mentions the search term.
export function find(raw, term) {
  const page = new TextDecoder('windows-1252').decode(raw);
  const parts = page.split(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/i);
  const needle = term?.toLowerCase();
  const headings = [], matches = [];
  for (let i = 1; i < parts.length; i += 3) {
    const heading = clean(parts[i + 1]);
    headings.push(heading);
    if (needle && parts[i + 2].toLowerCase().includes(needle)) matches.push([heading, clean(parts[i + 2].replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' '))]);
  }
  return {headings, matches};
}
