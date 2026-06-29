# crypto-bros-content

Static, app-native content for the Crypto Bros app. Served free via
`raw.githubusercontent.com` (and later jsDelivr). Replaces runtime Notion calls.

- `index.json` — lightweight, **bilingual** feed index (card metadata + preview
  blocks up to the first divider). The app's Feed downloads only this.
- `posts/<id>.<locale>.json` — full body of a post for one locale. Loaded only
  when a post is opened.
- `schema.json` — the format contract (JSON Schema, schemaVersion 1).

Published by the Crypto Bros **Studio** editor (and, during migration, by the
`sync-content` script). The app reads it via `CONTENT_BASE_URL`.

Base URL: `https://raw.githubusercontent.com/oviniciusramosp/crypto-bros-content/main`
