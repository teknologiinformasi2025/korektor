// netlify/functions/auto-correct.js
// -----------------------------------------------------------------------------
// Fungsi: menerima jawaban peserta → minta GPT menilai → simpan ke Neon DB.
// Sekarang dilengkapi CORS (OPTIONS + header) agar bisa dipanggil lintas‑domain.
// -----------------------------------------------------------------------------
import { Client } from "pg";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// CORS header (ganti origin jika ingin lebih ketat)
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

// -----------------------------------------------------------------------------
// 🔑  Muat answerKey.json  (case‑insensitive)
// -----------------------------------------------------------------------------
const candidateFiles = [
  path.resolve(__dirname, "answerKey.json"),
  path.resolve(__dirname, "answerkey.json")
];
let answerKey = [];
for (const p of candidateFiles) {
  if (fs.existsSync(p)) {
    try {
      answerKey = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      console.error(`❌ Gagal parse ${p}:`, e.message);
    }
    break;
  }
}
// -----------------------------------------------------------------------------

export async function handler(event) {
  // Pre‑flight CORS
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "CORS preflight" };
  }

  // Tolak selain POST
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders, body: "Method Not Allowed" };
  }

  // Validasi payload --------------------------------------------
  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: "Bad Request: JSON tidak valid" };
  }

  const { participant, userAnswers } = payload;
  if (!participant?.nama || !participant?.npm || !Array.isArray(userAnswers) || !userAnswers.length) {
    return { statusCode: 400, headers: corsHeaders, body: "Bad Request: payload tidak lengkap" };
  }
  if (!answerKey.length) {
    return { statusCode: 500, headers: corsHeaders, body: "Server error: answerKey.json tidak ditemukan." };
  }
  //--------------------------------------------------------------

  const results = [];
  try {
    await client.connect();

    for (const { id, jawaban } of userAnswers) {
      const kunci = answerKey.find((q) => q.id === id);
      if (!kunci) {
        results.push({ id, skor: 0, alasan: "Soal tidak ditemukan" });
        continue;
      }

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
        skor = mScore ? parseFloat(mScore[1]) : 0;
        const mAlasan = txt.match(/Alasan:\s*([\s\S]*)/i);
        alasan = mAlasan ? mAlasan[1].trim() : alasan;
      } catch (gptErr) {
        alasan = `GPT error: ${gptErr.message}`;
      }

      await client.query(
        `INSERT INTO leaderboard (nama, npm, soal_id, jawaban, skor, alasan)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [participant.nama, participant.npm, id, jawaban, skor, alasan]
      );

      results.push({ id, skor, alasan });
    }

    await client.end();
  } catch (err) {
    await client?.end?.();
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message }) };
  }

  return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ participant, results }) };
}
