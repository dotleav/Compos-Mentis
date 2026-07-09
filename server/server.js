require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");

const casesRouter = require("./routes/cases");
const chatRouter = require("./routes/chat");
const examRouter = require("./routes/exam");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Static frontend
app.use(express.static(path.join(__dirname, "..", "public")));

// Static case images (ECG, rontgen, etc.)
app.use("/data/images", express.static(path.join(__dirname, "..", "data", "images")));

// API routes
app.use("/api/cases", casesRouter);
app.use("/api/chat", chatRouter);
app.use("/api/exam", examRouter);

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`OSCE AI simulator running on http://localhost:${PORT}`);
});
