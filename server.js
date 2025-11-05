import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mysql from "mysql2/promise";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
const PORT = process.env.PORT || 3000;

// เสิร์ฟไฟล์ static (search.html) จากโฟลเดอร์ demo
app.use(express.static(__dirname));

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  connectionLimit: 8,
});

// --- helper: วิเคราะห์ query และสร้าง boolean query + tokens ---
function analyzeQuery(raw) {
  if (!raw) return { booleanQ: "", tokens: [], phrases: [], raw: raw || "" };
  // เก็บวลีที่ครอบด้วย "..." ก่อน
  const phrases = [];
  let q = raw.normalize("NFC").replace(/[–—]/g, "-").trim();
  q = q.replace(/[“”"]([^“”"]+)[“”"]/g, (_, m) => {
  phrases.push(`+"${m}"`);
  return " ";
});

  // แยก token ทั่วไป
  const esc = (s) => s.replace(/([+\-()~*"<>@\\])/g, "\\$1");
  const tokens = q
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 32) // กันยาวเกิน
    .map((t) => {
      const isThai = /[\u0E00-\u0E7F]/.test(t);
      console.log({ t: t.length, isThai });
      const hasSymbol = /[-+./#]/.test(t);
      if (hasSymbol) return `+"${t}"`; // คำมีสัญลักษณ์ → วลีบังคับ
      if (!isThai && t.length >= 3) return `+${esc(t)}`; // อังกฤษ ≥3 → บังคับ + prefix
      if (isThai && t.length >= 3) return `+${esc(t)}`; // ไทย ≥4 → บังคับ + prefix
      return ""; // ข้ามคำสั้น
    })
    .filter(Boolean);

  const finalQ = [...tokens, ...phrases].join(" ").trim();
  return { booleanQ: finalQ || raw, tokens, phrases, raw };
}

// simple HTML renderer ของผลลัพธ์
function renderResultsPage({ q, items, total, page, perPage, ms, debug }) {
  const rows = items
    .map(
      (r) => `<article style="padding:12px 0;border-bottom:1px solid #eee">
        <div><strong>ID:</strong> ${r.id}</div>
        <div><strong>Score:</strong> ${r.score ?? 0}</div>
        <p>${(r.bodyPreview || "").slice(0, 200)}... 
          <a href="/email/${r.id}" target="_blank" style="margin-left:8px;">ดูเนื้อหาเต็ม</a></p>
      </article>`
    )
    .join("");

  const nav = `<div style="margin-top:12px">
      <a href="/search?q=${encodeURIComponent(q)}&page=${Math.max(page - 1, 1)}">&laquo; Prev</a>
      &nbsp; Page ${page} &nbsp;
      <a href="/search?q=${encodeURIComponent(q)}&page=${page + 1}">Next &raquo;</a>
    </div>`;

  const debugBlock = debug
    ? `<details style="margin:16px 0" open>
         <summary style="cursor:pointer">Debug Query</summary>
         <pre style="white-space:pre-wrap;background:#fafafa;border:1px solid #eee;padding:8px">` +
        `raw: ${String(debug.raw || "")}\n` +
        `tokens: ${JSON.stringify(debug.tokens || [])}\n` +
        `phrases: ${JSON.stringify(debug.phrases || [])}\n` +
        `booleanQ: ${String(debug.booleanQ || "")}` +
        `</pre>
       </details>`
    : "";

  return `<!doctype html><meta charset="utf-8">
  <title>ผลค้นหา</title>
  <body style="font-family:system-ui;margin:40px;max-width:900px">
    <form action="/search" method="GET" style="display:flex;gap:8px">
      <input type="text" name="q" value="${q ? String(q).replace(/"/g, "&quot;") : ""}" style="flex:1;padding:10px 12px;font-size:16px" />
      ${debug ? '<input type="hidden" name="debug" value="1" />' : ''}
      <button>ค้นหา</button>
    </form>
    ${debugBlock}
    <p style="color:#555;margin:12px 0">พบ ${total} รายการ • ${ms} ms</p>
    ${rows || "<p>ไม่พบผลลัพธ์</p>"}
    ${rows ? nav : ""}
  </body>`;
}

// เส้นทางหลัก: /search?q=...
app.get("/search", async (req, res) => {
  const t0 = Date.now();
  const q = (req.query.q || "").toString();
  const page = Math.max(parseInt(req.query.page || "1", 10), 1);
  const perPage = 20;
  const offset = (page - 1) * perPage;

  if (!q.trim()) {
    // ไม่มีคำค้น → ส่งหน้าฟอร์มปกติ
    return res.redirect("/search.html");
  }

  console.log(`Search q=${q} (page ${page})`);

  const { booleanQ, tokens, phrases } = analyzeQuery(q);

  console.log({ booleanQ, tokens, phrases });

  try {
    const conn = await pool.getConnection();
    try {
      // นับจำนวนทั้งหมด
      const [cntRows] = await conn.execute(
        `SELECT COUNT(*) AS c
         FROM emailmessage
         WHERE MATCH(bodyPreview, bodyHtml, bodyText) AGAINST(? IN BOOLEAN MODE)`,
        [booleanQ]
      );
      const total = Number(cntRows?.[0]?.c || 0);

      // ดึงผลลัพธ์หน้าเดียว พร้อมคะแนน
      // หมายเหตุ: บางเวอร์ชันของ MySQL/MariaDB ไม่รองรับ placeholder ใน LIMIT/OFFSET
      // จึงประกอบเป็น literal หลังจากตรวจสอบว่าเป็นจำนวนเต็มที่ปลอดภัยแล้ว
      const limitNum = Number.isFinite(perPage) ? Math.max(1, Math.floor(perPage)) : 20;
      const offsetNum = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;

      const sqlPage = `
        SELECT id, bodyPreview,
               MATCH(bodyPreview, bodyHtml, bodyText) AGAINST(? IN BOOLEAN MODE) AS score
        FROM emailmessage
        WHERE MATCH(bodyPreview, bodyHtml, bodyText) AGAINST(? IN BOOLEAN MODE)
        ORDER BY score DESC, id DESC
        LIMIT ${limitNum} OFFSET ${offsetNum}`;

      const [rows] = await conn.execute(sqlPage, [booleanQ, booleanQ]);

      const html = renderResultsPage({
        q,
        items: rows,
        total,
        page,
        perPage,
        ms: Date.now() - t0,
        debug: req.query.debug === "1" ? { raw: q, tokens, phrases, booleanQ } : null,
      });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(html);
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .send(
        `<pre style="white-space:pre-wrap">เกิดข้อผิดพลาด\n${String(
          err.message || err
        )}</pre>`
      );
  }
});

// --- เส้นทางสำหรับดูอีเมลฉบับเต็ม ---
app.get("/email/:id", async (req, res) => {
  const id = req.params.id; // รับ ID มาเป็น string โดยตรง
  console.log(`Get email id=${id}`);
  if (!id) { // ตรวจสอบแค่ว่ามี ID ส่งมาหรือไม่
    return res.status(400).send("Invalid ID format");
  }

  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.execute(
        `SELECT bodyHtml, bodyText 
         FROM emailmessage 
         WHERE id = ?`,
        [id]
      );

      if (rows.length === 0) {
        return res.status(404).send("Email not found");
      }

      const email = rows[0];
      // ถ้ามี bodyHtml ให้แสดงผลเป็น HTML, ถ้าไม่มีให้แสดง bodyText เป็นข้อความธรรมดา
      const content = email.bodyHtml || `<pre>${email.bodyText || ""}</pre>`;

      const html = `<!doctype html>
        <meta charset="utf-8">
        <title>Email ID: ${email.id}</title>
        <body style="font-family:sans-serif;padding:20px;">
          <h1>Subject: ${email.subject || "(No Subject)"}</h1>
          <p><strong>From:</strong> ${email.fromAddress || "(Unknown Sender)"}</p>
          <hr>
          ${content}
        </body>`;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).send("Error retrieving email from database.");
  }
});

app.listen(PORT, () =>
  console.log(`Server running at http://localhost:${PORT}/search.html`)
);
