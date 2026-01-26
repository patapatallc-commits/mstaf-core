app.post("/webhook", async (req, res) => {
  try {
    const msg =
      req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!msg) {
      return res.sendStatus(200);
    }

    const from = msg.from;
    const text = msg.text?.body?.trim() || "";
    const upper = text.toUpperCase();

    if (upper.startsWith("MSTAF UPLOAD")) {
      await sendText(
        from,
        "✅ MSTAF UPLOAD received.\nPlease send:\n1) Product photo\n2) Price\n3) Store name + address\n4) Country/City"
      );
    } else if (upper.startsWith("MSTAF ")) {
      const query = text.substring(5).trim();
      await sendText(
        from,
        `🔎 Searching MSTAF for: ${query}\n\n(Next: database + store addresses)`
      );
    } else {
      await sendText(
        from,
        "Hi 👋 Welcome to MSTAF.\nTry:\n• MSTAF TELEVISION\n• MSTAF LAPTOP\n• MSTAF UPLOAD"
      );
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    return res.sendStatus(200);
  }
});

