
require("dotenv").config();

const express = require("express");
const { GoogleGenAI } = require("@google/genai");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const PLAN_LIMITS = {
  free: 20,
  plus: 100,
  pro: 300
};

app.post("/chat", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || "";

    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Please log in first." });
    }

    const token = authHeader.slice(7);

    const { data: userData, error: authError } =
      await supabase.auth.getUser(token);

    if (authError || !userData.user) {
      return res.status(401).json({ error: "Your session is invalid. Please log in again." });
    }

    const user = userData.user;

    const messages = req.body.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Please send a message." });
    }

    const { data: subscription, error: subError } = await supabase
      .from("subscriptions")
      .select("plan,status")
      .eq("user_id", user.id)
      .maybeSingle();

    if (subError) throw subError;

    const plan = subscription?.status === "active"
      ? subscription.plan
      : "free";

    const limit = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

    const today = new Date().toISOString().slice(0, 10);

    const { data: usage, error: usageError } = await supabase
      .from("daily_usage")
      .select("message_count")
      .eq("user_id", user.id)
      .eq("usage_date", today)
      .maybeSingle();

    if (usageError) throw usageError;

    const used = usage?.message_count || 0;

    if (used >= limit) {
      return res.status(429).json({
        error: `Daily message limit reached (${limit}). Try again tomorrow.`
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

    const { error: saveError } = await supabase
      .from("daily_usage")
      .upsert({
        user_id: user.id,
        usage_date: today,
        message_count: used + 1
      }, {
        onConflict: "user_id,usage_date"
      });

    if (saveError) throw saveError;

    res.json({
      reply: response.text || "I couldn't create a reply. Try again.",
      plan,
      remaining: limit - used - 1
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
