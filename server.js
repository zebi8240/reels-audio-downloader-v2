/**
 * reels-audio-service-v2  (SCRATCH BUILD - bilkul naya, purani service se alag)
 * Free Instagram Reels -> MP3 microservice (yt-dlp + ffmpeg).
 * Is build me koi paid API nahi hai - RapidAPI bhi nahi. Sirf yt-dlp.
 *
 * Endpoints:
 *   GET  /                        -> standalone tool page (public/index.html)
 *   GET  /health                  -> { ok: true, ytdlp: true/false }
 *   GET  /api/audio?url=<instagram reel/post url>
 *   POST /api/audio               -> body JSON { url } ya { link }
 *     -> { success: true, audioUrl, downloadUrl, mp3Url, m4aUrl, title, author, username, artist, thumbnail, duration }
 *        Download links temporary hain (30 min baad auto-delete).
 *     -> { success: false, message } on failure
 */

const express = require('express');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ffmpegPath = require('ffmpeg-static');

const app = express();
app.set('trust proxy', 1); // Render proxy ke peeche https pehchanne ke liye
const PORT = process.env.PORT || 3000;
const YTDLP = path.join(__dirname, 'bin', 'yt-dlp');
const FILES_DIR = path.join(__dirname, 'files');
const FILE_TTL_MS = 30 * 60 * 1000; // download links expire after 30 minutes

fs.mkdirSync(FILES_DIR, { recursive: true });

app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/files', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  if (String(req.query.download || '') === '1') {
    const raw = String(req.query.filename || path.basename(req.path || 'reel-audio'));
    const safe = raw.replace(/[^a-zA-Z0-9._ -]/g, '').trim().slice(0, 80) || 'reel-audio';
    res.setHeader('Content-Disposition', 'attachment; filename="' + safe + '"');
  }
  next();
}, express.static(FILES_DIR));

// ---- simple CORS (taake tool kisi bhi site se call ho sake) ----
app.use('/api/', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---- simple in-memory rate limit: max 30 requests per minute per IP ----
const hits = {};
setInterval(() => { for (const k in hits) delete hits[k]; }, 60 * 1000);
app.use('/api/', (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  hits[ip] = (hits[ip] || 0) + 1;
  if (hits[ip] > 30) return res.status(429).json({ success: false, message: 'Too many requests. Please slow down and try again in a minute.' });
  next();
});

app.get('/health', (req, res) => res.json({ ok: true, service: 'reels-audio-service-v2', ytdlp: fs.existsSync(YTDLP) }));

// ---- Instagram URL check: sirf instagram.com links allow ----
function isInstagramUrl(u) {
  return /^https?:\/\/(www\.)?instagram\.com\//i.test(String(u || ''));
}
function getInputUrl(req) {
  return String((req.query && req.query.url) || (req.body && (req.body.url || req.body.link)) || '').trim();
}

// ---- keep yt-dlp fresh: startup pe update check (non-blocking) ----
function updateYtDlp() {
  if (!fs.existsSync(YTDLP)) {
    console.log('[yt-dlp] binary not found. Run: node scripts/fetch-ytdlp.js');
    return;
  }
  execFile(YTDLP, ['-U'], { timeout: 90000 }, (err, stdout) => {
    const line = (stdout || '').trim().split('\n').pop();
    console.log('[yt-dlp] update check:', err ? String(err.message).slice(0, 120) : line);
  });
}

const AUDIO_EXT = /\.(m4a|mp3|aac|opus|ogg|webm|wav|mp4)$/i;

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).slice(-300)));
      resolve(String(stderr || stdout || ''));
    });
  });
}

function probeFile(filePath) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-i', filePath], { timeout: 20000 }, (err, stdout, stderr) => {
      const text = `${stdout || ''}\n${stderr || ''}`;
      const dur = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const audioLine = (text.match(/Audio:.*$/m) || [''])[0];
      const codec = (audioLine.match(/Audio:\s*([^,\s]+)/) || [])[1] || '';
      const bitrate = (audioLine.match(/(\d+)\s*kb\/s/) || [])[1] || null;
      let duration = null;
      if (dur) duration = Math.round((Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])) * 100) / 100;
      resolve({ duration, codec, bitrate: bitrate ? Number(bitrate) : null });
    });
  });
}

