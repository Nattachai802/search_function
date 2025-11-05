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

  // แยก token ทั่วไป และจัดการกับ Stopwords/สัญลักษณ์
  const esc = (s) => s.replace(/([+\-()~*"<>@\\])/g, "\\$1"); // Escape special characters for FTS
  const tokens = q
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 32) // กันยาวเกิน
    .map((t) => {
      const isThai = /[\u0E00-\u0E7F]/.test(t);
      const hasSpecialChars = /[~*<>@|:.]/.test(t); // สัญลักษณ์ที่อาจทำให้ FTS มีปัญหา

      // 1. ถ้ามีสัญลักษณ์พิเศษ หรือเป็นคำที่อาจเป็น Stopword (สั้นกว่า 4 ตัว)
      //    ให้ค้นหาแบบ "วลี" เพื่อความแม่นยำ และไม่บังคับ (ไม่มี +)
      //    เช่น "RE:", "UTAC", "for"
      if (hasSpecialChars || (!isThai && t.length < 4)) {
        return `"${esc(t)}"`;
      }

      // 2. สำหรับคำไทยและอังกฤษที่ยาวพอสมควร ให้เป็นคำบังคับ (+) เพื่อให้ผลลัพธ์กระชับ
      if ((!isThai && t.length >= 4) || (isThai && t.length >= 2)) {
        return `+${esc(t)}`;
      }

      return ""; // ข้ามคำที่ไม่เข้าเงื่อนไข
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
        <h3 style="margin:0 0 4px;"><a href="/email/${r.id}" target="_blank">${r.subject || '(No Subject)'}</a></h3>
        <div><strong>ID:</strong> ${r.id}</div>
        <div><strong>Score:</strong> ${(r.score ?? 0).toFixed(4)}</div>
        <p style="margin:4px 0;">${(r.bodyPreview || "").slice(0, 200)}... 
          <a href="/email/${r.id}" target="_blank" style="margin-left:8px;">ดูเนื้อหาเต็ม</a>
        </p>
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
  // สำหรับ Two-Phase Search: จำกัดจำนวน ID ที่จะนำมา re-rank ใน Phase 2
  // เพื่อความสมดุลระหว่างความแม่นยำและประสิทธิภาพ


  if (!q.trim()) {
    // ไม่มีคำค้น → ส่งหน้าฟอร์มปกติ
    return res.redirect("/search.html");
  }

  console.log(`Search q=${q} (page ${page})`);

  // ใช้ booleanQ สำหรับ Phase 1 และ q (raw query) สำหรับ Phase 2
  const { booleanQ, tokens, phrases } = analyzeQuery(q);
  const naturalQ = q; // ใช้ query ดิบสำหรับ Natural Language Mode scoring

  console.log({ booleanQ, tokens, phrases });

  try {
    const conn = await pool.getConnection();
    try {
      // --- Phase 1: Candidate Retrieval ---
      // ค้นหา ID ของเอกสารที่เกี่ยวข้องทั้งหมดอย่างรวดเร็วด้วย Boolean Mode
      // และจำกัดจำนวนเพื่อนำไป re-rank ใน Phase 2
      const sqlRelevantIds = `
        SELECT id
        FROM emailmessage
        WHERE MATCH(subject,bodyPreview, bodyHtml, bodyText) AGAINST(? IN BOOLEAN MODE)
        `;

      const [idRows] = await conn.execute(sqlRelevantIds, [booleanQ]);

      const total = idRows.length;
      let rows = [];

      if (total > 0) {
        // ดึง ID ทั้งหมดออกมาเป็น Array
        const relevantIds = idRows.map(r => r.id);

        // --- Phase 2: Re-ranking ---
        // นำ ID ที่ได้มาค้นหาและจัดอันดับคะแนนใหม่ด้วย Natural Language Mode
        // ซึ่งให้คะแนนความเกี่ยวข้องที่ดีกว่า
        // หมายเหตุ: บางเวอร์ชันของ MySQL/MariaDB ไม่รองรับ placeholder ใน LIMIT/OFFSET
        // จึงประกอบเป็น literal หลังจากตรวจสอบว่าเป็นจำนวนเต็มที่ปลอดภัยแล้ว
        const limitNum = Number.isFinite(perPage) ? Math.max(1, Math.floor(perPage)) : 20;
        const offsetNum = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;

        // สร้าง placeholder '?,?,?...' ตามจำนวน ID ที่ได้มา
        const placeholders = relevantIds.map(() => '?').join(',');
        const sqlPage = `
          SELECT id, subject, bodyPreview,
                 MATCH(subject, bodyPreview, bodyHtml, bodyText) AGAINST(? IN NATURAL LANGUAGE MODE) AS score
         FROM emailmessage
          WHERE id IN (${placeholders})
          ORDER BY score DESC, id DESC
          LIMIT ${limitNum} OFFSET ${offsetNum}`;
        
        // พารามิเตอร์ตัวแรกคือ naturalQ สำหรับ AGAINST(), ที่เหลือคือ ID ทั้งหมด
        const params = [naturalQ, ...relevantIds];
        [rows] = await conn.execute(sqlPage, params);
      }

      const html = renderResultsPage({
        q,
        items: rows,
        total, // total คือจำนวนที่พบใน Phase 1
        page,
        perPage,
        ms: Date.now() - t0,
        debug: req.query.debug === "1" ? { raw: q, tokens, phrases, booleanQ, naturalQ } : null,
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
        `SELECT subject, bodyHtml, bodyText 
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
