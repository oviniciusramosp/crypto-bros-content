// Rebuild index.json from posts/*.json. Preview = blocks before the first
// divider (or first 8 if none). Run: node build-index.mjs
import { readdirSync, readFileSync, writeFileSync } from 'fs';

const dir = 'posts';
const posts = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => {
    const { blocks, ...meta } = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
    const div = blocks.findIndex((b) => b.type === 'divider');
    return { ...meta, hasMore: div !== -1, preview: div === -1 ? blocks.slice(0, 8) : blocks.slice(0, div) };
  })
  .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

const index = { schemaVersion: 1, generatedAt: new Date().toISOString(), posts };
writeFileSync('index.json', JSON.stringify(index, null, 2) + '\n');
console.log(`index.json: ${posts.length} posts (${posts.map((p) => p.id + '.' + p.locale).join(', ')})`);
