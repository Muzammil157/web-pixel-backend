require("dotenv").config();
const cors = require("cors");
const express = require("express");
const fetch = require("node-fetch");
const axios = require("axios");
const bodyParser = require("body-parser");
const Database = require("better-sqlite3");

// ── Persistent store ───────────────────────────────────────────────────────
// hutkMap and checkoutTokenMap are persisted here so they survive restarts,
// deploys, and Render sleep cycles. In-memory maps remain as a fast cache.
const db = new Database(process.env.DB_PATH || "./payment_links.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS hutk_store (
    token      TEXT PRIMARY KEY,
    hutk       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS checkout_token_map (
    token      TEXT PRIMARY KEY,
    email      TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attribution_queue (
    order_id   TEXT PRIMARY KEY,
    order_gid  TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0
  );
`);
const _dbSetHutk          = db.prepare("INSERT OR REPLACE INTO hutk_store (token, hutk, created_at) VALUES (?, ?, ?)");
const _dbGetHutk          = db.prepare("SELECT hutk FROM hutk_store WHERE token = ?");
const _dbSetCheckoutToken = db.prepare("INSERT OR REPLACE INTO checkout_token_map (token, email, created_at) VALUES (?, ?, ?)");
const _dbGetCheckoutToken = db.prepare("SELECT email FROM checkout_token_map WHERE token = ?");
const _dbHasCheckoutToken = db.prepare("SELECT 1 FROM checkout_token_map WHERE token = ?");
// Orders whose Shopify customer journey wasn't ready yet — retried by the sweep.
const _dbQueueAttribution  = db.prepare("INSERT OR IGNORE INTO attribution_queue (order_id, order_gid, contact_id, created_at, attempts) VALUES (?, ?, ?, ?, 1)");
const _dbPendingAttribution = db.prepare("SELECT order_id, order_gid, contact_id, created_at, attempts FROM attribution_queue ORDER BY created_at");
const _dbBumpAttribution   = db.prepare("UPDATE attribution_queue SET attempts = attempts + 1 WHERE order_id = ?");
const _dbDoneAttribution   = db.prepare("DELETE FROM attribution_queue WHERE order_id = ?");

const app = express();
app.use(cors({
  origin: "*",   // allow all (safe for webhook style backend)
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());

const HUBSPOT_ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// ── Reconciliation Maps ────────────────────────────────────────────────────
// Both reset on server restart — HubSpot is the persistent source of truth.

// Primary: email → { status, checkout_token, firstname, lastname, timestamp }
const reconciliationMap = new Map();

// Secondary index: checkout_token → email
// Bridges the gap when order.email differs from checkout pixel email.
// Populated by /checkout-completed, consumed by reconcileOrderContact.
const checkoutTokenMap = new Map();

// Abandoned checkout URL index: checkout_token → abandoned_checkout_url
// Populated by /webhook/checkout-create (Shopify webhook — has the real recovery URL).
// Consumed by /checkout-completed to set shopify_checkout_url on the HubSpot contact.
const abandonedUrlMap = new Map();

// HubSpot visitor cookie index: checkout_token → hutk
// checkout/create fires before the customer enters their email, so we can't submit
// the HubSpot form there. Instead we store the hutk here and look it up in
// /checkout-completed (pixel) where the email is always available.
const hutkMap = new Map();

// ── Seed in-memory maps from SQLite on startup ─────────────────────────────
// Ensures hutk and checkout token data survives Render restarts and deploys.
for (const row of db.prepare("SELECT token, hutk FROM hutk_store").all()) {
  hutkMap.set(row.token, row.hutk);
}
for (const row of db.prepare("SELECT token, email FROM checkout_token_map").all()) {
  checkoutTokenMap.set(row.token, row.email);
}
console.log(`[DB] Seeded ${hutkMap.size} hutk + ${checkoutTokenMap.size} checkout token entries from SQLite`);


// Root route (optional)
app.get("/", (req, res) => {
  res.send("Backend is running!");
});


// // STEP 1: Install route
app.get('/install', (req, res) => {
  const shop = req.query.shop;

  if (!shop) {
    return res.send('Missing shop parameter');
  }

  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${process.env.SHOPIFY_CLIENT_ID}&scope=${process.env.SCOPES}&redirect_uri=${process.env.SHOPIFY_REDIRECT_URI}`;

  res.redirect(installUrl);
});

