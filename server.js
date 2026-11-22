
require("dotenv").config();

const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const { GoogleGenAI } = require("@google/genai");
const {
  clerkMiddleware,
  getAuth,
  clerkClient
} = require("@clerk/express");

const app = express();

// =====================================
// CONFIGURATION
// =====================================

const PORT = process.env.PORT || 3000;
const FREE_DAILY_LIMIT = 30;

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
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    apiVersion: "v1beta"
  }
});

// =====================================
// EXPRESS MIDDLEWARE
// =====================================

app.use(clerkMiddleware());
app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.join(__dirname, "public")));

// =====================================
// DATABASE SETUP
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
    CREATE TABLE IF NOT EXISTS daily_usage (
      clerk_user_id TEXT NOT NULL,
      usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
      message_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (clerk_user_id, usage_date)
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

  // Move older messages into a Previous chat.
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

      const firstMessage = oldMessages.rows[0]?.content || "";

      const title = firstMessage
        ? firstMessage.slice(0, 45)
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
// AUTHENTICATION
// =====================================

function requireLogin(req, res) {
  const auth = getAuth(req);

  if (!auth.isAuthenticated || !auth.userId) {
    res.status(401).json({
      error: "Please log in first."
    });

    return null;
  }

  return auth.userId;
}

// =====================================
// ADMIN ANALYTICS
// =====================================

app.get("/admin/analytics", async (req, res) => {
  try {
    const userId = requireLogin(req, res);
    if (!userId) return;

    if (!process.env.ADMIN_USER_ID ||
        userId !== process.env.ADMIN_USER_ID) {
      return res.status(403).json({
        error: "Admin access only."
      });
    }

    const [users, messages, conversations, activeToday] =
      await Promise.all([
        db.query(`
          SELECT COUNT(DISTINCT clerk_user_id)::int AS total
          FROM chat_messages
        `),

        db.query(`
          SELECT COUNT(*)::int AS total
          FROM chat_messages
        `),

        db.query(`
          SELECT COUNT(*)::int AS total
          FROM conversations
        `),

        db.query(`
          SELECT COUNT(DISTINCT clerk_user_id)::int AS total
          FROM chat_messages
          WHERE created_at >= CURRENT_DATE
        `)
      ]);

    res.json({
      totalUsers: users.rows[0].total,
      totalMessages: messages.rows[0].total,
      totalConversations: conversations.rows[0].total,
      activeToday: activeToday.rows[0].total
    });

  } catch (error) {
    console.error("Admin analytics error:", error);

    res.status(500).json({
      error: "Could not load analytics."
    });
  }
});

app.get("/admin/registrations", async (req, res) => {
  try {
    const userId = requireLogin(req, res);
    if (!userId) return;

    if (
      !process.env.ADMIN_USER_ID ||
      userId !== process.env.ADMIN_USER_ID
    ) {
      return res.status(403).json({
        error: "Admin access only."
      });
    }

    // Get the exact total number of registered users.
    const allUsers = await clerkClient.users.getUserList({
      limit: 1
    });

    // Calculate registration counts for the last 7 days.
    const today = new Date();
    const todayStart = Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate()
    );

    const dailyRegistrations = await Promise.all(
      Array.from({ length: 7 }, async (_, index) => {
        const start = todayStart -
          (6 - index) * 24 * 60 * 60 * 1000;

        const end = start + 24 * 60 * 60 * 1000;

        const result = await clerkClient.users.getUserList({
          createdAtAfter: start,
          createdAtBefore: end,
          limit: 1
        });

        return {
          date: new Date(start).toISOString().slice(0, 10),
          signups: result.totalCount
        };
      })
    );

    res.json({
      totalRegisteredUsers: allUsers.totalCount,
      dailyRegistrations
    });

  } catch (error) {
    console.error("Registration analytics error:", error);

    res.status(500).json({
      error: "Could not load registration analytics."
    });
  }
});

