require("dotenv").config();
const cors = require("cors");
const express = require("express");
const fetch = require("node-fetch");
const axios = require("axios");
const bodyParser = require("body-parser");
const crypto = require("crypto")

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

const CLIENT_ID = "388a0e6652106e31fd681110b0069668"; 
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const REDIRECT_URI = "https://web-pixel-backend-3c6p.onrender.com/oauth/callback";

// Step 1: Generate install link for merchant
app.get("/install", (req, res) => {
  const shop = req.query.shop; // e.g. medical-and-lab-supplies.myshopify.com
  if (!shop) return res.status(400).send("Missing shop query param");

  const state = crypto.randomBytes(16).toString("hex"); // CSRF token
  const scopes = "read_customer_events,read_customers,read_orders,write_pixels";

  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=${scopes}&redirect_uri=${REDIRECT_URI}&state=${state}`;

  res.redirect(installUrl);
});

app.get("/oauth/callback", async (req, res) => {
  const { shop, code, state } = req.query;

  if (!shop || !code) return res.status(400).send("Missing params");

  try {
    // Exchange code for Admin API token
    const tokenResponse = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: code
    });

    const accessToken = tokenResponse.data.access_token;
    console.log("Got Admin API token:", accessToken);

    // Save accessToken in DB or in memory for now
    // Example: run webPixelCreate automatically
    await createWebPixel(shop, accessToken);

    res.send("App installed and pixel connected successfully!");
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send("Failed to get access token");
  }
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

const createWebPixel = async (shop, accessToken) => {
  const query = `
    mutation webPixelCreate($settings: JSON!) {
      webPixelCreate(webPixel: { settings: $settings }) {
        userErrors { message }
        webPixel { id }
      }
    }
  `;
  const variables = {
    settings: { name: "HubSpot Pixel" }
  };

  const response = await axios.post(
    `https://${shop}/admin/api/2024-10/graphql.json`,
    { query, variables },
    {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json"
      }
    }
  );

  console.log("Pixel created:", response.data);
  return response.data;
};


// 3️⃣ Shopify webhook endpoint
app.post("/checkout-completed", async (req, res) => {
  const checkout = req.body;

  if (!HUBSPOT_ACCESS_TOKEN) {
    return res.status(400).json({ error: "HubSpot not authorized yet" });
  }

  try {
    // Send contact data
  const contactResponse = await axios.post(
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
      hs_order_name: "Shopify order",
      hs_total_price: checkout.total,
    },
    associations: [
        {
          to: { id: contactResponse.data.id }, // HubSpot Order ID
          types: [
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: 507
            }
          ]
        }
      ]
  },
  {
    headers: {
      Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
  }
);

for (let item of checkout.line_items) {
  await axios.post(
    "https://api.hubapi.com/crm/v3/objects/line_items",
    {
      properties: {
        name: item.title,
        quantity: item.quantity,
        price: item.price,
        hs_sku: item.sku,
      },
      associations: [
        {
          to: { id: orderResponse.data.id }, // HubSpot Order ID
          types: [
            {
              associationCategory: "HUBSPOT_DEFINED",
              associationTypeId: 514
            }
          ]
        }
      ]
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
