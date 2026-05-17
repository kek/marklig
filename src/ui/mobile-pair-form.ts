// Phone-side pairing — camera-driven QR scanner via @zxing/browser.
// Flow:
//   1. mountMobilePairForm shows a live video preview from the rear
//      camera and listens for QR codes via ZXing's BrowserMultiFormatReader.
//   2. On scan: stop the camera, parse the marklig-pair:// URL, transition
//      to a confirm screen showing the detected host + a friendly-name
//      input.
//   3. On submit: call mobile_pairing_start with the parsed payload.
//
// v1 QR payloads (no host field) fall back to a manual-host prompt so
// older pairings still work.

import { BrowserMultiFormatReader } from "@zxing/browser";

import { t } from "../i18n/strings";
import {
  startMobilePairing,
  type MobilePairResult,
} from "../shell/mobile-pairings";

export interface PairFormHandlers {
  onPaired: (result: MobilePairResult) => void;
  onCancel: () => void;
}

interface ParsedPayload {
  qrPayload: string;
  responderPubkeyHex: string;
  host: string;
  mdnsInstanceName: string;
  expiryUnix: number;
}

export function mountMobilePairForm(
  root: HTMLElement,
  handlers: PairFormHandlers,
): void {
  root.innerHTML = "";

  let activeReader: BrowserMultiFormatReader | null = null;

  const stopScanner = (): void => {
    if (activeReader) {
      try {
        const anyReader = activeReader as unknown as {
          reset?: () => void;
          stopContinuousDecode?: () => void;
        };
        anyReader.reset?.();
        anyReader.stopContinuousDecode?.();
      } catch {
        /* best-effort */
      }
      activeReader = null;
    }
  };

  const mountScanner = (): void => {
    root.innerHTML = "";

    const wrap = document.createElement("div");
    wrap.className = "mobile-pair-form mobile-pair-form--scanner";
    root.appendChild(wrap);

    const title = document.createElement("h1");
    title.className = "mobile-pair-form__title";
    title.textContent = t("mobile.pair.title");
    wrap.appendChild(title);

    const instructions = document.createElement("p");
    instructions.className = "mobile-pair-form__scan-instructions";
    instructions.textContent = t("mobile.pair.scan_instructions");
    wrap.appendChild(instructions);

    const videoFrame = document.createElement("div");
    videoFrame.className = "mobile-pair-form__video-frame";
    wrap.appendChild(videoFrame);

    const video = document.createElement("video");
    video.className = "mobile-pair-form__video";
    video.setAttribute("playsinline", "true");
    video.muted = true;
    videoFrame.appendChild(video);

    const status = document.createElement("p");
    status.className = "mobile-pair-form__status";
    status.textContent = t("mobile.pair.scan_starting");
    wrap.appendChild(status);

    const buttons = document.createElement("div");
    buttons.className = "mobile-pair-form__buttons";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "mobile-pair-form__cancel";
    cancel.textContent = t("mobile.pair.cancel");
    cancel.addEventListener("click", () => {
      stopScanner();
      handlers.onCancel();
    });
    buttons.appendChild(cancel);

    const manualBtn = document.createElement("button");
    manualBtn.type = "button";
    manualBtn.className = "mobile-pair-form__manual";
    manualBtn.textContent = t("mobile.pair.manual_entry");
    manualBtn.addEventListener("click", () => {
      stopScanner();
      mountManualEntry();
    });
    buttons.appendChild(manualBtn);
    wrap.appendChild(buttons);

    void startScannerFor(video, status, (qr) => {
      stopScanner();
      const parsed = parseQrPayload(qr);
      if (!parsed) {
        status.textContent = t("mobile.pair.invalid_qr");
        setTimeout(mountScanner, 1500);
        return;
      }
      if (!parsed.host) {
        // v1 payload — prompt for host
        mountManualEntry(parsed);
        return;
      }
      mountConfirm(parsed);
    });
  };

  const startScannerFor = async (
    video: HTMLVideoElement,
    status: HTMLElement,
    onDetected: (qr: string) => void,
  ): Promise<void> => {
    try {
      const reader = new BrowserMultiFormatReader();
      activeReader = reader;
      const devices = await BrowserMultiFormatReader.listVideoInputDevices();
      const rear =
        devices.find((d) =>
          /back|rear|environment/i.test(d.label || ""),
        ) ?? devices[devices.length - 1];
      if (!rear) {
        status.textContent = t("mobile.pair.no_camera");
        return;
      }
      status.textContent = t("mobile.pair.scan_ready");
      await reader.decodeFromVideoDevice(
        rear.deviceId,
        video,
        (result, _err, controls) => {
          if (!result) return;
          try {
            controls.stop();
          } catch {
            /* */
          }
          onDetected(result.getText());
        },
      );
    } catch (err) {
      status.textContent =
        t("mobile.pair.camera_failed_prefix") + String(err);
    }
  };

  const mountConfirm = (parsed: ParsedPayload): void => {
    root.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "mobile-pair-form";
    root.appendChild(wrap);

    const title = document.createElement("h1");
    title.className = "mobile-pair-form__title";
    title.textContent = t("mobile.pair.confirm_title");
    wrap.appendChild(title);

    const hostLine = document.createElement("p");
    hostLine.className = "mobile-pair-form__confirm-host";
    hostLine.innerHTML =
      t("mobile.pair.confirm_host_prefix") +
      ` <code>${escapeHtml(parsed.host)}</code>`;
    wrap.appendChild(hostLine);

    const form = document.createElement("form");
    form.className = "mobile-pair-form__form";
    const nameField = makeField(
      t("mobile.pair.name_label"),
      "name",
      t("mobile.pair.name_placeholder"),
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
      const name = nameField.input.value.trim() || "Phone";
      submit.disabled = true;
      cancel.disabled = true;
      status.textContent = t("mobile.pair.in_progress");
      try {
        const result = await startMobilePairing({
          qrPayload: parsed.qrPayload,
          host: parsed.host,
          friendlyName: name,
        });
        handlers.onPaired(result);
      } catch (err) {
        status.textContent = t("mobile.pair.failed_prefix") + String(err);
        submit.disabled = false;
        cancel.disabled = false;
      }
    });

    wrap.appendChild(form);
    setTimeout(() => nameField.input.focus(), 50);
  };

  const mountManualEntry = (preParsed?: ParsedPayload): void => {
    root.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "mobile-pair-form";
    root.appendChild(wrap);

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
    if (preParsed) qrField.input.value = preParsed.qrPayload;
    form.appendChild(qrField.label);

    const hostField = makeField(
      t("mobile.pair.host_label"),
      "host",
      t("mobile.pair.host_placeholder"),
    );
    if (preParsed?.host) hostField.input.value = preParsed.host;
    form.appendChild(hostField.label);

    const nameField = makeField(
      t("mobile.pair.name_label"),
      "name",
      t("mobile.pair.name_placeholder"),
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

    const scanBtn = document.createElement("button");
    scanBtn.type = "button";
    scanBtn.className = "mobile-pair-form__manual";
    scanBtn.textContent = t("mobile.pair.use_camera");
    scanBtn.addEventListener("click", () => mountScanner());

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "mobile-pair-form__submit";
    submit.textContent = t("mobile.pair.submit");

    buttons.appendChild(cancel);
    buttons.appendChild(scanBtn);
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
        handlers.onPaired(result);
      } catch (err) {
        status.textContent = t("mobile.pair.failed_prefix") + String(err);
        submit.disabled = false;
        cancel.disabled = false;
      }
    });

    wrap.appendChild(form);
    setTimeout(() => qrField.input.focus(), 50);
  };

  mountScanner();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseQrPayload(raw: string): ParsedPayload | null {
  if (!raw.startsWith("marklig-pair://")) return null;
  const isV2 = raw.startsWith("marklig-pair://v2/");
  const isV1 = raw.startsWith("marklig-pair://v1/");
  if (!isV2 && !isV1) return null;
  const body = isV2
    ? raw.slice("marklig-pair://v2/".length)
    : raw.slice("marklig-pair://v1/".length);
  try {
    const bytes = base64UrlDecode(body);
    if (bytes.length < 32 + 2 + 8) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const pubkey = hex(bytes.subarray(0, 32));
    let cursor = 32;
    let host = "";
    let mdnsInstanceName = "";
    if (isV2) {
      const hostLen = dv.getUint16(cursor, true);
      cursor += 2;
      host = new TextDecoder("utf-8").decode(
        bytes.subarray(cursor, cursor + hostLen),
      );
      cursor += hostLen;
      const mdnsLen = dv.getUint16(cursor, true);
      cursor += 2;
      mdnsInstanceName = new TextDecoder("utf-8").decode(
        bytes.subarray(cursor, cursor + mdnsLen),
      );
      cursor += mdnsLen;
    } else {
      const nameLen = dv.getUint16(cursor, true);
      cursor += 2;
      mdnsInstanceName = new TextDecoder("utf-8").decode(
        bytes.subarray(cursor, cursor + nameLen),
      );
      cursor += nameLen;
    }
    if (cursor + 8 > bytes.length) return null;
    const expiryLow = dv.getUint32(cursor, true);
    const expiryHigh = dv.getUint32(cursor + 4, true);
    const expiryUnix = expiryHigh * 0x100000000 + expiryLow;
    return {
      qrPayload: raw,
      responderPubkeyHex: pubkey,
      host,
      mdnsInstanceName,
      expiryUnix,
    };
  } catch {
    return null;
  }
}

function base64UrlDecode(s: string): Uint8Array {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function makeField(
  labelText: string,
  name: string,
  placeholder: string,
  multiline = false,
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
