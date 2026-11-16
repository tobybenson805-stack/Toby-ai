
require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const path = require("path");

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

app.post("/chat", async (req, res) => {
  try {
    const messages = req.body.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: "Please send a message."
      });
    }

    const safeMessages = messages.slice(-20);

    const response = await client.responses.create({
      model: "gpt-6-astra",
      instructions: "You are Toby AI, a friendly, funny and helpful AI assistant. Speak English. Help with schoolwork using simple step-by-step explanations. Be respectful and entertaining.",
      input: safeMessages
    });

    res.json({
      reply: response.output_text
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Toby AI is having trouble. Please try again."
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Toby AI is running on port ${PORT}`);
});
