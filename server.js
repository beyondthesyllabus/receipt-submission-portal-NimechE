"use strict";

const express = require("express");
const multer = require("multer");
let Database;
try {
  Database = require("better-sqlite3");
} catch {
  const { DatabaseSync } = require("node:sqlite");
  Database = class NodeSqliteAdapter {
    constructor(file) {
      this._db = new DatabaseSync(file);
    }
    pragma(str) {
      try {
        this._db.exec(`PRAGMA ${str}`);
      } catch (e) {}
    }
    exec(sql) {
      return this._db.exec(sql);
    }
    prepare(sql) {
      const stmt = this._db.prepare(sql);
      return {
        get: (...args) => stmt.get(...args),
        all: (...args) => stmt.all(...args),
        run: (...args) => stmt.run(...args),
      };
    }
    transaction(fn) {
      return (...args) => {
        this._db.exec("BEGIN IMMEDIATE");
        try {
          const res = fn(...args);
          this._db.exec("COMMIT");
          return res;
        } catch (e) {
          this._db.exec("ROLLBACK");
          throw e;
        }
      };
    }
  };
}
const sharp = require("sharp");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const DATA_DIR =
  process.env.DATA_DIR ||
  (process.env.VERCEL ? "/tmp" : path.join(__dirname, "data"));
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Mech001";
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  crypto.createHash("sha256").update("receipt-portal:" + ADMIN_PASSWORD).digest("hex");
const SITE_TITLE = process.env.SITE_TITLE || "Payment Receipts Register";

