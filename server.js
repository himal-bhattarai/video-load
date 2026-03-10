const express = require("express");
const { exec, spawn } = require("child_process");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;
app.set("trust proxy", 1); // Required for Render/proxied deployments (fixes rate-limit error)

// ─── yt-dlp binary path ───────────────────────────────────────────────────────
// Search common install locations in order
const YTDLP_CANDIDATES = [
  process.env.YTDLP_PATH,          // explicit override
  "/usr/local/bin/yt-dlp",         // pip install (Linux)
  "/usr/bin/yt-dlp",               // apt install (Linux)
  "/home/render/.local/bin/yt-dlp",// pip --user (Render)
  "/opt/render/project/src/yt-dlp",// curl to project dir
  "yt-dlp",                        // PATH fallback (Windows local)
].filter(Boolean);

const YTDLP = YTDLP_CANDIDATES.find((p) => {
  try { return p === "yt-dlp" || fs.existsSync(p); } catch { return false; }
}) || "yt-dlp";

// ─── Temp dir ─────────────────────────────────────────────────────────────────
const TEMP_DIR = path.join(os.tmpdir(), "video-downloader");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Too many requests. Please wait a minute." },
});
app.use("/api/", limiter);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isValidUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch { return false; }
}

/** Normalize and clean YouTube URLs — strips tracking params, handles all formats */
function normalizeUrl(raw) {
  try {
    const u = new URL(raw);

    // youtu.be/VIDEO_ID?si=... → clean youtube.com watch URL
    if (u.hostname === "youtu.be") {
      const videoId = u.pathname.slice(1).split("/")[0];
      return `https://www.youtube.com/watch?v=${videoId}`;
    }

    // youtube.com/watch?v=ID&si=...&pp=... → strip tracking params
    if (u.hostname === "www.youtube.com" || u.hostname === "youtube.com") {
      const videoId = u.searchParams.get("v");
      if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;

      // youtube.com/shorts/VIDEO_ID
      if (u.pathname.startsWith("/shorts/")) {
        const shortId = u.pathname.split("/shorts/")[1].split("/")[0];
        return `https://www.youtube.com/watch?v=${shortId}`;
      }
    }

    return raw;
  } catch { return raw; }
}

function ytDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP, args);
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", (err) => reject(new Error(`yt-dlp spawn failed: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
    });
  });
}

function cleanupFile(filePath) { fs.unlink(filePath, () => {}); }

function sanitizeFilename(name) {
  return name.replace(/[^\w\s\-\.]/g, "_").replace(/\s+/g, " ").trim().slice(0, 150);
}

function formatBytes(bytes) {
  if (!bytes) return null;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Job store ────────────────────────────────────────────────────────────────
// job = { status: 'pending'|'downloading'|'done'|'error',
//         percent, speed, filePath, filename, error, proc }
const jobs = new Map();

// Clean up finished jobs after 10 minutes
function scheduleCleanup(jobId) {
  setTimeout(() => {
    const job = jobs.get(jobId);
    if (job) {
      if (job.filePath) cleanupFile(job.filePath);
      jobs.delete(jobId);
    }
  }, 10 * 60 * 1000);
}

// ─── Speed flags ──────────────────────────────────────────────────────────────
const SPEED_FLAGS = [
  "--concurrent-fragments", "4",
  "--retries", "5",
  "--no-part",
  "--no-warnings",
  "--no-playlist",
  "--newline",   // ← makes progress output line-by-line for parsing
];

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/health
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// POST /api/info — fetch video metadata + quality list
app.post("/api/info", async (req, res) => {
  let { url } = req.body;
  if (!url || !isValidUrl(url))
    return res.status(400).json({ error: "A valid http/https URL is required." });

  url = normalizeUrl(url);

  try {
    const raw = await ytDlp(["--dump-json", "--no-playlist", "--no-warnings", url]);
    const info = JSON.parse(raw);

    const seenHeights = new Set();
    const qualities = [];

    const videoFormats = (info.formats || [])
      .filter((f) => f.vcodec && f.vcodec !== "none" && f.height)
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    for (const f of videoFormats) {
      const h = f.height;
      if (seenHeights.has(h)) continue;
      seenHeights.add(h);
      qualities.push({
        label: `${h}p${f.fps && f.fps > 30 ? ` ${Math.round(f.fps)}fps` : ""}`,
        height: h,
        formatId: `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/best[height<=${h}]`,
        ext: "mp4",
        filesize: formatBytes(f.filesize || f.filesize_approx),
        type: "video",
      });
    }

    qualities.push({ label: "Audio only (MP3)", height: null, formatId: null, ext: "mp3", filesize: null, type: "audio" });

    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      uploader: info.uploader,
      uploadDate: info.upload_date,
      viewCount: info.view_count,
      qualities,
    });
  } catch (err) {
    console.error("[/api/info] URL:", url);
    console.error("[/api/info] Error:", err.message);
    res.status(500).json({ error: "Failed to fetch video info.", detail: err.message });
  }
});

