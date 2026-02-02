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
  const redirectUri = encodeURIComponent(process.env.HUBSPOT_REDIRECT_URI);
  const appId = process.env.HUBSPOT_APP_ID;

  const scopes = encodeURIComponent(
    "crm.objects.contacts.write crm.objects.deals.write crm.objects.orders.write"
  );

  const url = `https://mcp-na2.hubspot.com/oauth/${appId}/authorize/user?client_id=${clientId}&redirect_uri=${redirectUri}&scope=${scopes}`;

  res.redirect(url);
});



// 2️⃣ OAuth callback
app.get("/oauth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const clientId = process.env.HUBSPOT_CLIENT_ID;
    const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
    const redirectUri = process.env.HUBSPOT_REDIRECT_URI;

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

    if (tokenData.error) {
      console.error("HubSpot OAuth error:", tokenData);
      return res.status(400).send("HubSpot OAuth failed");
    }

    HUBSPOT_ACCESS_TOKEN = tokenData.access_token;
    const HUBSPOT_REFRESH_TOKEN = tokenData.refresh_token;
    console.log("Access token:", HUBSPOT_ACCESS_TOKEN);
console.log("Refresh token:", HUBSPOT_REFRESH_TOKEN);

    res.send("HubSpot authorized! You can now send checkout data.");
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error during OAuth");
  }
});


// 3️⃣ Shopify webhook endpoint
app.post("/checkout-completed", async (req, res) => {
  const checkout = req.body;

  if (!HUBSPOT_ACCESS_TOKEN) {
    return res.status(400).json({ error: "HubSpot not authorized yet" });
  }

  try {
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
          firstname: checkout.billingAddress?.firstName || "",
          lastname: checkout.billingAddress?.lastName || "",
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
  } catch (err) {
    console.error("Error sending to HubSpot:", err);
    res.status(500).json({ error: "Failed to send data to HubSpot" });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
