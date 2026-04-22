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
  res.sendStatus(200); // respond fast to Shopify

  const checkout = req.body;
  const token               = checkout.token || "";
  const abandonedCheckoutUrl = checkout.abandoned_checkout_url || "";

  console.log('[Shopify] checkout/create webhook received');
  console.log('[Shopify] abandoned_checkout_url:', abandonedCheckoutUrl);

  // Store the real recovery URL so /checkout-completed can use it when the pixel fires
  if (token && abandonedCheckoutUrl) {
    abandonedUrlMap.set(token, abandonedCheckoutUrl);
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
  // Fires when either email OR checkout_token is present — handles email-mismatch cases.
  if (HUBSPOT_ACCESS_TOKEN && (order.email || order.checkout_token)) {
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
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error("Error sending to HubSpot:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to send data to HubSpot" });
  }
});

// ── HubSpot Contact Search Helper ─────────────────────────────────────────
// Returns the HubSpot contact object for a given email, or null if not found.
async function findHubSpotContactByEmail(email, hsHeaders) {
  try {
    const res = await axios.post(
      "https://api.hubapi.com/crm/v3/objects/contacts/search",
      {
        filterGroups: [
          { filters: [{ propertyName: "email", operator: "EQ", value: email }] },
        ],
        properties: ["email", "firstname", "lastname", "lifecyclestage",
                     "shopify_has_order", "shopify_is_abandoned", "contact_attempted"],
        limit: 1,
      },
      { headers: hsHeaders }
    );
    return res.data.results.length > 0 ? res.data.results[0] : null;
  } catch (err) {
    console.error(`[HubSpot] Search failed for email (${email}):`, err.message);
    return null;
  }
}

// ── HubSpot Order Reconciliation Helper ───────────────────────────────────
// Called after every orders/create webhook.
// Matching strategy (in order):
//   Step A — search HubSpot by order.email
//   Step B — if Step A misses, bridge via order.checkout_token → checkoutTokenMap → email
//   Last resort — create a new customer contact if no match at all
async function reconcileOrderContact(order) {
  const hsHeaders = {
    Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
    "Content-Type": "application/json",
  };

  // Order is the source of truth for real identity
  const firstname = order.customer?.first_name || order.billing_address?.first_name || "";
  const lastname  = order.customer?.last_name  || order.billing_address?.last_name  || "";
  const orderEmail = (order.email || "").trim().toLowerCase();

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

  if (contact) {
    // ── Contact found: promote to customer, always overwrite placeholder names ─
    await axios.patch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${contact.id}`,
      { properties: customerProps },
      { headers: hsHeaders }
    );
    console.log(`[HubSpot] Contact ${contact.id} → CUSTOMER (order ${order.id})`);
  } else {
    // ── Last resort: create new customer contact ───────────────────────────────
    const emailToUse = resolvedEmail || order.billing_address?.email || "";
    if (!emailToUse) {
      console.warn(`[HubSpot] No email available for order ${order.id} — skipping`);
      return;
    }
    const createRes = await axios.post(
      "https://api.hubapi.com/crm/v3/objects/contacts",
      { properties: { email: emailToUse, ...customerProps } },
      { headers: hsHeaders }
    );
    console.log(`[HubSpot] New CUSTOMER contact created: ${createRes.data.id} (order ${order.id})`);
    resolvedEmail = emailToUse;
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
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
