import { loadStoredTheme, setActiveTheme, type Theme } from "../editor/theme";
import {
  getRemoteImagePolicy,
  setRemoteImagePolicy,
  type RemoteImagePolicy,
} from "../shell/settings";
import { openModal } from "./modal";

/** Open the preferences modal. Resolves when the user closes it. */
export function openPreferences(): Promise<void> {
  return openModal({
    title: "Preferences",
    build: (body) => {
      body.append(buildThemeSection());
      body.append(buildImagePolicySection());
    },
  });
}

function buildThemeSection(): HTMLElement {
  const section = document.createElement("section");
  section.className = "viewer-prefs-section";

  const label = document.createElement("h4");
  label.textContent = "Appearance";
  section.append(label);

  const row = document.createElement("div");
  row.className = "viewer-prefs-row";
  const current: Theme = loadStoredTheme();
  for (const t of ["system", "light", "dark"] as const) {
    row.append(buildRadio({
      name: "theme",
      value: t,
      checked: current === t,
      label: humanize(t),
      onChange: () => setActiveTheme(t),
    }));
  }
  section.append(row);
  return section;
}

function buildImagePolicySection(): HTMLElement {
  const section = document.createElement("section");
  section.className = "viewer-prefs-section";

  const label = document.createElement("h4");
  label.textContent = "Remote images";
  section.append(label);

  const help = document.createElement("p");
  help.className = "viewer-prefs-help";
  help.textContent =
    "Markdown can reference images by URL. The viewer never fetches them by default — pick what should happen when a document points at one.";
  section.append(help);

  const row = document.createElement("div");
  row.className = "viewer-prefs-row viewer-prefs-row-vertical";
  const current = getRemoteImagePolicy();
  const options: Array<[RemoteImagePolicy, string]> = [
    ["placeholder", "Show a placeholder with the URL (default)"],
    ["load", "Load and display"],
    ["off", "Hide entirely"],
  ];
  for (const [value, optLabel] of options) {
    row.append(buildRadio({
      name: "image-policy",
      value,
      checked: current === value,
      label: optLabel,
      onChange: () => setRemoteImagePolicy(value),
    }));
  }
  section.append(row);
  return section;
}

interface RadioOptions {
  name: string;
  value: string;
  checked: boolean;
  label: string;
  onChange: () => void;
}

function buildRadio(opts: RadioOptions): HTMLLabelElement {
  const wrap = document.createElement("label");
  wrap.className = "viewer-prefs-radio";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = opts.name;
  input.value = opts.value;
  input.checked = opts.checked;
  input.addEventListener("change", () => {
    if (input.checked) opts.onChange();
  });
  const text = document.createElement("span");
  text.textContent = opts.label;
  wrap.append(input, text);
  return wrap;
}

function humanize(t: Theme): string {
  return t === "system" ? "Follow system" : t[0].toUpperCase() + t.slice(1);
}
