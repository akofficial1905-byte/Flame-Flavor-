// server.js – Abba SEENUUU... FAST FOODS

const express  = require("express");
const http     = require("http");
const socketio = require("socket.io");
const cors     = require("cors");
const path     = require("path");
const mongoose = require("mongoose");
const fs       = require("fs");

require("dotenv").config();

const app    = express();
const server = http.createServer(app);
const io     = socketio(server, {
  cors: { origin: "*", methods: ["GET", "POST", "PATCH", "DELETE"] }
});

const PORT        = process.env.PORT         || 4000;
const managerUser = process.env.MANAGER_USER || "admin";
const managerPass = process.env.MANAGER_PASS || "abbaseenu2025";
// SECURITY: the Mongo connection string (with credentials) must live ONLY in
// the .env file — never hardcoded in source. Example .env entry:
//   MONGO_URI=mongodb+srv://<user>:<password>@flameflavor.uc6rwro.mongodb.net/?appName=FlameFlavor
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("❌ MONGO_URI is missing from .env — server cannot start without it.");
  process.exit(1);
}

mongoose.connect(MONGO_URI, { dbName: "FlameFlavor" });
mongoose.connection.on("connected", () => console.log("✅ MongoDB connected"));
mongoose.connection.on("error",     (e) => console.error("❌ MongoDB error:", e));

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function calcTotal(items = []) {
  return (items || []).reduce((s, i) => s + Number(i.price || 0) * Number(i.qty || 0), 0);
}

function getISTDateBounds(dateStr) {
  const d = dateStr || new Date().toISOString().slice(0, 10);
  return {
    start: new Date(Date.parse(d + "T00:00:00+05:30")),
    end:   new Date(Date.parse(d + "T23:59:59+05:30"))
  };
}

function normalizeRequestType(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s === "manager" || s === "call manager") return "manager";
  if (s === "waiter"  || s === "call waiter")  return "waiter";
  return s || "waiter";
}

function sanitizeTableDraftPayload(body = {}) {
  const items = Array.isArray(body.items)
    ? body.items
        .map((i) => ({
          name:     String(i?.name     || "").trim(),
          variant:  String(i?.variant  || "").trim(),
          price:    Number(i?.price    || 0),
          qty:      Number(i?.qty      || 0),
          category: String(i?.category || "").trim()
        }))
        .filter((x) => x.name && x.qty > 0)
    : [];
  return {
    tableNumber:  String(body.tableNumber  || "").trim(),
    customerName: String(body.customerName || "").trim(),
    mobile:       String(body.mobile       || "").trim(),
    guestCount:   Math.max(1, Number(body.guestCount || 1)),
    status:       items.length ? "draft" : "available",
    items,
    extraCharge:  Math.max(0, Number(body.extraCharge || 0)),
    extraChargeNote: String(body.extraChargeNote || "").trim(),
    total:        calcTotal(items)
  };
}

// ─── SCHEMAS ──────────────────────────────────────────────────────────────────
const orderSchema = new mongoose.Schema(
  {
    orderType:          String,
    customerName:       String,
    registrationNumber: String,
    mobile:             String,
    tableNumber:        String,
    address:            String,
    location:           { lat: Number, lng: Number },
    paymentMethod:      String,
    paymentVerified:    { type: Boolean, default: false },
    specialRequest:     String,
    requestTags:        [String],
    items: [{ name: String, variant: String, price: Number, qty: Number }],
    subtotal:   { type: Number, default: 0 },   // items total before charges/GST
    extraCharge:{ type: Number, default: 0 },   // delivery / misc charge added by manager or settings
    extraChargeNote: { type: String, default: "" },
    gstEnabled: { type: Boolean, default: false },
    gstPercent: { type: Number, default: 0 },
    gstAmount:  { type: Number, default: 0 },
    gstin:      { type: String, default: "" },  // snapshot of GSTIN at order time
    ledgerApplied: { type: Number, default: 0 }, // advance/dues amount applied to this order
    collectedAmount: { type: Number, default: 0 }, // COD cash actually collected by delivery/takeaway staff
    total:    Number,
    isDraft:  { type: Boolean, default: false },
    source:   { type: String,  default: "" },
    status:   { type: String,  default: "incoming" },
    createdAt:{ type: Date,    default: Date.now, index: true }
  },
  { strict: false }
);
orderSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2678400 }); // 31-day retention
const Order = mongoose.model("Order", orderSchema);

const serviceRequestSchema = new mongoose.Schema({
  type: String, requestType: String, customerName: String, mobile: String,
  registrationNumber: String, orderType: String, tableNumber: String,
  address: String, location: { lat: Number, lng: Number },
  status:    { type: String, default: "pending" },
  createdAt: { type: Date,   default: Date.now, index: true }
});
serviceRequestSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2678400 }); // 31-day retention
const ServiceRequest = mongoose.model("ServiceRequest", serviceRequestSchema);

