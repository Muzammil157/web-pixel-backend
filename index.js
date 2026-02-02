require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

let HUBSPOT_ACCESS_TOKEN = null; // Will store after OAuth

// Root route (optional)
app.get("/", (req, res) => {
  res.send("Backend is running!");
});

// 1️⃣ Start OAuth flow
app.get("/oauth/start", (req, res) => {
  const clientId = process.env.HUBSPOT_CLIENT_ID;
  const redirectUri = process.env.HUBSPOT_REDIRECT_URI;
  const url = `https://mcp-na2.hubspot.com/oauth/authorize/user?client_id=${clientId}&redirect_uri=${redirectUri}`;
  res.redirect(url);
});

// 2️⃣ OAuth callback
app.get("/oauth/callback", async (req, res) => {
  const code = req.query.code;
  const clientId = process.env.HUBSPOT_CLIENT_ID;
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
  const redirectUri = process.env.HUBSPOT_REDIRECT_URI;

  // Exchange code for access token
  const tokenResponse = await fetch("https://api.hubapi.com/oauth/v1/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code: code
    })
  });

  const tokenData = await tokenResponse.json();
  HUBSPOT_ACCESS_TOKEN = tokenData.access_token;

  res.send("HubSpot authorized! You can now send checkout data.");
});

// 3️⃣ Shopify webhook endpoint
app.post("/checkout-completed", async (req, res) => {
  const checkout = req.body;

  if (!HUBSPOT_ACCESS_TOKEN) {
    return res.status(400).json({ error: "HubSpot not authorized yet" });
  }

  // Send contact data
  await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: {
        email: checkout.email,
        firstname: checkout.billingAddress.firstName,
        lastname: checkout.billingAddress.lastName,
      },
    }),
  });

  // Send order data
  await fetch("https://api.hubapi.com/crm/v3/objects/orders", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: {
        hs_order_id: checkout.order_id,
        amount: checkout.total,
        currency: checkout.currency,
        email: checkout.email,
      },
    }),
  });

  res.status(200).json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
