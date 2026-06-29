// Migrate posts from the Notion "Content" database into the lean GitHub format.
// Preserves: properties, cover, icon, text styles (spans), inline images (downloaded).
//
// Usage:
//   node scripts/notion-migrate.mjs                 # all published posts
//   node scripts/notion-migrate.mjs --limit 4       # first 4 (test batch)
//   node scripts/notion-migrate.mjs --ids <id,id>   # specific notion page ids
//   node scripts/notion-migrate.mjs --no-images     # skip image download (fast dry test)
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POSTS = join(ROOT, 'posts');
const ASSETS = join(ROOT, 'assets');
const PROXY = 'https://crypto-bros-notion-proxy.crypto-bros.workers.dev';
const VERSION = '2022-06-28';
const DB_ID = '2ef2da8d-8134-8092-a6d4-f85e3078c553';
const RAW_BASE = 'https://raw.githubusercontent.com/oviniciusramosp/crypto-bros-content/main/assets';

const args = process.argv.slice(2);
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const ONLY_IDS = args.includes('--ids') ? args[args.indexOf('--ids') + 1].split(',') : null;
const NO_IMAGES = args.includes('--no-images');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function napi(path, opts = {}) {
  for (let attempt = 0; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${PROXY}${path}`, {
        ...opts,
        headers: { 'Notion-Version': VERSION, 'Content-Type': 'application/json', ...opts.headers },
      });
      if (res.ok) return res.json();
      if (res.status === 429 || res.status >= 500) { await sleep(res.status === 429 ? 5000 : 1000 * 2 ** attempt); continue; }
      throw new Error(`Notion ${res.status}: ${await res.text()}`);
    } catch (e) {
      if (attempt === 4) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

// ---- properties → meta ----
const slugify = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'post';
const localeOf = (lang) => (lang === 'EN' ? 'en' : 'pt');

function richToSpans(rich = []) {
  const spans = [];
  for (const r of rich) {
    const text = r.plain_text ?? r.text?.content ?? '';
    if (!text) continue;
    const a = r.annotations || {};
    const span = { text };
    if (a.bold) span.bold = true;
    if (a.italic) span.italic = true;
    if (a.underline) span.underline = true;
    if (a.strikethrough) span.strikethrough = true;
    if (a.code) span.code = true;
    if (a.color && a.color !== 'default') span.color = a.color.replace('_background', '');
    const href = r.href ?? r.text?.link?.url;
    if (href) span.href = href;
    spans.push(span);
  }
  return spans.length ? spans : [{ text: '' }];
}

// ---- image download + rehost ----
const imageCache = new Map(); // notionUrl → rawUrl
async function rehostImage(url) {
  if (!url) return null;
  if (NO_IMAGES) return url;
  if (imageCache.has(url)) return imageCache.get(url);
  const res = await fetch(url);
  if (!res.ok) { console.warn('  ! image fetch failed', res.status); return url; }
  const buf = Buffer.from(await res.arrayBuffer());
  const hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const ct = res.headers.get('content-type') || '';
  const ext = ct.includes('png') ? 'png' : ct.includes('gif') ? 'gif' : ct.includes('webp') ? 'webp' : ct.includes('svg') ? 'svg' : 'jpg';
  const file = `${hash}.${ext}`;
  const dest = join(ASSETS, file);
  if (!existsSync(dest)) writeFileSync(dest, buf);
  const raw = `${RAW_BASE}/${file}`;
  imageCache.set(url, raw);
  return raw;
}

const fileUrl = (f) => (f?.type === 'external' ? f.external?.url : f?.file?.url) ?? null;

// ---- blocks → lean ----
async function fetchChildren(blockId) {
  const out = [];
  let cursor;
  do {
    const q = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100';
    const r = await napi(`/blocks/${blockId}/children${q}`);
    out.push(...(r.results || []));
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}

async function blockToLean(block) {
  const t = block.type;
  const d = block[t] || {};
  switch (t) {
    case 'paragraph':
      return d.rich_text?.length ? { type: 'p', spans: richToSpans(d.rich_text) } : null;
    case 'heading_1': return { type: 'h', level: 1, spans: richToSpans(d.rich_text) };
    case 'heading_2': return { type: 'h', level: 2, spans: richToSpans(d.rich_text) };
    case 'heading_3': return { type: 'h', level: 3, spans: richToSpans(d.rich_text) };
    case 'quote': return { type: 'quote', spans: richToSpans(d.rich_text) };
    case 'to_do': return { type: 'todo', checked: !!d.checked, spans: richToSpans(d.rich_text) };
    case 'divider': return { type: 'divider' };
    case 'code':
      return { type: 'code', lang: (d.language || 'text'), text: (d.rich_text || []).map((r) => r.plain_text).join('') };
    case 'callout': {
      const icon = d.icon?.emoji || '💡';
      const inner = [{ type: 'p', spans: richToSpans(d.rich_text) }];
      return { type: 'callout', icon, color: d.color || 'gray_background', blocks: inner };
    }
    case 'image': {
      const src = await rehostImage(fileUrl(d));
      return src ? { type: 'image', src, caption: richToSpans(d.caption || []) } : null;
    }
    case 'video': {
      const src = fileUrl(d);
      return src ? { type: 'video', src } : null;
    }
    case 'embed': case 'bookmark': {
      const url = d.url;
      return url ? { type: 'p', spans: [{ text: url, href: url }] } : null;
    }
    default:
      return null; // unknown → skip (logged by caller)
  }
}

// group consecutive list items into a single lean list block
async function blocksToLean(rawBlocks) {
  const out = [];
  let listBuf = null; // {ordered, items}
  const flush = () => { if (listBuf) { out.push({ type: 'list', ordered: listBuf.ordered, items: listBuf.items }); listBuf = null; } };
  for (const b of rawBlocks) {
    if (b.type === 'bulleted_list_item' || b.type === 'numbered_list_item') {
      const ordered = b.type === 'numbered_list_item';
      if (!listBuf || listBuf.ordered !== ordered) { flush(); listBuf = { ordered, items: [] }; }
      listBuf.items.push(richToSpans(b[b.type].rich_text));
      continue;
    }
    flush();
    const lean = await blockToLean(b);
    if (lean) out.push(lean);
    else if (!['column_list', 'column', 'table', 'table_row'].includes(b.type)) console.warn('  ? skipped block:', b.type);
  }
  flush();
  return out;
}

// ---- page → post ----
async function pageToMeta(page) {
  const p = page.properties || {};
  const titleSpans = richToSpans(p.Title?.title || []);
  const title = titleSpans.map((s) => s.text).join('');
  const lang = p.Language?.select?.name || 'PT-BR';
  const locale = localeOf(lang);
  const cover = await rehostImage(fileUrl(page.cover));
  const thumb = await rehostImage(fileUrl(p.Thumbnail?.files?.[0]));
  let icon = null;
  if (page.icon?.type === 'emoji') icon = { emoji: page.icon.emoji };
  else if (page.icon) { const u = await rehostImage(fileUrl(page.icon)); if (u) icon = { src: u }; }
  const date = p.PublishedAt?.date?.start || page.created_time;
  return {
    id: page.id.replace(/-/g, ''),
    locale,
    slug: slugify(title),
    date: new Date(date).toISOString(),
    updated: new Date(page.last_edited_time || date).toISOString(),
    categories: (p.Category?.multi_select || []).map((c) => c.name),
    tags: (p.Tags?.multi_select || []).map((t) => ({ name: t.name, color: t.color || 'blue' })),
    author: { id: 'a1', name: p.Author?.select?.name || 'Crypto Bros', avatar: null },
    cover: cover || null,
    thumbnail: thumb || null,
    icon,
    title: titleSpans,
    excerpt: '',
    pinned: !!p.Pin?.checkbox,
  };
}

async function migratePage(page) {
  const meta = await pageToMeta(page);
  const raw = await fetchChildren(page.id);
  const blocks = await blocksToLean(raw);
  // excerpt = first paragraph text, trimmed
  const firstP = blocks.find((b) => b.type === 'p');
  meta.excerpt = firstP ? firstP.spans.map((s) => s.text).join('').slice(0, 160) : '';
  const post = { schemaVersion: 1, ...meta, blocks };
  const f = join(POSTS, `${meta.id}.${meta.locale}.json`);
  writeFileSync(f, JSON.stringify(post, null, 2) + '\n');
  return { id: meta.id, locale: meta.locale, title: meta.title.map((s) => s.text).join(''), blocks: blocks.length };
}

async function queryPublished() {
  const pages = [];
  let cursor;
  do {
    const body = {
      filter: { property: 'Published', checkbox: { equals: true } },
      sorts: [{ property: 'PublishedAt', direction: 'descending' }],
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    };
    const r = await napi(`/databases/${DB_ID}/query`, { method: 'POST', body: JSON.stringify(body) });
    pages.push(...(r.results || []));
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return pages;
}

(async () => {
  console.log('Querying published posts…');
  let pages = ONLY_IDS
    ? await Promise.all(ONLY_IDS.map((id) => napi(`/pages/${id}`)))
    : await queryPublished();
  if (!ONLY_IDS) pages = pages.filter((p) => (p.properties?.Title?.title || []).length); // skip untitled
  pages = pages.slice(0, LIMIT);
  console.log(`Migrating ${pages.length} posts${NO_IMAGES ? ' (no images)' : ''}…`);
  let ok = 0;
  for (const page of pages) {
    try {
      const r = await migratePage(page);
      ok++;
      console.log(`  ✓ ${r.id}.${r.locale}  ${r.blocks} blocks  — ${r.title.slice(0, 50)}`);
    } catch (e) {
      console.error(`  ✗ ${page.id}: ${e.message}`);
    }
  }
  console.log(`\nDone: ${ok}/${pages.length} posts. Run \`node build-index.mjs\` to rebuild the index.`);
})();