// ── TableDraft ────────────────────────────────────────────────────────────────
const tableDraftSchema = new mongoose.Schema({
  tableNumber:   { type: String, required: true, unique: true, index: true },
  customerName:  { type: String, default: "" },
  mobile:        { type: String, default: "" },
  guestCount:    { type: Number, default: 1 },
  status:        { type: String, default: "available" },
  items: [{ name: String, variant: String, price: Number, qty: Number, category: String }],
  total:         { type: Number, default: 0 },
  extraCharge:      { type: Number, default: 0 },
  extraChargeNote:  { type: String, default: "" },
  isCustom:      { type: Boolean, default: false }, // ad-hoc/unorganized table (not one of the fixed tables)
  lastPrintedAt: Date,
  updatedAt:     { type: Date, default: Date.now },
  createdAt:     { type: Date, default: Date.now }
});

tableDraftSchema.pre("save", async function () {
  this.updatedAt = new Date();
  this.total     = calcTotal(this.items);
});

const TableDraft = mongoose.model("TableDraft", tableDraftSchema);

const pendingDineInSchema = new mongoose.Schema({
  tableNumber:        { type: String, required: true, index: true },
  customerName:       { type: String, default: "" },
  mobile:             { type: String, default: "" },
  registrationNumber: { type: String, default: "" },
  guestCount:         { type: Number, default: 1 },
  items: [{ name: String, variant: String, price: Number, qty: Number, category: String }],
  total:          { type: Number, default: 0 },
  specialRequest: { type: String, default: "" },
  requestTags:    [String],
  status:         { type: String, default: "pending" },
  createdAt:      { type: Date,   default: Date.now, index: true }
});
pendingDineInSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 }); // pending requests still auto-clear in 24h
const PendingDineIn = mongoose.model("PendingDineIn", pendingDineInSchema);

// ── Settings (singleton doc — GST & Compliance, delivery/extra charges) ───────
const settingsSchema = new mongoose.Schema({
  key:                     { type: String, default: "main", unique: true },
  gstin:                   { type: String, default: "" },
  gstEnabled:              { type: Boolean, default: false },
  gstPercent:              { type: Number, default: 5 },
  // Delivery / extra charge applied automatically to online takeaway & delivery orders
  deliveryChargeEnabled:   { type: Boolean, default: false },
  deliveryCharge:          { type: Number, default: 0 },
  takeawayChargeEnabled:   { type: Boolean, default: false },
  takeawayCharge:          { type: Number, default: 0 },
  updatedAt:               { type: Date, default: Date.now }
});
const Settings = mongoose.model("Settings", settingsSchema);

let _settingsCache = null;
async function getSettings() {
  if (_settingsCache) return _settingsCache;
  let s = await Settings.findOne({ key: "main" });
  if (!s) s = await Settings.create({ key: "main" });
  _settingsCache = s;
  return s;
}
function invalidateSettingsCache() { _settingsCache = null; }

// ── Customer Ledger (advance payments / dues, keyed by mobile number) ─────────
const ledgerEntrySchema = new mongoose.Schema({
  type:   { type: String, default: "adjust" }, // "advance" | "dues" | "adjust" | "applied"
  amount: { type: Number, default: 0 },         // positive = credit added, negative = debit
  note:   { type: String, default: "" },
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

const customerLedgerSchema = new mongoose.Schema({
  mobile:      { type: String, required: true, unique: true, index: true },
  customerName:{ type: String, default: "" },
  balance:     { type: Number, default: 0 }, // positive = advance credit available, negative = dues owed
  history:     [ledgerEntrySchema],
  updatedAt:   { type: Date, default: Date.now }
});
const CustomerLedger = mongoose.model("CustomerLedger", customerLedgerSchema);

// GST / total calculation helper — used for both online orders and manager POS
function computeOrderTotals(items, extraCharge, settings) {
  const subtotal = calcTotal(items);
  const ec = Math.max(0, Number(extraCharge || 0));
  const base = subtotal + ec;
  const gstEnabled = !!(settings && settings.gstEnabled);
  const gstPercent = gstEnabled ? Number(settings.gstPercent || 0) : 0;
  const gstAmount  = gstEnabled ? Math.round(base * (gstPercent / 100) * 100) / 100 : 0;
  const total = Math.round(base + gstAmount); // round to nearest ₹1 for the payable total — subtotal/GST kept precise above for records
  return {
    subtotal, extraCharge: ec, gstEnabled, gstPercent, gstAmount,
    gstin: gstEnabled ? (settings.gstin || "") : "", total
  };
}

// ─── APP SETUP ────────────────────────────────────────────────────────────────
let printQueue = [];

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─── MANAGER LOGIN ────────────────────────────────────────────────────────────
app.post("/api/manager/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ success: false, message: "Missing credentials" });
  if (username === managerUser && password === managerPass)
    return res.json({ success: true });
  return res.status(401).json({ success: false, message: "Invalid credentials" });
});

app.post("/api/manager/change-credentials", (_req, res) =>
  res.status(400).json({
    success: false,
    message: "Disabled. Update MANAGER_USER and MANAGER_PASS in .env file."
  })
);

// ─── MENU ─────────────────────────────────────────────────────────────────────
app.get("/menu.json", (req, res) =>
  res.sendFile(path.join(__dirname, "public/menu.json"))
);

app.post("/update-menu", (req, res) => {
  fs.writeFile(
    path.join(__dirname, "public", "menu.json"),
    JSON.stringify(req.body, null, 2),
    "utf8",
    (err) => {
      if (err) return res.status(500).json({ error: "Failed to save menu" });
      res.json({ success: true });
    }
  );
});

// ─── ORDERS ───────────────────────────────────────────────────────────────────
app.get("/api/orders", async (req, res) => {
  try {
    const { start, end } = getISTDateBounds(req.query.date || new Date().toISOString().slice(0, 10));
    const q = { createdAt: { $gte: start, $lte: end }, status: { $ne: "deleted" } };
    if (req.query.status) q.status = req.query.status;
    res.json(await Order.find(q).sort({ createdAt: -1 }));
  } catch (err) {
    res.status(500).json({ error: "Could not fetch orders" });
  }
});

// ─── NEW: Search orders by ID, customer name, mobile, or table ────────────────
app.get("/api/orders/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json([]);

    // Try ObjectId match first
    let idMatch = null;
    if (q.match(/^[a-f\d]{24}$/i)) {
      idMatch = await Order.findById(q).catch(() => null);
    }

    const textResults = await Order.find({
      status: { $ne: "deleted" },
      $or: [
        { customerName:  { $regex: q, $options: "i" } },
        { mobile:        { $regex: q, $options: "i" } },
        { tableNumber:   { $regex: q, $options: "i" } },
        { registrationNumber: { $regex: q, $options: "i" } }
      ]
    })
      .sort({ createdAt: -1 })
      .limit(20);

    const results = idMatch
      ? [idMatch, ...textResults.filter(r => r._id.toString() !== idMatch._id.toString())]
      : textResults;

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: "Could not search orders" });
  }
});

