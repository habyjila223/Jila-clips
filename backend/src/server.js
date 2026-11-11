
import express from "express";
import multer from "multer";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, unlink, writeFile } from "node:fs/promises";

const app = express();
const PORT = process.env.PORT || 4000;

await mkdir("uploads", { recursive: true });
await mkdir("outputs", { recursive: true });

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "https://habyjila223.github.io");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Rights-Confirmed");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

const jobs = new Map();
let isProcessing = false;

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowed = [
      "video/mp4",
      "video/quicktime",
      "video/webm",
      "video/x-matroska"
    ];

    cb(
      allowed.includes(file.mimetype)
        ? null
        : new Error("Unsupported video format."),
      allowed.includes(file.mimetype)
    );
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

function srtTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000);

  return (
    String(hours).padStart(2, "0") + ":" +
    String(minutes).padStart(2, "0") + ":" +
    String(secs).padStart(2, "0") + "," +
    String(ms).padStart(3, "0")
  );
}

const fontOptions = {
  arial: "Arial",
  dejavu: "DejaVu Sans",
  liberation: "Liberation Sans",
  serif: "DejaVu Serif"
};

const colorOptions = {
  white: "&H00FFFFFF",
  yellow: "&H0000FFFF",
  red: "&H000000FF",
  blue: "&H00FF0000",
  green: "&H0000FF00"
};

const sizeOptions = {
  small: 20,
  medium: 28,
  large: 38
};

const positionOptions = {
  top: 8,
  middle: 5,
  bottom: 2
};

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "JILA CLIPS",
    version: "0.5.0"
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
    res.status(400).json({
      valid: false,
      message: "Invalid URL."
    });
  }
});

app.post(
  "/api/jobs/upload",
  (req, res, next) => {
    if (req.get("X-Rights-Confirmed") !== "true") {
      return res.status(400).json({
        error: "Confirm you own this video or have permission to edit it."
      });
    }
    next();
  },
  upload.single("video"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({
        error: "Please upload a video."
      });
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

      res.status(400).json({
        error: "Could not read this video."
      });
    }
  }
);

app.post("/api/jobs/:id/clip", async (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      error: "Video job not found."
    });
  }

  const start = Number(req.body.startSeconds ?? 0);
  const duration = Number(req.body.durationSeconds ?? 15);
  const ratio = req.body.ratio || "9:16";
  const captionText = String(req.body.captionText || "").trim();

  const font = fontOptions[req.body.captionFont] || fontOptions.arial;
  const color = colorOptions[req.body.captionColor] || colorOptions.white;
  const fontSize = sizeOptions[req.body.captionSize] || sizeOptions.medium;
  const alignment = positionOptions[req.body.captionPosition] || positionOptions.bottom;

  const formats = {
    "9:16": [720, 1280],
    "16:9": [1280, 720],
    "1:1": [720, 720],
    "4:5": [720, 900]
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

  if (captionText.length > 2000) {
    return res.status(400).json({
      error: "Captions must be 2,000 characters or fewer."
    });
  }

  if (isProcessing) {
    return res.status(409).json({
      error: "Another video is processing. Please try again shortly."
    });
  }

  const [width, height] = formats[ratio];
  const output = path.join("outputs", `${job.id}.mp4`);
  const captionFile = path.resolve("uploads", `${job.id}.srt`);

  isProcessing = true;
  job.status = "processing";

  try {
    const filters = [
      `scale=${width}:${height}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}`
    ];

    if (captionText) {
      const subtitleContent =
        "1\n" +
        "00:00:00,000 --> " + srtTime(duration) + "\n" +
        captionText.replace(/\r/g, "") + "\n";

      await writeFile(captionFile, subtitleContent, "utf8");

      const style = [
        `FontName=${font}`,
        `FontSize=${fontSize}`,
        `PrimaryColour=${color}`,
        "OutlineColour=&H00000000",
        "BorderStyle=1",
        "Outline=2",
        "Shadow=1",
        `Alignment=${alignment}`,
        "MarginV=45"
      ].join(",");

      filters.push(
        `subtitles=filename='${captionFile}':force_style='${style}'`
      );
    }

    await execute(ffmpeg, [
      "-y",
      "-threads", "1",
      "-ss", String(start),
      "-i", job.input,
      "-t", String(duration),
      "-vf", filters.join(","),
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "28",
      "-threads", "1",
      "-c:a", "aac",
      "-b:a", "96k",
      "-movflags", "+faststart",
      output
    ]);

    job.status = "completed";
    job.output = output;

    res.json({
      id: job.id,
      status: "completed",
      download: `/api/jobs/${job.id}/download`,
      format: ratio,
      captionsBurnedIn: Boolean(captionText),
      captionStyle: {
        font,
        color,
        fontSize,
        alignment
      }
    });

  } catch (error) {
    console.error("Video processing failed:", error.message);

    job.status = "failed";

    res.status(500).json({
      error: "Video processing failed. Please check subtitle support."
    });

  } finally {
    await unlink(captionFile).catch(() => {});
    isProcessing = false;
  }
});

app.get("/api/jobs/:id/download", (req, res) => {
  const job = jobs.get(req.params.id);

  if (!job || job.status !== "completed") {
    return res.status(404).json({
      error: "Clip not ready."
    });
  }

  res.download(job.output);
});

app.use((error, req, res, next) => {
  console.error(error.message);

  res.status(400).json({
    error: error.message || "Something went wrong."
  });
});

app.listen(PORT, () => {
  console.log(`JILA CLIPS server running on port ${PORT}`);
});
