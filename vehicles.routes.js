const express = require("express");
const pool = require("./db");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");

// Create a new vehicle
router.post("/", async (req, res) => {
  const { userId, make, model, year, licensePlate, color, category } = req.body;
  try {
    const uuid = uuidv4();
    const result = await pool.query(
      `INSERT INTO vehicles (user_id, uuid, make, model, year, license_plate, color, category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [userId, uuid, make, model, year, licensePlate, color, category]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create vehicle" });
  }
});

// Get vehicle by ID
router.get("/:userId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM vehicles WHERE user_id = $1",
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch vehicle" });
  }
});

// Update vehicle
router.put("/:id", async (req, res) => {
  const { make, model, year, licensePlate, color, category } = req.body;
  try {
    const result = await pool.query(
      `UPDATE vehicles SET
        make = $1,
        model = $2,
        year = $3,
        license_plate = $4,
        color = $5,
        category = $6
       WHERE id = $7
       RETURNING *`,
      [make, model, year, licensePlate, color, category, req.params.id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "Vehicle not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update vehicle" });
  }
});

// Delete vehicle
router.delete("/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM vehicles WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    res.json({ message: "Vehicle deleted", vehicle: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete vehicle" });
  }
});

module.exports = router;