function metaFrom(info) {
  info = info || {};
  const username = info.channel || info.uploader_id || '';
  const rawAuthor = String(info.uploader || info.creator || '').trim();
  const sameAsUser = username && rawAuthor.toLowerCase() === String(username).replace(/^@/, '').toLowerCase();
  const author = (!rawAuthor || sameAsUser || /\s/.test(rawAuthor)) ? rawAuthor : '';
  const track = info.track || '';
  const artist = info.artist || (Array.isArray(info.artists) ? info.artists.filter(Boolean).join(', ') : '') || '';
  const rawTitle = String(info.title || '').trim();
  const generic = !track && /^video by\s/i.test(rawTitle);
  let title = track || (!generic && rawTitle) || 'Original audio';
  const caption = String(info.description || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  return {
    title,
    author,
    username,
    artist,
    track,
    originalAudio: !track && !artist,
    thumbnail: info.thumbnail || '',
    caption,
  };
}

function tryExtract(reelUrl, id, extraArgs) {
  return new Promise((resolve, reject) => {
    const outTemplate = path.join(FILES_DIR, `${id}.%(ext)s`);
    const args = [
      '--ffmpeg-location', ffmpegPath,
      '--no-playlist',
      '--socket-timeout', '30',
      '--retries', '3',
      '--print-json',
    ].concat(extraArgs, ['-o', outTemplate, reelUrl]);

    const child = spawn(YTDLP, args);
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { errOut += d.toString(); });
    child.on('error', (e) => reject(new Error('spawn: ' + e.message)));
    child.on('close', (code) => {
      const files = fs.readdirSync(FILES_DIR).filter((f) => f.startsWith(id + '.') && AUDIO_EXT.test(f));
      if (code === 0 && files.length > 0) {
        let info = {};
        try { info = JSON.parse(out.trim().split('\n').pop()); } catch (e) { /* info optional */ }
        return resolve({ file: files[0], info });
      }
      console.error('[yt-dlp] attempt failed, code', code, errOut.slice(-300));
      reject(new Error('yt-dlp failed with code ' + code));
    });
  });
}

function cleanupPartial(id) {
  fs.readdirSync(FILES_DIR)
    .filter((f) => f.startsWith(id))
    .forEach((f) => fs.unlink(path.join(FILES_DIR, f), () => {}));
}

