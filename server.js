const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const multer = require("multer");
const mime = require("mime-types");
const mm = require("music-metadata");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const LIBRARY_DIR = path.join(ROOT_DIR, "library");
const COVERS_DIR = path.join(ROOT_DIR, "covers");
const USER_MUSIC_DIR = path.join(os.homedir(), "Music");
const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".flac",
  ".webm"
]);

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "track";
}

function safeFileName(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

async function ensureDirectories() {
  await fsp.mkdir(LIBRARY_DIR, { recursive: true });
  await fsp.mkdir(COVERS_DIR, { recursive: true });
}

async function walkAudioFiles(dir) {
  try {
    await fsp.access(dir, fs.constants.R_OK);
  } catch {
    return [];
  }

  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkAudioFiles(fullPath));
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (AUDIO_EXTENSIONS.has(ext)) files.push(fullPath);
  }

  return files;
}

async function extractCover(metadata, trackId) {
  const picture = metadata.common.picture?.[0];
  if (!picture?.data?.length) return "";

  const extension = mime.extension(picture.format || "image/jpeg") || "jpg";
  const coverName = `${trackId}.${extension}`;
  const coverPath = path.join(COVERS_DIR, coverName);
  await fsp.writeFile(coverPath, picture.data);
  return `/covers/${coverName}`;
}

function fallbackTitle(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

async function buildTrackFromFile(filePath) {
  const sourceRoot = path.normalize(filePath).startsWith(path.normalize(USER_MUSIC_DIR))
    ? USER_MUSIC_DIR
    : LIBRARY_DIR;
  const relativePath = path.relative(sourceRoot, filePath).replaceAll("\\", "/");
  const stats = await fsp.stat(filePath);
  const metadata = await mm.parseFile(filePath, { duration: true }).catch(() => null);
  const artist = metadata?.common.artist || "Unknown Artist";
  const title = metadata?.common.title || fallbackTitle(filePath);
  const album = metadata?.common.album || "Local Library";
  const trackId = slugify(`${artist}-${title}-${relativePath}`);
  const artwork = metadata ? await extractCover(metadata, trackId) : "";

  return {
    id: trackId,
    title,
    artist,
    album,
    genre: metadata?.common.genre?.[0] || "Local Audio",
    durationSeconds: Number(metadata?.format.duration || 0),
    durationLabel: formatTime(metadata?.format.duration || 0),
    artwork,
    src: `/media/${sourceRoot === USER_MUSIC_DIR ? "user-music" : "project-library"}/${encodeURIComponent(relativePath).replace(/%2F/g, "/")}`,
    externalUrl: "",
    fileName: path.basename(filePath),
    relativePath,
    sourceRoot: sourceRoot === USER_MUSIC_DIR ? "user-music" : "project-library",
    sizeBytes: stats.size
  };
}

function formatTime(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const min = Math.floor(safe / 60);
  const sec = safe % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

async function getLibraryTracks() {
  await ensureDirectories();
  const scanRoots = [LIBRARY_DIR, USER_MUSIC_DIR];
  const seenPaths = new Set();
  const audioFiles = [];

  for (const root of scanRoots) {
    const files = await walkAudioFiles(root);
    for (const file of files) {
      const normalized = path.normalize(file);
      if (seenPaths.has(normalized)) continue;
      seenPaths.add(normalized);
      audioFiles.push(file);
    }
  }

  const tracks = [];

  for (const filePath of audioFiles) {
    tracks.push(await buildTrackFromFile(filePath));
  }

  tracks.sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
  return tracks;
}

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try {
      await ensureDirectories();
      cb(null, LIBRARY_DIR);
    } catch (error) {
      cb(error);
    }
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const base = path.basename(file.originalname || "track", ext);
    cb(null, `${Date.now()}-${safeFileName(base)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 250 * 1024 * 1024 }
});

app.use(express.json());
app.use("/covers", express.static(COVERS_DIR, { maxAge: "1d" }));
app.use(express.static(ROOT_DIR));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/tracks", async (_req, res) => {
  try {
    const tracks = await getLibraryTracks();
    res.json({
      tracks,
      scanRoots: [LIBRARY_DIR, USER_MUSIC_DIR]
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Gagal membaca library audio." });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const query = String(req.query.q || "");
    const normalizedQuery = normalizeSearchText(query);
    const tracks = await getLibraryTracks();

    const filtered = !normalizedQuery
      ? tracks
      : tracks.filter((track) => {
        const haystack = normalizeSearchText([
          track.title,
          track.artist,
          track.album,
          track.genre,
          track.fileName,
          track.relativePath
        ].join(" "));
        return haystack.includes(normalizedQuery);
      });

    res.json({
      tracks: filtered,
      totalTracks: tracks.length,
      query,
      scanRoots: [LIBRARY_DIR, USER_MUSIC_DIR]
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Gagal mencari lagu di library audio." });
  }
});

app.get("/media/:sourceRoot/*", async (req, res) => {
  try {
    const sourceRoot = req.params.sourceRoot;
    const relativePart = req.params[0] || "";
    const baseDir = sourceRoot === "user-music" ? USER_MUSIC_DIR : LIBRARY_DIR;
    const targetPath = path.resolve(baseDir, relativePart);

    if (!targetPath.startsWith(path.resolve(baseDir))) {
      return res.status(403).json({ error: "Akses file ditolak." });
    }

    await fsp.access(targetPath, fs.constants.R_OK);
    res.sendFile(targetPath);
  } catch (error) {
    res.status(404).json({ error: "File audio tidak ditemukan." });
  }
});

app.post("/api/upload", upload.array("audioFiles", 20), async (req, res) => {
  try {
    const files = req.files || [];
    const invalid = files.filter((file) => !AUDIO_EXTENSIONS.has(path.extname(file.originalname).toLowerCase()));

    for (const file of invalid) {
      await fsp.unlink(file.path).catch(() => { });
    }

    if (!files.length || invalid.length === files.length) {
      return res.status(400).json({ error: "Tidak ada file audio valid yang diunggah." });
    }

    const tracks = await getLibraryTracks();
    res.status(201).json({
      message: `${files.length - invalid.length} file audio berhasil diunggah.`,
      tracks
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Upload gagal." });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, "index.html"));
});

ensureDirectories()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`NeonWave local server running at http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Gagal menyiapkan folder library:", error);
    process.exit(1);
  });
