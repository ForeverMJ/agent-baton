/** Truncate long text, keeping head and tail (errors usually live at the end). */
export function clip(text: string, max: number): string {
  const t = text.replace(/\r\n/g, "\n").trim();
  if (t.length <= max) return t;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  return `${t.slice(0, head)}\n… [${t.length - max} chars omitted] …\n${t.slice(-tail)}`;
}

/** Single-line preview. */
export function oneLine(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

const INPUT_KEYS = [
  "command",
  "cmd",
  "file_path",
  "filePath",
  "notebook_path",
  "path",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
];

/** Summarize a tool input object into a short string. */
export function summarizeInput(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return oneLine(input, 300);
  if (Array.isArray(input)) return oneLine(input.map(String).join(" "), 300);
  if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    const parts: string[] = [];
    for (const k of INPUT_KEYS) {
      const v = o[k];
      if (v == null || v === "") continue;
      parts.push(Array.isArray(v) ? v.map(String).join(" ") : String(v));
      if (parts.length >= 2) break;
    }
    if (parts.length) return oneLine(parts.join(" · "), 300);
    return oneLine(JSON.stringify(o), 300);
  }
  return oneLine(String(input), 300);
}

/** Extract file paths from an apply_patch style patch. */
export function filesFromPatch(patch: string): string[] {
  const out: string[] = [];
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
  for (const m of patch.matchAll(re)) out.push((m[1] ?? m[2] ?? "").trim());
  return out.filter(Boolean);
}

export function tryJson(s: unknown): any {
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
