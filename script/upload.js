import fs from "fs";
import path from "path";
import fetch from "node-fetch";

// URL Netlify Function auto‑correct (ganti sesuai deploy Anda)
const endpoint = "https://uap25.netlify.app/.netlify/functions/auto-correct";

const filePath = process.argv[2] || "jawaban.json";

(async () => {
  try {
    const data = JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    const json = await res.json();
    console.log("✅ Hasil:", JSON.stringify(json, null, 2));
  } catch (err) {
    console.error("❌ Gagal:", err.message);
    process.exit(1);
  }
})();
