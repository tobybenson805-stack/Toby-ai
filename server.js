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

// Check required environment variables.
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing.");
}

if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is missing.");
}

// Supabase PostgreSQL connection.
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 15000
});

// Gemini connection.
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// Create chat history table.
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

  console.log("Supabase database connected.");
}

// Gemini request with automatic retries.
async function generateTobyReply(conversation) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: conversation,
        config: {
          systemInstruction:
            "You are Toby AI, a friendly and helpful assistant. Speak English. Explain schoolwork simply and step by step. Be respectful."
        }
      });

      return response.text || "I couldn't create a reply.";

    } catch (error) {
      lastError = error;

      const status = Number(error.status || error.code);
      const message = String(error.message || "");

      const temporaryError =
        [429, 500, 502, 503, 504].includes(status) ||
        message.includes("UNAVAILABLE");

      console.error(
        `Gemini attempt ${attempt} failed:`,
        message
      );

      if (!temporaryError || attempt === 3) {
        throw error;
      }

      await new Promise(resolve =>
        setTimeout(resolve, attempt * 2000)
      );
    }
  }

  throw lastError;
}

// Load chat history.
app.get("/history", async (req, res) => {
  try {
    const auth = getAuth(req);

    if (!auth.isAuthenticated || !auth.userId) {
      return res.status(401).json({
        error: "Please log in first."
      });
    }

    const result = await db.query(
      `SELECT role, content, created_at
       FROM chat_messages
       WHERE clerk_user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [auth.userId]
    );

    res.json({
      messages: result.rows.reverse()
    });

  } catch (error) {
    console.error("History error:", error.message);

    res.status(500).json({
      error: "Could not load chat history."
    });
  }
});

// Chat with Toby AI.
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
      .find(message =>
        message &&
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.trim()
      );

    if (!lastUserMessage) {
      return res.status(400).json({
        error: "Please send a valid message."
      });
    }

    const conversation = messages
      .slice(-20)
      .map(message => {
        const role =
          message.role === "assistant"
            ? "assistant"
            : "user";

        return `${role}: ${String(message.content).slice(0, 4000)}`;
      })
      .join("\n");

    // Generate AI response.
    const reply = await generateTobyReply(conversation);

    // Save user message and AI response.
    await db.query(
      `INSERT INTO chat_messages
       (clerk_user_id, role, content)
       VALUES ($1, $2, $3), ($1, $4, $5)`,
      [
        auth.userId,
        "user",
        lastUserMessage.content.slice(0, 4000),
        "assistant",
        reply.slice(0, 4000)
      ]
    );

    res.json({ reply });

  } catch (error) {
    console.error("Toby AI error:", error);

    res.status(500).json({
      error: "Toby AI is having trouble. Please try again."
    });
  }
});

// Check server and database.
app.get("/health", async (req, res) => {
  try {
    await db.query("SELECT 1");

    res.json({
      status: "ok",
      database: "connected",
      ai: "configured"
    });

  } catch (error) {
    console.error("Health check error:", error.message);

    res.status(500).json({
      status: "error",
      database: "disconnected"
    });
  }
});

// Start server.
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

