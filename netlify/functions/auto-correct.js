// netlify/functions/auto-correct.js
// -----------------------------------------------------------------------------
// Versi ringkas: proses 1 soal saja, fix ES‑module __dirname, loop valid, CORS OK.
// -----------------------------------------------------------------------------
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { Client } from "pg";
import OpenAI from "openai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

// --- Load answerKey once -----------------------------------------------------
const keyPath1 = path.resolve(__dirname, "answerKey.json");
const keyPath2 = path.resolve(__dirname, "answerkey.json");
const keyFile  = fs.existsSync(keyPath1) ? keyPath1 : fs.existsSync(keyPath2) ? keyPath2 : "";
const answerKey = keyFile ? JSON.parse(fs.readFileSync(keyFile, "utf8")) : [];
// -----------------------------------------------------------------------------

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "CORS" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders, body: "Method Not Allowed" };
  }

  // Parse payload -------------------------------------------------------------
  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers: corsHeaders, body: "JSON tidak valid" }; }

  const { participant, userAnswers } = payload;
  if (!participant?.nama || !participant?.npm || !Array.isArray(userAnswers) || !userAnswers.length) {
    return { statusCode: 400, headers: corsHeaders, body: "Payload tidak lengkap" };
  }
  if (!answerKey.length) {
    return { statusCode: 500, headers: corsHeaders, body: "answerKey.json tidak ditemukan" };
  }
  // --------------------------------------------------------------------------

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  const results = [];
  try {
    await client.connect();

    // === Kerjakan HANYA 1 soal (index 0) agar tidak timeout ===
    const { id, jawaban } = userAnswers[0];
    const kunci = answerKey.find((q) => q.id === id);
    if (!kunci) {
      results.push({ id, skor: 0, alasan: "Soal tidak ditemukan" });
    } else {
      const prompt = `Soal: ${kunci.pertanyaan}\nJawaban Benar: ${kunci.jawaban_benar}\nJawaban Peserta: ${jawaban}\n\nNilai jawaban peserta dari 0 sampai 10.\nFormat balasan:\nSkor: <angka>\nAlasan: <penjelasan singkat>`;

      let skor = 0;
      let alasan = "Tidak ada alasan.";
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2
        });
        const txt = completion.choices[0].message.content || "";
        const mScore  = txt.match(/Skor:\s*(\d+(?:\.\d+)?)/i);
        skor   = mScore ? parseFloat(mScore[1]) : 0;
        const mAlasan = txt.match(/Alasan:\s*([\s\S]*)/i);
        alasan = mAlasan ? mAlasan[1].trim() : alasan;
      } catch (e) {
        alasan = `GPT error: ${e.message}`;
      }

      await client.query(
        `INSERT INTO leaderboard (nama, npm, soal_id, jawaban, skor, alasan)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [participant.nama, participant.npm, id, jawaban, skor, alasan]
      );

      results.push({ id, skor, alasan });
    }
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message }) };
  } finally {
    await client.end();
  }

  return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ participant, results }) };
}
