// Import dependencies
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { Pool } = require("pg");
const admin = require("firebase-admin");
var cors = require('cors')

// Initialize app
const app = express();
app.use(bodyParser.json());
app.use(cors())

// Connect to PostgreSQL (Neon.tech)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// Initialize Firebase Admin SDK
const serviceAccount = require("./firebaseServiceAccountKey.json"); // Download from Firebase Console
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// User login/signup using Firebase ID token
app.post("/auth/firebase", async (req, res) => {
  const { token } = req.body;
  const clientConn = await pool.connect();
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    const { uid, email, name, picture } = decodedToken;

    // Check if user exists
    const userResult = await clientConn.query(
      "SELECT * FROM users WHERE firebase_uid = $1",
      [uid]
    );
    let user;

    if (userResult.rows.length === 0) {
      // Create new user
      const insertUser = await clientConn.query(
        `INSERT INTO users (firebase_uid, email, name, picture)
                 VALUES ($1, $2, $3, $4) RETURNING *`,
        [uid, email, name || "", picture || ""]
      );
      user = insertUser.rows[0];
    } else {
      user = userResult.rows[0];
    }

    res.status(200).json({ message: "Authenticated with Firebase", user });
  } catch (err) {
    console.error(err);
    res.status(401).json({ error: "Invalid Firebase token" });
  } finally {
    clientConn.release();
  }
});

// Create a new job
app.post("/jobs", async (req, res) => {
  const client = await pool.connect();
  try {
    const { userId, name, date, parts, laborCost, generalObservations } =
      req.body;
    const totalPartsCost = parts.reduce((sum, part) => sum + part.cost, 0);
    const totalCost = totalPartsCost + laborCost;

    await client.query("BEGIN");

    const jobInsert = await client.query(
      `INSERT INTO jobs (user_id, name, date, labor_cost, total_cost, general_observations)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [userId, name, date, laborCost, totalCost, generalObservations]
    );

    const jobId = jobInsert.rows[0].id;

    for (let part of parts) {
      await client.query(
        `INSERT INTO parts (job_id, name, type, cost, observations)
                 VALUES ($1, $2, $3, $4, $5)`,
        [jobId, part.name, part.type, part.cost, part.observations]
      );
    }

    await client.query("COMMIT");
    res.status(201).json({ message: "Job created successfully", jobId });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Error creating job" });
  } finally {
    client.release();
  }
});

// Get all jobs for a specific user
app.get("/jobs/:userId", async (req, res) => {
  const client = await pool.connect();
  try {
    const { userId } = req.params;
    const jobsResult = await client.query(
      `SELECT * FROM jobs WHERE user_id = $1`,
      [userId]
    );

    const jobs = await Promise.all(
      jobsResult.rows.map(async (job) => {
        const partsResult = await client.query(
          `SELECT * FROM parts WHERE job_id = $1`,
          [job.id]
        );
        return {
          ...job,
          parts: partsResult.rows,
        };
      })
    );

    res.status(200).json(jobs);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error fetching jobs" });
  } finally {
    client.release();
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
