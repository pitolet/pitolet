import type { TextSpan } from '@pitolet/schema';

/**
 * contentEditable DOM → TextSpan[]. The single parser through which every
 * inline edit round-trips. Supported marks: bold (<strong>/<b>), italic
 * (<em>/<i>), link (<a href>). Everything else flattens to plain text.
 */
export function domToSpans(root: Node): TextSpan[] {
  const spans: TextSpan[] = [];

  const walk = (node: Node, marks: TextSpan['marks']) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      if (text.length > 0) pushSpan(spans, { text, marks: cloneMarks(marks) });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName;
    if (tag === 'BR') {
      pushSpan(spans, { text: '\n', marks: cloneMarks(marks) });
      return;
    }
    const next: TextSpan['marks'] = { ...marks };
    if (tag === 'STRONG' || tag === 'B') next.bold = true;
    if (tag === 'EM' || tag === 'I') next.italic = true;
    if (tag === 'A') next.link = el.getAttribute('href') ?? '';
    for (const child of Array.from(node.childNodes)) walk(child, next);
  };

  for (const child of Array.from(root.childNodes)) walk(child, {});
  if (spans.length === 0) spans.push({ text: '' });
  return spans;
}

export function spansToPlainText(spans: TextSpan[]): string {
  return spans.map((s) => s.text).join('');
}

function pushSpan(spans: TextSpan[], span: TextSpan): void {
  const last = spans[spans.length - 1];
  if (last && marksEqual(last.marks, span.marks)) {
    last.text += span.text;
  } else {
    spans.push(span);
  }
}

function marksEqual(a?: TextSpan['marks'], b?: TextSpan['marks']): boolean {
  return (
    (a?.bold ?? false) === (b?.bold ?? false) &&
    (a?.italic ?? false) === (b?.italic ?? false) &&
    (a?.link ?? null) === (b?.link ?? null)
  );
}

function cloneMarks(marks: TextSpan['marks']): TextSpan['marks'] | undefined {
  if (!marks) return undefined;
  const out: NonNullable<TextSpan['marks']> = {};
  if (marks.bold) out.bold = true;
  if (marks.italic) out.italic = true;
  if (marks.link !== undefined) out.link = marks.link;
  return Object.keys(out).length > 0 ? out : undefined;
}
