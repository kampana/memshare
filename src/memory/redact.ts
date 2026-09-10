/**
 * Conservative PII detection, run before anything leaves the machine.
 *
 * The bias here is deliberate: a false positive costs the user one keystroke
 * in the export preview, a false negative leaks their medical history to a
 * colleague. When in doubt, flag it.
 */

export type PiiCategory =
  | "email"
  | "phone"
  | "government-id"
  | "credit-card"
  | "bank-account"
  | "secret"
  | "health"
  | "financial";

export interface PiiFinding {
  category: PiiCategory;
  /** Human-readable name for the preview UI. */
  label: string;
  /** The exact text that matched. */
  match: string;
  /** Start offset in the scanned string. */
  index: number;
}

export interface RedactionResult {
  text: string;
  findings: PiiFinding[];
}

const LABELS: Record<PiiCategory, string> = {
  email: "email address",
  phone: "phone number",
  "government-id": "government ID",
  "credit-card": "payment card",
  "bank-account": "bank account",
  secret: "credential or API key",
  health: "health information",
  financial: "financial information",
};

/** Lower priority categories lose when two findings cover the same text. */
const PRIORITY: PiiCategory[] = [
  "secret",
  "credit-card",
  "bank-account",
  "government-id",
  "email",
  "phone",
  "health",
  "financial",
];

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

// Any run of 7-15 digits held together by the usual separators, optionally
// with a country code. Post-filtered below so "15min" and "2024-01-02" survive.
const PHONE_CANDIDATE = /\+?\d[\d\s().-]{5,}\d/g;

const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;

// A bare 9-digit national ID is indistinguishable from any other number, so
// it only counts when the surrounding text says that is what it is.
const GOV_ID_IN_CONTEXT =
  /\b(?:ssn|social security|passport(?:\s*(?:no|number|#))?|national\s*id|id\s*(?:no|number|#)|driver'?s?\s*licen[cs]e|tax\s*id|tin)\b\W{0,12}([A-Z0-9][A-Z0-9-]{5,})/gi;

const CARD_CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g;

const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}[ ]?[A-Z0-9]{1,4}\b/g;

const BANK_IN_CONTEXT =
  /\b(?:iban|swift|bic|routing(?:\s*number)?|sort\s*code|account\s*(?:no|number|#))\b\W{0,12}([A-Z0-9][A-Z0-9-]{5,})/gi;

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI-style
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, // Anthropic
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
  /\b(?:api[_-]?key|secret|token|password|passwd|bearer)\b\s*[:=]\s*["']?([A-Za-z0-9_\-./+]{12,})["']?/gi,
];

const HEALTH_KEYWORDS = [
  "diagnosis",
  "diagnosed",
  "prescription",
  "prescribed",
  "medication",
  "dosage",
  "symptom",
  "therapist",
  "therapy session",
  "psychiatric",
  "psychiatrist",
  "antidepressant",
  "depression",
  "anxiety disorder",
  "bipolar",
  "adhd",
  "autism",
  "cancer",
  "chemotherapy",
  "tumor",
  "hiv",
  "diabetes",
  "insulin",
  "pregnant",
  "pregnancy",
  "miscarriage",
  "fertility",
  "surgery",
  "hospitalized",
  "medical record",
  "blood test",
  "disability",
  "chronic illness",
];

const FINANCIAL_KEYWORDS = [
  "salary",
  "my income",
  "net worth",
  "credit score",
  "mortgage",
  "in debt",
  "bankruptcy",
  "bank balance",
  "take-home pay",
  "annual compensation",
  "stock options",
  "equity grant",
  "severance",
];

/** Finds every PII-looking span in `text`, highest-confidence first. */
export function scanForPII(text: string): PiiFinding[] {
  const found: PiiFinding[] = [];

  for (const pattern of SECRET_PATTERNS) {
    collect(text, pattern, "secret", found);
  }

  for (const m of matches(text, CARD_CANDIDATE)) {
    const digits = m.value.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    if (!luhn(digits)) continue;
    found.push(finding("credit-card", m.value, m.index));
  }

  collect(text, IBAN, "bank-account", found, (v) => /\d/.test(v) && /[A-Z]/.test(v));
  collectGroup(text, BANK_IN_CONTEXT, "bank-account", found);
  collect(text, SSN, "government-id", found);
  collectGroup(text, GOV_ID_IN_CONTEXT, "government-id", found);
  collect(text, EMAIL, "email", found);

  for (const m of matches(text, PHONE_CANDIDATE)) {
    if (!looksLikePhone(m.value)) continue;
    found.push(finding("phone", m.value, m.index));
  }

  collectKeywords(text, HEALTH_KEYWORDS, "health", found);
  collectKeywords(text, FINANCIAL_KEYWORDS, "financial", found);

  return dedupe(found);
}

/** True when `text` carries anything that should not be exported by default. */
export function containsPII(text: string): boolean {
  return scanForPII(text).length > 0;
}

/**
 * Replaces every finding with a `[redacted: ...]` marker. Keyword findings
 * mark the keyword only -- the surrounding sentence is left intact so the
 * user can see what they are deciding about.
 */
export function redact(text: string): RedactionResult {
  const findings = scanForPII(text);
  if (findings.length === 0) return { text, findings };

  // Right to left, so earlier offsets stay valid as we splice.
  const ordered = [...findings].sort((a, b) => b.index - a.index);
  let out = text;
  for (const f of ordered) {
    out =
      out.slice(0, f.index) +
      `[redacted: ${LABELS[f.category]}]` +
      out.slice(f.index + f.match.length);
  }
  return { text: out, findings };
}

/** One line per finding, for the export preview. */
export function summarisePII(findings: PiiFinding[]): string {
  const byCategory = new Map<PiiCategory, number>();
  for (const f of findings) byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1);
  return [...byCategory.entries()]
    .map(([category, count]) => (count > 1 ? `${LABELS[category]} x${count}` : LABELS[category]))
    .join(", ");
}

export function labelFor(category: PiiCategory): string {
  return LABELS[category];
}

function finding(category: PiiCategory, match: string, index: number): PiiFinding {
  return { category, label: LABELS[category], match, index };
}

interface RawMatch {
  value: string;
  index: number;
}

function* matches(text: string, pattern: RegExp): Generator<RawMatch> {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === "") {
      re.lastIndex += 1;
      continue;
    }
    yield { value: m[0], index: m.index };
  }
}

function collect(
  text: string,
  pattern: RegExp,
  category: PiiCategory,
  out: PiiFinding[],
  accept: (value: string) => boolean = () => true,
): void {
  for (const m of matches(text, pattern)) {
    if (accept(m.value)) out.push(finding(category, m.value, m.index));
  }
}

/** Like `collect`, but flags only capture group 1 (the value after a label). */
function collectGroup(
  text: string,
  pattern: RegExp,
  category: PiiCategory,
  out: PiiFinding[],
): void {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = m[1];
    if (!value) continue;
    const index = m.index + m[0].lastIndexOf(value);
    out.push(finding(category, value, index));
  }
}

