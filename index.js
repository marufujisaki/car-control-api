// Import dependencies
require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
var cors = require("cors");
const pool = require("./db");

const vehiclesRoutes = require("./vehicles.routes");

// Initialize app
const app = express();
app.use(bodyParser.json());
app.use(cors());

admin.initializeApp({
  credential: admin.credential.cert({
    type: process.env.FIREBASE_TYPE,
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: process.env.FIREBASE_AUTH_URI,
    token_uri: process.env.FIREBASE_TOKEN_URI,
    auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
    client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
  }),
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

app.use("/vehicles", vehiclesRoutes);

// Create a new job
app.post("/jobs", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vehicleId, name, date, parts, laborCost, generalObservations } =
      req.body;
    const totalPartsCost = parts.reduce((sum, part) => sum + part.cost, 0);
    const totalCost = totalPartsCost + laborCost;

    await client.query("BEGIN");

    const jobInsert = await client.query(
      `INSERT INTO jobs (vehicle_id, name, date, labor_cost, total_cost, general_observations)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [vehicleId, name, date, laborCost, totalCost, generalObservations]
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

// Get all jobs for a specific vehicle
app.get("/jobs/:vehicleId", async (req, res) => {
  const client = await pool.connect();
  try {
    const { vehicleId } = req.params;
    const jobsResult = await client.query(
      `SELECT * FROM jobs WHERE vehicle_id = $1`,
      [vehicleId]
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

app.put("/jobs/:jobId", async (req, res) => {
  const client = await pool.connect();
  try {
    const { jobId } = req.params;
    const { name, date, parts, laborCost, generalObservations } = req.body;
    const totalPartsCost = parts.reduce((sum, part) => sum + part.cost, 0);
    let totalCost = totalPartsCost + laborCost;

    await client.query("BEGIN");

    // Update job
    await client.query(
      `UPDATE jobs 
           SET name = $1, date = $2, labor_cost = $3, total_cost = $4, general_observations = $5
           WHERE id = $6`,
      [name, date, laborCost, totalCost, generalObservations, jobId]
    );

    // Get existing part IDs from DB
    const existingPartsRes = await client.query(
      `SELECT id FROM parts WHERE job_id = $1`,
      [jobId]
    );
    const existingPartIds = existingPartsRes.rows.map((r) => r.id);

    // Track IDs sent in request
    const incomingPartIds = parts.filter((p) => p.id).map((p) => p.id);

    // Delete parts that are in DB but not in the request
    const partsToDelete = existingPartIds.filter(
      (id) => !incomingPartIds.includes(id)
    );
    if (partsToDelete.length > 0) {
      await client.query(`DELETE FROM parts WHERE id = ANY($1::int[])`, [
        partsToDelete,
      ]);
    }

    // Upsert parts
    for (let part of parts) {
      if (part.id) {
        // Update
        await client.query(
          `UPDATE parts
                   SET name = $1, type = $2, cost = $3, observations = $4
                   WHERE id = $5 AND job_id = $6`,
          [part.name, part.type, part.cost, part.observations, part.id, jobId]
        );
      } else {
        // Insert
        await client.query(
          `INSERT INTO parts (job_id, name, type, cost, observations)
                   VALUES ($1, $2, $3, $4, $5)`,
          [jobId, part.name, part.type, part.cost, part.observations]
        );
      }
    }

    const finalExistingParts = await client.query(
      `SELECT cost FROM parts WHERE job_id = $1`,
      [jobId]
    );

    const finalPartsCost = finalExistingParts.rows
      .map((r) => Number(r.cost))
      .reduce((sum, cost) => sum + cost, 0);
    totalCost = finalPartsCost + Number(laborCost);

    await client.query(
      `UPDATE jobs 
         SET total_cost = $1 
         WHERE id = $2`,
      [totalCost, jobId]
    );

    await client.query("COMMIT");
    res.status(200).json({ message: "Job and parts updated successfully" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Error updating job" });
  } finally {
    client.release();
  }
});

app.delete("/jobs/:jobId", async (req, res) => {
  const client = await pool.connect();
  try {
    const { jobId } = req.params;

    await client.query("BEGIN");

    await client.query(`DELETE FROM parts WHERE job_id = $1`, [jobId]);
    await client.query(`DELETE FROM jobs WHERE id = $1`, [jobId]);

    await client.query("COMMIT");
    res.status(200).json({ message: "Job deleted successfully" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    res.status(500).json({ error: "Error deleting job" });
  } finally {
    client.release();
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
