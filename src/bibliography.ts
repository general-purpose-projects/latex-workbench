export type BibliographyIssue = {
  severity: "error" | "warning";
  line: number;
  message: string;
};

type Entry = {
  type: string;
  key: string;
  line: number;
  fields: Set<string>;
};

const requiredFields: Record<string, string[]> = {
  article: ["author", "title", "journal", "year"],
  book: ["title", "publisher", "year"],
  inbook: ["title", "publisher", "year"],
  incollection: ["author", "title", "booktitle", "year"],
  inproceedings: ["author", "title", "booktitle", "year"],
  mastersthesis: ["author", "title", "school", "year"],
  phdthesis: ["author", "title", "school", "year"],
  techreport: ["author", "title", "institution", "year"],
};

function lineAt(lineStarts: number[], index: number) {
  let low = 0;
  let high = lineStarts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= index) low = middle + 1;
    else high = middle;
  }
  return low;
}

function matchingEntryEnd(source: string, start: number, opening: string) {
  const stack = [opening];
  let quoted = false;
  let escaped = false;
  for (let position = start + 1; position < source.length; position += 1) {
    const character = source[position];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (quoted) continue;
    if (character === "{" || character === "(") {
      stack.push(character);
    } else if (character === "}" || character === ")") {
      const expected = character === "}" ? "{" : "(";
      if (stack.at(-1) === expected) {
        stack.pop();
        if (!stack.length) return position;
      }
    }
  }
  return -1;
}

function bibliographyFields(source: string) {
  const fields = new Set<string>();
  let start = 0;
  let braceDepth = 0;
  let quoted = false;
  let escaped = false;
  const addField = (end: number) => {
    const field = source.slice(start, end).match(/^\s*([a-z][a-z0-9_-]*)\s*=/i);
    if (field) fields.add(field[1].toLowerCase());
  };
  for (let position = 0; position < source.length; position += 1) {
    const character = source[position];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') quoted = !quoted;
    if (quoted) continue;
    if (character === "{") braceDepth += 1;
    else if (character === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (character === "," && braceDepth === 0) {
      addField(position);
      start = position + 1;
    }
  }
  addField(source.length);
  return fields;
}

function parseEntries(source: string, lineStarts: number[], issues: BibliographyIssue[]) {
  const entries: Entry[] = [];
  let position = 0;
  while (position < source.length) {
    const start = source.indexOf("@", position);
    if (start < 0) break;
    const header = source.slice(start).match(/^@([a-z]+)\s*([({])/i);
    if (!header) {
      position = start + 1;
      continue;
    }
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    if (/^\s*%/.test(source.slice(lineStart, start))) {
      position = start + 1;
      continue;
    }
    const type = header[1].toLowerCase();
    const opening = header[2];
    const bodyStart = start + header[0].length - 1;
    const end = matchingEntryEnd(source, bodyStart, opening);
    const line = lineAt(lineStarts, start);
    if (end < 0) {
      issues.push({ severity: "error", line, message: `La entrada @${type} no está cerrada.` });
      break;
    }
    position = end + 1;
    if (["comment", "preamble", "string"].includes(type)) continue;

    const body = source.slice(bodyStart + 1, end);
    const comma = body.indexOf(",");
    if (comma < 0) {
      issues.push({ severity: "error", line, message: `La entrada @${type} debe incluir una clave y campos.` });
      continue;
    }
    const key = body.slice(0, comma).trim();
    if (!key) {
      issues.push({ severity: "error", line, message: `La entrada @${type} no tiene clave bibliográfica.` });
      continue;
    }
    const fields = bibliographyFields(body.slice(comma + 1));
    entries.push({ type, key, line, fields });
  }
  return entries;
}

export function validateBibliography(source: string): BibliographyIssue[] {
  const issues: BibliographyIssue[] = [];
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") lineStarts.push(index + 1);
  }
  const entries = parseEntries(source, lineStarts, issues);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.key)) {
      issues.push({
        severity: "error",
        line: entry.line,
        message: `La clave “${entry.key}” está duplicada.`,
      });
    }
    seen.add(entry.key);
    for (const field of requiredFields[entry.type] ?? []) {
      if (!entry.fields.has(field)) {
        issues.push({
          severity: "warning",
          line: entry.line,
          message: `@${entry.type} “${entry.key}” no incluye el campo ${field}.`,
        });
      }
    }
  }
  return issues;
}
