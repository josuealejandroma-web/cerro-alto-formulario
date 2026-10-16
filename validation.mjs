export const SERVICES = Object.freeze([
  "Blanqueamiento", "Combo limpieza + blanqueamiento", "Limpieza", "Valoración",
  "Ortodoncia", "Alineadores", "Otro"
]);

const cleanText = (value) => typeof value === "string" ? value.trim() : "";

// Normalización de formato: no verifica que el número exista ni su titular.
export function normalizePhone(value) {
  const original = cleanText(value);
  if (!original || original.length > 32 || !/^[+\d\s().-]+$/.test(original)) return null;
  let compact = original.replace(/[\s().-]/g, "");
  if (compact.startsWith("00")) compact = "+" + compact.slice(2);
  if (/^09\d{8}$/.test(compact) || /^0[2-7]\d{7}$/.test(compact)) {
    compact = "+593" + compact.slice(1);
  } else if (/^593\d+$/.test(compact)) {
    compact = "+" + compact;
  }
  if (!/^\+[1-9]\d{7,14}$/.test(compact)) return null;
  if (compact.startsWith("+593") && !/^\+593(?:9\d{8}|[2-7]\d{7})$/.test(compact)) return null;
  return compact;
}

export function validEmail(value) {
  const email = cleanText(value);
  if (!email) return true;
  if (email.length > 254 || /\s/.test(email)) return false;
  const parts = email.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)) return false;
  const labels = domain.split(".");
  return labels.length >= 2 && /^[a-zA-Z]{2,63}$/.test(labels.at(-1)) && labels.every(label =>
    label.length <= 63 && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label)
  );
}

export function validateForm(raw) {
  const lead = {
    full_name: cleanText(raw.full_name),
    phone: normalizePhone(raw.phone) || "",
    email: cleanText(raw.email),
    city: cleanText(raw.city),
    service_interest: cleanText(raw.service_interest),
    message: cleanText(raw.message)
  };
  const errors = {};
  if (lead.full_name.length < 2 || lead.full_name.length > 120 || !/\p{L}/u.test(lead.full_name) || /[<>\x00-\x1f]/.test(lead.full_name)) {
    errors.full_name = "Escribe tu nombre completo (entre 2 y 120 caracteres).";
  }
  if (!lead.phone) errors.phone = "Escribe un teléfono válido: 0991234567, 022000440 o un número con + y código de país.";
  if (!validEmail(raw.email)) errors.email = "Revisa el correo: usa un formato como nombre@correo.com, sin espacios interiores.";
  if (lead.city.length < 2 || lead.city.length > 80 || !/\p{L}/u.test(lead.city) || /[<>\x00-\x1f]/.test(lead.city)) {
    errors.city = "Escribe tu ciudad (entre 2 y 80 caracteres).";
  }
  if (!SERVICES.includes(lead.service_interest)) errors.service_interest = "Selecciona un servicio. Si no sabes cuál, elige Otro / necesito orientación.";
  if (lead.message.length > 1000) errors.message = "Resume tu consulta en un máximo de 1000 caracteres.";
  if (raw.consent !== true) errors.consent = "Marca la autorización para que podamos gestionar tu consulta y contactarte.";
  return { valid: Object.keys(errors).length === 0, lead, errors };
}

export function createEvent(lead, eventId, createdAt) {
  return {
    event_id: eventId,
    event_type: "lead.created",
    created_at: createdAt,
    source: { platform: "web", campaign: null, form_id: "frm_web_contacto" },
    lead: {
      full_name: lead.full_name,
      phone: lead.phone,
      email: lead.email,
      city: lead.city,
      service_interest: lead.service_interest,
      message: lead.message
    }
  };
}

export class DeliveryError extends Error {
  constructor(code) {
    super("No se pudo confirmar la recepción de la consulta.");
    this.name = "DeliveryError";
    this.code = code;
  }
}

// Mantiene la identidad del evento durante reintentos de un mismo formulario.
// La deduplicación definitiva debe implementarse también en el servidor receptor.
export function createSubmission({
  fetchImpl = globalThis.fetch,
  makeId = () => "evt_web_" + globalThis.crypto.randomUUID(),
  now = () => new Date().toISOString(),
  timeoutMs = 12000
} = {}) {
  let fingerprint;
  let event;
  let pending;
  return {
    submit(lead, url) {
      if (pending) return pending;
      const nextFingerprint = JSON.stringify(lead);
      if (nextFingerprint !== fingerprint) {
        event = createEvent(lead, makeId(), now());
        fingerprint = nextFingerprint;
      }
      if (!url) return Promise.resolve({ mode: "demo", eventId: event.event_id });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      pending = Promise.resolve().then(async () => {
        try {
          const response = await fetchImpl(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(event),
            signal: controller.signal,
            credentials: "omit",
            referrerPolicy: "no-referrer"
          });
          if (!response.ok) throw new DeliveryError("http");
          return { mode: "sent", eventId: event.event_id };
        } catch (error) {
          if (error instanceof DeliveryError) throw error;
          throw new DeliveryError(controller.signal.aborted ? "timeout" : "network");
        } finally {
          clearTimeout(timer);
          pending = undefined;
        }
      });
      return pending;
    },
    reset() {
      if (pending) return;
      fingerprint = undefined;
      event = undefined;
    }
  };
}
