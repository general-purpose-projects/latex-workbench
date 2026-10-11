import { describe, expect, it } from "vitest";
import { crossrefToBibtex, normalizeDoi } from "./crossref";

describe("Crossref bibliography import", () => {
  it("normalizes DOI links and prefixes", () => {
    expect(normalizeDoi(" https://doi.org/10.1234/AbC ")).toBe("10.1234/AbC");
    expect(normalizeDoi("doi:10.1234/xyz")).toBe("10.1234/xyz");
  });

  it("creates BibTeX without losing common metadata", () => {
    expect(crossrefToBibtex({
      DOI: "10.1234/example",
      type: "journal-article",
      title: ["A Useful Paper"],
      author: [{ given: "Ada", family: "Lovelace" }],
      "container-title": ["Journal of Examples"],
      published: { "date-parts": [[2025, 2]] },
      volume: "7",
      issue: "2",
      page: "10-19",
      URL: "https://doi.org/10.1234/example",
    })).toBe(`@article{lovelace2025,
  author = {Ada Lovelace},
  title = {A Useful Paper},
  journal = {Journal of Examples},
  year = {2025},
  volume = {7},
  number = {2},
  pages = {10-19},
  doi = {10.1234/example},
  url = {https://doi.org/10.1234/example}
}`);
  });
});
