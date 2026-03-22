/**
 * Infinite Animations — Worker Server
 * ─────────────────────────────────────
 * Deploy on Render (free) or any Node.js host
 * Handles: Video Assembly (FFmpeg) + YouTube Upload
 *
 * Endpoints:
 *   GET  /health               → status check
 *   POST /assemble             → start video assembly job
 *   GET  /status/:idea_id      → check job status + get video paths
 *   POST /youtube-upload       → upload video to YouTube
 */

const express    = require('express');
const { exec }   = require('child_process');
const fs         = require('fs');
const fsp        = require('fs').promises;
const path       = require('path');
const { google } = require('googleapis');

const app  = express();
const PORT = process.env.PORT || 8080;

// ── Middleware ─────────────────────────────────────────────────────────
app.use(express.json({ limit: '100mb' }));

// ── In-memory job store ────────────────────────────────────────────────
const JOBS = new Map();

// ── Helper: download a URL and return base64 string (Node 18+ fetch) ───
async function urlToBase64(url) {
  if (!url) return null;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    return buf.toString('base64');
  } catch (e) {
    throw new Error(`urlToBase64 failed for ${url}: ${e.message}`);
  }
}

// ── Auth middleware ────────────────────────────────────────────────────
function auth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== process.env.SESSION_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:    'ok',
    timestamp: new Date().toISOString(),
    jobs:      JOBS.size
  });
});

