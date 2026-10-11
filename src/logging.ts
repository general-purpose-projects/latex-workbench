const MAX_VISIBLE_LOG_BYTES = 2 * 1024 * 1024;
const TRUNCATED_MARKER = "\n[Registro truncado: límite de 2 MiB]\n";
const encoder = new TextEncoder();
const markerBytes = encoder.encode(TRUNCATED_MARKER).byteLength;

function utf8CharacterLength(character: string) {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

export function appendBoundedLog(current: { text: string; byteLength: number }, chunk: string) {
  const byteLength = current.byteLength;
  if (current.text.endsWith(TRUNCATED_MARKER)) return { text: current.text, byteLength };

  const available = MAX_VISIBLE_LOG_BYTES - markerBytes - byteLength;
  if (available <= 0) {
    return { text: current.text + TRUNCATED_MARKER, byteLength: byteLength + markerBytes };
  }

  let addedBytes = 0;
  const payload: string[] = [];
  for (const character of chunk) {
    const characterBytes = utf8CharacterLength(character);
    if (addedBytes + characterBytes > available) break;
    payload.push(character);
    addedBytes += characterBytes;
  }
  const text = payload.join("");
  const truncated = text.length < chunk.length;
  return {
    text: current.text + text + (truncated ? TRUNCATED_MARKER : ""),
    byteLength: byteLength + addedBytes + (truncated ? markerBytes : 0),
  };
}

export function utf8ByteLength(value: string) {
  return encoder.encode(value).byteLength;
}
