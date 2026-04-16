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
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// ── Reconciliation Map ─────────────────────────────────────────────────────
// Lightweight in-memory store tracking each email's lifecycle state.
// Resets on server restart — HubSpot is the persistent source of truth.
// Key: email (string)
// Value: { status: 'LEAD'|'CUSTOMER', firstname, lastname, timestamp }
const reconciliationMap = new Map();


// Root route (optional)
app.get("/", (req, res) => {
  res.send("Backend is running!");
});


// // STEP 1: Install route
// app.get('/install', (req, res) => {
//   const shop = req.query.shop;

//   if (!shop) {
//     return res.send('Missing shop parameter');
//   }

//   const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${process.env.SHOPIFY_CLIENT_ID}&scope=${process.env.SCOPES}&redirect_uri=${process.env.SHOPIFY_REDIRECT_URI}`;

//   res.redirect(installUrl);
// });

// // STEP 2: Callback route (THIS MUST MATCH YOUR REDIRECT URI)
// app.get('/oauth/callback', async (req, res) => {
//   const { shop, code } = req.query;

//   if (!shop || !code) {
//     return res.send('Missing shop or code');
//   }

//   try {
//     // STEP 3: Exchange code for token
//     const response = await axios.post(
//       `https://${shop}/admin/oauth/access_token`,
//       {
//         client_id: process.env.SHOPIFY_CLIENT_ID,
//         client_secret: process.env.SHOPIFY_CLIENT_SECRET,
//         code
//       }
//     );

//     const accessToken = response.data.access_token;

//     console.log('✅ ACCESS TOKEN:', accessToken);

//     // 👉 Save this somewhere (DB ideally)
//     res.send(`
//       <h2>App Installed Successfully 🎉</h2>
//       <p>Store: ${shop}</p>
//       <p><strong>Access Token:</strong></p>
//       <code>${accessToken}</code>
//     `);

//   } catch (error) {
//     console.error('❌ ERROR:', error.response?.data || error.message);
//     res.send('Error generating token');
//   }
// });

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

app.post("/connect-pixel", async (req, res) => {
  try {
    const shop = "medical-and-lab-supplies.myshopify.com";

    const response = await axios.post(
      `https://${shop}/admin/api/2026-01/graphql.json`,
            {
        query: `
          mutation webPixelCreate($settings: JSON!) {
            webPixelCreate(webPixel: { settings: $settings }) {
              userErrors {
                code
                field
                message
              }
              webPixel {
                settings
                id
              }
            }
          }
        `,
        variables: {
          settings: {
            name: "Test Pixel"
          }
        }
      },
      {
        headers: {
          "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
          "Content-Type": "application/json"
        }
      }
    );

    res.json(response.data);
  } catch (error) {
  console.error(
    "Shopify error:",
    error.response?.data || error.message
  );
  res.status(500).json(error.response?.data || { error: error.message });
}
});