// ─── NEW: Customer autocomplete ───────────────────────────────────────────────
app.get("/api/customers/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 1) return res.json([]);

    // Get distinct customers matching the query by name or mobile
    const orders = await Order.find({
      status: { $ne: "deleted" },
      $or: [
        { customerName: { $regex: q, $options: "i" } },
        { mobile:       { $regex: q, $options: "i" } }
      ]
    })
      .select("customerName mobile")
      .sort({ createdAt: -1 })
      .limit(100);

    // Deduplicate by name+mobile pair
    const seen = new Set();
    const unique = [];
    for (const o of orders) {
      const key = `${(o.customerName || "").toLowerCase()}|${o.mobile || ""}`;
      if (!seen.has(key) && (o.customerName || o.mobile)) {
        seen.add(key);
        unique.push({ customerName: o.customerName || "", mobile: o.mobile || "" });
      }
      if (unique.length >= 8) break;
    }

    res.json(unique);
  } catch (err) {
    res.status(500).json({ error: "Could not search customers" });
  }
});

app.post("/api/orders", async (req, res) => {
  try {
    const {
      orderType, customerName, registrationNumber, mobile,
      tableNumber, address, location, items,
      paymentMethod, specialRequest, requestTags
    } = req.body || {};

    const normalItems = Array.isArray(items)
      ? items.map((i) => ({
          name:    String(i?.name    || ""),
          variant: String(i?.variant || ""),
          price:   Number(i?.price   || 0),
          qty:     Number(i?.qty     || 0)
        }))
      : [];
    const total = calcTotal(normalItems);

    // DINE-IN → pending queue only. No Order record created until manager finalizes.
    // (GST / extra charges for dine-in are applied later at manager finalize time.)
    if (orderType === "dinein") {
      const pending = new PendingDineIn({
        tableNumber:        String(tableNumber || "").trim(),
        customerName:       customerName       || "",
        mobile:             mobile             || "",
        registrationNumber: registrationNumber || "",
        guestCount:         1,
        items: Array.isArray(items)
          ? items.map((i) => ({
              name: i?.name || "", variant: i?.variant || "",
              price: Number(i?.price || 0), qty: Number(i?.qty || 0),
              category: i?.category || ""
            }))
          : [],
        total,
        specialRequest: specialRequest || "",
        requestTags:    Array.isArray(requestTags) ? requestTags : [],
        status:         "pending"
      });
      await pending.save();
      const obj = pending.toObject();
      obj._id   = obj._id.toString();
      io.emit("pendingDineIn", obj);
      return res.json({ success: true, pending: true, pendingId: obj._id });
    }

    // TAKEAWAY / DELIVERY → create Order immediately
    // Auto-apply manager-configured delivery/takeaway charge + GST (settings-driven,
    // since online customers can't be charged extra after placing the order).
    const settings = await getSettings();
    let autoExtraCharge = 0;
    if (orderType === "delivery" && settings.deliveryChargeEnabled) {
      autoExtraCharge = Number(settings.deliveryCharge || 0);
    } else if (orderType === "takeaway" && settings.takeawayChargeEnabled) {
      autoExtraCharge = Number(settings.takeawayCharge || 0);
    }
    const totals = computeOrderTotals(normalItems, autoExtraCharge, settings);

    const order = new Order({
      orderType, customerName, registrationNumber, mobile,
      tableNumber: tableNumber ? String(tableNumber) : "",
      address: address || "", location: location || null,
      items: normalItems,
      subtotal:    totals.subtotal,
      extraCharge: totals.extraCharge,
      extraChargeNote: autoExtraCharge ? (orderType === "delivery" ? "Delivery charge" : "Takeaway charge") : "",
      gstEnabled:  totals.gstEnabled,
      gstPercent:  totals.gstPercent,
      gstAmount:   totals.gstAmount,
      gstin:       totals.gstin,
      total:       totals.total,
      paymentMethod:   paymentMethod || "COD",
      paymentVerified: false,
      specialRequest:  specialRequest || "",
      requestTags:     Array.isArray(requestTags) ? requestTags : [],
      isDraft: false, source: "customer-menu", status: "incoming"
    });
    await order.save();
    io.emit("newOrder", order);
    printQueue.push(order);
    res.json({ success: true, order });
  } catch (err) {
    console.error("Create order error:", err);
    res.status(500).json({ success: false, error: "Could not create order", detail: err.message });
  }
});

