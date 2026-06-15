/**
 * Split consolidated body text into search chunks (paragraph-aware).
 *
 * @param {string} bodyText
 * @param {number} [maxChars]
 * @returns {string[]}
 */
export function chunkBodyText(bodyText, maxChars = 1200) {
  const text = (bodyText ?? '').trim();
  if (!text) return [];

  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  if (!paragraphs.length) return [text];

  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (para.length <= maxChars) {
      current = para;
      continue;
    }
    let start = 0;
    while (start < para.length) {
      chunks.push(para.slice(start, start + maxChars).trim());
      start += maxChars;
    }
    current = '';
  }

  if (current) chunks.push(current);
  return chunks;
}

export default { chunkBodyText };