// ─────────────────────────────────────────────────────────────────────
// POST /assemble
// Body: { idea_id, short_audio_b64, long_audio_b64, image_b64,
//         topic_category, short_script, long_script,
//         short_title, long_title }
// ─────────────────────────────────────────────────────────────────────
app.post('/assemble', auth, async (req, res) => {
  const {
    idea_id,
    // Accept base64 strings OR remote URLs — server downloads URLs automatically
    short_audio_b64, short_audio_url,
    long_audio_b64,  long_audio_url,
    image_b64,       image_url,
    topic_category, short_script, long_script,
    short_title, long_title
  } = req.body;

  if (!idea_id) {
    return res.status(400).json({ error: 'idea_id is required' });
  }

  // Respond immediately — assembly runs in background
  res.json({ status: 'accepted', idea_id, message: 'Assembly started' });

  JOBS.set(String(idea_id), { status: 'processing', started_at: Date.now() });

  try {
    const workDir = path.join('/tmp', String(idea_id));
    await fsp.mkdir(workDir, { recursive: true });

    // ── Resolve base64 from inline data OR remote URL ───────────────
    console.log(`[${idea_id}] Resolving assets...`);
    const resolvedShortAudio = short_audio_b64 || await urlToBase64(short_audio_url);
    const resolvedLongAudio  = long_audio_b64  || await urlToBase64(long_audio_url);
    const resolvedImage      = image_b64       || await urlToBase64(image_url);

    // ── Save audio + image files ────────────────────────────────────
    if (resolvedShortAudio) {
      await fsp.writeFile(
        path.join(workDir, 'short_audio.wav'),
        Buffer.from(resolvedShortAudio, 'base64')
      );
    }
    if (resolvedLongAudio) {
      await fsp.writeFile(
        path.join(workDir, 'long_audio.wav'),
        Buffer.from(resolvedLongAudio, 'base64')
      );
    }
    if (resolvedImage) {
      await fsp.writeFile(
        path.join(workDir, 'thumbnail.jpg'),
        Buffer.from(resolvedImage, 'base64')
      );
    }

    // ── Get audio durations ─────────────────────────────────────────
    const shortDuration = await getAudioDuration(path.join(workDir, 'short_audio.wav')).catch(() => 55);
    const longDuration  = await getAudioDuration(path.join(workDir, 'long_audio.wav')).catch(() => 210);

    console.log(`[${idea_id}] Short: ${shortDuration}s | Long: ${longDuration}s`);

    // ── Generate SRT subtitles ──────────────────────────────────────
    await generateSRT(short_script || '', shortDuration, path.join(workDir, 'short_subs.srt'));
    await generateSRT(long_script  || '', longDuration,  path.join(workDir, 'long_subs.srt'));

    // ── Assemble SHORT video (1080×1920 vertical for Shorts) ────────
    const shortOut = path.join(workDir, 'short_video.mp4');
    await runFFmpeg(buildFFmpegCmd({
      image:    path.join(workDir, 'thumbnail.jpg'),
      audio:    path.join(workDir, 'short_audio.wav'),
      subs:     path.join(workDir, 'short_subs.srt'),
      output:   shortOut,
      duration: shortDuration,
      format:   'short',
      category: topic_category || 'Science'
    }));
    console.log(`[${idea_id}] Short video assembled`);

    // ── Assemble LONG video (1920×1080 landscape) ───────────────────
    const longOut = path.join(workDir, 'long_video.mp4');
    await runFFmpeg(buildFFmpegCmd({
      image:    path.join(workDir, 'thumbnail.jpg'),
      audio:    path.join(workDir, 'long_audio.wav'),
      subs:     path.join(workDir, 'long_subs.srt'),
      output:   longOut,
      duration: longDuration,
      format:   'long',
      category: topic_category || 'Science'
    }));
    console.log(`[${idea_id}] Long video assembled`);

    JOBS.set(String(idea_id), {
      status:          'ready',
      short_video_path: shortOut,
      long_video_path:  longOut,
      thumbnail_path:   path.join(workDir, 'thumbnail.jpg'),
      short_title:      short_title || '',
      long_title:       long_title  || '',
      completed_at:     Date.now()
    });

    console.log(`[${idea_id}] ✅ Assembly complete`);

  } catch (err) {
    console.error(`[${idea_id}] ❌ Assembly failed:`, err.message);
    JOBS.set(String(idea_id), { status: 'failed', error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /status/:idea_id
// ─────────────────────────────────────────────────────────────────────
app.get('/status/:idea_id', auth, (req, res) => {
  const job = JOBS.get(String(req.params.idea_id));
  if (!job) return res.status(404).json({ error: 'Job not found', idea_id: req.params.idea_id });
  res.json(job);
});

// ─────────────────────────────────────────────────────────────────────
// POST /youtube-upload
// Body: { idea_id, title, description, tags, category_id,
//         privacy_status, is_short, thumbnail_prompt }
// ─────────────────────────────────────────────────────────────────────
app.post('/youtube-upload', auth, async (req, res) => {
  const {
    idea_id, title, description, tags,
    category_id, privacy_status, is_short
  } = req.body;

  try {
    const job = JOBS.get(String(idea_id));
    if (!job)               return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'ready') return res.status(400).json({ error: 'Video not ready. Status: ' + job.status });

    const videoPath     = is_short ? job.short_video_path : job.long_video_path;
    const thumbnailPath = job.thumbnail_path;

    if (!fs.existsSync(videoPath)) {
      return res.status(400).json({ error: 'Video file missing: ' + videoPath });
    }

    const youtubeUrl = await uploadToYouTube({
      videoPath,
      thumbnailPath,
      title:         (title || '').substring(0, 100),
      description:   (description || '').substring(0, 5000),
      tags:          Array.isArray(tags) ? tags : (tags ? String(tags).split(',').map(t => t.trim()) : []),
      categoryId:    category_id   || '23',
      privacyStatus: privacy_status || 'public'
    });

    console.log(`[${idea_id}] Uploaded ${is_short ? 'Short' : 'Long'}: ${youtubeUrl}`);
    res.json({
      youtube_url: youtubeUrl,
      idea_id,
      type: is_short ? 'short' : 'long'
    });

  } catch (err) {
    console.error(`[${idea_id}] Upload failed:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Helper: Build FFmpeg command
// ─────────────────────────────────────────────────────────────────────
function buildFFmpegCmd({ image, audio, subs, output, duration, format, category }) {
  const isShort = format === 'short';
  const w = isShort ? 1080 : 1920;
  const h = isShort ? 1920 : 1080;
  const fps    = 25;
  const frames = Math.ceil(duration * fps);

  // Ken Burns zoom effect
  const zoom = `zoompan=z='min(zoom+0.0008,1.4)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${fps}`;

  // Color grade per category
  const grades = {
    Horror:  'eq=saturation=0.6:brightness=-0.05:contrast=1.2',
    Comedy:  'eq=saturation=1.4:brightness=0.05:contrast=1.1',
    Science: 'eq=saturation=1.0:brightness=0.0:contrast=1.05',
    ASMR:    'eq=saturation=0.85:brightness=-0.02:contrast=0.95',
    Weird:   'eq=saturation=1.3:brightness=0.0:contrast=1.15'
  };
  const grade = grades[category] || grades.Science;

  // Subtitle style
  const subStyle = isShort
    ? 'FontSize=26,FontName=Arial,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Bold=1,Outline=2,Shadow=1,Alignment=2,MarginV=140'
    : 'FontSize=20,FontName=Arial,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Bold=1,Outline=2,Shadow=1,Alignment=2,MarginV=60';

  // Escape subs path for FFmpeg
  const escapedSubs = subs.replace(/\\/g, '/').replace(/:/g, '\\:');

  return [
    'ffmpeg -y',
    `-loop 1 -i "${image}"`,
    `-i "${audio}"`,
    `-filter_complex "[0:v]${zoom},${grade},format=yuv420p[v];[v]subtitles='${escapedSubs}':force_style='${subStyle}'[vout]"`,
    `-map "[vout]" -map 1:a`,
    `-c:v libx264 -preset fast -crf 23`,
    `-c:a aac -b:a 128k`,
    `-t ${duration}`,
    `-r ${fps}`,
    `-shortest`,
    `"${output}"`
  ].join(' ');
}

// ─────────────────────────────────────────────────────────────────────
// Helper: Run FFmpeg command
// ─────────────────────────────────────────────────────────────────────
function runFFmpeg(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 200 }, (err, stdout, stderr) => {
      if (err) {
        console.error('FFmpeg error:', stderr.substring(0, 500));
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// Helper: Get audio duration via ffprobe
// ─────────────────────────────────────────────────────────────────────
function getAudioDuration(file) {
  return new Promise((resolve, reject) => {
    exec(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`,
      (err, stdout) => {
        if (err) reject(err);
        else resolve(parseFloat(stdout.trim()) || 60);
      }
    );
  });
}

// ─────────────────────────────────────────────────────────────────────
// Helper: Generate SRT subtitles from script text
// ─────────────────────────────────────────────────────────────────────
async function generateSRT(script, totalDuration, outputPath) {
  if (!script || script.length < 3) {
    await fsp.writeFile(outputPath, '');
    return;
  }

  const words        = script.split(' ').filter(Boolean);
  const wordsPerLine = 6;
  const lines        = [];

  for (let i = 0; i < words.length; i += wordsPerLine) {
    lines.push(words.slice(i, i + wordsPerLine).join(' '));
  }

  const lineDuration = totalDuration / lines.length;
  let srt = '';

  lines.forEach((line, i) => {
    const start = i * lineDuration;
    const end   = (i + 1) * lineDuration;
    srt += `${i + 1}\n${toSRTTime(start)} --> ${toSRTTime(end)}\n${line}\n\n`;
  });

  await fsp.writeFile(outputPath, srt, 'utf8');
}

function toSRTTime(sec) {
  const h  = Math.floor(sec / 3600);
  const m  = Math.floor((sec % 3600) / 60);
  const s  = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function pad(n, len = 2) {
  return String(n).padStart(len, '0');
}

// ─────────────────────────────────────────────────────────────────────
// Helper: Upload video to YouTube
// ─────────────────────────────────────────────────────────────────────
async function uploadToYouTube({ videoPath, thumbnailPath, title, description, tags, categoryId, privacyStatus }) {
  const auth = new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET
  );

  auth.setCredentials({
    refresh_token: process.env.YOUTUBE_REFRESH_TOKEN
  });

  const youtube   = google.youtube({ version: 'v3', auth });
  const videoStat = await fsp.stat(videoPath);

  console.log(`Uploading "${title}" (${(videoStat.size / 1024 / 1024).toFixed(1)} MB)...`);

  const uploadRes = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title:           title.substring(0, 100),
        description:     description.substring(0, 5000),
        tags:            tags.slice(0, 500),
        categoryId,
        defaultLanguage: 'en'
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: false
      }
    },
    media: {
      body: fs.createReadStream(videoPath)
    }
  });

  const videoId  = uploadRes.data.id;
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Upload thumbnail (non-critical — won't fail the upload if it errors)
  if (thumbnailPath && fs.existsSync(thumbnailPath)) {
    try {
      await youtube.thumbnails.set({
        videoId,
        media: { mimeType: 'image/jpeg', body: fs.createReadStream(thumbnailPath) }
      });
      console.log(`Thumbnail set for ${videoId}`);
    } catch (err) {
      console.warn('Thumbnail upload failed (non-critical):', err.message);
    }
  }

  return videoUrl;
}

// ─────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Infinite Animations Worker running on port ${PORT}`);
  console.log(`📋 Endpoints: GET /health | POST /assemble | GET /status/:id | POST /youtube-upload`);
  console.log(`🔑 Auth: x-api-key header required`);
});

module.exports = app;
