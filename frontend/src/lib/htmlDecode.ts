/**
 * Giải mã triệt để HTML entities (kể cả double-encoded như `&amp;yacute;`),
 * loại bỏ thẻ HTML dư thừa và trả về chuỗi văn bản thuần sạch đẹp.
 */
export function decodeHtmlEntities(raw: string | null | undefined): string {
  if (!raw) return '';
  let cur = String(raw).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

  if (typeof DOMParser !== 'undefined') {
    const parser = new DOMParser();
    for (let pass = 0; pass < 3; pass++) {
      // Thay thế thẻ HTML trước khi decode nếu cần, giữ lại khoảng trắng giữa các khối
      const doc = parser.parseFromString(cur.replace(/<[^>]+>/g, ' '), 'text/html');
      const next = doc.documentElement.textContent ?? '';
      if (next === cur) break;
      cur = next;
    }
  } else if (typeof document !== 'undefined') {
    const ta = document.createElement('textarea');
    for (let pass = 0; pass < 3; pass++) {
      ta.innerHTML = cur.replace(/<[^>]+>/g, ' ');
      const next = ta.value;
      if (next === cur) break;
      cur = next;
    }
  }

  return cur
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
