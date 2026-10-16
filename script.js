import { validateForm, createSubmission } from "./validation.mjs";

const form = document.getElementById("formulario");
const fieldsets = [...form.querySelectorAll("fieldset")];
const summary = document.getElementById("error-summary");
const errorList = document.getElementById("error-list");
const status = document.getElementById("submission-status");
const button = document.getElementById("submit-button");
const buttonLabel = document.getElementById("submit-label");
const newRequest = document.getElementById("new-request");
const webhook = typeof window.WEBHOOK_URL === "string" ? window.WEBHOOK_URL.trim() : "";
const fields = {
  full_name: document.getElementById("nombre"),
  phone: document.getElementById("telefono"),
  email: document.getElementById("correo"),
  city: document.getElementById("ciudad"),
  service_interest: document.getElementById("servicio"),
  message: document.getElementById("mensaje"),
  consent: document.getElementById("consentimiento")
};
const labels = { full_name: "Nombre", phone: "Teléfono", email: "Correo", city: "Ciudad", service_interest: "Servicio", message: "Mensaje", consent: "Autorización" };
const submission = createSubmission();
let submitted = false;
let busy = false;

function readForm() {
  return Object.fromEntries(Object.entries(fields).map(([name, input]) => [name, name === "consent" ? input.checked : input.value]));
}

function showFieldError(name, message) {
  const input = fields[name];
  const error = document.getElementById(input.id + "-error");
  input.setAttribute("aria-invalid", message ? "true" : "false");
  error.textContent = message || "";
  error.hidden = !message;
}

function renderErrors(errors) {
  errorList.replaceChildren();
  for (const name of Object.keys(fields)) {
    showFieldError(name, errors[name]);
    if (!errors[name]) continue;
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = "#" + fields[name].id;
    link.textContent = labels[name] + ": " + errors[name];
    link.addEventListener("click", (event) => { event.preventDefault(); fields[name].focus(); });
    item.append(link);
    errorList.append(item);
  }
  summary.hidden = Object.keys(errors).length === 0;
}

function setBusy(value) {
  busy = value;
  fieldsets.forEach(fieldset => { fieldset.disabled = value; });
  button.disabled = value;
  form.setAttribute("aria-busy", String(value));
  buttonLabel.textContent = value ? "Enviando…" : "Enviar mi consulta";
}

function showStatus(title, text, isError = false) {
  status.replaceChildren();
  const heading = document.createElement("h3");
  const paragraph = document.createElement("p");
  heading.textContent = title;
  paragraph.textContent = text;
  status.append(heading, paragraph);
  status.classList.toggle("notice-error", isError);
  status.hidden = false;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  submitted = true;
  status.hidden = true;
  const result = validateForm(readForm());
  renderErrors(result.errors);
  if (!result.valid) { summary.focus(); return; }
  setBusy(true);
  try {
    const delivery = await submission.submit(result.lead, webhook);
    if (delivery.mode === "demo") {
      showStatus("Prueba local: no se ha enviado tu consulta.", "Los datos tienen un formato válido. Esta vista es una demostración; para contactar a la clínica, llama a recepción al +593 2 000 4400.");
    } else {
      showStatus("Recibimos tu consulta.", "Recepción revisará tu mensaje y te contactará en su horario de atención. Si escribiste fuera de horario, será desde la próxima apertura. Este envío no confirma una cita.");
    }
    form.hidden = true;
    newRequest.hidden = false;
  } catch (error) {
    const text = error.code === "timeout"
      ? "La conexión tardó demasiado y no pudimos confirmar la recepción. Tus datos siguen aquí: puedes reintentar. Si necesitas ayuda, llama al +593 2 000 4400."
      : "No pudimos confirmar la recepción. Conservamos tus datos en este formulario para que reintentes. Si el problema continúa, llama al +593 2 000 4400.";
    showStatus("No se confirmó el envío.", text, true);
  } finally {
    setBusy(false);
    status.focus();
  }
});

for (const [name, input] of Object.entries(fields)) {
  input.addEventListener("blur", () => {
    if (busy) return;
    const { errors } = validateForm(readForm());
    if (submitted) renderErrors(errors);
    else if (input.value || input.type === "checkbox") showFieldError(name, errors[name]);
  });
  input.addEventListener(name === "consent" || name === "service_interest" ? "change" : "input", () => {
    if (busy) return;
    status.hidden = true;
    if (submitted) renderErrors(validateForm(readForm()).errors);
    else if (input.getAttribute("aria-invalid") === "true") showFieldError(name, validateForm(readForm()).errors[name]);
  });
}
fields.message.addEventListener("input", () => {
  document.getElementById("message-count").textContent = fields.message.value.length + "/1000";
});
newRequest.addEventListener("click", () => {
  form.reset();
  submission.reset();
  submitted = false;
  renderErrors({});
  document.getElementById("message-count").textContent = "0/1000";
  status.hidden = true;
  form.hidden = false;
  newRequest.hidden = true;
  fields.full_name.focus();
});

document.getElementById("demo-notice").hidden = Boolean(webhook);
fieldsets.forEach(fieldset => { fieldset.disabled = false; });
