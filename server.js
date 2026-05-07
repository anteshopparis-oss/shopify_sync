const express = require("express");
const axios = require("axios");
const cors = require("cors");

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

app.use(express.json());
// 🔑 Baakman credentials
const CLIENT_ID = process.env.CLIENT_ID;
const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;


// create Basic Auth token
const BASIC_AUTH = Buffer.from(`${EMAIL}:${PASSWORD}`).toString("base64");

// ===============================
// 🔥 1. GET PRODUCTS (Baakman)
// ===============================
async function getBaakmanProducts() {
  try {
    const response = await axios.get(
      "https://baakman-api.123utilize.nl/api/Product",
      {
        headers: {
          "Client": CLIENT_ID,
          "Authorization": `Basic ${BASIC_AUTH}`
        }
      }
    );

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
app.post("/webhook/order", async (req, res) => {
  const order = req.body;

  console.log("📦 Shopify order received:", order.name);

  try {
    const baakmanOrder = mapShopifyToBaakman(order);

    console.log("➡️ Sending to Baakman:", JSON.stringify(baakmanOrder, null, 2));

    await axios.post(
      "https://baakman-api.123utilize.nl/api/Order",
      baakmanOrder,
      {
        headers: {
          "Content-Type": "application/json",
          "Client": CLIENT_ID,
          "Authorization": `Basic ${BASIC_AUTH}`
        }
      }
    );

    console.log("✅ Sent to Baakman successfully");

    res.sendStatus(200);

  } catch (err) {
    console.error("❌ Error sending order:");

    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Data:", err.response.data);
    } else {
      console.error(err.message);
    }

    res.sendStatus(500);
  }
});

// ===============================
// 🔥 3. CHECK ORDER
// ===============================
app.get("/order/:orderNumber", async (req, res) => {
  const { orderNumber } = req.params;

  try {
    const response = await axios.get(
      `https://baakman-api.123utilize.nl/api/Order/${orderNumber}`,
      {
        headers: {
          "Client": CLIENT_ID,
          "Authorization": `Basic ${BASIC_AUTH}`
        }
      }
    );

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
// 🔁 MAPPING FUNCTION
// ===============================
function mapShopifyToBaakman(order) {

  // 🔥 parse address
  const address = order.shipping_address?.address1 || "";
  const match = address.match(/^(\d+)\s+(.*)$/);

  const houseNumber = match ? match[1] : "1";
  const street = match ? match[2] : address;

  return {
    reference: order.name.replace("#", ""),
    deliveryDate: new Date().toISOString(),

    // ⚠️ Replace with valid debtorId from Baakman
    debtorId: "123",

    isCustomDeliveryAddress: false,

    deliveryAddress: {
      street: street,
      houseNumber: houseNumber,
      houseNumberAddition: "",
      zipCode: order.shipping_address?.zip || "",
      city: order.shipping_address?.city || "",
      region: "",
      countryCode: "33", // ⚠️ adjust if needed
      companyName: order.shipping_address?.company || "",
      title: "",
      firstName: order.shipping_address?.first_name || "",
      infix: "",
      lastName: order.shipping_address?.last_name || ""
    },

    comment: order.note || "",

    orderLines: order.line_items.map(item => ({
      productCode: item.sku || item.product_id?.toString() || "UNKNOWN",
      productDescription: item.title,
      comment: "",
      grossPrice: parseFloat(item.price) || 0,
      orderQuantity: item.quantity,
      unit: "pcs"
    }))
  };
}

app.get("/test", (req, res) => {
  console.log("🔥 TEST ENDPOINT HIT");
  res.json({ ok: true });
});

// ===============================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