// ─── NEW: GET single order by ID (was missing!) ───────────────────────────────
app.get("/api/orders/:id", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: "Not found" });
    res.json(order);
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not fetch order" });
  }
});

app.patch("/api/orders/:id/status", async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(
      req.params.id, { status: req.body?.status }, { new: true }
    );
    if (!order) return res.status(404).json({ success: false, error: "Not found" });
    io.emit("orderUpdated", order);
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not update status" });
  }
});

app.patch("/api/orders/:id/payment-verified", async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(
      req.params.id, { paymentVerified: !!req.body?.paymentVerified }, { new: true }
    );
    if (!order) return res.status(404).json({ success: false, error: "Not found" });
    io.emit("orderUpdated", order);
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not update payment" });
  }
});

// ─── NEW: Full order edit (items, customer info, status, payment) ─────────────
app.patch("/api/orders/:id", async (req, res) => {
  try {
    const allowed = [
      "customerName", "mobile", "registrationNumber", "address",
      "items", "total", "paymentMethod", "paymentVerified",
      "specialRequest", "requestTags", "status", "tableNumber",
      "extraCharge", "extraChargeNote", "collectedAmount"
    ];

    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }

    // Recalculate total if items or extraCharge changed — GST status/percent is
    // preserved from the original order (not retroactively toggled by current settings).
    if (update.items || update.extraCharge !== undefined) {
      const existing = await Order.findById(req.params.id);
      if (!existing) return res.status(404).json({ success: false, error: "Not found" });

      const newItems = update.items
        ? update.items.map(i => ({
            name:    String(i?.name    || ""),
            variant: String(i?.variant || ""),
            price:   Number(i?.price   || 0),
            qty:     Number(i?.qty     || 0)
          })).filter(i => i.name && i.qty > 0)
        : existing.items;
      if (update.items) update.items = newItems;

      const extraCharge = update.extraCharge !== undefined ? Number(update.extraCharge || 0) : Number(existing.extraCharge || 0);
      const subtotal = calcTotal(newItems);
      const base = subtotal + Math.max(0, extraCharge);
      const gstPercent = Number(existing.gstPercent || 0);
      const gstAmount = existing.gstEnabled ? Math.round(base * (gstPercent / 100) * 100) / 100 : 0;

      update.subtotal    = subtotal;
      update.extraCharge = Math.max(0, extraCharge);
      update.gstAmount   = gstAmount;
      update.total       = Math.round(base + gstAmount);
    }

    const order = await Order.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
    if (!order) return res.status(404).json({ success: false, error: "Not found" });

    io.emit("orderUpdated", order);
    res.json({ success: true, order });
  } catch (err) {
    console.error("Edit order error:", err);
    res.status(500).json({ success: false, error: "Could not edit order", detail: err.message });
  }
});

// ─── NEW: Delete ALL orders for a customer (by mobile) — must be declared
// BEFORE the generic "/:id" delete route below so Express doesn't treat
// "customer" as an :id value.
app.delete("/api/orders/customer/:mobile", async (req, res) => {
  try {
    const mobile = String(req.params.mobile || "").trim();
    if (!mobile) return res.status(400).json({ success: false, error: "mobile is required" });
    const result = await Order.deleteMany({ mobile });
    res.json({ success: true, deletedCount: result.deletedCount || 0 });
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not delete customer history" });
  }
});

app.delete("/api/orders/:id", async (req, res) => {
  try {
    await Order.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not delete order" });
  }
});

