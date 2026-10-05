require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const axios = require("axios");
const cors = require("cors");

// ===============================
// ✅ ENV VALIDATION
// ===============================
const REQUIRED_ENV = ["CLIENT_ID", "EMAIL", "PASSWORD", "SHOPIFY_WEBHOOK_SECRET"];
const missingEnv = REQUIRED_ENV.filter(key => !process.env[key]);

if (missingEnv.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingEnv.join(", ")}`);
  console.error("   Set them in .env (local) or in the Render dashboard (production).");
  process.exit(1);
}

// 🔑 Baakman credentials
const CLIENT_ID = process.env.CLIENT_ID;
const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!SLACK_WEBHOOK_URL) {
  console.warn("⚠️ SLACK_WEBHOOK_URL not set — failed orders will not be alerted to Slack");
}

const BAAKMAN_API = "https://baakman-api.123utilize.nl/api";

// create Basic Auth token
const BASIC_AUTH = Buffer.from(`${EMAIL}:${PASSWORD}`).toString("base64");

const BAAKMAN_HEADERS = {
  "Client": CLIENT_ID,
  "Authorization": `Basic ${BASIC_AUTH}`
};

const app = express();

// ✅ MUST be FIRST middleware
app.use(cors({
  origin: "*"
}));

// ✅ optional but safe
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  next();
});

// keep the raw body around — Shopify HMAC is computed over the exact bytes
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// ===============================
// 🔐 SHOPIFY HMAC VERIFICATION
// ===============================
function verifyShopifyHmac(req) {
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  if (!hmacHeader || !req.rawBody) return false;

  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("base64");

  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ===============================
// 💬 SLACK ALERTS
// ===============================
async function sendSlackAlert(text) {
  if (!SLACK_WEBHOOK_URL) return;

  try {
    await axios.post(SLACK_WEBHOOK_URL, { text });
  } catch (err) {
    console.error("❌ Failed to send Slack alert:", err.message);
  }
}

function describeError(err) {
  if (err.response) {
    return `Status ${err.response.status}: ${JSON.stringify(err.response.data)}`;
  }
  return err.message;
}

// ===============================
// 🔥 1. GET PRODUCTS (Baakman)
// ===============================
async function getBaakmanProducts() {
  try {
    const response = await axios.get(`${BAAKMAN_API}/Product`, {
      headers: BAAKMAN_HEADERS
    });

    console.log("📦 Products fetched:", response.data.length);
    return response.data;

  } catch (err) {
    console.error("❌ Error fetching products");

    if (err.response) {
      console.error(err.response.data);
    }

    return [];
  }
}

// test endpoint
app.get("/products", async (req, res) => {
  const products = await getBaakmanProducts();
  res.json(products);
});

// ===============================
// 🔥 2. SHOPIFY WEBHOOK (ORDER)
// ===============================
async function sendOrderToBaakman(order) {
  const baakmanOrder = mapShopifyToBaakman(order);

  console.log("➡️ Sending to Baakman:", JSON.stringify(baakmanOrder, null, 2));

  const response = await axios.post(`${BAAKMAN_API}/Order`, baakmanOrder, {
    headers: {
      ...BAAKMAN_HEADERS,
      "Content-Type": "application/json"
    }
  });

  // Baakman can answer 2xx with hasError: true — treat that as a failure
  if (response.data?.hasError) {
    throw new Error(`Baakman rejected order: ${JSON.stringify(response.data.errorMessage)}`);
  }

  console.log("✅ Sent to Baakman successfully, Baakman order number:", response.data?.orderNumber);
  return response.data;
}

// Shopify may deliver the same webhook more than once — remember orders
// already sent (in memory, so this resets when the server restarts)
const sentOrderIds = new Set();

app.post("/webhook/order", async (req, res) => {
  if (!verifyShopifyHmac(req)) {
    console.warn("⛔ Rejected webhook with invalid HMAC");
    return res.sendStatus(401);
  }

  const order = req.body;

  console.log("📦 Shopify order received:", order.name);

  if (sentOrderIds.has(order.id)) {
    console.log("↩️ Duplicate webhook, already sent:", order.name);
    return res.sendStatus(200);
  }

  try {
    await sendOrderToBaakman(order);
    sentOrderIds.add(order.id);
    res.sendStatus(200);

  } catch (err) {
    const details = describeError(err);
    console.error("❌ Error sending order:", details);

    await sendSlackAlert(
      `🚨 Failed to send Shopify order ${order.name} (id ${order.id}) to Baakman\n` +
      `${details}\n` +
      `Recover with POST /webhook/order/retry using the order payload.`
    );

    res.sendStatus(500);
  }
});

// ===============================
// 🔁 2b. MANUAL RETRY
// ===============================
// POST a raw Shopify order payload to resend it to Baakman.
// Protected by the x-admin-token header (must match ADMIN_TOKEN).
app.post("/webhook/order/retry", async (req, res) => {
  if (!ADMIN_TOKEN || req.get("x-admin-token") !== ADMIN_TOKEN) {
    return res.sendStatus(401);
  }

  const order = req.body;

  if (!order || !order.name || !Array.isArray(order.line_items)) {
    return res.status(400).json({ error: "Body must be a Shopify order payload (name, line_items, ...)" });
  }

  console.log("🔁 Manual retry for order:", order.name);

  try {
    const result = await sendOrderToBaakman(order);
    sentOrderIds.add(order.id);
    res.json({ ok: true, order: order.name, baakmanOrderNumber: result?.orderNumber });

  } catch (err) {
    const details = describeError(err);
    console.error("❌ Retry failed:", details);
    res.status(502).json({ ok: false, order: order.name, error: details });
  }
});

// ===============================
// 🔥 3. CHECK ORDER
// ===============================
app.get("/order/:orderNumber", async (req, res) => {
  const { orderNumber } = req.params;

  try {
    const response = await axios.get(`${BAAKMAN_API}/Order/${orderNumber}`, {
      headers: BAAKMAN_HEADERS
    });

    res.json(response.data);

  } catch (err) {
    console.error("❌ Error fetching order:");

    if (err.response) {
      console.error(err.response.data);
    }

    res.sendStatus(500);
  }
});

// ===============================
// 🩺 4. HEALTH CHECK
// ===============================
app.get("/health", async (req, res) => {
  const started = Date.now();

  try {
    await axios.get(`${BAAKMAN_API}/Product`, {
      headers: BAAKMAN_HEADERS,
      timeout: 10000
    });

    res.json({
      status: "ok",
      baakman: { reachable: true, latencyMs: Date.now() - started }
    });

  } catch (err) {
    res.status(503).json({
      status: "degraded",
      baakman: { reachable: false, error: describeError(err) }
    });
  }
});

// ===============================
// 🔁 MAPPING FUNCTION (Shopify order → Baakman OrderViewModel)
// ===============================
// Field names and max lengths follow Baakman's Swagger spec:
// https://baakman-api.123utilize.nl/swagger/v1/swagger.json

const clip = (value, max) => (value == null ? "" : String(value).trim().slice(0, max));

// Splits "12 rue de Paris", "Hoofdstraat 12a" or "Hoofdstraat 12-B"
// into street / house number / addition.
function parseAddress(address1) {
  const line = (address1 || "").trim();

  // number first: "12 rue de Paris", "12bis rue de Paris"
  let match = line.match(/^(\d+)\s*([a-zA-Z]{0,3})[,\s]+(.+)$/);
  if (match) {
    return { houseNumber: match[1], houseNumberAddition: match[2], street: match[3] };
  }

  // number last: "Hoofdstraat 12a", "Hoofdstraat 12-B"
  match = line.match(/^(.+?)\s+(\d+)\s*[-\s]?\s*([a-zA-Z0-9]{0,10})$/);
  if (match) {
    return { houseNumber: match[2], houseNumberAddition: match[3], street: match[1] };
  }

  return { houseNumber: "", houseNumberAddition: "", street: line };
}

function mapShopifyToBaakman(order) {
  const shipping = order.shipping_address || order.billing_address || {};
  const { street, houseNumber, houseNumberAddition } = parseAddress(shipping.address1);
  const fullName = [shipping.first_name, shipping.last_name].filter(Boolean).join(" ");

  const comment = [
    order.note,
    shipping.address2 ? `Address line 2: ${shipping.address2}` : "",
    shipping.phone || order.phone ? `Phone: ${shipping.phone || order.phone}` : ""
  ].filter(Boolean).join("\n");

  return {
    reference: clip(order.name.replace("#", ""), 80),
    deliveryDate: new Date().toISOString(),

    // Optional in Baakman's spec — set BAAKMAN_DEBTOR_ID if Baakman gave you one
    debtorId: process.env.BAAKMAN_DEBTOR_ID || null,

    // ship to the Shopify customer, not to the debtor's address on file
    isCustomDeliveryAddress: true,

    deliveryAddress: {
      street: clip(street, 80),
      houseNumber: clip(houseNumber, 10),
      houseNumberAddition: clip(houseNumberAddition, 10),
      zipCode: clip(shipping.zip, 10),
      city: clip(shipping.city, 80),
      region: clip(shipping.province, 80),
      countryCode: clip(shipping.country_code, 20), // ISO code from Shopify, e.g. "FR"
      // companyName is required by Baakman — fall back to the customer's name
      companyName: clip(shipping.company || fullName, 80),
      title: "",
      firstName: clip(shipping.first_name, 80),
      infix: "",
      lastName: clip(shipping.last_name, 80)
    },

    comment,

    orderLines: order.line_items.map(item => ({
      productCode: clip(item.sku || item.product_id, 30),
      productDescription: [item.title, item.variant_title].filter(Boolean).join(" - "),
      comment: "",
      grossPrice: parseFloat(item.price) || 0,
      orderQuantity: item.quantity,
      unit: "pcs"
    }))
  };
}

// ===============================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
