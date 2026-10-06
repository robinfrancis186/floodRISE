import { describe, expect, it } from "vitest";
import { helplines } from "../data/helplines";
import { LANGUAGES, resolveLanguage, translate, type MessageKey } from "./i18n";

describe("field language selection", () => {
  it("prefers a stored choice, then the first supported browser language", () => {
    expect(resolveLanguage("ta", ["hi-IN"])).toBe("ta");
    expect(resolveLanguage(null, ["fr-FR", "hi-IN", "ta-IN"])).toBe("hi");
    expect(resolveLanguage("klingon", ["TA-in"])).toBe("ta");
    expect(resolveLanguage(null, ["fr-FR"])).toBe("en");
    expect(resolveLanguage(null, [])).toBe("en");
  });

  it("falls back to English for a key a language has not translated", () => {
    expect(translate("hi", "header.sos")).toBe("112");
    expect(translate("ta", "nav.alerts")).toBe("எச்சரிக்கை");
  });

  it("translates every helpline label and the safety line in each language", () => {
    const required: MessageKey[] = [
      ...helplines.map((helpline) => helpline.labelKey),
      "helplines.safety",
      "helplines.verify",
      "helplines.title"
    ];
    for (const { code } of LANGUAGES.filter((language) => language.code !== "en")) {
      for (const key of required) {
        expect(translate(code, key), `${code}:${key}`).not.toBe(translate("en", key));
      }
      expect(translate(code, "helplines.safety")).toContain("112");
    }
  });
});

describe("packaged helplines", () => {
  it("lead with 112 and have unique dialable numbers", () => {
    expect(helplines[0]?.number).toBe("112");
    expect(new Set(helplines.map((helpline) => helpline.number)).size).toBe(helplines.length);
    for (const helpline of helplines) expect(helpline.number).toMatch(/^\d{3,4}$/);
  });
});