// ─── SERVICE REQUESTS ─────────────────────────────────────────────────────────
app.post("/api/service-request", async (req, res) => {
  try {
    const { type, requestType, customerName, mobile,
            registrationNumber, orderType, tableNumber, address, location } = req.body || {};
    const rt = normalizeRequestType(requestType || type);
    const sr = new ServiceRequest({
      type: rt, requestType: rt,
      customerName: customerName || "", mobile: mobile || "",
      registrationNumber: registrationNumber || "",
      orderType: orderType || "", tableNumber: tableNumber || "",
      address: address || "", location: location || null, status: "pending"
    });
    await sr.save();
    const payload = { ...sr.toObject(), requestType: rt, type: rt };
    io.emit("serviceRequest", payload);
    res.json({ success: true, serviceRequest: payload });
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not create service request" });
  }
});

app.get("/api/service-request", async (req, res) => {
  try {
    const { start, end } = getISTDateBounds(req.query.date || new Date().toISOString().slice(0, 10));
    const list = await ServiceRequest.find({ createdAt: { $gte: start, $lte: end } }).sort({ createdAt: -1 });
    res.json(list.map((item) => {
      const obj = item.toObject();
      const rt  = normalizeRequestType(obj.requestType || obj.type);
      return { ...obj, requestType: rt, type: rt };
    }));
  } catch (err) {
    res.status(500).json({ error: "Could not get service requests" });
  }
});

// ─── PENDING DINE-IN ──────────────────────────────────────────────────────────
app.get("/api/pending-dinein", async (req, res) => {
  try {
    const list = await PendingDineIn.find({ status: "pending" }).sort({ createdAt: -1 });
    res.json(list.map((r) => { const o = r.toObject(); o._id = o._id.toString(); return o; }));
  } catch (err) {
    res.status(500).json({ error: "Could not fetch pending requests" });
  }
});

app.post("/api/pending-dinein/:id/accept", async (req, res) => {
  try {
    const id      = req.params.id;
    const pending = await PendingDineIn.findById(id);
    if (!pending)
      return res.status(404).json({ success: false, error: "Pending request not found" });

    const tableNumber = String(pending.tableNumber || "").trim();
    if (!tableNumber)
      return res.status(400).json({ success: false, error: "Table number missing" });

    // Already processed — re-emit so UI syncs
    if (pending.status !== "pending") {
      const draft = await TableDraft.findOne({ tableNumber });
      if (draft) {
        const obj = draft.toObject(); obj._id = obj._id.toString();
        io.emit("tableDraftUpdated",     obj);
        io.emit("pendingDineInAccepted", { id: id.toString(), tableNumber });
        return res.json({ success: true, draft: obj });
      }
      return res.json({ success: true, draft: null });
    }

    pending.status = "accepted";
    await pending.save();

    let draft = await TableDraft.findOne({ tableNumber });

    if (!draft) {
      draft = new TableDraft({
        tableNumber,
        customerName: pending.customerName || "",
        mobile: pending.mobile || "",
        guestCount: pending.guestCount || 1,
        items: pending.items || [],
        status: "draft"
      });
    } else {
      const mergedItems = [...(draft.items || [])];

      (pending.items || []).forEach((pItem) => {
        const existing = mergedItems.find(
          (i) => i.name === pItem.name && i.variant === pItem.variant
        );

        if (existing) {
          existing.qty += Number(pItem.qty || 0);
        } else {
          mergedItems.push({
            name: pItem.name || "",
            variant: pItem.variant || "",
            price: Number(pItem.price || 0),
            qty: Number(pItem.qty || 0),
            category: pItem.category || ""
          });
        }
      });

      draft.items = mergedItems;

      if (!draft.customerName) draft.customerName = pending.customerName || "";
      if (!draft.mobile) draft.mobile = pending.mobile || "";

      draft.status = "draft";
    }

    await draft.save();

    const obj = draft.toObject();
    obj._id = obj._id.toString();

    io.emit("tableDraftUpdated", obj);
    io.emit("pendingDineInAccepted", {
      id: id.toString(),
      tableNumber
    });

    return res.json({ success: true, draft: obj });
  } catch (err) {
    console.error("Accept error:", err.message);
    res.status(500).json({ success: false, error: "Could not accept", detail: err.message });
  }
});

app.post("/api/pending-dinein/:id/reject", async (req, res) => {
  try {
    const pending = await PendingDineIn.findByIdAndUpdate(
      req.params.id, { status: "rejected" }, { new: true }
    );
    if (!pending)
      return res.status(404).json({ success: false, error: "Not found" });
    io.emit("pendingDineInRejected", { id: req.params.id, tableNumber: pending.tableNumber });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not reject" });
  }
});

// ─── TABLE DRAFTS ─────────────────────────────────────────────────────────────
app.get("/api/table-orders", async (req, res) => {
  try {
    res.json(await TableDraft.find({}).sort({ tableNumber: 1 }));
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not get table drafts" });
  }
});

