// Headings and field names of the memory files. New files use the configured language;
// parsing accepts every language, so switching `lang` never orphans existing sections.

export type Lang = "en" | "zh";

export type SectionKey = "preference" | "fact" | "status" | "decision" | "next" | "history";

const LABELS = {
  en: {
    profileTitle: "Profile",
    sections: { preference: "Preferences", fact: "Facts", status: "Status", decision: "Decisions", next: "Next", history: "History" },
    supersededBy: (id: string) => `superseded by ${id}`,
    chat: "desktop chat",
    project: "project",
    folder: "folder",
    turns: "turns",
    first: "First",
    lastRequest: "Last request",
    lastReply: "Last reply",
    remembered: "Remembered",
  },
  zh: {
    profileTitle: "个人档案",
    sections: { preference: "偏好", fact: "事实", status: "现状", decision: "决定", next: "下一步", history: "历史" },
    supersededBy: (id: string) => `被 ${id} 取代`,
    chat: "桌面对话",
    project: "项目",
    folder: "目录",
    turns: "轮",
    first: "开头",
    lastRequest: "最后的请求",
    lastReply: "最后的回复",
    remembered: "写入的记忆",
  },
} as const;

export type Labels = (typeof LABELS)[Lang];

export function labels(lang: Lang): Labels {
  return LABELS[lang];
}

/** Which section a `## heading` is, in any language. */
export function sectionKeyOf(heading: string): SectionKey | undefined {
  const h = heading.trim().toLowerCase();
  for (const l of Object.values(LABELS)) {
    for (const [k, v] of Object.entries(l.sections)) if (v.toLowerCase() === h) return k as SectionKey;
  }
  return undefined;
}

/** Default language for a new memory dir: Chinese locales get zh, everything else en. */
export function defaultLang(): Lang {
  const loc = Intl.DateTimeFormat().resolvedOptions().locale;
  return /^zh\b/i.test(loc) ? "zh" : "en";
}