const MAX_FILE_MB = 10;
const MAX_FILES_PER_SUBMISSION = 5;
const SESSION_HOURS = 8;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (ADMIN_PASSWORD === "Mech001") {
  console.warn(
    "\n  NOTE: Using default ADMIN_PASSWORD 'Mech001'. Set ADMIN_PASSWORD='your-password' to override.\n"
  );
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const db = new Database(path.join(DATA_DIR, "portal.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    reg_number  TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS receipts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    file          TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('image','pdf')),
    original_name TEXT,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_receipts_student ON receipts(student_id);
`);

const q = {
  studentByReg: db.prepare("SELECT * FROM students WHERE reg_number = ?"),
  insertStudent: db.prepare("INSERT INTO students (name, reg_number, created_at) VALUES (?, ?, ?)"),
  insertReceipt: db.prepare(
    "INSERT INTO receipts (student_id, file, kind, original_name, created_at) VALUES (?, ?, ?, ?, ?)"
  ),
  listStudents: db.prepare(`
    SELECT s.id, s.name, s.reg_number, s.created_at,
           (SELECT COUNT(*) FROM receipts r WHERE r.student_id = s.id) AS receipt_count
    FROM students s ORDER BY s.created_at ASC, s.id ASC`),
  studentById: db.prepare("SELECT * FROM students WHERE id = ?"),
  receiptsForStudent: db.prepare("SELECT * FROM receipts WHERE student_id = ? ORDER BY id ASC"),
  receiptById: db.prepare("SELECT * FROM receipts WHERE id = ?"),
  deleteReceipt: db.prepare("DELETE FROM receipts WHERE id = ?"),
  deleteStudent: db.prepare("DELETE FROM students WHERE id = ?"),
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}

function makeToken() {
  const exp = String(Date.now() + SESSION_HOURS * 3600 * 1000);
  return `${exp}.${sign(exp)}`;
}

function tokenValid(token) {
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig) return false;
  const expected = sign(exp);
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Number(exp) > Date.now();
}

function requireAdmin(req, res, next) {
  if (tokenValid(parseCookies(req).admin)) return next();
  res.status(401).json({ error: "Please sign in." });
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Tiny in-memory rate limiter (per IP).
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    const rec = hits.get(req.ip);
    if (!rec || rec.reset < now) {
      hits.set(req.ip, { count: 1, reset: now + windowMs });
      return next();
    }
    rec.count++;
    if (rec.count > max) return res.status(429).json({ error: message });
    next();
  };
}

function isoNow() {
  return new Date().toISOString();
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString("en-GB", {
    timeZone: "Africa/Lagos",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function fmtDateTime(iso) {
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Africa/Lagos",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  if (!req.path.startsWith("/api/")) {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
        "font-src https://fonts.gstatic.com; img-src 'self' data: blob:; frame-ancestors 'none'"
    );
  }
  next();
});

app.use(express.json({ limit: "20kb" }));

// ---------------------------------------------------------------------------
// Student submission
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_FILES_PER_SUBMISSION },
});

const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: "Too many submissions from this network. Please try again later.",
});

function isPdf(buf) {
  return buf.length > 4 && buf.slice(0, 5).toString("latin1") === "%PDF-";
}

async function processUpload(file) {
  // Returns { buffer, kind, ext }
  if (isPdf(file.buffer)) {
    const err = new Error(
      `"${file.originalname}" is a PDF file. Please upload a clear photo (JPG, PNG or WEBP) of your receipt.`
    );
    err.status = 400;
    throw err;
  }
  try {
    const buffer = await sharp(file.buffer, { failOn: "error" })
      .rotate() // respect phone camera orientation
      .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 88 })
      .toBuffer();
    return { buffer, kind: "image", ext: ".jpg" };
  } catch (e) {
    const err = new Error(
      `"${file.originalname}" is not a supported photo. Upload a clear JPG, PNG or WEBP image.`
    );
    err.status = 400;
    throw err;
  }
}

app.post(
  "/api/submit",
  submitLimiter,
  (req, res, next) => {
    upload.array("receipts", MAX_FILES_PER_SUBMISSION)(req, res, (err) => {
      if (!err) return next();
      let msg = "Upload failed. Please try again.";
      if (err.code === "LIMIT_FILE_SIZE") msg = `Each file must be ${MAX_FILE_MB} MB or smaller.`;
      if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE")
        msg = `You can upload at most ${MAX_FILES_PER_SUBMISSION} files at a time.`;
      res.status(400).json({ error: msg });
    });
  },
  async (req, res) => {
    const written = [];
    try {
      const name = String(req.body.name || "").replace(/\s+/g, " ").trim();
      const reg = String(req.body.regNumber || "").replace(/\s+/g, "").toUpperCase();

      if (name.length < 3 || name.length > 100)
        return res.status(400).json({ error: "Enter your full name (3 to 100 characters)." });
      if (!/^[A-Z0-9/\-_.]{3,30}$/.test(reg))
        return res.status(400).json({
          error: "Enter a valid registration number (letters, numbers, / - _ . only).",
        });

      try {
        if (!reg.includes("ME")) {
          const err = new Error("Registration number must belong to Mechanical Engineering (must contain 'ME', e.g. 22/EG/ME/001).");
          err.status = 400;
          throw err;
        }
      } catch (valErr) {
        return res.status(valErr.status || 400).json({ error: valErr.message });
      }

      if (!req.files || req.files.length === 0)
        return res.status(400).json({ error: "Attach at least one receipt." });

      // Convert/validate every file first so a bad file rejects the whole submission.
      const processed = [];
      for (const f of req.files) processed.push({ ...(await processUpload(f)), original: f.originalname });

      for (const p of processed) {
        p.filename = crypto.randomBytes(16).toString("hex") + p.ext;
        fs.writeFileSync(path.join(UPLOAD_DIR, p.filename), p.buffer);
        written.push(p.filename);
      }

      const now = isoNow();
      const tx = db.transaction(() => {
        let student = q.studentByReg.get(reg);
        if (!student) {
          const info = q.insertStudent.run(name, reg, now);
          student = { id: info.lastInsertRowid, name, reg_number: reg };
        }
        for (const p of processed) {
          q.insertReceipt.run(student.id, p.filename, p.kind, String(p.original).slice(0, 200), now);
        }
        return student;
      });
      const student = tx();

      res.json({ ok: true, name: student.name, regNumber: student.reg_number, count: processed.length });
    } catch (e) {
      written.forEach((f) => fs.rmSync(path.join(UPLOAD_DIR, f), { force: true }));
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error(e);
      res.status(500).json({ error: "Something went wrong on our side. Please try again." });
    }
  }
);

// ---------------------------------------------------------------------------
// Admin auth
// ---------------------------------------------------------------------------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many attempts. Try again in 15 minutes.",
});

app.post("/api/admin/login", loginLimiter, (req, res) => {
  if (!safeEqual(req.body && req.body.password, ADMIN_PASSWORD))
    return res.status(401).json({ error: "Wrong password." });
  const secure = req.secure ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `admin=${encodeURIComponent(makeToken())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${
      SESSION_HOURS * 3600
    }${secure}`
  );
  res.json({ ok: true });
});

app.post("/api/admin/logout", (req, res) => {
  res.setHeader("Set-Cookie", "admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/admin/me", (req, res) => {
  res.json({ signedIn: tokenValid(parseCookies(req).admin), title: SITE_TITLE });
});

// ---------------------------------------------------------------------------
// Admin data
// ---------------------------------------------------------------------------
app.get("/api/admin/students", requireAdmin, (req, res) => {
  const students = q.listStudents.all().map((s) => ({
    ...s,
    receipts: q.receiptsForStudent.all(s.id).map((r) => ({
      id: r.id,
      kind: r.kind,
      original_name: r.original_name,
      created_at: r.created_at,
    })),
  }));
  res.json({ students });
});

app.get("/api/admin/receipts/:id/file", requireAdmin, (req, res) => {
  const r = q.receiptById.get(Number(req.params.id));
  if (!r) return res.status(404).end();
  const full = path.join(UPLOAD_DIR, path.basename(r.file));
  if (!fs.existsSync(full)) return res.status(404).end();
  res.setHeader("Content-Type", r.kind === "pdf" ? "application/pdf" : "image/jpeg");
  res.setHeader("Cache-Control", "private, max-age=3600");
  fs.createReadStream(full).pipe(res);
});

function removeFiles(receipts) {
  receipts.forEach((r) => fs.rmSync(path.join(UPLOAD_DIR, path.basename(r.file)), { force: true }));
}

app.delete("/api/admin/receipts/:id", requireAdmin, (req, res) => {
  const r = q.receiptById.get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: "Not found" });
  q.deleteReceipt.run(r.id);
  removeFiles([r]);
  res.json({ ok: true });
});

app.delete("/api/admin/students/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const s = q.studentById.get(id);
  if (!s) return res.status(404).json({ error: "Not found" });
  const receipts = q.receiptsForStudent.all(id);
  q.deleteStudent.run(id);
  removeFiles(receipts);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// PDF export
// ---------------------------------------------------------------------------
const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 40;
const INK = rgb(0.08, 0.13, 0.24);
const MUTED = rgb(0.42, 0.46, 0.53);
const LINE = rgb(0.82, 0.85, 0.89);
const SHADE = rgb(0.955, 0.963, 0.976);

// Names like "Onwu" with dot-below vowels need a Unicode font. We bundle DejaVu Sans;
// if the font files are missing we fall back to Helvetica and strip unsupported characters.
const FONT_REGULAR = path.join(__dirname, "fonts", "DejaVuSans.ttf");
const FONT_BOLD = path.join(__dirname, "fonts", "DejaVuSans-Bold.ttf");
let unicodeFonts = fs.existsSync(FONT_REGULAR) && fs.existsSync(FONT_BOLD);

function pdfSafe(text) {
  const t = String(text).replace(/[\u0000-\u001F\u007F]/g, " ");
  if (unicodeFonts) return t;
  return t
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

function fit(text, font, size, maxWidth) {
  let t = pdfSafe(text);
  if (font.widthOfTextAtSize(t, size) <= maxWidth) return t;
  while (t.length > 1 && font.widthOfTextAtSize(t + "...", size) > maxWidth) t = t.slice(0, -1);
  return t + "...";
}

async function buildPdf(students, { includeReceipts }) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(SITE_TITLE);
  let font;
  let bold;
  if (unicodeFonts) {
    try {
      pdf.registerFontkit(fontkit);
      font = await pdf.embedFont(fs.readFileSync(FONT_REGULAR), { subset: true });
      bold = await pdf.embedFont(fs.readFileSync(FONT_BOLD), { subset: true });
    } catch (e) {
      console.warn("Could not load bundled fonts, using Helvetica:", e.message);
      unicodeFonts = false;
    }
  }
  if (!unicodeFonts) {
    font = await pdf.embedFont(StandardFonts.Helvetica);
    bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  }

  // ---- Register table ------------------------------------------------------
  const cols = [
    { label: "S/N", w: 34, x: 0 },
    { label: "Full name", w: 205, x: 0 },
    { label: "Reg. number", w: 125, x: 0 },
    { label: "Receipts", w: 55, x: 0 },
    { label: "Submitted", w: 96, x: 0 },
  ];
  let cx = MARGIN;
  cols.forEach((c) => {
    c.x = cx;
    cx += c.w;
  });
  const tableW = cx - MARGIN;
  const ROW_H = 24;
  const BOTTOM = 60;

  let page;
  let y;
  let sn = 0;

  const startTablePage = (first) => {
    page = pdf.addPage([A4.w, A4.h]);
    y = A4.h - MARGIN;
    if (first) {
      page.drawText(pdfSafe(SITE_TITLE), { x: MARGIN, y: y - 16, size: 18, font: bold, color: INK });
      y -= 26;
      page.drawText(
        `${students.length} ${students.length === 1 ? "student" : "students"}  |  Generated ${fmtDateTime(
          isoNow()
        )}`,
        { x: MARGIN, y: y - 12, size: 9.5, font, color: MUTED }
      );
      y -= 34;
    }
    // header row
    page.drawRectangle({ x: MARGIN, y: y - ROW_H, width: tableW, height: ROW_H, color: INK });
    cols.forEach((c) =>
      page.drawText(c.label, { x: c.x + 8, y: y - 16, size: 9.5, font: bold, color: rgb(1, 1, 1) })
    );
    y -= ROW_H;
  };

  startTablePage(true);
  if (students.length === 0) {
    page.drawText("No submissions yet.", { x: MARGIN + 8, y: y - 20, size: 10.5, font, color: MUTED });
  }
  students.forEach((s, i) => {
    if (y - ROW_H < BOTTOM) startTablePage(false);
    sn++;
    if (i % 2 === 1)
      page.drawRectangle({ x: MARGIN, y: y - ROW_H, width: tableW, height: ROW_H, color: SHADE });
    const cells = [
      String(sn),
      fit(s.name, font, 10, cols[1].w - 14),
      fit(s.reg_number, font, 10, cols[2].w - 14),
      String(s.receipts.length),
      fmtDate(s.created_at),
    ];
    cells.forEach((t, k) => page.drawText(t, { x: cols[k].x + 8, y: y - 16, size: 10, font, color: INK }));
    page.drawLine({
      start: { x: MARGIN, y: y - ROW_H },
      end: { x: MARGIN + tableW, y: y - ROW_H },
      thickness: 0.5,
      color: LINE,
    });
    y -= ROW_H;
  });

  // ---- Receipt pages (Grid Layout: 4 cards per A4 page) -------------------
  if (includeReceipts) {
    const items = [];
    for (const s of students) {
      const total = s.receipts.length;
      for (let i = 0; i < total; i++) {
        items.push({ student: s, receipt: s.receipts[i], index: i + 1, total });
      }
    }

    const CARDS_PER_PAGE = 4;
    const colW = (A4.w - MARGIN * 2 - 14) / 2;
    const cardH = (A4.h - MARGIN * 2 - 20 - 40) / 2;

    const getCardBounds = (slotIndex) => {
      const col = slotIndex % 2;
      const row = Math.floor(slotIndex / 2);
      const x = MARGIN + col * (colW + 14);
      const yTop = A4.h - MARGIN - 20 - row * (cardH + 16);
      return { x, yTop, width: colW, height: cardH };
    };

    let currentPage = null;
    let slotOnPage = 0;

    for (const item of items) {
      if (!currentPage || slotOnPage >= CARDS_PER_PAGE) {
        currentPage = pdf.addPage([A4.w, A4.h]);
        slotOnPage = 0;
      }

      const bounds = getCardBounds(slotOnPage);
      slotOnPage++;

      const s = item.student;
      const r = item.receipt;
      const label = `Receipt ${item.index} of ${item.total}`;

      // Card Container Box
      currentPage.drawRectangle({
        x: bounds.x,
        y: bounds.yTop - bounds.height,
        width: bounds.width,
        height: bounds.height,
        color: rgb(1, 1, 1),
        borderColor: LINE,
        borderWidth: 0.8,
      });

      // Card Header Strip
      const headerH = 46;
      currentPage.drawRectangle({
        x: bounds.x,
        y: bounds.yTop - headerH,
        width: bounds.width,
        height: headerH,
        color: SHADE,
        borderColor: LINE,
        borderWidth: 0.6,
      });

      // Left Accent Strip
      currentPage.drawRectangle({
        x: bounds.x,
        y: bounds.yTop - headerH,
        width: 4,
        height: headerH,
        color: INK,
      });

      // Text inside Card Header
      currentPage.drawText(pdfSafe(`REG: ${s.reg_number}`), {
        x: bounds.x + 10,
        y: bounds.yTop - 16,
        size: 10.5,
        font: bold,
        color: INK,
      });

      currentPage.drawText(pdfSafe(fit(s.name, font, 9.5, bounds.width - 20)), {
        x: bounds.x + 10,
        y: bounds.yTop - 30,
        size: 9.5,
        font: font,
        color: INK,
      });

      currentPage.drawText(pdfSafe(`${label}  •  ${fmtDate(s.created_at)}`), {
        x: bounds.x + 10,
        y: bounds.yTop - 42,
        size: 8,
        font: font,
        color: MUTED,
      });

      // Photo Frame Box
      const pad = 6;
      const imgBoxX = bounds.x + pad;
      const imgBoxYTop = bounds.yTop - headerH - pad;
      const imgBoxW = bounds.width - pad * 2;
      const imgBoxH = bounds.height - headerH - pad * 2;

      const filePath = path.join(UPLOAD_DIR, path.basename(r.file));
      try {
        const bytes = fs.readFileSync(filePath);
        if (r.kind === "pdf") {
          const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
          const embedded = await pdf.embedPdf(src, src.getPageIndices());
          if (embedded.length > 0) {
            const scale = Math.min(imgBoxW / embedded[0].width, imgBoxH / embedded[0].height);
            const dw = embedded[0].width * scale;
            const dh = embedded[0].height * scale;
            const dx = imgBoxX + (imgBoxW - dw) / 2;
            const dy = imgBoxYTop - imgBoxH + (imgBoxH - dh) / 2;
            currentPage.drawPage(embedded[0], { x: dx, y: dy, width: dw, height: dh });
          }
        } else {
          const img = await pdf.embedJpg(bytes);
          const scale = Math.min(imgBoxW / img.width, imgBoxH / img.height);
          const dw = img.width * scale;
          const dh = img.height * scale;
          const dx = imgBoxX + (imgBoxW - dw) / 2;
          const dy = imgBoxYTop - imgBoxH + (imgBoxH - dh) / 2;
          currentPage.drawImage(img, { x: dx, y: dy, width: dw, height: dh });
        }
      } catch (e) {
        currentPage.drawText("Could not load photo.", {
          x: imgBoxX + 10,
          y: imgBoxYTop - 30,
          size: 10,
          font,
          color: MUTED,
        });
      }
    }
  }

  // ---- Footer on every page ------------------------------------------------
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    const t = `Page ${i + 1} of ${pages.length}`;
    const w = font.widthOfTextAtSize(t, 8.5);
    p.drawText(t, { x: A4.w - MARGIN - w, y: 28, size: 8.5, font, color: MUTED });
    p.drawText(pdfSafe(SITE_TITLE), { x: MARGIN, y: 28, size: 8.5, font, color: MUTED });
  });

  return Buffer.from(await pdf.save());
}

function loadStudentsWithReceipts(idsParam) {
  let rows = q.listStudents.all();
  if (idsParam) {
    const wanted = new Set(
      String(idsParam)
        .split(",")
        .map(Number)
        .filter((n) => Number.isInteger(n))
    );
    rows = rows.filter((s) => wanted.has(s.id));
  }
  return rows.map((s) => ({ ...s, receipts: q.receiptsForStudent.all(s.id) }));
}

function sendPdf(req, res, buffer, filename) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `${req.query.download === "1" ? "attachment" : "inline"}; filename="${filename}"`
  );
  res.setHeader("Cache-Control", "no-store");
  res.end(buffer);
}

const today = () => new Date().toISOString().slice(0, 10);

// Full document: register table followed by every receipt (optionally only chosen students)
app.get("/api/admin/export.pdf", requireAdmin, async (req, res) => {
  try {
    const students = loadStudentsWithReceipts(req.query.ids);
    let filename = `receipts-${today()}.pdf`;
    if (students.length === 1) {
      const s = students[0];
      const safeReg = String(s.reg_number).replace(/[^a-zA-Z0-9_-]/g, "_");
      const safeName = String(s.name).replace(/[^a-zA-Z0-9_-]/g, "_");
      filename = `Receipt_${safeReg}_${safeName}.pdf`;
    }
    sendPdf(req, res, await buildPdf(students, { includeReceipts: true }), filename);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not build the PDF." });
  }
});

// Register table only
app.get("/api/admin/table.pdf", requireAdmin, async (req, res) => {
  try {
    const students = loadStudentsWithReceipts(req.query.ids);
    sendPdf(req, res, await buildPdf(students, { includeReceipts: false }), `register-${today()}.pdf`);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Could not build the PDF." });
  }
});

app.get("/api/admin/export.csv", requireAdmin, (req, res) => {
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [["S/N", "Full name", "Reg number", "Receipts", "Submitted"].map(esc).join(",")];
  q.listStudents.all().forEach((s, i) =>
    rows.push([i + 1, s.name, s.reg_number, s.receipt_count, fmtDateTime(s.created_at)].map(esc).join(","))
  );
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="register-${today()}.csv"`);
  res.end("\uFEFF" + rows.join("\r\n"));
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Receipt portal running:  http://localhost:${PORT}`);
    console.log(`Admin page:              http://localhost:${PORT}/admin`);
  });
}

module.exports = app;
