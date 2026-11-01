// Best-effort secret scrubbing for anything we write into .baton/.
// Transcripts routinely contain tokens pasted by users or printed by commands.

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}/g, "[REDACTED]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "[REDACTED]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED]"],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, "[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED JWT]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, "$1 [REDACTED]"],
  // KEY=value / "token": "value" style assignments
  [
    /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi,
    "$1$2[REDACTED]",
  ],
  // credentials in URLs: scheme://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, "$1:[REDACTED]@"],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}