app.get("/admin/analytics/daily", async (req, res) => {
  try {
    const userId = requireLogin(req, res);
    if (!userId) return;

    if (
      !process.env.ADMIN_USER_ID ||
      userId !== process.env.ADMIN_USER_ID
    ) {
      return res.status(403).json({
        error: "Admin access only."
      });
    }

    const result = await db.query(`
      SELECT
        TO_CHAR(day::date, 'Mon DD') AS date,
        COUNT(chat_messages.id)::int AS messages
      FROM generate_series(
        CURRENT_DATE - INTERVAL '6 days',
        CURRENT_DATE,
        INTERVAL '1 day'
      ) AS day
      LEFT JOIN chat_messages
        ON chat_messages.created_at >= day
        AND chat_messages.created_at < day + INTERVAL '1 day'
      GROUP BY day
      ORDER BY day ASC
    `);

    res.json({
      dailyActivity: result.rows
    });

  } catch (error) {
    console.error("Daily analytics error:", error);

    res.status(500).json({
      error: "Could not load daily activity."
    });
  }
});

// =====================================
// DAILY USAGE
// =====================================

async function checkDailyUsage(userId) {
  const result = await db.query(
    `INSERT INTO daily_usage
       (clerk_user_id, usage_date, message_count)
     VALUES ($1, CURRENT_DATE, 0)
     ON CONFLICT (clerk_user_id, usage_date)
     DO UPDATE SET message_count = daily_usage.message_count
     RETURNING message_count`,
    [userId]
  );

  return Number(result.rows[0].message_count);
}

async function increaseDailyUsage(userId) {
  const result = await db.query(
    `UPDATE daily_usage
     SET message_count = message_count + 1
     WHERE clerk_user_id = $1
       AND usage_date = CURRENT_DATE
       AND message_count < $2
     RETURNING message_count`,
    [userId, FREE_DAILY_LIMIT]
  );

  return result.rows[0] || null;
}

async function refundDailyUsage(userId) {
  await db.query(
    `UPDATE daily_usage
     SET message_count = GREATEST(message_count - 1, 0)
     WHERE clerk_user_id = $1
       AND usage_date = CURRENT_DATE`,
    [userId]
  );
}

// =====================================
// GEMINI CHAT
// =====================================

async function generateTobyReply(conversation, attachment = null) {
  let contents = conversation;

  if (attachment) {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
      "text/plain"
    ];

    if (
      !allowedTypes.includes(attachment.mimeType) ||
      typeof attachment.data !== "string" ||
      !attachment.data ||
      attachment.data.length > 7 * 1024 * 1024
    ) {
      throw new Error("Invalid or oversized attachment.");
    }

    if (attachment.mimeType === "text/plain") {
      const fileText = Buffer.from(
        attachment.data,
        "base64"
      ).toString("utf8");

      contents =
        conversation +
        "\n\nAttached text file:\n" +
        fileText.slice(0, 100000);

    } else {
      contents = [
        {
          role: "user",
          parts: [
            { text: conversation },
            {
              inlineData: {
                mimeType: attachment.mimeType,
                data: attachment.data
              }
            }
          ]
        }
      ];
    }
  }

  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`Toby Gemini attempt ${attempt}`);

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash-lite",
        contents,
        config: {
          systemInstruction:
            "You are Toby AI, a friendly and helpful AI assistant. " +
            "Speak clearly in English. Explain schoolwork simply and step by step. " +
            "Be respectful, accurate, and helpful. " +
            "Carefully examine uploaded images and documents before answering."
        }
      });

      if (!response.text) {
        throw new Error("Gemini returned an empty response.");
      }

      console.log("Toby Gemini reply successful.");
      return response.text;

    } catch (error) {
      lastError = error;

      const status = Number(
        error.status ||
        error.code ||
        error.error?.code ||
        error.response?.status
      );

      const message = String(error.message || "");

      const temporaryError =
        [429, 500, 502, 503, 504].includes(status) ||
        message.includes("UNAVAILABLE");

      console.error(
        `Toby Gemini attempt ${attempt} failed:`,
        message
      );

      if (!temporaryError || attempt === 3) {
        throw error;
      }

      await new Promise(resolve =>
        setTimeout(resolve, attempt * 5000)
      );
    }
  }

  throw lastError || new Error("Gemini request failed.");
}

