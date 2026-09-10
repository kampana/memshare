import { describe, expect, it } from "vitest";

import { containsPII, redact, scanForPII, summarisePII } from "../src/memory/redact.js";

const categories = (text: string) => scanForPII(text).map((f) => f.category);

describe("detects", () => {
  it("email addresses", () => {
    expect(categories("Contact me at alice@email.com")).toContain("email");
  });

  it("phone numbers in several shapes", () => {
    expect(categories("call 054-1234567")).toContain("phone");
    expect(categories("+1 (555) 123-4567 is my cell")).toContain("phone");
    expect(categories("reach me on +972 54 123 4567")).toContain("phone");
  });

  it("the spec's mixed example", () => {
    const found = scanForPII("Contact me at alice@email.com or 054-1234567");
    expect(found.map((f) => f.category).sort()).toEqual(["email", "phone"]);
  });

  it("US social security numbers", () => {
    expect(categories("ssn 123-45-6789")).toContain("government-id");
  });

  it("government IDs when the surrounding text names them", () => {
    expect(categories("passport number X1234567")).toContain("government-id");
  });

  it("card numbers that pass a Luhn check", () => {
    expect(categories("card 4111 1111 1111 1111")).toContain("credit-card");
  });

  it("IBANs and labelled account numbers", () => {
    expect(categories("IBAN GB82 WEST 1234 5698 7654 32")).toContain("bank-account");
    expect(categories("routing number 021000021")).toContain("bank-account");
  });

  it("credentials and API keys", () => {
    expect(categories("key sk-abcdefghijklmnop1234")).toContain("secret");
    expect(categories("AKIAIOSFODNN7EXAMPLE")).toContain("secret");
    expect(categories('api_key = "s3cr3tvalue12345"')).toContain("secret");
  });

  it("health information", () => {
    expect(categories("was prescribed medication for anxiety disorder")).toContain("health");
  });

  it("financial information", () => {
    expect(categories("My salary is 50000")).toContain("financial");
    expect(categories("my credit score went up")).toContain("financial");
  });
});

describe("leaves ordinary technical text alone", () => {
  const clean = [
    "Auth service uses JWT with 15min refresh",
    "Team decided Postgres over MySQL",
    "You prefer functional style over OOP",
    "Deploy runs at 14:30 every Tuesday",
    "We are on version 1.2.3 of the API",
    "The migration touched 1200 rows",
    "Sprint 42 ends on 2026-03-14",
    "Set the timeout to 30000 ms",
  ];

  for (const text of clean) {
    it(`"${text}"`, () => {
      expect(scanForPII(text)).toEqual([]);
      expect(containsPII(text)).toBe(false);
    });
  }

  it("does not treat a random long number as a card", () => {
    // Fails the Luhn check, so it is not a payment card.
    expect(categories("order id 1234567890123456")).not.toContain("credit-card");
  });

  it("does not fire on keywords glued inside other words", () => {
    expect(categories("salarycap discussion")).not.toContain("financial");
  });
});

describe("redact", () => {
  it("replaces every finding with a marker", () => {
    const { text, findings } = redact("Contact me at alice@email.com or 054-1234567");
    expect(findings).toHaveLength(2);
    expect(text).not.toContain("alice@email.com");
    expect(text).not.toContain("054-1234567");
    expect(text).toContain("[redacted: email address]");
    expect(text).toContain("[redacted: phone number]");
  });

  it("keeps the rest of the sentence readable", () => {
    const { text } = redact("Ping alice@email.com about the auth refactor");
    expect(text).toBe("Ping [redacted: email address] about the auth refactor");
  });

  it("returns clean text unchanged", () => {
    const original = "Team decided Postgres over MySQL";
    expect(redact(original).text).toBe(original);
  });

  it("handles several findings without corrupting offsets", () => {
    const { text } = redact("a@b.com, c@d.com and e@f.com");
    expect(text).toBe(
      "[redacted: email address], [redacted: email address] and [redacted: email address]",
    );
  });
});

describe("overlapping matches", () => {
  it("reports a card number once, as a card", () => {
    const found = scanForPII("4111 1111 1111 1111");
    expect(found).toHaveLength(1);
    expect(found[0]!.category).toBe("credit-card");
  });
});

describe("summarisePII", () => {
  it("counts repeats", () => {
    expect(summarisePII(scanForPII("a@b.com and c@d.com"))).toBe("email address x2");
  });
});