/**
 * POST /api/start
 * Body: { url, formatId, audioOnly, title }
 *
 * Starts a background yt-dlp job immediately and returns { jobId }.
 * The frontend then connects to /api/progress/:jobId (SSE) for live updates,
 * and fetches /api/file/:jobId once done. Browser never hangs.
 */
app.post("/api/start", (req, res) => {
  let { url, formatId, audioOnly, title } = req.body;

  if (!url || !isValidUrl(url))
    return res.status(400).json({ error: "A valid http/https URL is required." });

  url = normalizeUrl(url);
  const isAudio = audioOnly === true || audioOnly === "true";
  const jobId = uuidv4();
  const ext = isAudio ? "mp3" : "mp4";
  const safeTitle = title ? sanitizeFilename(title) : jobId;
  const outputPath = path.join(TEMP_DIR, `${jobId}.${ext}`);

  const args = [...SPEED_FLAGS, "-o", outputPath];

  if (isAudio) {
    args.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
  } else if (formatId) {
    args.push("-f", formatId, "--merge-output-format", "mp4");
  } else {
    args.push("-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best", "--merge-output-format", "mp4");
  }
  args.push(url);

  const job = {
    status: "downloading",
    percent: 0,
    speed: "",
    eta: "",
    filePath: outputPath,
    filename: `${safeTitle}.${ext}`,
    error: null,
    proc: null,
    sseClients: [],   // SSE clients listening for this job
  };
  jobs.set(jobId, job);

  console.log(`[${jobId}] Starting: "${safeTitle}"`);

  const proc = spawn(YTDLP, args);
  job.proc = proc;

  // Handle spawn errors (e.g. yt-dlp binary not found)
  proc.on("error", (err) => {
    job.status = "error";
    job.error  = `yt-dlp could not start: ${err.message}`;
    console.error(`[${jobId}] spawn error:`, err.message);
    broadcastJob(jobId, { error: job.error });
    scheduleCleanup(jobId);
    for (const client of job.sseClients) { try { client.end(); } catch {} }
    job.sseClients = [];
  });

  // Parse progress lines from both stdout AND stderr
  // yt-dlp sends progress to stderr locally but stdout on some Linux envs
  const progressRegex = /(\d+\.?\d*)%\s+of\s+[\d.]+\S+\s+at\s+([\d.]+\S+\/s)(?:\s+ETA\s+(\S+))?/;

  function parseProgress(data) {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      const m = line.match(progressRegex);
      if (m) {
        job.percent = parseFloat(m[1]);
        job.speed   = m[2] || "";
        job.eta     = m[3] || "";
        broadcastJob(jobId, { percent: job.percent, speed: job.speed, eta: job.eta });
      }
    }
  }

  proc.stdout.on("data", parseProgress);
  proc.stderr.on("data", parseProgress);

  proc.on("close", (code) => {
    if (code === 0) {
      // Find actual output file (yt-dlp may tweak extension)
      const base = path.basename(outputPath, `.${ext}`);
      const files = fs.readdirSync(TEMP_DIR).filter((f) => f.startsWith(base));
      const actualFile = files.length ? path.join(TEMP_DIR, files[0]) : outputPath;
      const actualExt  = path.extname(actualFile).slice(1) || ext;

      job.status   = "done";
      job.filePath = actualFile;
      job.filename = `${safeTitle}.${actualExt}`;
      job.percent  = 100;

      console.log(`[${jobId}] ✅ Done: ${job.filename}`);
      broadcastJob(jobId, { percent: 100, done: true });
      scheduleCleanup(jobId);
    } else {
      job.status = "error";
      job.error  = "Download failed. The video may be unavailable or unsupported.";
      console.error(`[${jobId}] ❌ Failed`);
      broadcastJob(jobId, { error: job.error });
      scheduleCleanup(jobId);
    }
    // Close all SSE connections for this job
    for (const client of job.sseClients) { try { client.end(); } catch {} }
    job.sseClients = [];
  });

  // Return jobId immediately — frontend doesn't wait
  res.json({ jobId });
});

