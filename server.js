
require("dotenv").config();

const express = require("express");
const path = require("path");

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const MODEL = "gemini-2.5-flash";

app.post("/chat", async (req, res) => {
  try {
    const messages = req.body.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Please send a message." });
    }

    const contents = messages.slice(-20).map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content) }]
    }));

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: "You are Toby AI, a friendly, funny and helpful AI assistant." }]
          },
          contents
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(JSON.stringify(data));
      return res.status(500).json({ error: "Toby AI is having trouble. Please try again." });
    }

    const reply = (data.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || "")
      .join("");

    res.json({ reply });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Toby AI is having trouble. Please try again." });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Toby AI is running on port ${PORT}`);
});
