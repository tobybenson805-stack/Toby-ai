
require("dotenv").config();

const express = require("express");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");
const { clerkMiddleware, getAuth } = require("@clerk/express");

const app = express();

// Clerk middleware must run before other middleware.
app.use(clerkMiddleware());

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

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

    res.json({
      reply: response.text || "I couldn't create a reply."
    });

  } catch (error) {
    console.error("Toby AI error:", error.message);

    res.status(500).json({
      error: "Toby AI is having trouble. Please try again."
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Toby AI is running on port ${PORT}`);
});