// =====================================
// LIST RECENT CONVERSATIONS
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
       LIMIT 50`,
      [userId]
    );

    res.json({
      conversations: result.rows
    });

  } catch (error) {
    console.error("Conversations error:", error);

    res.status(500).json({
      error: "Could not load recent conversations."
    });
  }
});
// =====================================
// LOAD CHAT HISTORY
// =====================================

app.get("/history", async (req, res) => {
  try {
    const userId = requireLogin(req, res);
    if (!userId) return;

    const conversationId = req.query.conversationId;

    if (
      !conversationId ||
      !/^\d+$/.test(String(conversationId))
    ) {
      return res.status(400).json({
        error: "Please choose a valid conversation."
      });
    }

    const conversation = await db.query(
      `SELECT id, title
       FROM conversations
       WHERE id = $1
         AND clerk_user_id = $2`,
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
// CHECK USAGE
// =====================================

app.get("/usage", async (req, res) => {
  try {
    const userId = requireLogin(req, res);
    if (!userId) return;

    const used = await checkDailyUsage(userId);

    res.json({
      plan: "Free",
      used,
      limit: FREE_DAILY_LIMIT,
      remaining: Math.max(0, FREE_DAILY_LIMIT - used)
    });

  } catch (error) {
    console.error("Usage error:", error.message);

    res.status(500).json({
      error: "Could not load message usage."
    });
  }
});

// =====================================
// CHAT WITH TOBY AI
// =====================================

app.post("/chat", async (req, res) => {
  let userId;
  let usageReserved = false;

  try {
    userId = requireLogin(req, res);
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

    // Check message limit.
    await checkDailyUsage(userId);

    const reserved = await increaseDailyUsage(userId);

    if (!reserved) {
      const used = await checkDailyUsage(userId);

      return res.status(429).json({
        error: "You have used your 30 free messages for today. Please come back tomorrow.",
        limit: FREE_DAILY_LIMIT,
        used
      });
    }

    usageReserved = true;

    // Validate or create conversation.
    let conversationId = req.body.conversationId;

    if (conversationId) {
      if (!/^\d+$/.test(String(conversationId))) {
        throw new Error("Invalid conversation ID.");
      }

      const existing = await db.query(
        `SELECT id
         FROM conversations
         WHERE id = $1
           AND clerk_user_id = $2`,
        [conversationId, userId]
      );

      if (!existing.rows.length) {
        throw new Error("Conversation not found. Start a new chat.");
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

    // Prepare a smaller, faster conversation context.
const conversationText = messages
  .slice(-10)
  .map(message => {
    const role =
      message.role === "assistant" ? "assistant" : "user";

    const content =
      typeof message.content === "string"
        ? message.content.slice(0, 2000)
        : "";

    return `${role}: ${content}`;
  })
  .join("\n");

    // Generate reply.
    const reply = await generateTobyReply(
      conversationText,
      req.body.attachment || null
    );

    // Save both messages.
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
       WHERE id = $1
         AND clerk_user_id = $2`,
      [conversationId, userId]
    );

    usageReserved = false;

    res.json({
      reply,
      conversationId,
      usage: {
        used: Number(reserved.message_count),
        limit: FREE_DAILY_LIMIT,
        remaining:
          FREE_DAILY_LIMIT - Number(reserved.message_count)
      }
    });

  } catch (error) {
    console.error("Toby AI chat error:", error);

    if (userId && usageReserved) {
      try {
        await refundDailyUsage(userId);
      } catch (refundError) {
        console.error("Usage refund error:", refundError.message);
      }
    }

    res.status(500).json({
      error: "Toby AI is having trouble. Please try again."
    });
  }
});

// =====================================
// IMAGE GENERATION
// =====================================


  

