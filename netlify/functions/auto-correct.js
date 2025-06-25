// netlify/functions/auto-correct.js
// -----------------------------------------------------------------------------
// Proses 1 soal (untuk menghindari timeout 10 s), skor & alasan via Cohere API
// -----------------------------------------------------------------------------
import path from "path";
import fs from "fs";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import { Client } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

// -----------------------------------------------------------------------------
// 🔑 Muat kunci jawaban satu kali per cold-start
// -----------------------------------------------------------------------------
const keyPath1 = path.resolve(__dirname, "answerKey.json");
const keyPath2 = path.resolve(__dirname, "answerkey.json");
const keyFile  = fs.existsSync(keyPath1) ? keyPath1 : fs.existsSync(keyPath2) ? keyPath2 : "";
const answerKey = keyFile ? JSON.parse(fs.readFileSync(keyFile, "utf8")) : [];
// -----------------------------------------------------------------------------

export async function handler(event) {
  // CORS pre-flight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "CORS" };
  }
  // Hanya terima POST
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders, body: "Method Not Allowed" };
  }

  // ---------------------------------------------------------------------------
  // Validasi payload
  // ---------------------------------------------------------------------------
  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers: corsHeaders, body: "JSON tidak valid" };
  }

  const { participant, userAnswers } = payload;
  if (!participant?.nama || !participant?.npm || !Array.isArray(userAnswers) || !userAnswers.length) {
    return { statusCode: 400, headers: corsHeaders, body: "Payload tidak lengkap" };
  }
  if (!answerKey.length) {
    return { statusCode: 500, headers: corsHeaders, body: "answerKey.json tidak ditemukan" };
  }

  // ---------------------------------------------------------------------------
  // Koneksi PostgreSQL per-request
  // ---------------------------------------------------------------------------
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  const results = [];

  try {
    await client.connect();

    // ⚡ Kerjakan hanya 1 soal (index 0) agar tidak timeout 10 detik Netlify
    const { id, jawaban } = userAnswers[0];
    const kunci = answerKey.find((q) => q.id === id);

    if (!kunci) {
      results.push({ id, skor: 0, alasan: "Soal tidak ditemukan" });
    } else {
      // Prompt penilaian
      const prompt = `Soal: ${kunci.pertanyaan}
Jawaban Benar: ${kunci.jawaban_benar}
Jawaban Peserta: ${jawaban}

Nilai jawaban peserta dari 0 sampai 10. Jelaskan alasannya.`;

      let skor   = 0;
      let alasan = "Tidak ada alasan.";

      try {
        // Panggil Cohere langsung via fetch
        const completion = await fetch("https://api.cohere.ai/generate", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.COHERE_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "command",
            prompt,
            max_tokens: 150,
            temperature: 0.3
          })
        }).then((res) => res.json());

        const txt     = completion.generations?.[0]?.text || "";
        const mScore  = txt.match(/Skor:\\s*(\\d+(?:\\.\\d+)?)/i);
        score         = mScore ? parseFloat(mScore[1]) : 0;
        const mAlasan = txt.match(/Alasan:\\s*([\\s\\S]*)/i);
        alasan        = mAlasan ? mAlasan[1].trim() : alasan;
      } catch (e) {
        alasan = `Cohere error: ${e.message}`;
      }

      // Simpan ke DB
      await client.query(
        `INSERT INTO leaderboard (nama, npm, soal_id, jawaban, skor, alasan)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [participant.nama, participant.npm, id, jawaban, skor, alasan]
      );

      results.push({ id, skor, alasan });
    }
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: err.message })
    };
  } finally {
    await client.end();
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ participant, results })
  };
}
