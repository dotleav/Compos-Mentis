require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");

const casesRouter = require("./routes/cases");
const chatRouter = require("./routes/chat");
const examRouter = require("./routes/exam");
const customCasesRouter = require("./routes/customCases");
const driveRouter = require("./routes/drive");
const keysRouter = require("./routes/keys");
const { sessionMiddleware } = require("./lib/session");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));
// Anonymous per-browser session (signed cookie, no login system) — powers
// "bring your own API key" and per-user Google Drive. See lib/session.js.
app.use(sessionMiddleware);

// Static frontend
app.use(express.static(path.join(__dirname, "..", "public")));

// Static case images (ECG, rontgen, etc.)
app.use("/data/images", express.static(path.join(__dirname, "..", "data", "images")));

// API routes
app.use("/api/cases", casesRouter);
app.use("/api/chat", chatRouter);
app.use("/api/exam", examRouter);
app.use("/api/custom-cases", customCasesRouter);
app.use("/api/drive", driveRouter);
app.use("/api/keys", keysRouter);

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`OSCE AI simulator running on http://localhost:${PORT}`);
});
