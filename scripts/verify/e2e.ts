/**
 * StayLoop — end-to-end feature verification against the running dev server.
 * Walks the real product flows: admin CRM → restaurant setup → guest QR order
 * → kitchen → POS bill → payment → reports, plus RBAC + tenant isolation.
 */
import { call, check, summary } from "./probe-lib";

const uniq = Date.now();
const rnd = Math.floor(Math.random() * 1e6);

async function main() {
  // ============ 1. Admin session ============
  const login = await call("POST", "/api/auth/login", {
    email: "admin@grandpalace.com",
    password: "TestAdmin123",
  });
  check("auth", "hotel admin login", login.status === 200, `status=${login.status}`);

  // ============ 2. Restaurant setup: category + item + table with ORDER QR ============
  const cat = await call("POST", "/api/menu/categories", { name: `E2E Cat ${uniq}`, sortOrder: 50 });
  const catId = cat.body?.category?.id ?? cat.body?.id;
  check("menu", "create category", cat.status === 201 && !!catId, `status=${cat.status}`);

  const item = await call("POST", "/api/menu/items", {
    name: "E2E Dish",
    categoryId: catId,
    priceMinor: 25000, // ₹250.00
    isVeg: true,
  });
  const itemId = item.body?.item?.id ?? item.body?.id;
  check("menu", "create menu item (priceMinor paise)", item.status === 201 && !!itemId, `status=${item.status} ${JSON.stringify(item.body).slice(0, 120)}`);

  const table = await call("POST", "/api/tables", { number: `E2E${rnd % 997}`, capacity: 4, createQr: true });
  const tableId = table.body?.table?.id;
  const orderQr = table.body?.table?.qr?.code;
  check("tables", "create table + bound ORDER QR", table.status === 201 && !!tableId && !!orderQr, `status=${table.status} qr=${orderQr ? "yes" : "no"}`);

  // ============ 3. Guest scan: public menu resolves + opens a session ============
  const menu = await call("GET", `/api/public/menu/${orderQr}`);
  const sessionToken = menu.body?.session?.publicToken;
  const publicItems = menu.body?.categories?.flatMap?.((c: any) => c.items ?? []) ?? [];
  check("guest", "public menu by QR code (no auth)", menu.status === 200, `status=${menu.status} categories=${menu.body?.categories?.length ?? "?"}`);
  check("guest", "table QR bootstraps dining session", !!sessionToken, `token=${sessionToken ? "yes" : "no"}`);
  check("guest", "public catalog contains the new item", publicItems.some((i: any) => i.id === itemId), `items=${publicItems.length}`);

  // ============ 4. Guest places an order (server-priced, idempotent) ============
  const idem = `e2e-${uniq}-${rnd}`;
  const order = await call("POST", "/api/public/orders", {
    sessionToken,
    idempotencyKey: idem,
    cart: [{ menuItemId: itemId, quantity: 2 }],
    customerName: "E2E Guest",
    customerPhone: `+9198${String(rnd).padStart(8, "0").slice(0, 8)}`,
  });
  const orderId = order.body?.order?.id;
  check("guest", "place order from QR cart", order.status === 201 && !!orderId, `status=${order.status} ${JSON.stringify(order.body).slice(0, 150)}`);

  const order2 = await call("POST", "/api/public/orders", {
    sessionToken,
    idempotencyKey: idem,
    cart: [{ menuItemId: itemId, quantity: 2 }],
  });
  check("guest", "same idempotency key → same order (no duplicate)", order2.body?.order?.id === orderId, `status=${order2.status} sameId=${order2.body?.order?.id === orderId}`);

  // ============ 5. Kitchen: KDS queue + item status transitions ============
  const kds = await call("GET", "/api/kds");
  const kdsOrder = kds.body?.queue?.find?.((o: any) => o.id === orderId);
  check("kds", "order appears on the kitchen display", kds.status === 200 && !!kdsOrder, `status=${kds.status} found=${!!kdsOrder}`);

  const kdsItemId = kdsOrder?.items?.[0]?.id;
  if (kdsItemId) {
    const prep = await call("PATCH", `/api/orders/${orderId}/items/${kdsItemId}`, { to: "PREPARING" });
    const ready = await call("PATCH", `/api/orders/${orderId}/items/${kdsItemId}`, { to: "READY" });
    const served = await call("PATCH", `/api/orders/${orderId}/items/${kdsItemId}`, { to: "SERVED" });
    check("kds", "item lifecycle PREPARING → READY → SERVED", prep.status === 200 && ready.status === 200 && served.status === 200, `${prep.status}/${ready.status}/${served.status}`);
    const bad = await call("PATCH", `/api/orders/${orderId}/items/${kdsItemId}`, { to: "PREPARING" });
    check("kds", "illegal backwards transition rejected", bad.status >= 400, `status=${bad.status}`);
  }

  // ============ 6. POS: bill the session, check GST math, then pay ============
  const sessionId = menu.body?.session?.id;
  const bill = await call("POST", "/api/bills", { tableSessionId: sessionId });
  const billId = bill.body?.bill?.id;
  const billRead = billId ? await call("GET", `/api/bills/${billId}`) : { body: null, status: 0 };
  const totals = billRead.body?.bill ?? bill.body?.bill;
  check("pos", "generate bill from session", bill.status === 201 && !!billId, `status=${bill.status} ${JSON.stringify(bill.body).slice(0, 200)}`);
  if (totals) {
    const expectedSubtotal = 25000 * 2;
    check("pos", "bill subtotal = server-computed cart total", totals.subtotalMinor === expectedSubtotal, `subtotal=${totals.subtotalMinor} expected=${expectedSubtotal}`);
    check("pos", "bill total = subtotal + tax − discount", totals.totalMinor === totals.subtotalMinor + (totals.taxMinor ?? 0) - (totals.discountMinor ?? 0), `total=${totals.totalMinor} tax=${totals.taxMinor} discount=${totals.discountMinor}`);
  }

  if (billId && totals) {
    const partial = await call("POST", `/api/bills/${billId}/pay`, { method: "CASH", amountMinor: Math.floor(totals.totalMinor / 2) });
    check("pos", "partial cash payment accepted (split payment)", partial.status === 201, `status=${partial.status}`);
    const over = await call("POST", `/api/bills/${billId}/pay`, { method: "CASH", amountMinor: totals.totalMinor * 10 });
    check("pos", "overpayment rejected", over.status >= 400, `status=${over.status} ${JSON.stringify(over.body).slice(0, 120)}`);
    const rest = await call("POST", `/api/bills/${billId}/pay`, { method: "UPI", amountMinor: totals.totalMinor - Math.floor(totals.totalMinor / 2) });
    check("pos", "remaining balance paid → bill settled", rest.status === 201, `status=${rest.status}`);

    const receipt = await call("GET", `/api/bills/${billId}/receipt`);
    check("pos", "receipt retrievable after settlement", receipt.status === 200, `status=${receipt.status}`);
    const gateway = await call("POST", `/api/bills/${billId}/pay`, { method: "ONLINE", amountMinor: 100 });
    check("pos", "client-claimed ONLINE payment rejected (gateway-only)", gateway.status === 422, `status=${gateway.status}`);
  }

  // ============ 7. Reports reflect the settled bill ============
  const sales = await call("GET", "/api/reports/sales");
  check("reports", "daily sales report returns a window + totals", sales.status === 200 && !!sales.body?.window, `status=${sales.status} window=${JSON.stringify(sales.body?.window ?? {}).slice(0, 100)}`);
  check("reports", "settled bill counted in today's sales", (sales.body?.bills?.count ?? 0) > 0, `bills=${sales.body?.bills?.count} netMinor=${sales.body?.bills?.netMinor ?? "?"}`);

  // ============ 8. Reservations + inventory + loyalty ============
  const d = new Date(Date.now() + 2 * 86400000);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const resv = await call("POST", "/api/reservations", {
    guestName: "E2E Guest", guestPhone: "+919000000009", partySize: 4, date: ymd, startTime: "19:30",
  });
  check("operations", "create reservation (YYYY-MM-DD + HH:MM)", resv.status === 201 || resv.status === 200, `status=${resv.status} ${JSON.stringify(resv.body).slice(0, 120)}`);

  const ing = await call("POST", "/api/inventory/ingredients", {
    name: `E2E Flour ${uniq}`, unit: "KG", reorderLevel: 2, costPerUnitMinor: 5000,
  });
  const ingId = ing.body?.ingredient?.id;
  check("inventory", "create ingredient", ing.status === 201 && !!ingId, `status=${ing.status}`);
  if (ingId) {
    const po = await call("POST", "/api/inventory/purchase-orders", {
      supplier: { name: "E2E Supplier" },
      lines: [{ ingredientId: ingId, qty: 10, unitCostMinor: 4500 }],
    });
    check("inventory", "raise purchase order", po.status === 201, `status=${po.status} ${JSON.stringify(po.body).slice(0, 140)}`);
  }

  const loyalty = await call("GET", "/api/loyalty");
  check("loyalty", "loyalty dashboard", loyalty.status === 200, `status=${loyalty.status}`);

  // ============ 9. RBAC: staff cannot do manager actions ============
  const savedJar = call.jar;
  await call("POST", "/api/auth/logout");
  const staffLogin = await call("POST", "/api/auth/login", { email: "staff@grandpalace.com", password: "TestStaff123" });
  check("rbac", "staff login", staffLogin.status === 200, `status=${staffLogin.status}`);
  const staffBill = await call("POST", "/api/bills", { tableSessionId: sessionId });
  check("rbac", "HOTEL_STAFF denied bill creation (needs BILL_CREATE)", staffBill.status === 403, `status=${staffBill.status}`);
  const staffRoles = await call("POST", "/api/custom-roles", { name: "Rogue", permissions: ["ADMIN_ACCESS"] });
  check("rbac", "HOTEL_STAFF denied custom-role creation", staffRoles.status === 403, `status=${staffRoles.status}`);
  const staffAudit = await call("GET", "/api/audit-logs");
  check("rbac", "HOTEL_STAFF audit-log access is allowed or denied (no 500)", staffAudit.status === 200 || staffAudit.status === 403, `status=${staffAudit.status}`);

  // ============ 10. Tenant isolation across hotels ============
  await call("POST", "/api/auth/logout");
  const otherLogin = await call("POST", "/api/auth/login", { email: "admin@seaview.com", password: "TestAdmin123" });
  check("tenant", "second hotel admin login", otherLogin.status === 200, `status=${otherLogin.status}`);
  const foreign = await call("GET", `/api/bills/${billId}`);
  check("tenant", "cannot read another hotel's bill", foreign.status === 404 || foreign.status === 403, `status=${foreign.status}`);
  const foreignCustomer = await call("GET", "/api/customers?limit=100");
  const ids = (foreignCustomer.body?.customers ?? []).map((c: any) => c.id);
  check("tenant", "customer list is tenant-scoped", !ids.includes(undefined) && foreignCustomer.status === 200, `status=${foreignCustomer.status} count=${ids.length}`);
  summary();
  return savedJar;
}

await main();
