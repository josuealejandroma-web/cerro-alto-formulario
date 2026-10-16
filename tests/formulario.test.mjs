import test from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, validEmail, validateForm, createEvent, createSubmission, DeliveryError } from "../validation.mjs";

const raw = {
  full_name: "  Lucía Prueba  ", phone: "099 123 4567", email: "", city: " Quito ",
  service_interest: "Limpieza", message: "  Quisiera información.  ", consent: true
};
const lead = validateForm(raw).lead;

test("equivalentes ecuatorianos producen el mismo E.164; también acepta fijo", () => {
  for (const phone of ["0991234567", "+593 99 123 4567", "00593 (99) 123-4567", "593991234567"]) {
    assert.equal(normalizePhone(phone), "+593991234567");
  }
  assert.equal(normalizePhone("02 000 4400"), "+59320004400");
});

test("internacional requiere país explícito y no se transforma en Ecuador", () => {
  assert.equal(normalizePhone("+1 (415) 555-0123"), "+14155550123");
  assert.equal(normalizePhone("0044 20 7946 0123"), "+442079460123");
  for (const phone of ["4155550123", "911", "+5930991234567", "09abc12345", "+0001234567", "+1234567890123456"]) {
    assert.equal(normalizePhone(phone), null, phone);
  }
});

test("correo opcional; conserva espacios interiores como error en vez de corregirlos", () => {
  assert.equal(validEmail(""), true);
  assert.equal(validEmail("   "), true);
  assert.equal(validEmail(" nombre+consulta@correo.com "), true);
  for (const email of ["a b@correo.com", "a@correo .com", "a@@correo.com", "a@correo", "a@-correo.com", ".a@correo.com", "a..b@correo.com"]) {
    assert.equal(validEmail(email), false, email);
  }
});

test("campos obligatorios y consentimiento, sin exigir correo ni mensaje", () => {
  const valid = validateForm({ ...raw, message: "" });
  assert.equal(valid.valid, true);
  assert.equal(valid.lead.email, "");
  assert.equal(valid.lead.message, "");
  const invalid = validateForm({ full_name: " ", phone: "", city: "", service_interest: "", consent: false });
  assert.deepEqual(Object.keys(invalid.errors), ["full_name", "phone", "city", "service_interest", "consent"]);
  assert.equal(validateForm({ ...raw, consent: "true" }).valid, false);
});

test("rechaza servicio ajeno al contrato, longitudes excesivas y nombre vacío", () => {
  assert.ok(validateForm({ ...raw, service_interest: "Implantes" }).errors.service_interest);
  assert.ok(validateForm({ ...raw, message: "x".repeat(1001) }).errors.message);
  assert.ok(validateForm({ ...raw, full_name: "12345" }).errors.full_name);
  assert.equal(validateForm({ ...raw, full_name: "María-José O’Connor" }).valid, true);
});

test("evento mantiene exactamente contrato original y no agrega consentimiento", () => {
  const event = createEvent({ ...lead, consent: true, ignored: "nunca incluir" }, "evt_web_test", "2026-10-16T12:00:00Z");
  assert.deepEqual(Object.keys(event), ["event_id", "event_type", "created_at", "source", "lead"]);
  assert.deepEqual(event.source, { platform: "web", campaign: null, form_id: "frm_web_contacto" });
  assert.deepEqual(Object.keys(event.lead), ["full_name", "phone", "email", "city", "service_interest", "message"]);
  assert.equal(event.event_type, "lead.created");
  assert.equal(event.lead.full_name, "Lucía Prueba");
  assert.equal(event.lead.phone, "+593991234567");
});

test("demo valida formato pero nunca hace petición ni anuncia recepción real", async () => {
  const client = createSubmission({ fetchImpl: () => { throw new Error("No debe llamar red"); }, makeId: () => "evt_demo" });
  assert.deepEqual(await client.submit(lead, ""), { mode: "demo", eventId: "evt_demo" });
});

test("HTTP fallido conserva payload e identidad para reintento, sin mutar datos", async () => {
  const requests = [];
  let attempt = 0;
  const client = createSubmission({
    fetchImpl: async (url, options) => { requests.push(JSON.parse(options.body)); return { ok: ++attempt > 1 }; },
    makeId: () => "evt_same", now: () => "2026-10-16T12:00:00Z"
  });
  const before = structuredClone(lead);
  await assert.rejects(client.submit(lead, "https://webhook.example"), error => error instanceof DeliveryError && error.code === "http");
  assert.deepEqual(lead, before);
  assert.deepEqual(await client.submit(lead, "https://webhook.example"), { mode: "sent", eventId: "evt_same" });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
});

test("doble envío mientras hay petición pendiente comparte una sola petición", async () => {
  let finish;
  let calls = 0;
  const client = createSubmission({
    fetchImpl: () => { calls++; return new Promise(resolve => { finish = resolve; }); }, makeId: () => "evt_pending"
  });
  const first = client.submit(lead, "https://webhook.example");
  const second = client.submit(lead, "https://webhook.example");
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish({ ok: true });
  await first;
});

test("edición del contenido o nueva consulta genera otra identidad", async () => {
  let ids = 0;
  const client = createSubmission({ makeId: () => "evt_" + ++ids });
  const first = await client.submit(lead, "");
  assert.equal((await client.submit(lead, "")).eventId, first.eventId);
  assert.notEqual((await client.submit({ ...lead, city: "Cumbayá" }, "")).eventId, first.eventId);
  client.reset();
  assert.equal((await client.submit(lead, "")).eventId, "evt_3");
});

test("timeout aborta la petición y permite reintentar con mismo event_id", async () => {
  const events = [];
  const client = createSubmission({
    timeoutMs: 5, makeId: () => "evt_timeout",
    fetchImpl: (url, options) => {
      events.push(JSON.parse(options.body));
      if (events.length > 1) return Promise.resolve({ ok: true });
      return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("abort")), { once: true }));
    }
  });
  await assert.rejects(client.submit(lead, "https://webhook.example"), error => error.code === "timeout");
  await client.submit(lead, "https://webhook.example");
  assert.deepEqual(events[0], events[1]);
});

test("un error de red sincrónico libera el envío y conserva su identidad", async () => {
  let calls = 0;
  const client = createSubmission({
    makeId: () => "evt_network",
    fetchImpl: () => { if (++calls === 1) throw new TypeError("Network error"); return Promise.resolve({ ok: true }); }
  });
  await assert.rejects(client.submit(lead, "https://webhook.example"), error => error.code === "network");
  assert.deepEqual(await client.submit(lead, "https://webhook.example"), { mode: "sent", eventId: "evt_network" });
});
