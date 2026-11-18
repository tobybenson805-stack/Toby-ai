
require("dotenv").config();

const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const { GoogleGenAI } = require("@google/genai");
const { clerkMiddleware, getAuth } = require("@clerk/express");

const app = express();

app.use(clerkMiddleware());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing from environment variables.");
}

if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is missing from environment variables.");
}

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// Create the chat history table.
async function initializeDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGSERIAL PRIMARY KEY,
      clerk_user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log("Neon database connected.");
}

// Read saved chat history for the logged-in user.
app.get("/history", async (req, res) => {
  try {
    const auth = getAuth(req);

    if (!auth.isAuthenticated || !auth.userId) {
      return res.status(401).json({ error: "Please log in first." });
    }

    const result = await db.query(
      `SELECT role, content, created_at
       FROM chat_messages
       WHERE clerk_user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [auth.userId]
    );

    res.json({ messages: result.rows.reverse() });
  } catch (error) {
    console.error("History error:", error.message);
    res.status(500).json({ error: "Could not load chat history." });
  }
});

// Send a message to Toby AI and save the conversation.
app.post("/chat", async (req, res) => {
  try {
    const auth = getAuth(req);

    if (!auth.isAuthenticated || !auth.userId) {
      return res.status(401).json({
        error: "Please log in first."
      });
    }

    const messages = req.body.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: "Please send a message."
      });
    }

    const lastUserMessage = [...messages]
      .reverse()
      .find(message => message.role === "user");

    if (!lastUserMessage || !lastUserMessage.content) {
      return res.status(400).json({
        error: "Please send a valid message."
      });
    }

    const conversation = messages.slice(-20).map(message => {
      const role = message.role === "assistant" ? "assistant" : "user";
      return `${role}: ${String(message.content).slice(0, 4000)}`;
    }).join("\n");

    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-lite",
      contents: conversation,
      config: {
        systemInstruction:
          "You are Toby AI, a friendly and helpful assistant. Speak English. Explain schoolwork simply and step by step. Be respectful."
      }
    });

    const reply = response.text || "I couldn't create a reply.";

    await db.query(
      `INSERT INTO chat_messages (clerk_user_id, role, content)
       VALUES ($1, $2, $3), ($1, $4, $5)`,
      [
        auth.userId,
        "user",
        String(lastUserMessage.content).slice(0, 4000),
        "assistant",
        reply.slice(0, 4000)
      ]
    );

    res.json({ reply });

  } catch (error) {
    console.error("Toby AI error:", error.message);

    res.status(500).json({
      error: "Toby AI is having trouble. Please try again."
    });
  }
});

app.get("/health", async (req, res) => {
  try {
    await db.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    res.status(500).json({
      status: "error",
      database: "disconnected"
    });
  }
});

const PORT = process.env.PORT || 3000;

initializeDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Toby AI is running on port ${PORT}`);
    });
  })
  .catch(error => {
    console.error("Database startup error:", error.message);
    process.exit(1);
  });