async function ensureFormats(srcFile, id) {
  const srcPath = path.join(FILES_DIR, srcFile);
  const ext = path.extname(srcFile).toLowerCase();
  const mp3Path = path.join(FILES_DIR, `${id}.mp3`);
  const m4aPath = path.join(FILES_DIR, `${id}.m4a`);
  const probe = await probeFile(srcPath);

  if (ext !== '.m4a' && !fs.existsSync(m4aPath)) {
    const canCopy = ext === '.mp4' || /aac|mp4a|alac/i.test(probe.codec);
    const args = canCopy
      ? ['-y', '-i', srcPath, '-vn', '-c:a', 'copy', m4aPath]
      : ['-y', '-i', srcPath, '-vn', '-c:a', 'aac', '-b:a', '192k', m4aPath];
    try {
      await runFfmpeg(args);
    } catch (e) {
      console.error('[m4a]', e.message);
      if (fs.existsSync(m4aPath)) fs.unlink(m4aPath, () => {});
    }
  }

  if (ext !== '.mp3' && !fs.existsSync(mp3Path)) {
    try {
      await runFfmpeg(['-y', '-i', srcPath, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', mp3Path]);
    } catch (e) {
      console.error('[mp3]', e.message);
      if (fs.existsSync(mp3Path)) fs.unlink(mp3Path, () => {});
    }
  }

  if (ext !== '.mp3' && ext !== '.m4a' && fs.existsSync(srcPath)) fs.unlink(srcPath, () => {});

  return {
    mp3: fs.existsSync(mp3Path) ? `${id}.mp3` : null,
    m4a: fs.existsSync(m4aPath) ? `${id}.m4a` : null,
  };
}

function fileSize(name) {
  if (!name) return null;
  try { return fs.statSync(path.join(FILES_DIR, name)).size; } catch (e) { return null; }
}

function publicFile(req, name) {
  return `${req.protocol}://${req.get('host')}/files/${name}`;
}

function cleanInstagramUrl(raw) {
  try {
    const url = new URL(raw);
    url.search = '';
    url.hash = '';
    if (url.hostname === 'instagr.am') url.hostname = 'www.instagram.com';
    return url.toString();
  } catch (e) {
    return raw;
  }
}

function plainText(value) {
  return String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// Instagram hides some reels from logged-out tools. Ask why before spending time on yt-dlp.
async function instagramBlockReason(reelUrl) {
  try {
    const endpoint = 'https://www.instagram.com/api/v1/oembed/?url=' + encodeURIComponent(reelUrl);
    const res = await fetch(endpoint, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'X-IG-App-ID': '936619743392459',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(12000),
    });
    const text = await res.text();
    if (/no media match/i.test(text)) {
      return 'Instagram could not find this reel. It may have been deleted, or the link is not a reel.';
    }
    let data;
    try { data = JSON.parse(text); } catch (e) { return null; }
    if (!data || data.status !== 'fail') return null;
    const title = plainText(data.title);
    const description = plainText(data.description);
    if (data.blocks_logging_data === 'MIN_AGE_ACCOUNT' || /under 18/i.test(title)) {
      return 'This reel cannot be downloaded. Instagram says this account limits who can see their content, including people under 18, so the audio is hidden.';
    }
    if (title) return description ? `${title}. ${description}` : title;
    return null;
  } catch (e) {
    return null;
  }
}

async function handleAudio(req, res) {
  const reelUrl = cleanInstagramUrl(getInputUrl(req));
  if (!isInstagramUrl(reelUrl)) {
    return res.status(400).json({ success: false, message: 'Please provide a valid Instagram URL.' });
  }
  if (!fs.existsSync(YTDLP)) {
    return res.status(500).json({ success: false, message: 'Audio engine not installed yet. Try again in a minute.' });
  }

  const blocked = await instagramBlockReason(reelUrl);
  if (blocked) {
    return res.status(400).json({ success: false, message: blocked });
  }

  const id = crypto.randomBytes(8).toString('hex');
  const attempts = [
    ['-x', '--audio-format', 'm4a', '--audio-quality', '0'],
    ['--impersonate', 'Chrome-136', '-x', '--audio-format', 'm4a', '--audio-quality', '0'],
    ['-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
  ];

  for (let i = 0; i < attempts.length; i++) {
    try {
      const { file, info } = await tryExtract(reelUrl, id, attempts[i]);
      const formats = await ensureFormats(file, id);
      if (!formats.mp3 && !formats.m4a) throw new Error('Could not encode MP3 or M4A');

      const playName = formats.mp3 || formats.m4a;
      const probed = await probeFile(path.join(FILES_DIR, playName));
      const meta = metaFrom(info);
      [formats.mp3, formats.m4a].filter(Boolean).forEach((name) => {
        setTimeout(() => fs.unlink(path.join(FILES_DIR, name), () => {}), FILE_TTL_MS);
      });

      const mp3Url = formats.mp3 ? publicFile(req, formats.mp3) : '';
      const m4aUrl = formats.m4a ? publicFile(req, formats.m4a) : '';
      return res.json({
        success: true,
        audioUrl: mp3Url || m4aUrl,
        downloadUrl: mp3Url || m4aUrl,
        mp3Url,
        m4aUrl,
        mp3Size: fileSize(formats.mp3),
        m4aSize: fileSize(formats.m4a),
        title: meta.title,
        author: meta.author,
        username: meta.username,
        artist: meta.artist,
        track: meta.track,
        originalAudio: meta.originalAudio,
        thumbnail: meta.thumbnail,
        caption: meta.caption,
        duration: probed.duration || info.duration || null,
        bitrate: probed.bitrate,
      });
    } catch (e) {
      console.error('[audio] attempt', i + 1, 'failed:', e.message);
      cleanupPartial(id);
    }
  }

  const reason = await instagramBlockReason(reelUrl);
  return res.status(500).json({
    success: false,
    message: reason || 'Could not extract audio from this link. It may be private, removed, age-limited, or Instagram is busy right now. Please try another public reel.',
  });
}
app.get('/api/audio', handleAudio);
app.post('/api/audio', handleAudio);

// ---- background cleanup: 30 min se purani MP3 files delete (har 10 min) ----
setInterval(() => {
  const now = Date.now();
  fs.readdirSync(FILES_DIR).forEach((f) => {
    if (f === '.gitkeep') return;
    const p = path.join(FILES_DIR, f);
    fs.stat(p, (e, st) => {
      if (!e && now - st.mtimeMs > FILE_TTL_MS) fs.unlink(p, () => {});
    });
  });
}, 10 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`reels-audio-service-v2 listening on port ${PORT}`);
  updateYtDlp();
});
