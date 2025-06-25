// netlify/functions/auto-correct.js (clean, single DIRNAME)
import path from "path";
import fs from "fs";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import { Client } from "pg";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

// Load answerKey.json (case-insensitive)
const keyCandidates = [
  path.resolve(DIRNAME, "answerKey.json"),
  path.resolve(DIRNAME, "answerkey.json")
];
let answerKey = [];
for (const p of keyCandidates) {
  if (fs.existsSync(p)) {
    answerKey = JSON.parse(fs.readFileSync(p, "utf8"));
    break;
  }
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "CORS" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders, body: "Method Not Allowed" };
  }

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

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  const results = [];
  try {
    await client.connect();

    // Proses 1 soal pertama
    const { id, jawaban } = userAnswers[0];
    const kunci = answerKey.find(q => q.id === id);
    if (!kunci) {
      results.push({ id, skor: 0, alasan: "Soal tidak ditemukan" });
    } else {
      const prompt = `Soal: ${kunci.pertanyaan}\nJawaban Benar: ${kunci.jawaban_benar}\nJawaban Peserta: ${jawaban}\n\nNilai jawaban peserta dari 0 sampai 10. Jelaskan alasannya.`;

      let skor = 0;
      let alasan = "Tidak ada alasan.";
      try {
        const completion = await fetch("https://api.cohere.ai/generate", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.COHERE_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ model: "command", prompt, max_tokens: 150, temperature: 0.3 })
        }).then(r => r.json());

        const txt = completion.generations?.[0]?.text || "";
        const mScore = txt.match(/Skor:\s*(\d+(?:\.\d+)?)/i);
        skor = mScore ? parseFloat(mScore[1]) : 0;
        const mAlasan = txt.match(/Alasan:\s*([\s\S]*)/i);
        alasan = mAlasan ? mAlasan[1].trim() : alasan;
      } catch (e) {
        alasan = `Cohere error: ${e.message}`;
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
