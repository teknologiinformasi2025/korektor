// netlify/functions/auto-correct.js
// -----------------------------------------------------------------------------
// Payload yang diterima (POST JSON):
// {
//   "participant": { "nama": "Satrio", "npm": "2300010001" },
//   "userAnswers": [
//     { "id": "soal1",  "jawaban": "..." },
//     ...
//     { "id": "soal25", "jawaban": "..." }
//   ]
// }
//
// 1. Mencari kunci jawaban di /data/answerKey.json
// 2. Meminta GPT-4o memberi nilai 0–10 + alasan per soal
// 3. Menulis setiap soal ke tabel `leaderboard` di Neon PostgreSQL
// 4. Merespons JSON: { participant, results:[{id, skor, alasan}, …] }
// -----------------------------------------------------------------------------

import { Client } from "pg";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// -----------------------------------------------------------------------------
// Muat kunci jawaban sekali saja (di luar handler agar reuse antar-invoke)
const answerKeyPath = path.resolve(__dirname, "answerKey.json");

let answerKey = [];

try {
  answerKey = JSON.parse(fs.readFileSync(answerKeyPath, "utf8"));
} catch (err) {
  console.error("❌ Gagal memuat answerKey.json:", err.message);
}
// -----------------------------------------------------------------------------

export async function handler(event) {
  // Tolak selain POST
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // ---------------------- Validasi payload ----------------------
  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: "Bad Request: JSON tidak valid" };
  }

  const { participant, userAnswers } = payload;
  if (
    !participant?.nama ||
    !participant?.npm ||
    !Array.isArray(userAnswers) ||
    userAnswers.length === 0
  ) {
    return { statusCode: 400, body: "Bad Request: payload tidak lengkap" };
  }
  // --------------------------------------------------------------

  const results = [];

  try {
    await client.connect();

    // -------- Proses setiap soal ----------
    for (const { id, jawaban } of userAnswers) {
      const kunci = answerKey.find((q) => q.id === id);
      if (!kunci) {
        results.push({ id, skor: 0, alasan: "Soal tidak ditemukan" });
        continue;
      }

      // Prompt penilaian
      const prompt = `Soal: ${kunci.pertanyaan}
Jawaban Benar: ${kunci.jawaban_benar}
Jawaban Peserta: ${jawaban}

Nilai jawaban peserta dari 0 sampai 10.
Format balasan:
Skor: <angka>
Alasan: <penjelasan singkat>
`;

      let skor = 0;
      let alasan = "Tidak ada alasan.";

      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
        });

        const txt = completion.choices[0].message.content || "";

        const mScore = txt.match(/Skor:\s*(\d+(?:\.\d+)?)/i);
        skor = mScore ? parseFloat(mScore[1]) : 0;

        const mAlasan = txt.match(/Alasan:\s*([\s\S]*)/i);
        alasan = mAlasan ? mAlasan[1].trim() : alasan;
      } catch (gptErr) {
        alasan = `GPT error: ${gptErr.message}`;
      }

      // Simpan hasil ke DB
      await client.query(
        `INSERT INTO leaderboard
         (nama, npm, soal_id, jawaban, skor, alasan)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [participant.nama, participant.npm, id, jawaban, skor, alasan]
      );

      results.push({ id, skor, alasan });
    }
    // --------------------------------------

    await client.end();
  } catch (err) {
    await client?.end?.();
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ participant, results }),
  };
}
