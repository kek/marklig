// Phone-side pairing form. v2.0-alpha shortcut: a plain HTML form with
// three text inputs (QR URL, desktop host, friendly name). The QR is
// pasted as text since a camera-driven scanner is its own follow-up.
//
// On submit, calls mobile_pairing_start (Rust-side Noise XK initiator)
// and renders the success/failure state. On success, the caller
// re-renders the library so the new pairing appears in the list.

import { t } from "../i18n/strings";
import { startMobilePairing, type MobilePairResult } from "../shell/mobile-pairings";

export interface PairFormHandlers {
  onPaired: (result: MobilePairResult) => void;
  onCancel: () => void;
}

export function mountMobilePairForm(
  root: HTMLElement,
  handlers: PairFormHandlers,
): void {
  root.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "mobile-pair-form";

  const title = document.createElement("h1");
  title.className = "mobile-pair-form__title";
  title.textContent = t("mobile.pair.title");
  wrap.appendChild(title);

  const form = document.createElement("form");
  form.className = "mobile-pair-form__form";

  const qrField = makeField(
    t("mobile.pair.qr_label"),
    "qr",
    t("mobile.pair.qr_placeholder"),
    true,
  );
  form.appendChild(qrField.label);

  const hostField = makeField(
    t("mobile.pair.host_label"),
    "host",
    t("mobile.pair.host_placeholder"),
    false,
  );
  form.appendChild(hostField.label);

  const nameField = makeField(
    t("mobile.pair.name_label"),
    "name",
    t("mobile.pair.name_placeholder"),
    false,
  );
  form.appendChild(nameField.label);

  const status = document.createElement("p");
  status.className = "mobile-pair-form__status";
  form.appendChild(status);

  const buttons = document.createElement("div");
  buttons.className = "mobile-pair-form__buttons";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "mobile-pair-form__cancel";
  cancel.textContent = t("mobile.pair.cancel");
  cancel.addEventListener("click", () => handlers.onCancel());

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "mobile-pair-form__submit";
  submit.textContent = t("mobile.pair.submit");

  buttons.appendChild(cancel);
  buttons.appendChild(submit);
  form.appendChild(buttons);

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const qr = qrField.input.value.trim();
    const host = hostField.input.value.trim();
    const name = nameField.input.value.trim() || "Phone";
    if (!qr || !host) {
      status.textContent = "Please fill in the QR URL and the desktop IP.";
      return;
    }
    submit.disabled = true;
    cancel.disabled = true;
    status.textContent = t("mobile.pair.in_progress");
    try {
      const result = await startMobilePairing({
        qrPayload: qr,
        host,
        friendlyName: name,
      });
      // Show a success view briefly with the fingerprint then hand off
      // to the caller. The caller re-renders the library.
      handlers.onPaired(result);
    } catch (err) {
      status.textContent = t("mobile.pair.failed_prefix") + String(err);
      submit.disabled = false;
      cancel.disabled = false;
    }
  });

  wrap.appendChild(form);
  root.appendChild(wrap);

  // Focus the QR field so the user can paste immediately.
  setTimeout(() => qrField.input.focus(), 50);
}

function makeField(
  labelText: string,
  name: string,
  placeholder: string,
  multiline: boolean,
): { label: HTMLLabelElement; input: HTMLInputElement | HTMLTextAreaElement } {
  const label = document.createElement("label");
  label.className = "mobile-pair-form__field";

  const span = document.createElement("span");
  span.className = "mobile-pair-form__field-label";
  span.textContent = labelText;
  label.appendChild(span);

  const input = multiline
    ? document.createElement("textarea")
    : document.createElement("input");
  if (input instanceof HTMLInputElement) input.type = "text";
  input.name = name;
  input.placeholder = placeholder;
  input.className = "mobile-pair-form__input";
  if (input instanceof HTMLTextAreaElement) input.rows = 3;
  label.appendChild(input);

  return { label, input };
}

export function showMobilePairSuccess(
  root: HTMLElement,
  result: MobilePairResult,
  onDismiss: () => void,
): void {
  root.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "mobile-pair-form mobile-pair-form--success";

  const title = document.createElement("h1");
  title.className = "mobile-pair-form__title";
  title.textContent =
    t("mobile.pair.success_prefix") + (result.friendly_name || "desktop");
  wrap.appendChild(title);

  const hint = document.createElement("p");
  hint.className = "mobile-pair-form__success-hint";
  hint.textContent = t("mobile.pair.success_fingerprint").replace(
    "{fingerprint}",
    result.verification_fingerprint,
  );
  wrap.appendChild(hint);

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "mobile-pair-form__submit";
  dismiss.textContent = t("mobile.pair.dismiss");
  dismiss.addEventListener("click", onDismiss);
  wrap.appendChild(dismiss);

  root.appendChild(wrap);
}
