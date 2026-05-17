// Pairing modal — step 5 of the v2 mobile companion. Shows the QR
// payload from the desktop's pairing handshake so the user can scan it
// on the phone (step 7 ships the scanner). Until the LAN transport
// (step 6) and phone-side scanner (step 7) land, this modal is mostly
// informational: the QR payload is rendered as copyable text and the
// confirm/cancel buttons short-circuit. When the network plumbing
// arrives, the same modal extends to display the verification
// fingerprint and drive the final confirm.

import { openModal } from "./modal";
import { startPairing, cancelPairing } from "../shell/pairings";
import { t } from "../i18n/strings";

export function openPairingModal(): Promise<void> {
  return openModal({
    title: t("pairing.modal.title"),
    build: (body) => {
      const status = document.createElement("p");
      status.className = "pairing-modal__status";
      status.textContent = t("pairing.modal.starting");
      body.appendChild(status);

      const qrLabel = document.createElement("p");
      qrLabel.className = "pairing-modal__scan-hint";
      qrLabel.textContent = t("pairing.modal.scan_hint");
      qrLabel.style.display = "none";
      body.appendChild(qrLabel);

      const qrField = document.createElement("textarea");
      qrField.className = "pairing-modal__qr-payload";
      qrField.readOnly = true;
      qrField.rows = 3;
      qrField.style.display = "none";
      qrField.setAttribute("aria-label", t("pairing.modal.qr_payload_aria"));
      body.appendChild(qrField);

      const note = document.createElement("p");
      note.className = "pairing-modal__note";
      note.textContent = t("pairing.modal.alpha_note");
      note.style.display = "none";
      body.appendChild(note);

      void startPairing().then(
        (started) => {
          status.textContent = t("pairing.modal.ready");
          qrLabel.style.display = "";
          qrField.value = started.qr_payload;
          qrField.style.display = "";
          note.style.display = "";
        },
        (err) => {
          status.textContent = t("pairing.modal.failed_prefix") + String(err);
        },
      );
    },
    closeLabel: t("pairing.modal.close"),
  }).then(async () => {
    // openModal resolves on Esc / overlay click / close button — cancel
    // any in-flight handshake on the Rust side so a subsequent open
    // starts fresh.
    try {
      await cancelPairing();
    } catch {
      // best-effort cleanup
    }
  });
}
