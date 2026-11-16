// MIDI library kept in Vercel Blob.
//   GET    /api/songs          -> list of songs (everyone)
//   GET    /api/songs?id=...   -> the MIDI file itself (everyone)
//   POST   /api/songs          -> register a song   (needs the admin password)
//   POST   /api/songs?check=1  -> check the password
//   PATCH  /api/songs          -> rename            (needs the admin password)
//   DELETE /api/songs?id=...   -> delete            (needs the admin password)
import { put, list, del } from '@vercel/blob';

const MAX_SONGS = 20;            // classic-midi.com allows up to 20 songs in one service
const MAX_BYTES = 1024 * 1024;

const authed = req => {
  const pw = process.env.ADMIN_PASSWORD;
  return !!pw && req.headers['x-admin'] === pw;
};

// the song list is one small JSON file; each write makes a new file and removes the old ones,
// so a cached copy is never served
async function readIndex() {
  const { blobs } = await list({ prefix: 'index/' });
  if (!blobs.length) return { songs: [], urls: [] };
  blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  const r = await fetch(blobs[0].url + '?t=' + Date.now(), { cache: 'no-store' });
  const data = r.ok ? await r.json() : {};
  return { songs: Array.isArray(data.songs) ? data.songs : [], urls: blobs.map(b => b.url) };
}
async function writeIndex(songs, oldUrls) {
  await put('index/songs.json', JSON.stringify({ songs }), { access: 'public', addRandomSuffix: true, contentType: 'application/json' });
  if (oldUrls.length) await del(oldUrls).catch(() => {});
}

// every blob that is not the song list, i.e. the MIDI files themselves
async function midiBlobs() {
  const out = [];
  let cursor;
  do {
    const r = await list({ cursor, limit: 1000 });
    for (const b of r.blobs) if (!b.pathname.startsWith('index/')) out.push(b);
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return out;
}
const blobsFor = (blobs, id) => blobs.filter(b => b.pathname.includes(id));

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  try {
    if (req.method === 'GET') {
      if (q.id) {
        const id = String(q.id);
        const { songs } = await readIndex();
        const s = songs.find(x => x.id === id);
        let url = s && s.url;
        if (!url) { const [b] = blobsFor(await midiBlobs(), id); url = b && b.url; }
        if (!s || !url) return res.status(404).json({ error: '曲が見つかりません' });
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) return res.status(502).json({ error: '曲を取得できませんでした' });
        res.setHeader('Content-Type', 'audio/midi');
        res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
        return res.status(200).send(Buffer.from(await r.arrayBuffer()));
      }
      const { songs } = await readIndex();
      // the storage address stays on the server
      return res.status(200).json({ songs: songs.map(({ url, ...rest }) => rest), max: MAX_SONGS });
    }

    if (!authed(req)) return res.status(401).json({ error: 'パスワードが違います' });

    if (req.method === 'POST' && q.check) return res.status(200).json({ ok: true });

    if (req.method === 'POST') {
      const body = await readBody(req);
      const data = Buffer.from(String(body.data || ''), 'base64');
      if (!data.length) return res.status(400).json({ error: 'ファイルが空です' });
      if (data.length > MAX_BYTES) return res.status(413).json({ error: '1MBまでのファイルにしてください' });
      if (data.subarray(0, 4).toString('latin1') !== 'MThd') return res.status(400).json({ error: 'MIDIファイルではありません' });
      const { songs, urls } = await readIndex();
      if (songs.length >= MAX_SONGS) return res.status(409).json({ error: `登録できるのは${MAX_SONGS}曲までです` });
      const id = newId();
      const blob = await put(`midi/${id}.mid`, data, { access: 'public', addRandomSuffix: true, contentType: 'audio/midi' });
      const song = {
        id,
        url: blob.url,
        name: String(body.name || body.file || '無題').slice(0, 80),
        file: String(body.file || '').slice(0, 120),
        parts: Number(body.parts) || 0,
        dur: Number(body.dur) || 0,
        added: Date.now(),
      };
      await writeIndex([...songs, song], urls);
      const { url, ...pub } = song;
      return res.status(200).json({ song: pub });
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const name = String(body.name || '').trim().slice(0, 80);
      if (!body.id || !name) return res.status(400).json({ error: '名前が空です' });
      const { songs, urls } = await readIndex();
      const s = songs.find(x => x.id === body.id);
      if (!s) return res.status(404).json({ error: '曲が見つかりません' });
      s.name = name;
      await writeIndex(songs, urls);
      const { url, ...pub } = s;
      return res.status(200).json({ song: pub });
    }

    if (req.method === 'DELETE') {
      const id = String(q.id || '');
      if (!id) return res.status(400).json({ error: 'idがありません' });
      const { songs, urls } = await readIndex();
      const gone = songs.find(x => x.id === id);
      const rest = songs.filter(x => x.id !== id);
      if (rest.length === songs.length) return res.status(404).json({ error: '曲が見つかりません' });
      await writeIndex(rest, urls);
      const files = blobsFor(await midiBlobs(), id).map(b => b.url);
      if (gone && gone.url && !files.includes(gone.url)) files.push(gone.url);
      if (files.length) await del(files).catch(() => {});
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'この操作はできません' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'サーバーエラー' });
  }
}