app.post('/webhook/orders-create', async (req, res) => {
  const order = req.body;

  // Always respond fast to Shopify
  res.sendStatus(200);

  try {
    if (!order.customer) return;

    const customerId = order.customer.id;

    // 🔹 Get customer from Shopify
    const customerRes = await axios.get(
      `https://medical-and-lab-supplies.myshopify.com/admin/api/2026-01/customers/${customerId}.json`,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
        }
      }
    );

    const tags = customerRes.data.customer.tags;

    // 🔹 Check if B2B
    if (tags && tags.includes('PROC_ACCT')) {

      // 🔹 Update order with PO number
      await axios.put(
        `https://medical-and-lab-supplies.myshopify.com/admin/api/2026-01/orders/${order.id}.json`,
        {
          order: {
            id: order.id,
            po_number: "PROC_ACCT"
          }
        },
        {
          headers: {
            'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log(`Order ${order.id} updated with B2B PO number`);
    }

  } catch (err) {
    console.error(
      'Error:',
      err.response?.data || err.message
    );
  }

  // ── HubSpot reconciliation: order = truth, promote to CUSTOMER ────────────
  // Runs after B2B logic. Isolated — any failure here never affects Shopify response.
  if (order.email && HUBSPOT_ACCESS_TOKEN) {
    reconcileOrderContact(order).catch(err =>
      console.error('[HubSpot] reconcileOrderContact error:', err.message)
    );
  }
});



// // 3️⃣ Shopify webhook endpoint
// app.post("/checkout-completed", async (req, res) => {
//   const checkout = req.body;

//   if (!HUBSPOT_ACCESS_TOKEN) {
//     return res.status(400).json({ error: "HubSpot not authorized yet" });
//   }

//   try {
//     // Send contact data
//   const contactResponse = await axios.post(
//   "https://api.hubapi.com/crm/v3/objects/contacts",
//   {
//     properties: {
//       email: checkout.email,
//       firstname: checkout.first_name || "",
//       lastname: checkout.last_name || "",
//     },
//   },
//   {
//     headers: {
//       Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
//     },
//   }
// );

//     // Send order data
//    const orderResponse = await axios.post(
//   "https://api.hubapi.com/crm/v3/objects/orders",
//   {
//     properties: {
//       hs_order_name: "Shopify order",
//       hs_total_price: checkout.total,
//     },
//     associations: [
//         {
//           to: { id: contactResponse.data.id }, // HubSpot Order ID
//           types: [
//             {
//               associationCategory: "HUBSPOT_DEFINED",
//               associationTypeId: 507
//             }
//           ]
//         }
//       ]
//   },
//   {
//     headers: {
//       Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
//       "Content-Type": "application/json",
//     },
//   }
// );

// for (let item of checkout.line_items) {
//   await axios.post(
//     "https://api.hubapi.com/crm/v3/objects/line_items",
//     {
//       properties: {
//         name: item.title,
//         quantity: item.quantity,
//         price: item.price,
//         hs_sku: item.sku,
//       },
//       associations: [
//         {
//           to: { id: orderResponse.data.id }, // HubSpot Order ID
//           types: [
//             {
//               associationCategory: "HUBSPOT_DEFINED",
//               associationTypeId: 514
//             }
//           ]
//         }
//       ]
//     },
//     {
//       headers: {
//         Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
//         "Content-Type": "application/json",
//       },
//     }
//   );
// }

//     res.status(200).json({ success: true });
//   } catch (err) {
//     console.error("Error sending to HubSpot:", err);
//     res.status(500).json({ error: "Failed to send data to HubSpot" });
//   }
// });


// Shopify webhook endpoint for contact creation
app.post("/checkout-completed", async (req, res) => {
  const checkout = req.body;

  if (!HUBSPOT_ACCESS_TOKEN) {
    return res.status(400).json({ error: "HubSpot not authorized yet" });
  }

  try {
    const email = checkout.email;
    if (!email || email.trim() === "") {
      console.log("Skipping HubSpot contact creation because email is empty");
      return;
    }

    // 1️⃣ Check if contact already exists
    const searchResponse = await axios.post(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        filterGroups: [
          {
            filters: [
              {
                propertyName: "email",
                operator: "EQ",
                value: email,
              },
            ],
          },
        ],
        properties: ["email", "firstname", "lastname", "lifecyclestage"],
        limit: 1,
      },
      {
        headers: {
          Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    const hsHeaders = {
      Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    };

    if (searchResponse.data.results.length === 0) {
      // 2️⃣ No contact yet — create as LEAD only (pixel = intent, not purchase)
      const contactResponse = await axios.post(
        "https://api.hubapi.com/crm/v3/objects/contacts",
        {
          properties: {
            email: email,
            firstname: checkout.first_name || "",
            lastname: checkout.last_name || "",
            lifecyclestage: "lead",
          },
        },
        { headers: hsHeaders }
      );
      console.log("[HubSpot] LEAD contact created:", contactResponse.data.id);
    } else {
      // 3️⃣ Contact exists — only update to lead if not already a customer
      // HubSpot lifecycle can only move forward, never backward
      const existing = searchResponse.data.results[0];
      const currentStage = existing.properties?.lifecyclestage;

      if (currentStage !== "customer") {
        const updateProps = { lifecyclestage: "lead" };

        // Fix placeholder names set by previous "Guest"/"Shopify" fallback
        if (!existing.properties?.firstname || existing.properties.firstname === "Guest") {
          updateProps.firstname = checkout.first_name || "";
        }
        if (!existing.properties?.lastname || existing.properties.lastname === "Shopify") {
          updateProps.lastname = checkout.last_name || "";
        }

        await axios.patch(
          `https://api.hubapi.com/crm/v3/objects/contacts/${existing.id}`,
          { properties: updateProps },
          { headers: hsHeaders }
        );
        console.log(`[HubSpot] Existing contact ${existing.id} updated to LEAD`);
      } else {
        console.log(`[HubSpot] Contact ${existing.id} is already CUSTOMER — skipping lifecycle downgrade`);
      }
    }

    // Track in reconciliation map
    reconciliationMap.set(email, {
      status: "LEAD",
      firstname: checkout.first_name || "",
      lastname: checkout.last_name || "",
      timestamp: Date.now(),
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error("Error sending to HubSpot:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to send data to HubSpot" });
  }
});

// ── HubSpot Order Reconciliation Helper ───────────────────────────────────
// Called after every orders/create webhook.
// Finds or creates the HubSpot contact and promotes lifecycle to "customer".
// Fixes any placeholder "Guest"/"Shopify" names written during the checkout step.
async function reconcileOrderContact(order) {
  const email = order.email;
  const hsHeaders = {
    Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };

  // Resolve real name from order object (customer block or billing address)
  const firstname = order.customer?.first_name || order.billing_address?.first_name || "";
  const lastname  = order.customer?.last_name  || order.billing_address?.last_name  || "";

  // Search HubSpot for existing contact by email
  const searchRes = await axios.post(
    "https://api.hubapi.com/crm/v3/objects/contacts/search",
    {
      filterGroups: [
        { filters: [{ propertyName: "email", operator: "EQ", value: email }] },
      ],
      properties: ["email", "firstname", "lastname", "lifecyclestage"],
      limit: 1,
    },
    { headers: hsHeaders }
  );

  if (searchRes.data.results.length > 0) {
    // ── Contact exists: update lifecycle + fix guest placeholder names ──────
    const contact = searchRes.data.results[0];
    const updateProps = { lifecyclestage: "customer" };

    if (!contact.properties?.firstname || contact.properties.firstname === "Guest") {
      updateProps.firstname = firstname;
    }
    if (!contact.properties?.lastname || contact.properties.lastname === "Shopify") {
      updateProps.lastname = lastname;
    }

    await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contact.id}`,
      { properties: updateProps },
      { headers: hsHeaders }
    );
    console.log(`[HubSpot] Contact ${contact.id} promoted to CUSTOMER (order ${order.id})`);
  } else {
    // ── No contact: create directly as customer ─────────────────────────────
    const createRes = await axios.post(
      "https://api.hubapi.com/crm/v3/objects/contacts",
      {
        properties: { email, firstname, lastname, lifecyclestage: "customer" },
      },
      { headers: hsHeaders }
    );
    console.log(`[HubSpot] New CUSTOMER contact created: ${createRes.data.id} (order ${order.id})`);
  }

  // Update reconciliation map — order is the final truth
  reconciliationMap.set(email, {
    status: "CUSTOMER",
    firstname,
    lastname,
    timestamp: Date.now(),
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
