import { describe, expect, it } from "vitest";
import { validateBibliography } from "./bibliography";

describe("validateBibliography", () => {
  it("accepts a complete entry with nested braces and quoted values", () => {
    const source = `@article{smith2025,
  author = {Smith, Jane},
  title = {A {Nested} Title},
  journal = "Science, Today",
  year = {2025}
}`;
    expect(validateBibliography(source)).toEqual([]);
  });

  it("reports missing required fields and duplicate keys with source lines", () => {
    const source = `@article{same,
  title = {First}
}
@book{same,
  title = {Second}
}`;
    expect(validateBibliography(source)).toEqual([
      { severity: "warning", line: 1, message: "@article “same” no incluye el campo author." },
      { severity: "warning", line: 1, message: "@article “same” no incluye el campo journal." },
      { severity: "warning", line: 1, message: "@article “same” no incluye el campo year." },
      { severity: "error", line: 4, message: "La clave “same” está duplicada." },
      { severity: "warning", line: 4, message: "@book “same” no incluye el campo publisher." },
      { severity: "warning", line: 4, message: "@book “same” no incluye el campo year." },
    ]);
  });

  it("ignores comments and reports an unclosed entry", () => {
    expect(validateBibliography("% @article{ignored}\n@comment{ignored}\n@article{broken, title={Missing close}"))
      .toEqual([{ severity: "error", line: 3, message: "La entrada @article no está cerrada." }]);
  });

  it("does not mistake commas inside field values for new fields", () => {
    const issues = validateBibliography(`@article{smith,
  title = {A phrase, author = {not an actual field}},
  journal = {Journal},
  year = {2025}
}`);
    expect(issues).toEqual([{
      severity: "warning",
      line: 1,
      message: "@article “smith” no incluye el campo author.",
    }]);
  });
});
