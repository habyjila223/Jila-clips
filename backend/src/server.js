import express from "express";
import multer from "multer";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, unlink } from "node:fs/promises";

const app = express();
const PORT = process.env.PORT || 4000;

await mkdir("uploads", { recursive: true });
await mkdir("outputs", { recursive: true });

app.use(express.json());

const jobs = new Map();

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = [
      "video/mp4",
      "video/quicktime",
      "video/webm",
      "video/x-matroska"
    ];
    cb(null, allowed.includes(file.mimetype));
  }
});

function execute(command, args) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args);
    let errors = "";

    process.stderr.on("data", data => {
      errors += data.toString();
    });

    process.on("error", reject);

    process.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(errors.slice(-2000)));
    });
  });
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "JILA CLIPS",
    version: "0.2.0"
  });
});

app.post("/api/youtube/validate", (req, res) => {
  try {
    const url = new URL(req.body.url);
    const valid = [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "youtu.be"
    ].includes(url.hostname);

    res.json({
      valid,
      message: valid
        ? "Link recognized. Upload an authorized video file to edit it."
        : "Invalid YouTube link."
    });
  } catch {
    res.status(400).json({ valid: false });
  }
});

app.post("/api/jobs/upload", (req, res, next) => {
  if (req.get("X-Rights-Confirmed") !== "true") {
    return res.status(400).json({
      error: "Confirm you own this video or have permission to edit it."
    });
  }
  next();
}, upload.single("video"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Please upload a video." });
  }

  try {
    await execute(ffprobe.path, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      req.file.path
    ]);

    const id = randomUUID();

    jobs.set(id, {
      id,
      input: req.file.path,
      status: "uploaded"
    });

    res.status(201).json({
      id,
      status: "uploaded",
      message: "Video received successfully."
    });
  } catch {
    await unlink(req.file.path).catch(() => {});
    res.status(400).json({ error: "Could not read this video." });
  }
});

app.post("/api/jobs/:id/clip", async (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({ error: "Video job not found." });
  }

  const start = Number(req.body.startSeconds ?? 0);
  const duration = Number(req.body.durationSeconds ?? 15);
  const ratio = req.body.ratio || "9:16";

  const formats = {
    "9:16": [1080, 1920],
    "16:9": [1920, 1080],
    "1:1": [1080, 1080],
    "4:5": [1080, 1350]
  };

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(duration) ||
    start < 0 ||
    duration < 1 ||
    duration > 60 ||
    !formats[ratio]
  ) {
    return res.status(400).json({
      error: "Invalid clipping settings."
    });
  }

  const [width, height] = formats[ratio];
  const output = path.join("outputs", `${job.id}.mp4`);

  try {
    job.status = "processing";

    await execute(ffmpeg, [
      "-y",
      "-ss", String(start),
      "-i", job.input,
      "-t", String(duration),
      "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-c:a", "aac",
      "-movflags", "+faststart",
      output
    ]);

    job.status = "completed";
    job.output = output;

    res.json({
      id: job.id,
      status: "completed",
      download: `/api/jobs/${job.id}/download`,
      format: ratio
    });
  } catch {
    job.status = "failed";
    res.status(500).json({
      error: "Video processing failed."
    });
  }
});

app.get("/api/jobs/:id/download", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job || job.status !== "completed") {
    return res.status(404).json({ error: "Clip not ready." });
  }

  res.download(job.output);
});

app.listen(PORT, () => {
  console.log(`JILA CLIPS server running on port ${PORT}`);
});