// NOTE: This specific route must come BEFORE the :tableNumber param route
app.post("/api/table-orders/save-draft", async (req, res) => {
  try {
    const p = sanitizeTableDraftPayload(req.body);
    if (!p.tableNumber)
      return res.status(400).json({ success: false, error: "tableNumber is required" });

    const isCustom = !/^[1-9]\d*$/.test(p.tableNumber) || !!req.body.isCustom;
    const draft = await TableDraft.findOneAndUpdate(
      { tableNumber: p.tableNumber },
      {
        $set: {
          customerName: p.customerName,
          mobile:       p.mobile,
          guestCount:   p.guestCount,
          status:       p.status,
          items:        p.items,
          total:        p.total,
          extraCharge:      p.extraCharge,
          extraChargeNote:  p.extraChargeNote,
          isCustom,
          updatedAt:    new Date()
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { new: true, upsert: true }
    );

    io.emit("tableDraftUpdated", draft);
    res.json({ success: true, draft });
  } catch (err) {
    console.error("Save draft error:", err);
    res.status(500).json({ success: false, error: "Could not save table draft", detail: err.message });
  }
});

app.post("/api/table-orders/clear", async (req, res) => {
  try {
    const tableNumber = String(req.body?.tableNumber || "").trim();
    if (!tableNumber)
      return res.status(400).json({ success: false, error: "tableNumber is required" });
    await TableDraft.findOneAndDelete({ tableNumber });
    io.emit("tableDraftCleared", { tableNumber });
    res.json({ success: true, tableNumber });
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not clear table draft" });
  }
});

// Finalize: THIS is the only place a dine-in order enters Order History.
app.post("/api/table-orders/finalize", async (req, res) => {
  try {
    const p = sanitizeTableDraftPayload(req.body);
    if (!p.tableNumber)
      return res.status(400).json({ success: false, error: "tableNumber is required" });
    if (!p.items.length)
      return res.status(400).json({ success: false, error: "No items in draft" });

    const settings = await getSettings();
    const totals = computeOrderTotals(p.items, p.extraCharge, settings);

    // Apply any ledger credit/dues the manager chose to settle against this bill
    const ledgerApplied = Number(req.body.ledgerApplied || 0);

    const order = new Order({
      orderType:       "dinein",
      customerName:    p.customerName || "",
      mobile:          p.mobile       || "",
      tableNumber:     p.tableNumber,
      items: p.items.map((i) => ({
        name: i.name, variant: i.variant || "",
        price: Number(i.price || 0), qty: Number(i.qty || 0)
      })),
      subtotal:        totals.subtotal,
      extraCharge:      totals.extraCharge,
      extraChargeNote:  p.extraChargeNote || "",
      gstEnabled:      totals.gstEnabled,
      gstPercent:      totals.gstPercent,
      gstAmount:       totals.gstAmount,
      gstin:           totals.gstin,
      ledgerApplied,
      total:           Math.round(totals.total - ledgerApplied),
      paymentMethod:   "PAYLATERDINEIN",
      paymentVerified: false,
      isDraft:         false,
      source:          "manager-pos",
      status:          "delivered"
    });
    await order.save();

    if (p.mobile && ledgerApplied) {
      await CustomerLedger.findOneAndUpdate(
        { mobile: p.mobile },
        {
          $inc: { balance: -ledgerApplied },
          $push: { history: { type: "applied", amount: -ledgerApplied, note: `Applied to order ${order._id}` } },
          $set: { customerName: p.customerName || "", updatedAt: new Date() }
        },
        { upsert: true }
      );
    }

    io.emit("newOrder", order);
    printQueue.push(order);

    await TableDraft.findOneAndDelete({ tableNumber: p.tableNumber });
    io.emit("tableDraftCleared",   { tableNumber: p.tableNumber });
    io.emit("tableOrderFinalized", { tableNumber: p.tableNumber, order });

    res.json({ success: true, order });
  } catch (err) {
    console.error("Finalize error:", err);
    res.status(500).json({ success: false, error: "Could not finalize", detail: err.message });
  }
});

// Parameterised route — MUST be after save-draft / clear / finalize
app.get("/api/table-orders/:tableNumber", async (req, res) => {
  try {
    const draft = await TableDraft.findOne({ tableNumber: String(req.params.tableNumber).trim() });
    if (!draft) return res.status(404).json({ success: false, error: "Not found" });
    res.json(draft);
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not get table draft" });
  }
});

// ─── SETTINGS: GST & Compliance, delivery/takeaway charges ────────────────────
app.get("/api/settings", async (req, res) => {
  try {
    const s = await getSettings();
    res.json({ success: true, settings: s });
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not get settings" });
  }
});

app.post("/api/settings", async (req, res) => {
  try {
    const allowed = [
      "gstin", "gstEnabled", "gstPercent",
      "deliveryChargeEnabled", "deliveryCharge",
      "takeawayChargeEnabled", "takeawayCharge"
    ];
    const update = { updatedAt: new Date() };
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }
    const s = await Settings.findOneAndUpdate(
      { key: "main" }, { $set: update }, { new: true, upsert: true }
    );
    invalidateSettingsCache();
    io.emit("settingsUpdated", s);
    res.json({ success: true, settings: s });
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not update settings" });
  }
});

// ─── CUSTOMER LEDGER: advance payments / dues ──────────────────────────────────
app.get("/api/ledger/:mobile", async (req, res) => {
  try {
    const mobile = String(req.params.mobile || "").trim();
    if (!mobile) return res.json({ success: true, balance: 0, history: [] });
    const l = await CustomerLedger.findOne({ mobile });
    res.json({ success: true, balance: l ? l.balance : 0, history: l ? l.history : [] });
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not get ledger" });
  }
});

app.post("/api/ledger/adjust", async (req, res) => {
  try {
    const mobile = String(req.body?.mobile || "").trim();
    const amount = Number(req.body?.amount || 0);
    const note   = String(req.body?.note   || "").trim();
    const customerName = String(req.body?.customerName || "").trim();
    if (!mobile || !amount) return res.status(400).json({ success: false, error: "mobile and non-zero amount are required" });

    const l = await CustomerLedger.findOneAndUpdate(
      { mobile },
      {
        $inc: { balance: amount },
        $push: { history: { type: amount > 0 ? "advance" : "dues", amount, note } },
        $set:  { customerName: customerName || undefined, updatedAt: new Date() }
      },
      { new: true, upsert: true }
    );
    res.json({ success: true, balance: l.balance, history: l.history });
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not adjust ledger" });
  }
});

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
app.get("/api/dashboard/sales", async (req, res) => {
  try {
    const period = req.query.period || "day";
    const date   = req.query.date   || new Date().toISOString().slice(0, 10);
    let start, end;
    if (period === "day") {
      ({ start, end } = getISTDateBounds(date));
    } else if (period === "week") {
      const { start: ds } = getISTDateBounds(date);
      const d = new Date(ds);
      const first = new Date(d.setDate(d.getDate() - d.getDay()));
      start = new Date(first.setHours(0, 0, 0, 0));
      end   = new Date(new Date(start).setDate(start.getDate() + 7));
    } else {
      const { start: ds } = getISTDateBounds(date);
      const d = new Date(ds);
      start = new Date(d.getFullYear(), d.getMonth(), 1);
      end   = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
    }
    const orders = await Order.find({ createdAt: { $gte: start, $lte: end }, status: { $ne: "deleted" } });
    res.json({
      total: orders.reduce((s, o) => s + (o.total || 0), 0),
      count: orders.length,
      gstCollected: Math.round(orders.reduce((s, o) => s + (o.gstAmount || 0), 0) * 100) / 100,
      extraCharges: Math.round(orders.reduce((s, o) => s + (o.extraCharge || 0), 0) * 100) / 100
    });
  } catch (err) {
    res.status(500).json({ error: "Could not get sales" });
  }
});

app.get("/api/dashboard/peakhour", async (req, res) => {
  try {
    const { start, end } = getISTDateBounds(req.query.date || new Date().toISOString().slice(0, 10));
    const orders = await Order.find({ createdAt: { $gte: start, $lte: end }, status: { $ne: "deleted" } });
    const hourly = {};
    orders.forEach((o) => { const h = new Date(o.createdAt).getHours(); hourly[h] = (hourly[h] || 0) + 1; });
    let peak = { hour: "-", count: 0 };
    Object.entries(hourly).forEach(([h, c]) => { if (c > peak.count) peak = { hour: h, count: c }; });
    res.json(peak);
  } catch (err) {
    res.status(500).json({ error: "Could not get peak hour" });
  }
});

app.get("/api/dashboard/topdish", async (req, res) => {
  try {
    const { start } = getISTDateBounds(req.query.from || req.query.date || new Date().toISOString().slice(0, 10));
    const end = req.query.to
      ? getISTDateBounds(req.query.to).end
      : getISTDateBounds(req.query.from || req.query.date || new Date().toISOString().slice(0, 10)).end;
    const orders = await Order.find({ createdAt: { $gte: start, $lte: end }, status: { $ne: "deleted" } });
    const map = {};
    orders.forEach((o) => (o.items || []).forEach((i) => {
      const n = i.name || "?"; map[n] = (map[n] || 0) + (i.qty || 0);
    }));
    const top = Object.entries(map).sort((a, b) => b[1] - a[1])[0];
    res.json(top ? { _id: top[0], count: top[1] } : null);
  } catch (err) {
    res.status(500).json({ error: "Could not get top dish" });
  }
});

app.get("/api/dashboard/repeatcustomers", async (req, res) => {
  try {
    const { start } = getISTDateBounds(req.query.from || req.query.date || new Date().toISOString().slice(0, 10));
    const end = req.query.to
      ? getISTDateBounds(req.query.to).end
      : getISTDateBounds(req.query.from || req.query.date || new Date().toISOString().slice(0, 10)).end;
    const nameFilter = req.query.name ? { customerName: req.query.name } : {};
    const orders = await Order.find({ createdAt: { $gte: start, $lte: end }, status: { $ne: "deleted" }, ...nameFilter });
    const stats = {};
    orders.forEach((o) => { if (o.customerName) stats[o.customerName] = (stats[o.customerName] || 0) + 1; });
    if (req.query.name) return res.json([{ _id: req.query.name, orders: stats[req.query.name] || 0 }]);
    res.json(Object.entries(stats).sort((a, b) => b[1] - a[1]).map(([n, c]) => ({ _id: n, orders: c })));
  } catch (err) {
    res.status(500).json({ error: "Could not get repeat customers" });
  }
});

// ─── PRINT TICKET / KOT ───────────────────────────────────────────────────────
app.get("/api/next-print-ticket", (req, res) => {
  if (!printQueue.length) return res.status(204).send();
  const o = printQueue.shift();
  res.type("text/plain").send(buildKOTText(o));
});

// ─── NEW: Print KOT for any order by ID ───────────────────────────────────────
app.get("/api/orders/:id/kot", async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: "Not found" });
    res.type("text/plain").send(buildKOTText(order));
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not generate KOT" });
  }
});