// STEP 2: Callback route (THIS MUST MATCH YOUR REDIRECT URI)
app.get('/oauth/callback', async (req, res) => {
  const { shop, code } = req.query;

  if (!shop || !code) {
    return res.send('Missing shop or code');
  }

  try {
    // STEP 3: Exchange code for token
    const response = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      {
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        code
      }
    );

    const accessToken = response.data.access_token;

    console.log('✅ ACCESS TOKEN:', accessToken);

    // 👉 Save this somewhere (DB ideally)
    res.send(`
      <h2>App Installed Successfully 🎉</h2>
      <p>Store: ${shop}</p>
      <p><strong>Access Token:</strong></p>
      <code>${accessToken}</code>
    `);

  } catch (error) {
    console.error('❌ ERROR:', error.response?.data || error.message);
    res.send('Error generating token');
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

app.post('/webhook/checkout-create', (req, res) => {
  res.sendStatus(200); // respond immediately — Shopify requires fast acknowledgement

  const checkout = req.body;
  const token              = checkout.token || "";
  const abandonedCheckoutUrl = checkout.abandoned_checkout_url || "";
  const email              = (checkout.email || "").trim();

  console.log(`\n──────────── checkout/create | token: ${token} | email: ${email || "MISSING"} ────────────`);

  // ── Store abandoned checkout URL for /checkout-completed to use later ──────
  // When the pixel fires (checkout_contact_info_submitted), it looks up this URL
  // by token so the real Shopify recovery link ends up on the HubSpot contact.
  if (token && abandonedCheckoutUrl) {
    abandonedUrlMap.set(token, abandonedCheckoutUrl);
    console.log(`[Shopify] Stored abandoned_checkout_url for token: ${token}`);
  } else {
    console.log(`[Shopify] No abandoned_checkout_url to store | token: ${token || "MISSING"}`);
  }

  // ── Extract hubspotutk from note_attributes and store by token ───────────
  // theme.liquid saves the hubspotutk browser cookie as a Shopify cart
  // attribute via /cart/update.js. Shopify carries it here as note_attributes.
  //
  // We DO NOT submit the HubSpot form here — checkout/create fires before the
  // customer enters their email, so email is often missing at this point.
  // Instead we store hutk by token so /checkout-completed (pixel) can look it
  // up later when the email is guaranteed to be available.
  const noteAttributes = Array.isArray(checkout.note_attributes) ? checkout.note_attributes : [];
  const hutkAttr = noteAttributes.find(attr => attr.name === "hubspotutk");
  const hutk = hutkAttr?.value || null;

  if (hutk && token) {
    hutkMap.set(token, hutk);
    _dbSetHutk.run(token, hutk, Date.now());
    console.log(`[HubSpot] hutk stored for token: ${token} → will be used when pixel fires with email`);
  } else {
    console.log(`[HubSpot] hutk not found in note_attributes — visitor stitching will be skipped if cookie was blocked`);
  }
  console.log(`──────────── checkout/create END | token: ${token} ────────────\n`);
});

// ── Pixel: checkout_started ────────────────────────────────────────────────
// Fired by the web pixel for ALL checkout paths including accelerated checkout
// (Shop Pay, Apple Pay, Google Pay, Buy Now). Stores hutk in hutkMap so
// reconcileOrderContact can stitch the visitor session even when
// checkout_contact_info_submitted is skipped entirely.
app.post('/webhook/checkout-started', (req, res) => {
  res.sendStatus(200);
  const { token, hutk } = req.body;
  if (!token) return;
  // The pixel now posts on every checkout_started, with or without a cookie,
  // so the logs show whether the pixel ran at all (e.g. on express checkouts).
  if (!hutk) {
    console.log(`[HubSpot] checkout_started received for token: ${token} | hutk: MISSING — pixel ran but found no hubspotutk cookie`);
    return;
  }
  hutkMap.set(token, hutk);
  _dbSetHutk.run(token, hutk, Date.now());
  console.log(`[HubSpot] checkout_started hutk stored for token: ${token}`);
});

app.post('/webhook/orders-create', async (req, res) => {
  const order = req.body;

  // Always respond fast to Shopify
  res.sendStatus(200);

  console.log(`\n▓▓▓▓▓▓▓▓▓▓▓▓ ORDER: orders/create | order: ${order.id} | email: ${order.email || "MISSING"} ▓▓▓▓▓▓▓▓▓▓▓▓`);

  // customerEmail: fallback when order.email is missing (common for accelerated checkout).
  // The Shopify customer record almost always has an email even when the order payload doesn't.
  let customerEmail = "";
  // customerPhone: fallback identity for phone-only checkouts (no email anywhere).
  let customerPhone = "";

  // ── B2B logic ─────────────────────────────────────────────────────────────
  // Isolated in its own try/catch — never blocks HubSpot reconciliation below.
  if (order.customer) {
    try {
      const customerId = order.customer.id;

      // 🔹 Get customer from Shopify
      const customerRes = await axios.get(
        `https://medical-and-lab-supplies.myshopify.com/admin/api/2026-01/customers/${customerId}.json`,
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
      );

      const shopifyCustomer = customerRes.data.customer;

      // Capture email from Shopify customer record as fallback
      customerEmail = (shopifyCustomer.email || "").trim().toLowerCase();
      customerPhone = (shopifyCustomer.phone || "").trim();

      // 🔹 Check if B2B
      if (shopifyCustomer.tags && shopifyCustomer.tags.includes('PROC_ACCT')) {
        await axios.put(
          `https://medical-and-lab-supplies.myshopify.com/admin/api/2026-01/orders/${order.id}.json`,
          { order: { id: order.id, po_number: "PROC_ACCT" } },
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
      console.error('Error:', err.response?.data || err.message);
    }
  }

  // ── HubSpot reconciliation: order = truth, promote to CUSTOMER ────────────
  // Runs after B2B logic. Isolated — any failure here never affects Shopify response.
  // customerEmail fallback ensures orders with no email still get reconciled.
  // customerPhone fallback lets phone-only checkouts reach HubSpot too.
  // After the contact is resolved, Shopify's own attribution (source, UTM,
  // landing pages) is written to it — this works even when no hutk exists.
  const hasIdentity = order.email || order.checkout_token || customerEmail
                   || order.phone || customerPhone;
  if (HUBSPOT_ACCESS_TOKEN && hasIdentity) {
    reconcileOrderContact(order, customerEmail, customerPhone)
      .then(contactId => {
        if (contactId) scheduleShopifyAttribution(order, contactId);
      })
      .catch(err =>
        console.error('[HubSpot] reconcileOrderContact error:', err.response?.data?.message || err.message)
      );
  }
  console.log(`▓▓▓▓▓▓▓▓▓▓▓▓ ORDER END | order: ${order.id} ▓▓▓▓▓▓▓▓▓▓▓▓\n`);
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


// ── HubSpot Forms API Submission ──────────────────────────────────────────
// Submits the customer's email to a HubSpot form.
//
// The hutk parameter is the critical piece — it is the value of the
// "hubspotutk" browser cookie that HubSpot's tracking script sets when a
// visitor lands on any tracked page. By passing it here, HubSpot will
// retroactively stitch ALL anonymous activity stored under that cookie
// (page views, traffic source, sessions, referrer) onto the contact record.
//
// Without hutk → contact is created/updated but traffic source shows as
//   "Offline Sources" and no page view history is attached.
// With hutk    → HubSpot shows the real traffic source (Paid Search,
//   Organic, Email, etc.) and full pre-checkout browsing history.
//
// theme.liquid reads the cookie and saves it as a Shopify cart attribute.
// Shopify carries it through checkout and delivers it in note_attributes
// on the checkout/create webhook payload — that's how it gets here.
async function submitHubSpotForm(email, hutk) {
  const PORTAL_ID = "5031174";
  const FORM_ID   = "e25d767c-f06c-4c65-99ad-ec3781d1dcd5";
  const url = `https://api.hsforms.com/submissions/v3/integration/submit/${PORTAL_ID}/${FORM_ID}`;

  // Build the submission body
  const body = {
    fields: [
      {
        objectTypeId: "0-1", // 0-1 = Contact object in HubSpot
        name: "email",
        value: email,
      },
    ],
    context: {
      pageUri:  "https://www.medical-and-lab-supplies.com/checkouts",
      pageName: "Checkout - Abandoned",
    },
  };

  // Only attach hutk if it exists — passing null/undefined causes API errors
  if (hutk) {
    body.context.hutk = hutk;
  }

  console.log(`[HubSpot Form] Submitting | email: ${email} | hutk: ${hutk || "not present — traffic source will show as Offline Sources"}`);

  try {
    const response = await axios.post(url, body, {
      headers: { "Content-Type": "application/json" },
    });

    console.log("[HubSpot Form] Submission SUCCESS | message:", response.data.inlineMessage || "OK");
  } catch (err) {
    const errData = err.response?.data || err.message;
    console.error("[HubSpot Form] Submission FAILED:", JSON.stringify(errData));
  }
}

// ── Abandoned Cart HTML Helper ─────────────────────────────────────────────
// Generates an email-safe, table-based HTML string from Shopify line items.
// Used to populate shopify_abandoned_cart_html on the HubSpot contact.
function generateCartHTML(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return "";

  return lineItems.map(item => {
    const title      = item.title        || "Product";
    const price      = item.variant?.price?.amount || item.price || "0.00";
    const quantity   = item.quantity     || 1;
    const imageUrl   = item.variant?.image?.src    || item.image || item.image_url || "";
    const productUrl = item.variant?.product?.url  || item.url   || item.product_url
                    || item.variant_url  || "#";

    const imgTag = imageUrl
      ? `<img src="${imageUrl}" width="100" style="border-radius:8px;display:block;" alt="${title}" />`
      : `<div style="width:100px;height:100px;background:#f0f0f0;border-radius:8px;"></div>`;

    return (
      `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:15px;border-collapse:collapse;">` +
        `<tr>` +
          `<td width="100" style="padding-right:10px;vertical-align:top;">${imgTag}</td>` +
          `<td style="vertical-align:top;">` +
            `<p style="margin:0;font-size:16px;font-weight:bold;color:#111;">${title}</p>` +
            `<p style="margin:5px 0;color:#555;font-size:14px;">Rs. ${price} (Qty: ${quantity})</p>` +
            `<a href="${productUrl}" style="color:#007bff;text-decoration:none;font-size:14px;">View Product</a>` +
          `</td>` +
        `</tr>` +
      `</table>`
    );
  }).join("");
}

// Shopify webhook endpoint for contact creation
app.post("/checkout-completed", async (req, res) => {
  const webhookCheckout = req.body;

  if (!HUBSPOT_ACCESS_TOKEN) {
    return res.status(400).json({ error: "HubSpot not authorized yet" });
  }

  try {
    // ── Pixel payload is the sole source of truth (Shopify Checkout REST API is deprecated) ──
    const webhookToken = webhookCheckout.token || webhookCheckout.checkout_token || "";
    const firstName    = webhookCheckout.first_name || "";

    console.log(`\n════════════ PIXEL: checkout_contact_info_submitted | token: ${webhookToken} ════════════`);
    console.log(`[DEBUG] Pixel hutk from payload: ${webhookCheckout.hutk || "MISSING"}`);
    console.log(`[DEBUG] hutkMap has token: ${hutkMap.has(webhookToken)} | stored hutk: ${hutkMap.get(webhookToken) || "MISSING"}`);
    const lastName     = webhookCheckout.last_name  || "";
    const email        = (webhookCheckout.email || "").trim();

    if (!email) {
      console.log("Skipping HubSpot contact creation because email is empty");
      return res.status(200).json({ success: true });
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
        properties: ["email", "firstname", "lastname", "lifecyclestage",
                     "shopify_has_order", "shopify_is_abandoned", "contact_attempted"],
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

    // ── Abandoned cart data — computed once, injected into both create + update ──
    // checkoutUrl: use the real Shopify recovery URL stored by /webhook/checkout-create,
    // fall back to constructing from token if the checkout/create webhook hasn't fired yet.
    const shop = process.env.SHOPIFY_SHOP_DOMAIN || "medical-and-lab-supplies.myshopify.com";
    const abandonedCartHTML = generateCartHTML(webhookCheckout.line_items);
    const checkoutUrl = (webhookToken && abandonedUrlMap.get(webhookToken))
                     || (webhookToken ? `https://${shop}/checkouts/${webhookToken}` : "");

    if (searchResponse.data.results.length === 0) {
      // 2️⃣ No contact yet — create as LEAD only (pixel = intent, not purchase)
      const contactResponse = await axios.post(
        "https://api.hubapi.com/crm/v3/objects/contacts",
        {
          properties: {
            email: email,
            firstname: firstName,
            lastname: lastName,
            lifecyclestage: "lead",
            // Segmentation flags — pixel/checkout = abandoned intent, never a purchase
            shopify_has_order:   "false",
            shopify_is_abandoned: "true",
            contact_attempted:   "false",
            // Abandoned cart data
            shopify_abandoned_cart_html: abandonedCartHTML,
            shopify_checkout_url:        checkoutUrl,
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
          updateProps.firstname = firstName;
        }
        if (!existing.properties?.lastname || existing.properties.lastname === "Shopify") {
          updateProps.lastname = lastName;
        }

        // Segmentation flags — only apply if this contact does NOT already have
        // a confirmed order (shopify_has_order=true). Never overwrite purchase truth.
        if (existing.properties?.shopify_has_order !== "true") {
          updateProps.shopify_has_order    = "false";
          updateProps.shopify_is_abandoned = "true";
          // Preserve contact_attempted if marketing already set it to true
          if (existing.properties?.contact_attempted !== "true") {
            updateProps.contact_attempted = "false";
          }
        }

        // Always update abandoned cart data — reflects the latest checkout session
        updateProps.shopify_abandoned_cart_html = abandonedCartHTML;
        updateProps.shopify_checkout_url        = checkoutUrl;

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

    // Track in reconciliation map — include token for order-side bridging
    const checkoutToken = webhookToken;
    reconciliationMap.set(email, {
      status: "LEAD",
      checkout_token: checkoutToken,
      firstname: firstName,
      lastname: lastName,
      timestamp: Date.now(),
    });

    // Secondary index: token → email (survives email mismatch on order webhook)
    if (checkoutToken) {
      checkoutTokenMap.set(checkoutToken, email);
      _dbSetCheckoutToken.run(checkoutToken, email, Date.now());
    }

    // ── HubSpot visitor stitching via Forms API ───────────────────────────────
    // hutk priority:
    //   1. webhookCheckout.hutk — read directly by the pixel via browser.cookie.get()
    //      Works for all checkout paths including Buy Now (no cart step needed).
    //   2. hutkMap.get(token) — stored by /webhook/checkout-create from note_attributes
    //      Fallback for cases where the pixel couldn't read the cookie.
    const hutk = webhookCheckout.hutk || hutkMap.get(checkoutToken) || null;
    console.log(`[HubSpot Form] Pixel fired | email: ${email} | hutk: ${hutk ? hutk : "not available — cookie blocked or incognito"}`);
    submitHubSpotForm(email, hutk).catch(err =>
      console.error("[HubSpot Form] Unhandled error:", err.message)
    );

    console.log(`════════════ PIXEL END | email: ${email} ════════════\n`);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error("Error sending to HubSpot:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to send data to HubSpot" });
  }
});

// ── HubSpot Contact Search Helper ─────────────────────────────────────────
// Returns the HubSpot contact object for a given email, or null if not found.
// Retries once on 401/429 — HubSpot's search endpoint (4 req/s limit) can
// return 401 instead of 429 when rate-limited.
async function findHubSpotContactByEmail(email, hsHeaders) {
  const body = {
    filterGroups: [
      { filters: [{ propertyName: "email", operator: "EQ", value: email }] },
    ],
    properties: ["email", "firstname", "lastname", "lifecyclestage",
                 "shopify_has_order", "shopify_is_abandoned", "contact_attempted"],
    limit: 1,
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axios.post(
        "https://api.hubapi.com/crm/v3/objects/contacts/search",
        body,
        { headers: hsHeaders }
      );
      return res.data.results.length > 0 ? res.data.results[0] : null;
    } catch (err) {
      const status = err.response?.status;
      if (attempt === 1 && (status === 401 || status === 429)) {
        console.warn(`[HubSpot] Search attempt ${attempt} failed (${status}) for ${email} — retrying in 1s`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      console.error(`[HubSpot] Search failed for email (${email}):`, err.message);
      return null;
    }
  }
  return null;
}

// ── Phone helpers (phone-only checkouts) ──────────────────────────────────
// Shopify lets buyers check out with a phone number instead of an email.
// Those orders arrive with no email anywhere, so they are matched by phone.
function normalizePhone(raw) {
  if (!raw) return "";
  const trimmed = String(raw).trim();
  const digits  = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  if (trimmed.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;   // US/CA number without country code
  return `+${digits}`;
}

async function findHubSpotContactByPhone(phone, hsHeaders) {
  try {
    const res = await axios.post(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        filterGroups: [
          { filters: [{ propertyName: "phone",       operator: "EQ", value: phone }] },
          { filters: [{ propertyName: "mobilephone", operator: "EQ", value: phone }] },
        ],
        properties: ["email", "phone", "firstname", "lastname", "lifecyclestage"],
        limit: 1,
      },
      { headers: hsHeaders }
    );
    return res.data.results.length > 0 ? res.data.results[0] : null;
  } catch (err) {
    console.error(`[HubSpot] Search failed for phone (${phone}):`, err.message);
    return null;
  }
}

// ── HubSpot write helpers ─────────────────────────────────────────────────
// Both retry once on 401/429 — HubSpot can return 401 instead of 429 when rate-limited.
async function patchHubSpotContact(contactId, properties, hsHeaders) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await axios.patch(
        `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
        { properties },
        { headers: hsHeaders }
      );
      return;
    } catch (err) {
      const status = err.response?.status;
      if (attempt === 1 && (status === 401 || status === 429)) {
        console.warn(`[HubSpot] PATCH attempt ${attempt} failed (${status}) for contact ${contactId} — retrying in 1s`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      throw err;
    }
  }
}

// Creates a contact. On 409 (the contact was created in the meantime — usually
// by HubSpot's native Shopify app racing us on the same order) it reads the
// existing ID from the error and updates that contact instead.
// Returns { id, existed }.
async function createHubSpotContact(properties, hsHeaders, label) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await axios.post(
        "https://api.hubapi.com/crm/v3/objects/contacts",
        { properties },
        { headers: hsHeaders }
      );
      return { id: res.data.id, existed: false };
    } catch (err) {
      const status = err.response?.status;
      if (status === 409) {
        const match = String(err.response?.data?.message || "").match(/Existing ID:\s*(\d+)/i);
        if (match) {
          console.log(`[HubSpot] Contact already exists for ${label} (409) — updating existing contact ${match[1]} instead`);
          await patchHubSpotContact(match[1], properties, hsHeaders);
          return { id: match[1], existed: true };
        }
      }
      if (attempt === 1 && (status === 401 || status === 429)) {
        console.warn(`[HubSpot] POST attempt ${attempt} failed (${status}) for ${label} — retrying in 1s`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      throw err;
    }
  }
}

// ── HubSpot Order Reconciliation Helper ───────────────────────────────────
// Called after every orders/create webhook.
// Matching strategy (in order):
//   Step A — search HubSpot by order.email
//   Step B — if Step A misses, bridge via order.checkout_token → checkoutTokenMap → email
//   Last resort — create a new customer contact if no match at all
//   Phone-only — no email anywhere: match or create the contact by phone
// Returns the HubSpot contact ID (or null) so Shopify attribution can be written to it.
async function reconcileOrderContact(order, customerEmailFallback = "", customerPhoneFallback = "") {
  const hsHeaders = {
    Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };

  // Order is the source of truth for real identity
  const firstname = order.customer?.first_name || order.billing_address?.first_name || "";
  const lastname  = order.customer?.last_name  || order.billing_address?.last_name  || "";
  // Use Shopify customer email as fallback when order.email is missing
  // (common for accelerated checkout — Shop Pay, Apple Pay, Google Pay)
  const orderEmail = (order.email || customerEmailFallback || "").trim().toLowerCase();
  if (!order.email && customerEmailFallback) {
    console.log(`[HubSpot] order.email missing for order ${order.id} — using Shopify customer email: ${customerEmailFallback}`);
  }

  let contact      = null;
  let resolvedEmail = orderEmail;

  // ── Step A: match by order email ──────────────────────────────────────────
  if (orderEmail) {
    contact = await findHubSpotContactByEmail(orderEmail, hsHeaders);
  }

  // ── Step B: fallback — bridge via checkout_token ───────────────────────────
  // Covers the case where pixel email ≠ order email (e.g. guest changes email
  // at payment step), or where order arrives with no email at all.
  if (!contact && order.checkout_token) {
    const tokenEmail = checkoutTokenMap.get(order.checkout_token);
    if (tokenEmail) {
      console.log(`[HubSpot] Bridging order ${order.id} via checkout_token → ${tokenEmail}`);
      contact = await findHubSpotContactByEmail(tokenEmail, hsHeaders);
      if (contact) resolvedEmail = tokenEmail;
    }
  }

  // Properties to write — order is the source of truth for purchase state
  // contact_attempted is intentionally excluded: marketing engagement state is
  // independent of purchase state and must never be reset by an order event.
  const customerProps = {
    lifecyclestage:       "customer",
    shopify_has_order:    "true",   // PURCHASE TRUTH — only ever set here
    shopify_is_abandoned: "false",  // order cancels abandoned state
  };
  if (firstname) customerProps.firstname = firstname;
  if (lastname)  customerProps.lastname  = lastname;

  let contactId = null;

  if (contact) {
    // ── Contact found: promote to customer, always overwrite placeholder names ─
    await patchHubSpotContact(contact.id, customerProps, hsHeaders);
    contactId = contact.id;
    console.log(`[HubSpot] Contact ${contact.id} → CUSTOMER (order ${order.id})`);
  } else {
    const emailToUse = resolvedEmail || order.billing_address?.email || "";
    if (emailToUse) {
      // ── Last resort: create new customer contact (409-safe) ─────────────────
      const created = await createHubSpotContact({ email: emailToUse, ...customerProps }, hsHeaders, emailToUse);
      contactId = created.id;
      resolvedEmail = emailToUse;
      console.log(created.existed
        ? `[HubSpot] Contact ${contactId} → CUSTOMER (order ${order.id}) — after 409`
        : `[HubSpot] New CUSTOMER contact created: ${contactId} (order ${order.id})`);
    } else {
      // ── Phone-only checkout: no email on order or customer ─────────────────
      const phone = normalizePhone(
        order.phone || customerPhoneFallback || order.customer?.phone ||
        order.billing_address?.phone || order.shipping_address?.phone
      );
      if (!phone) {
        console.warn(`[HubSpot] No email or phone available for order ${order.id} — skipping`);
        return null;
      }
      const phoneProps = { phone, ...customerProps };
      const existing = await findHubSpotContactByPhone(phone, hsHeaders);
      if (existing) {
        await patchHubSpotContact(existing.id, customerProps, hsHeaders);
        contactId = existing.id;
        console.log(`[HubSpot] Phone-only order ${order.id} — matched contact ${contactId} by phone ${phone} → CUSTOMER`);
      } else {
        const created = await createHubSpotContact(phoneProps, hsHeaders, phone);
        contactId = created.id;
        console.log(`[HubSpot] Phone-only order ${order.id} — CUSTOMER contact ${created.existed ? "updated" : "created"}: ${contactId} (phone ${phone})`);
      }
      console.log(`[HubSpot Form] Phone-only order ${order.id} — no email, so the hubspotutk cookie can't be attached (Shopify attribution will still be written)`);
    }
  }

  // Update reconciliation map — order is always the final truth
  if (resolvedEmail) {
    reconciliationMap.set(resolvedEmail, {
      status: "CUSTOMER",
      firstname,
      lastname,
      timestamp: Date.now(),
    });
  }

  // ── Visitor stitching fallback for accelerated checkout ───────────────────
  // Shop Pay / Apple Pay / Google Pay skip checkout_contact_info_submitted,
  // so the pixel never fires and submitHubSpotForm is never called.
  // The checkout/create webhook already stored hutk in hutkMap — use it now.
  //
  // Guard: skip if checkoutTokenMap has this token, meaning the pixel already
  // fired and submitted the form — avoids double submission.
  //
  // hutk priority:
  //   1. order.note_attributes.hubspotutk — the cart attribute saved by
  //      theme.liquid, carried on the order itself. Works for draft orders
  //      (e.g. Wholesale Pricing Discount) whose checkout token never reaches
  //      hutkMap, and survives server restarts.
  //   2. hutkMap.get(order.checkout_token) — stored by /webhook/checkout-create
  //      or the pixel's checkout_started event.
  if (resolvedEmail) {
    if (order.checkout_token && checkoutTokenMap.has(order.checkout_token)) {
      console.log(`[HubSpot Form] Order fallback skipped — pixel already submitted form for token: ${order.checkout_token}`);
    } else {
      const orderNoteAttributes = Array.isArray(order.note_attributes) ? order.note_attributes : [];
      const orderHutk = orderNoteAttributes.find(attr => attr.name === "hubspotutk")?.value || null;
      const mapHutk   = order.checkout_token ? (hutkMap.get(order.checkout_token) || null) : null;
      const hutk      = orderHutk || mapHutk;
      if (hutk) {
        console.log(`[HubSpot Form] Order fallback | email: ${resolvedEmail} | hutk: ${hutk} | source: ${orderHutk ? "order.note_attributes" : "hutkMap"}`);
        submitHubSpotForm(resolvedEmail, hutk).catch(err =>
          console.error("[HubSpot Form] Order fallback error:", err.message)
        );
      } else {
        console.log(`[HubSpot Form] Order fallback | email: ${resolvedEmail} | hutk: not on order.note_attributes or in hutkMap — accelerated checkout without cart step or cookie blocked`);
      }
    }
  }

  return contactId;
}

// ── Shopify attribution → HubSpot ─────────────────────────────────────────
// Shopify records where every buyer came from (source, UTM, landing pages) on
// the order's customer journey — including Shop Pay express checkouts that our
// pixel and the hubspotutk cookie never see. These are written to custom
// contact properties on EVERY order, separate from HubSpot's own analytics
// fields, so they never conflict with page views or Original Source.
// Values reflect the most recent order (Shopify's journey covers the sessions
// since the customer's previous order, within a 30-day window).
const SHOPIFY_ATTRIBUTION_PROPERTIES = [
  { name: "shopify_source",              label: "Shopify Source (latest order)",              type: "string", fieldType: "text"   },
  { name: "shopify_utm_source",          label: "Shopify UTM Source (latest order)",          type: "string", fieldType: "text"   },
  { name: "shopify_utm_medium",          label: "Shopify UTM Medium (latest order)",          type: "string", fieldType: "text"   },
  { name: "shopify_utm_campaign",        label: "Shopify UTM Campaign (latest order)",        type: "string", fieldType: "text"   },
  { name: "shopify_referrer_url",        label: "Shopify Referrer URL (latest order)",        type: "string", fieldType: "text"   },
  { name: "shopify_first_landing_page",  label: "Shopify First Landing Page (latest order)",  type: "string", fieldType: "text"   },
  { name: "shopify_last_landing_page",   label: "Shopify Last Landing Page (latest order)",   type: "string", fieldType: "text"   },
  { name: "shopify_sessions_before_order", label: "Shopify Sessions Before Order (latest order)", type: "number", fieldType: "number" },
  { name: "shopify_days_to_conversion",  label: "Shopify Days to Conversion (latest order)",  type: "number", fieldType: "number" },
  { name: "shopify_attribution_order",   label: "Shopify Attribution Order",                  type: "string", fieldType: "text"   },
];

// Creates any missing attribution properties at startup.
// Needs the crm.schemas.contacts.write scope on the HubSpot private app;
// without it, the properties must be created by hand in HubSpot.
async function ensureAttributionProperties() {
  if (!HUBSPOT_ACCESS_TOKEN) return;
  const hsHeaders = { Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`, "Content-Type": "application/json" };
  const missing = [];
  for (const prop of SHOPIFY_ATTRIBUTION_PROPERTIES) {
    try {
      await axios.get(`https://api.hubapi.com/crm/v3/properties/contacts/${prop.name}`, { headers: hsHeaders });
    } catch (err) {
      if (err.response?.status === 404) missing.push(prop);
      else console.error(`[Attribution] Could not check property ${prop.name}:`, err.response?.status || err.message);
    }
  }
  if (missing.length === 0) {
    console.log(`[Attribution] All ${SHOPIFY_ATTRIBUTION_PROPERTIES.length} Shopify attribution properties exist in HubSpot`);
    return;
  }
  for (const prop of missing) {
    try {
      await axios.post(
        "https://api.hubapi.com/crm/v3/properties/contacts",
        {
          name: prop.name,
          label: prop.label,
          type: prop.type,
          fieldType: prop.fieldType,
          groupName: "contactinformation",
          description: "Set by the Shopify-HubSpot backend from Shopify's order customer journey.",
        },
        { headers: hsHeaders }
      );
      console.log(`[Attribution] Created HubSpot property: ${prop.name}`);
    } catch (err) {
      const status = err.response?.status;
      if (status === 403) {
        console.error(`[Attribution] Cannot create HubSpot properties (403) — add the crm.schemas.contacts.write scope to the private app, or create these by hand: ${missing.map(p => p.name).join(", ")}`);
        return;
      }
      console.error(`[Attribution] Failed to create property ${prop.name}:`, err.response?.data?.message || err.message);
    }
  }
}

// Shopify builds the customer journey asynchronously and it can take well over
// 5 minutes (observed 2026-10-12). Try once right away; if it isn't ready,
// park the order in the SQLite attribution_queue. A sweep every 10 minutes
// retries queued orders for up to 24 hours. The queue lives in SQLite, so it
// survives Render restarts and deploys.
const ATTRIBUTION_SWEEP_MS   = Number(process.env.ATTRIBUTION_SWEEP_MS) || 10 * 60 * 1000;
const ATTRIBUTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function scheduleShopifyAttribution(order, contactId) {
  const job = {
    orderId:   String(order.id),
    orderGid:  order.admin_graphql_api_id || `gid://shopify/Order/${order.id}`,
    contactId: String(contactId),
  };
  runAttributionJob(job).then(done => {
    if (done) return;
    _dbQueueAttribution.run(job.orderId, job.orderGid, job.contactId, Date.now());
    console.log(`[Attribution] Order ${job.orderId} queued — will retry every ${Math.round(ATTRIBUTION_SWEEP_MS / 60000)} min for up to 24h`);
  });
}

// Returns true when finished, false when it should be retried later.
async function runAttributionJob(job) {
  try {
    return await applyShopifyAttribution(job);
  } catch (err) {
    const status = err.response?.status;
    // Network errors, rate limits and server errors are worth retrying
    if (!status || status === 429 || status >= 500) {
      console.warn(`[Attribution] Temporary error for order ${job.orderId} (${status || err.code || err.message}) — will retry`);
      return false;
    }
    console.error(`[Attribution] Error for order ${job.orderId}:`, err.response?.data?.message || err.message);
    return true;
  }
}

let attributionSweepRunning = false;
async function sweepAttributionQueue() {
  if (attributionSweepRunning) return;
  attributionSweepRunning = true;
  try {
    const rows = _dbPendingAttribution.all();
    if (rows.length) console.log(`[Attribution] Sweep: ${rows.length} queued order(s)`);
    for (const row of rows) {
      if (Date.now() - row.created_at > ATTRIBUTION_MAX_AGE_MS) {
        _dbDoneAttribution.run(row.order_id);
        console.log(`[Attribution] Gave up on order ${row.order_id} after 24h (${row.attempts} attempts) — Shopify journey never became ready`);
        continue;
      }
      const done = await runAttributionJob({ orderId: row.order_id, orderGid: row.order_gid, contactId: row.contact_id });
      if (done) _dbDoneAttribution.run(row.order_id);
      else _dbBumpAttribution.run(row.order_id);
    }
  } catch (err) {
    console.error("[Attribution] Sweep failed:", err.message);
  } finally {
    attributionSweepRunning = false;
  }
}

// Returns true when finished (written or nothing to write), false to retry later.
async function applyShopifyAttribution(job) {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN || "medical-and-lab-supplies.myshopify.com";
  const { orderId, orderGid, contactId } = job;

  const gqlRes = await axios.post(
    `https://${shop}/admin/api/2026-01/graphql.json`,
    {
      query: `
        query OrderAttribution($id: ID!) {
          order(id: $id) {
            name
            customerJourneySummary {
              ready
              daysToConversion
              momentsCount { count }
              firstVisit {
                landingPage
                referrerUrl
                source
                utmParameters { source medium campaign }
              }
              lastVisit { landingPage }
            }
          }
        }
      `,
      variables: { id: orderGid },
    },
    { headers: { "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN, "Content-Type": "application/json" } }
  );

  if (gqlRes.data.errors) {
    console.error(`[Attribution] Shopify GraphQL error for order ${orderId}:`, JSON.stringify(gqlRes.data.errors));
    return true;
  }

  const shopifyOrder = gqlRes.data.data?.order;
  const journey = shopifyOrder?.customerJourneySummary;
  if (!journey) {
    // Draft orders, POS and API-created orders have no online-store journey.
    console.log(`[Attribution] No customer journey for order ${orderId} (draft/POS/API order) — nothing to write`);
    return true;
  }
  if (!journey.ready) {
    console.log(`[Attribution] Journey not ready yet for order ${orderId}`);
    return false;
  }

  const first = journey.firstVisit || {};
  const utm   = first.utmParameters || {};
  const raw = {
    shopify_source:                first.source,
    shopify_utm_source:            utm.source,
    shopify_utm_medium:            utm.medium,
    shopify_utm_campaign:          utm.campaign,
    shopify_referrer_url:          first.referrerUrl,
    shopify_first_landing_page:    first.landingPage,
    shopify_last_landing_page:     journey.lastVisit?.landingPage,
    shopify_sessions_before_order: journey.momentsCount?.count,
    shopify_days_to_conversion:    journey.daysToConversion,
    shopify_attribution_order:     shopifyOrder.name,
  };
  // Drop empty values so a sparse journey never blanks out earlier data
  const properties = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== null && value !== undefined && value !== "") properties[key] = String(value);
  }

  const hsHeaders = { Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`, "Content-Type": "application/json" };
  try {
    await patchHubSpotContact(contactId, properties, hsHeaders);
    console.log(`[Attribution] Contact ${contactId} ← order ${shopifyOrder.name} | source: ${properties.shopify_source || "-"} | campaign: ${properties.shopify_utm_campaign || "-"}`);
  } catch (err) {
    const message = err.response?.data?.message || err.message;
    if (/does not exist/i.test(message)) {
      console.error(`[Attribution] HubSpot properties missing — create them (see ensureAttributionProperties): ${message}`);
    } else {
      console.error(`[Attribution] Failed to write attribution to contact ${contactId}:`, message);
    }
  }
  return true;
}

ensureAttributionProperties().catch(err =>
  console.error("[Attribution] Property check failed:", err.message)
);

// ── One-time backfill (2026-10-12) ─────────────────────────────────────────
// Orders placed after the first attribution release, whose attribution was
// dropped by the old 5-minute retry. Seeded into the queue on startup until
// 2026-10-14; re-writing the same values on a restart is harmless.
// Safe to delete this block after 2026-10-14.
const ATTRIBUTION_BACKFILL = [
  // [order id,       HubSpot contact id]   order   / contact
  ["7378605408574", "254501290096"],    // #398793 / Shane Spurlock (phone-only)
  ["7378606948670", "53468051"],        // #398794 / sambay818@yahoo.com
  ["7378664915262", "254504597810"],    // #398795 / kylep@lenz-tx.com
  ["7378714984766", "122625386408"],    // #398796 / aidanye@gmail.com
  ["7378719670590", "102211417870"],    // #398797 / k3vinsanch0@gmail.com
];
if (Date.now() < Date.parse("2026-10-14T00:00:00Z")) {
  for (const [orderId, contactId] of ATTRIBUTION_BACKFILL) {
    _dbQueueAttribution.run(orderId, `gid://shopify/Order/${orderId}`, contactId, Date.now());
  }
  console.log(`[Attribution] Backfill: ${ATTRIBUTION_BACKFILL.length} order(s) seeded into the queue`);
}

// Retry queued attribution every 10 minutes; first sweep 1 minute after start
// so orders queued before a restart are picked up promptly.
setTimeout(sweepAttributionQueue, 60 * 1000);
setInterval(sweepAttributionQueue, ATTRIBUTION_SWEEP_MS);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