function collectKeywords(
  text: string,
  keywords: string[],
  category: PiiCategory,
  out: PiiFinding[],
): void {
  const lower = text.toLowerCase();
  for (const keyword of keywords) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(keyword, from);
      if (at === -1) break;
      if (isWordBoundary(lower, at, keyword.length)) {
        out.push(finding(category, text.slice(at, at + keyword.length), at));
      }
      from = at + keyword.length;
    }
  }
}

function isWordBoundary(text: string, index: number, length: number): boolean {
  const before = index === 0 ? "" : text[index - 1]!;
  const after = text[index + length] ?? "";
  return !/[a-z0-9]/i.test(before) && !/[a-z0-9]/i.test(after);
}

/**
 * Keeps the highest-priority finding when spans overlap, so a credit card
 * number is not also reported as a phone number.
 */
function dedupe(findings: PiiFinding[]): PiiFinding[] {
  const ranked = [...findings].sort((a, b) => {
    const byPriority = PRIORITY.indexOf(a.category) - PRIORITY.indexOf(b.category);
    if (byPriority !== 0) return byPriority;
    return b.match.length - a.match.length;
  });

  const kept: PiiFinding[] = [];
  for (const candidate of ranked) {
    const start = candidate.index;
    const end = start + candidate.match.length;
    const overlaps = kept.some((k) => start < k.index + k.match.length && k.index < end);
    if (!overlaps) kept.push(candidate);
  }
  return kept.sort((a, b) => a.index - b.index);
}

/**
 * Rejects the things that look like phone numbers but aren't: version strings,
 * dates, plain counts, and anything with too few or too many digits.
 */
function looksLikePhone(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return false;

  const trimmed = value.trim();
  // ISO dates and dotted versions.
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return false;
  if (/^\d+(?:\.\d+){2,}$/.test(trimmed)) return false;

  const separators = (trimmed.match(/[\s().-]/g) ?? []).length;
  const hasCountryCode = trimmed.startsWith("+");
  // A long unbroken digit run is more likely an id or an amount than a number
  // someone would dial.
  if (!hasCountryCode && separators === 0 && digits.length < 9) return false;
  return true;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
