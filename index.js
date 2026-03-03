require("dotenv").config();
const cors = require("cors");
const express = require("express");
const fetch = require("node-fetch");
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();
app.use(cors({
  origin: "*",   // allow all (safe for webhook style backend)
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());

const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;


// Root route (optional)
app.get("/", (req, res) => {
  res.send("Backend is running!");
});

// 1️⃣ Start OAuth flow
// app.get("/oauth/start", (req, res) => {
//   const clientId = process.env.HUBSPOT_CLIENT_ID;
//   const redirectUri = encodeURIComponent(process.env.HUBSPOT_REDIRECT_URI);
//   const appId = process.env.HUBSPOT_APP_ID;

//   const scopes = encodeURIComponent(
//     "crm.objects.contacts.write crm.objects.deals.write crm.objects.orders.write"
//   );

//   const url = `https://mcp-na2.hubspot.com/oauth/${appId}/authorize/user?client_id=${clientId}&redirect_uri=${redirectUri}&scope=${scopes}`;

//   res.redirect(url);
// });



// 2️⃣ OAuth callback
// app.get("/oauth/callback", async (req, res) => {
//   try {
//     const code = req.query.code;
//     const clientId = process.env.HUBSPOT_CLIENT_ID;
//     const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
//     const redirectUri = process.env.HUBSPOT_REDIRECT_URI;
//     const codeVerifier = process.env.CODE_VERIFIER;
//     const tokenResponse = await axios.post(
//   "https://api.hubapi.com/oauth/v1/token",
//   new URLSearchParams({
//     grant_type: "authorization_code",
//     client_id: clientId,
//     client_secret: clientSecret,
//     redirect_uri: redirectUri,
//     code: code,
//     code_verifier: codeVerifier,
//   }),
//   {
//     headers: {
//       "Content-Type": "application/x-www-form-urlencoded",
//         },
//       }
//     );

//     const tokenData = tokenResponse.data;

//     if (tokenData.error) {
//       console.error("HubSpot OAuth error:", tokenData);
//       return res.status(400).send("HubSpot OAuth failed");
//     }

//     HUBSPOT_ACCESS_TOKEN = tokenData.access_token;
//     const HUBSPOT_REFRESH_TOKEN = tokenData.refresh_token;
//     console.log("Access token:", HUBSPOT_ACCESS_TOKEN);
//       console.log("Refresh token:", HUBSPOT_REFRESH_TOKEN);

//     res.send("HubSpot authorized! You can now send checkout data.");
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: err.message });
//   }
// });


// 3️⃣ Shopify webhook endpoint
app.post("/checkout-completed", async (req, res) => {
  const checkout = req.body;

  if (!HUBSPOT_ACCESS_TOKEN) {
    return res.status(400).json({ error: "HubSpot not authorized yet" });
  }

  try {
    // Send contact data
    await axios.post(
  "https://api.hubapi.com/crm/v3/objects/contacts",
  {
    properties: {
      email: checkout.email,
      firstname: checkout.first_name || "",
      lastname: checkout.last_name || "",
    },
  },
  {
    headers: {
      Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
    },
  }
);

    // Send order data
   const orderResponse = await axios.post(
  "https://api.hubapi.com/crm/v3/objects/orders",
  {
    properties: {
      hs_order_name: checkout.order?.id,
      hs_currency_code: checkout.totalPrice?.currencyCode,
      hs_total: checkout.totalPrice?.amount,
      email: checkout.email,
      firstname: checkout.billingAddress?.firstName,
      lastname: checkout.billingAddress?.lastName,
    },
  },
  {
    headers: {
      Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
  }
);

for (let item of checkout.lineItems) {
  await axios.post(
    "https://api.hubapi.com/crm/v3/objects/line_items",
    {
      properties: {
        name: item.title,
        quantity: item.quantity,
        price: item.price?.amount,
        hs_sku: item.variant?.sku,
        associatedorderid: orderResponse.data.id, // associate with the order
      },
    },
    {
      headers: {
        Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

    res.status(200).json({ success: true });
  } catch (err) {
    console.error("Error sending to HubSpot:", err);
    res.status(500).json({ error: "Failed to send data to HubSpot" });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