/** Send SSE event to all clients watching a job */
function broadcastJob(jobId, data) {
  const job = jobs.get(jobId);
  if (!job) return;
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of job.sseClients) {
    try { client.write(msg); } catch {}
  }
}

/**
 * GET /api/progress/:jobId  — Server-Sent Events
 * Frontend connects here to receive live percent/speed/done/error events.
 */
app.get("/api/progress/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);

  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  if (!job) {
    res.write(`data: ${JSON.stringify({ error: "Job not found." })}\n\n`);
    return res.end();
  }

  // If already done/error, send final event immediately
  if (job.status === "done") {
    res.write(`data: ${JSON.stringify({ percent: 100, done: true })}\n\n`);
    return res.end();
  }
  if (job.status === "error") {
    res.write(`data: ${JSON.stringify({ error: job.error })}\n\n`);
    return res.end();
  }

  // Otherwise register as a live listener
  job.sseClients.push(res);

  // Send current progress immediately on connect
  res.write(`data: ${JSON.stringify({ percent: job.percent, speed: job.speed, eta: job.eta })}\n\n`);

  req.on("close", () => {
    if (job.sseClients) {
      job.sseClients = job.sseClients.filter((c) => c !== res);
    }
  });
});

/**
 * GET /api/file/:jobId  — serve the finished file
 * Called by the frontend once SSE reports done:true.
 */
app.get("/api/file/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job)             return res.status(404).json({ error: "Job not found." });
  if (job.status !== "done") return res.status(400).json({ error: "File not ready yet." });
  if (!fs.existsSync(job.filePath)) return res.status(404).json({ error: "File missing." });

  const stat = fs.statSync(job.filePath);
  const encodedName = encodeURIComponent(job.filename);
  const isAudio = job.filename.endsWith(".mp3");

  res.setHeader("Content-Disposition", `attachment; filename="${job.filename}"; filename*=UTF-8''${encodedName}`);
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Content-Type", isAudio ? "audio/mpeg" : "video/mp4");

  const stream = fs.createReadStream(job.filePath);
  stream.pipe(res);
  stream.on("close", () => {
    console.log(`[${req.params.jobId}] 📦 Delivered: ${job.filename}`);
    cleanupFile(job.filePath);
    job.status = "delivered";
  });
});

// GET /api/formats/presets
app.get("/api/formats/presets", (req, res) => {
  res.json([
    { label: "Best Quality", formatId: "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best", ext: "mp4", type: "video" },
    { label: "1080p", formatId: "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]", ext: "mp4", type: "video" },
    { label: "720p",  formatId: "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]",   ext: "mp4", type: "video" },
    { label: "480p",  formatId: "bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]",   ext: "mp4", type: "video" },
    { label: "360p",  formatId: "bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360]",   ext: "mp4", type: "video" },
    { label: "Audio (MP3)", formatId: null, ext: "mp3", type: "audio" },
  ]);
});

// ─── 404 & error ──────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: "Route not found." }));
app.use((err, req, res, next) => {
  console.error("[Unhandled]", err);
  res.status(500).json({ error: "Internal server error." });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown() {
  console.log("Shutting down…");
  for (const [, job] of jobs) {
    try { job.proc && job.proc.kill("SIGTERM"); } catch {}
    if (job.filePath) cleanupFile(job.filePath);
  }
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  Video Downloader API → http://localhost:${PORT}`);
  console.log(`   Temp dir: ${TEMP_DIR}`);
  console.log(`   Resolved YTDLP: ${YTDLP}`);

  // Check if file exists at resolved path
  const exists = YTDLP !== "yt-dlp" ? fs.existsSync(YTDLP) : "unknown (PATH)";
  console.log(`   Binary exists: ${exists}`);

  const check = spawn(YTDLP, ["--version"]);
  let version = "";
  check.stdout.on("data", (d) => (version += d));
  check.on("close", (code) => {
    if (code === 0) console.log(`   yt-dlp version: ${version.trim()} ✅`);
    else console.warn(`⚠️  yt-dlp not working at: ${YTDLP}`);
  });
  check.on("error", (err) => {
    console.warn(`⚠️  yt-dlp spawn error: ${err.message}`);
    console.warn(`   Searched paths: ${YTDLP_CANDIDATES.join(", ")}`);
  });
});