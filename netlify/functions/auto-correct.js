// netlify/functions/auto-correct.js
// -----------------------------------------------------------------------------
// Fungsi: menerima jawaban peserta → minta GPT menilai → simpan ke Neon DB.
// Perbaikan: loader kunci jawaban kini otomatis mencari "answerKey.json" 
// atau "answerkey.json" (case‑insensitive) di direktori fungsi.
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

// -----------------------------------------------------------------------------
// 🔑  Muat answerKey.json  (case‑insensitive, dua nama alternatif)
// -----------------------------------------------------------------------------
const candidateFiles = [
  path.resolve(__dirname, "answerKey.json"),
  path.resolve(__dirname, "answerkey.json")
];

let answerKey = [];
let foundPath = "";
for (const p of candidateFiles) {
  if (fs.existsSync(p)) {
    foundPath = p;
    try {
      answerKey = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      console.error(`❌ Gagal parse ${p}:`, e.message);
    }
    break;
  }
}
if (!foundPath) {
  console.error("❌ Tidak menemukan answerKey.json / answerkey.json di", __dirname);
}
// -----------------------------------------------------------------------------

export async function handler(event) {
  // Tolak selain POST
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // Validasi payload --------------------------------------------
  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: "Bad Request: JSON tidak valid" };
  }

  const { participant, userAnswers } = payload;
  if (!participant?.nama || !participant?.npm || !Array.isArray(userAnswers) || !userAnswers.length) {
    return { statusCode: 400, body: "Bad Request: payload tidak lengkap" };
  }
  if (!answerKey.length) {
    return { statusCode: 500, body: "Server error: answerKey.json tidak ditemukan." };
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

      // Prompt untuk GPT
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
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }

  return { statusCode: 200, body: JSON.stringify({ participant, results }) };
}
