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
const MONGO_URI   = process.env.MONGO_URI    ||
  "mongodb+srv://architkumarsncp2123_db_user:abbaseenu@abbaseenudb.5sndjat.mongodb.net/?appName=AbbaSeenudb";

mongoose.connect(MONGO_URI, { dbName: "AbbaSeenudb" });
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
    total:    Number,
    isDraft:  { type: Boolean, default: false },
    source:   { type: String,  default: "" },
    status:   { type: String,  default: "incoming" },
    createdAt:{ type: Date,    default: Date.now, index: true }
  },
  { strict: false }
);
orderSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });
const Order = mongoose.model("Order", orderSchema);

const serviceRequestSchema = new mongoose.Schema({
  type: String, requestType: String, customerName: String, mobile: String,
  registrationNumber: String, orderType: String, tableNumber: String,
  address: String, location: { lat: Number, lng: Number },
  status:    { type: String, default: "pending" },
  createdAt: { type: Date,   default: Date.now, index: true }
});
serviceRequestSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });
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
pendingDineInSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });
const PendingDineIn = mongoose.model("PendingDineIn", pendingDineInSchema);

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
    const order = new Order({
      orderType, customerName, registrationNumber, mobile,
      tableNumber: tableNumber ? String(tableNumber) : "",
      address: address || "", location: location || null,
      items: normalItems, total,
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
      "specialRequest", "requestTags", "status", "tableNumber"
    ];

    const update = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }

    // Recalculate total if items changed
    if (update.items) {
      update.items = update.items.map(i => ({
        name:    String(i?.name    || ""),
        variant: String(i?.variant || ""),
        price:   Number(i?.price   || 0),
        qty:     Number(i?.qty     || 0)
      })).filter(i => i.name && i.qty > 0);
      update.total = calcTotal(update.items);
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

    const order = new Order({
      orderType:       "dinein",
      customerName:    p.customerName || "",
      mobile:          p.mobile       || "",
      tableNumber:     p.tableNumber,
      items: p.items.map((i) => ({
        name: i.name, variant: i.variant || "",
        price: Number(i.price || 0), qty: Number(i.qty || 0)
      })),
      total:           p.total || calcTotal(p.items),
      paymentMethod:   "PAYLATERDINEIN",
      paymentVerified: false,
      isDraft:         false,
      source:          "manager-pos",
      status:          "delivered"
    });
    await order.save();

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
    res.json({ total: orders.reduce((s, o) => s + (o.total || 0), 0), count: orders.length });
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
    "   ABBA SEENUUU... FAST FOODS   ",
    '   Taste like "ahh devudaa..."  ',
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
  lines.push(`Payment  : ${o.paymentMethod || "COD"}${o.paymentVerified ? " ✓ PAID" : " (PENDING)"}`);
  lines.push("================================");
  lines.push("           ITEMS");
  lines.push("================================");
  (o.items || []).forEach((it) =>
    lines.push(`  ${it.name}${it.variant ? ` (${it.variant})` : ""}\n  Qty: ${it.qty}   @ ₹${it.price} = ₹${it.price * it.qty}`)
  );
  lines.push("================================");
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