function buildKOTText(o) {
  const lines = [
    "================================",
    "        FLAME AND FLAVOR        ",
    "================================",
    `KOT / ORDER TICKET`,
    `Order ID : ${o._id}`,
    `Type     : ${(o.orderType || "").toUpperCase()}`,
    `Time     : ${o.createdAt ? new Date(o.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : ""}`,
    "--------------------------------"
  ];
  if (o.customerName)        lines.push(`Name     : ${o.customerName}`);
  if (o.registrationNumber)  lines.push(`Reg No   : ${o.registrationNumber}`);
  if (o.mobile)              lines.push(`Mobile   : ${o.mobile}`);
  if (o.tableNumber)         lines.push(`Table    : ${o.tableNumber}`);
  if (o.address)             lines.push(`Address  : ${o.address}`);
  if (o.specialRequest)      lines.push(`Note     : ${o.specialRequest}`);
  if (o.requestTags?.length) lines.push(`Tags     : ${o.requestTags.join(", ")}`);
  if (o.gstin)                lines.push(`GSTIN    : ${o.gstin}`);
  lines.push(`Payment  : ${o.paymentMethod || "COD"}${o.paymentVerified ? " ✓ PAID" : " (PENDING)"}`);
  lines.push("================================");
  lines.push("           ITEMS");
  lines.push("================================");
  (o.items || []).forEach((it) =>
    lines.push(`  ${it.name}${it.variant ? ` (${it.variant})` : ""}\n  Qty: ${it.qty}   @ ₹${it.price} = ₹${it.price * it.qty}`)
  );
  lines.push("================================");
  if (o.subtotal)             lines.push(`  Subtotal      : ₹${o.subtotal}`);
  if (o.extraCharge)          lines.push(`  ${o.extraChargeNote || "Extra Charge"} : ₹${o.extraCharge}`);
  if (o.gstEnabled && o.gstAmount) lines.push(`  GST (${o.gstPercent}%)     : ₹${o.gstAmount}`);
  if (o.ledgerApplied)        lines.push(`  Balance Applied: -₹${o.ledgerApplied}`);
  lines.push(`  TOTAL : ₹${o.total}`);
  lines.push("================================");
  lines.push("\n\n\n");
  return lines.join("\n");
}

