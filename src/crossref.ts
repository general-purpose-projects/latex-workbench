export type CrossrefWork = {
  title?: string[];
  author?: { given?: string; family?: string }[];
  DOI: string;
  type?: string;
  "container-title"?: string[];
  publisher?: string;
  volume?: string;
  issue?: string;
  page?: string;
  URL?: string;
  published?: { "date-parts"?: number[][] };
  "published-print"?: { "date-parts"?: number[][] };
  "published-online"?: { "date-parts"?: number[][] };
};

function bibValue(value: string) {
  return value.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
}

function yearOf(work: CrossrefWork) {
  const date = work.published ?? work["published-print"] ?? work["published-online"];
  return date?.["date-parts"]?.[0]?.[0]?.toString();
}

export function crossrefToBibtex(work: CrossrefWork) {
  const title = bibValue(work.title?.[0] ?? "");
  const family = work.author?.[0]?.family ?? work.author?.[0]?.given ?? "reference";
  const keyStem = bibValue(family).toLowerCase().replace(/[^a-z0-9]+/g, "");
  const year = yearOf(work);
  const key = `${keyStem || "reference"}${year ?? ""}`;
  const type = work.type === "book" ? "book" : work.type === "book-chapter" ? "incollection"
    : work.type === "proceedings-article" ? "inproceedings" : "article";
  const fields: [string, string | undefined][] = [
    ["author", work.author?.map((author) => [author.given, author.family].filter(Boolean).join(" ")).filter(Boolean).join(" and ")],
    ["title", title || undefined],
    [type === "article" ? "journal" : type === "inproceedings" ? "booktitle" : "publisher",
      type === "book" ? work.publisher : work["container-title"]?.[0] ?? work.publisher],
    ["year", year],
    ["volume", work.volume],
    ["number", work.issue],
    ["pages", work.page],
    ["doi", work.DOI],
    ["url", work.URL],
  ];
  const formatted = fields
    .filter(([, value]) => value?.trim())
    .map(([name, value]) => `  ${name} = {${bibValue(value!)}}`)
    .join(",\n");
  return `@${type}{${key},\n${formatted}\n}`;
}

export function normalizeDoi(value: string) {
  return value.trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "");
}
