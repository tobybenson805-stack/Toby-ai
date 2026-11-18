
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
  throw new Error("DATABASE_URL is missing.");
}

if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is missing.");
}

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 15000
});

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

// =====================================
// DATABASE SETUP AND OLD CHAT MIGRATION
// =====================================

async function initializeDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id BIGSERIAL PRIMARY KEY,
      clerk_user_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT 'New chat',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGSERIAL PRIMARY KEY,
      clerk_user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS conversation_id BIGINT
    REFERENCES conversations(id) ON DELETE CASCADE
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS conversations_user_updated_idx
    ON conversations (clerk_user_id, updated_at DESC)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx
    ON chat_messages (conversation_id, created_at)
  `);

  // Keep older messages by placing them in one Previous chat.
  const oldUsers = await db.query(`
    SELECT DISTINCT clerk_user_id
    FROM chat_messages
    WHERE conversation_id IS NULL
  `);

  for (const user of oldUsers.rows) {
    const client = await db.connect();

    try {
      await client.query("BEGIN");

      const oldMessages = await client.query(
        `SELECT content
         FROM chat_messages
         WHERE clerk_user_id = $1
           AND conversation_id IS NULL
         ORDER BY created_at ASC`,
        [user.clerk_user_id]
      );

      const firstUserMessage = oldMessages.rows[0]?.content || "";

      const title = firstUserMessage
        ? firstUserMessage.slice(0, 45)
        : "Previous chat";

      const conversation = await client.query(
        `INSERT INTO conversations (clerk_user_id, title)
         VALUES ($1, $2)
         RETURNING id`,
        [user.clerk_user_id, title]
      );

      await client.query(
        `UPDATE chat_messages
         SET conversation_id = $1
         WHERE clerk_user_id = $2
           AND conversation_id IS NULL`,
        [conversation.rows[0].id, user.clerk_user_id]
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  console.log("Supabase database and chat history ready.");
}

// =====================================
// AUTHENTICATION HELPER
// =====================================

function requireLogin(req, res) {
  const auth = getAuth(req);

  if (!auth.isAuthenticated || !auth.userId) {
    res.status(401).json({ error: "Please log in first." });
    return null;
  }

  return auth.userId;
}

// =====================================
// GEMINI AI
// =====================================

async function generateTobyReply(conversation) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash-lite",
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

      console.error(`Gemini attempt ${attempt} failed:`, message);

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

// =====================================
// LIST USER CONVERSATIONS
// =====================================

app.get("/conversations", async (req, res) => {
  try {
    const userId = requireLogin(req, res);
    if (!userId) return;

    const result = await db.query(
      `SELECT id, title, created_at, updated_at
       FROM conversations
       WHERE clerk_user_id = $1
       ORDER BY updated_at DESC
       LIMIT 100`,
      [userId]
    );

    res.json({ conversations: result.rows });
  } catch (error) {
    console.error("Conversations error:", error.message);
    res.status(500).json({
      error: "Could not load your conversations."
    });
  }
});

// =====================================
// LOAD ONE CONVERSATION
// =====================================

app.get("/history", async (req, res) => {
  try {
    const userId = requireLogin(req, res);
    if (!userId) return;

    const conversationId = req.query.conversationId;

    if (!conversationId || !/^\d+$/.test(String(conversationId))) {
      return res.status(400).json({
        error: "Please choose a valid conversation."
      });
    }

    const conversation = await db.query(
      `SELECT id, title
       FROM conversations
       WHERE id = $1 AND clerk_user_id = $2`,
      [conversationId, userId]
    );

    if (!conversation.rows.length) {
      return res.status(404).json({
        error: "Conversation not found."
      });
    }

    const result = await db.query(
      `SELECT role, content, created_at
       FROM chat_messages
       WHERE conversation_id = $1
         AND clerk_user_id = $2
       ORDER BY created_at ASC
       LIMIT 500`,
      [conversationId, userId]
    );

    res.json({
      conversation: conversation.rows[0],
      messages: result.rows
    });
  } catch (error) {
    console.error("History error:", error.message);
    res.status(500).json({
      error: "Could not load chat history."
    });
  }
});

// =====================================
// CHAT WITH TOBY AI AND SAVE CONVERSATION
// =====================================

app.post("/chat", async (req, res) => {
  try {
    const userId = requireLogin(req, res);
    if (!userId) return;

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

    const conversationText = messages
      .slice(-20)
      .map(message => {
        const role =
          message.role === "assistant" ? "assistant" : "user";

        return `${role}: ${String(message.content).slice(0, 4000)}`;
      })
      .join("\n");

    const reply = await generateTobyReply(conversationText);

    let conversationId = req.body.conversationId;

    if (conversationId) {
      if (!/^\d+$/.test(String(conversationId))) {
        return res.status(400).json({
          error: "Invalid conversation."
        });
      }

      const existing = await db.query(
        `SELECT id
         FROM conversations
         WHERE id = $1 AND clerk_user_id = $2`,
        [conversationId, userId]
      );

      if (!existing.rows.length) {
        return res.status(404).json({
          error: "Conversation not found. Start a new chat."
        });
      }
    } else {
      const title = lastUserMessage.content.trim().slice(0, 45);

      const created = await db.query(
        `INSERT INTO conversations (clerk_user_id, title)
         VALUES ($1, $2)
         RETURNING id`,
        [userId, title || "New chat"]
      );

      conversationId = created.rows[0].id;
    }

    await db.query(
      `INSERT INTO chat_messages
       (clerk_user_id, conversation_id, role, content)
       VALUES ($1, $2, $3, $4),
              ($1, $2, $5, $6)`,
      [
        userId,
        conversationId,
        "user",
        lastUserMessage.content.slice(0, 4000),
        "assistant",
        reply.slice(0, 4000)
      ]
    );

    await db.query(
      `UPDATE conversations
       SET updated_at = NOW()
       WHERE id = $1 AND clerk_user_id = $2`,
      [conversationId, userId]
    );

    res.json({
      reply,
      conversationId
    });
  } catch (error) {
    console.error("Toby AI error:", error);

    res.status(500).json({
      error: "Toby AI is having trouble. Please try again."
    });
  }
});

// =====================================
// NATURAL TOBY AI VOICE
// =====================================

app.post("/speak", async (req, res) => {
  try {
    const userId = requireLogin(req, res);
    if (!userId) return;

    const text = req.body.text;

    if (typeof text !== "string" || !text.trim()) {
      return res.status(400).json({
        error: "No text provided."
      });
    }

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          model: "gemini-3.8-flash-lite-tts",
          input: [{
            type: "user_input",
            content: [{
              type: "text",
              text: text.slice(0, 2000),
              annotations: [{
                type: "speech_metadata",
                style: "Friendly, warm, natural, relaxed male conversational voice. Speak clearly and naturally."
              }]
            }]
          }],
          response_format: { type: "audio" },
          generation_config: {
            speech_config: [{ voice: "Puck" }]
          }
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error("Voice API error:", result);
      return res.status(502).json({
        error: "Voice generation failed."
      });
    }

    const audio = (result.steps || [])
      .filter(step => step.type === "model_output")
      .flatMap(step => step.content || [])
      .find(part => part.type === "audio" && part.data);

    if (!audio) {
      return res.status(502).json({
        error: "No audio was generated."
      });
    }

    res.json({
      audio: audio.data,
      mimeType: "audio/wav"
    });
  } catch (error) {
    console.error("Voice error:", error);
    res.status(500).json({
      error: "Could not generate Toby's voice."
    });
  }
});

// =====================================
// HEALTH CHECK
// =====================================

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

// =====================================
// START SERVER
// =====================================

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
