/**
 * Next free id with the given prefix ("q" -> q1, q2, ...). Ids are never reused
 * within a kit, so a deleted q3 does not come back as a different question.
 * `floor` lets the caller keep a high-water mark across deletions.
 */
export function nextId(prefix: string, items: { id: string }[], floor = 0): string {
  const re = new RegExp(`^${prefix}(\\d+)$`);
  let max = floor;
  for (const item of items) {
    const m = re.exec(item.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}
