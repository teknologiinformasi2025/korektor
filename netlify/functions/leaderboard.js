// netlify/functions/leaderboard.js

import { Client } from "pg";

export async function handler(event) {
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      body: "Method Not Allowed",
    };
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    const result = await client.query(`
      SELECT nama, npm,
             SUM(skor)::INT AS total_skor,
             MAX(waktu) AS submit_time
      FROM leaderboard
      GROUP BY nama, npm
      ORDER BY total_skor DESC, submit_time ASC
    `);

    await client.end();

    return {
      statusCode: 200,
      body: JSON.stringify(result.rows),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
}