// ─── AI RECOMMENDATIONS ─────────────────────────────────────────────
app.post("/api/recommendations", async (req, res) => {
  try {
    const cartItems = req.body.items || [];

    if (!cartItems.length) {
      return res.json({ success: true, suggestions: [] });
    }

    const orders = await Order.find({}, { items: 1 })
      .sort({ createdAt: -1 })
      .limit(500);

    const pairCount = {};
    const itemCount = {};

    orders.forEach(order => {
      const names = (order.items || []).map(i => i.name).filter(Boolean);
      names.forEach(a => {
        itemCount[a] = (itemCount[a] || 0) + 1;
        names.forEach(b => {
          if (a === b) return;
          const key = `${a}||${b}`;
          pairCount[key] = (pairCount[key] || 0) + 1;
        });
      });
    });

    const cartNames = cartItems.map(i => i.name);
    const suggestionsMap = {};

    cartNames.forEach(name => {
      Object.keys(pairCount).forEach(key => {
        const [a, b] = key.split("||");
        if (a === name && !cartNames.includes(b)) {
          const confidence = pairCount[key] / (itemCount[a] || 1);
          if (!suggestionsMap[b]) suggestionsMap[b] = 0;
          suggestionsMap[b] += confidence;
        }
      });
    });

    const suggestions = Object.entries(suggestionsMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, score]) => ({
        name,
        score,
        reason: score > 0.6 ? "🔥 Frequently ordered together" : "⭐ Popular add-on"
      }));

    res.json({ success: true, suggestions });
  } catch (err) {
    console.error("Recommendation error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── SOCKET / HEALTH ──────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("🟢 Client connected:", socket.id);
  socket.emit("connected", { status: "connected" });
});

app.get("/health", (_req, res) => res.status(200).send("OK"));

server.listen(PORT, () => {
  console.log(`🚀 Server on http://localhost:${PORT}`);
  console.log(`👤 Manager: ${managerUser}`);
});