app.post("/generate-image", async (req, res) => {
  try {
    const userId = requireLogin(req, res);
    if (!userId) return;

    const prompt = req.body.prompt;

    if (
      typeof prompt !== "string" ||
      !prompt.trim() ||
      prompt.length > 2000
    ) {
      return res.status(400).json({
        error: "Enter a valid image description."
      });
    }

    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = process.env.CLOUDFLARE_API_TOKEN;

    if (!accountId || !apiToken) {
      return res.status(500).json({
        error: "Cloudflare is not configured."
      });
    }

    console.log("Starting Cloudflare image generation...");

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          prompt: prompt.trim(),
          steps: 4
        })
      }
    );

    const contentType =
      response.headers.get("content-type") || "";

    if (!response.ok) {
      const errorText = await response.text();

      console.error("Cloudflare HTTP error:", {
        status: response.status,
        details: errorText.slice(0, 2000)
      });

      return res.status(502).json({
        error: "Cloudflare rejected the image request."
      });
    }

    let imageBuffer;
    let mimeType = "image/png";

    if (contentType.startsWith("image/")) {
      imageBuffer = Buffer.from(
        await response.arrayBuffer()
      );

      mimeType = contentType.split(";")[0];

    } else {
      const responseText = await response.text();

      let data;

      try {
        data = JSON.parse(responseText);
      } catch {
        console.error(
          "Unexpected Cloudflare response:",
          responseText.slice(0, 1000)
        );

        return res.status(502).json({
          error: "Cloudflare returned an unexpected response."
        });
      }

      const imageData =
        data.result?.image || data.result;

      if (
        typeof imageData !== "string" ||
        !imageData
      ) {
        console.error(
          "No image in Cloudflare response:",
          JSON.stringify(data).slice(0, 1000)
        );

        return res.status(502).json({
          error: "Cloudflare did not return an image."
        });
      }

      imageBuffer = Buffer.from(imageData, "base64");
    }

    if (!imageBuffer || imageBuffer.length === 0) {
      return res.status(502).json({
        error: "The generated image was empty."
      });
    }

    console.log("Cloudflare image generated successfully.");

    return res.json({
      image: imageBuffer.toString("base64"),
      mimeType
    });

  } catch (error) {
    console.error("Cloudflare image generation error:", {
      message: error.message
    });

    return res.status(500).json({
      error: "Image generation failed. Please try again."
    });
  }
});




// =====================================
// TOBY AI VOICE
// =====================================

app.post("/speak", async (req, res) => {
  try {
    const userId = requireLogin(req, res);
    if (!userId) return;

    const text = req.body.text;

    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.length > 2000
    ) {
      return res.status(400).json({
        error: "Enter text of up to 2000 characters."
      });
    }

    const interaction = await ai.interactions.create({
      model: "gemini-3.8-flash-lite-tts",

      input: [
        {
          type: "user_input",
          content: [
            {
              type: "text",
              text: text.trim(),
              annotations: [
                {
                  type: "speech_metadata",
                  style: "Friendly, warm, natural, relaxed conversational voice. Speak clearly and naturally."
                }
              ]
            }
          ]
        }
      ],

      response_format: {
        type: "audio"
      },

      generation_config: {
        speech_config: [
          {
            voice: "Puck"
          }
        ]
      }
    });

    const audioData = interaction.output_audio?.data;

    if (!audioData) {
      return res.status(502).json({
        error: "No audio was generated."
      });
    }

    res.json({
      audio: audioData,
      mimeType: "audio/wav"
    });

  } catch (error) {
    console.error("Voice generation error:", error);

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
// ERROR HANDLER
// =====================================

app.use((error, req, res, next) => {
  console.error("Server error:", error.message);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    error: "Something went wrong. Please try again."
  });
});

// =====================================
// START SERVER
// =====================================

initializeDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Toby AI is running on port ${PORT}`);
    });
  })
  .catch(error => {
    console.error("Database startup error:", error);
    process.exit(1);
  });
