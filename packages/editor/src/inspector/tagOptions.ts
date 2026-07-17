import { CONTAINER_TAGS, TEXT_TAGS } from '@pitolet/schema';
import type { SearchableSelectGroup } from '@pitolet/ui';

export type TagOptionKind = 'container' | 'text';

const CONTAINER_GROUPS = [
  {
    label: 'Structure',
    tags: ['div', 'section', 'main', 'header', 'footer', 'nav', 'aside', 'article', 'figure'],
  },
  {
    label: 'Forms',
    tags: [
      'form',
      'button',
      'input',
      'textarea',
      'select',
      'option',
      'fieldset',
      'legend',
      'label',
    ],
  },
  { label: 'Lists and links', tags: ['a', 'ul', 'ol', 'li'] },
  { label: 'Tables', tags: ['table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th'] },
  { label: 'Disclosure', tags: ['details', 'summary'] },
  { label: 'Other', tags: ['br', 'hr'] },
] as const;

const TEXT_GROUPS = [
  { label: 'Text', tags: ['p', 'span', 'blockquote', 'figcaption', 'code'] },
  { label: 'Headings', tags: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] },
  { label: 'Interactive', tags: ['a', 'button', 'label', 'option'] },
  { label: 'Tables', tags: ['td', 'th'] },
] as const;

export function tagOptionGroups(kind: TagOptionKind): SearchableSelectGroup[] {
  const supported = kind === 'text' ? TEXT_TAGS : CONTAINER_TAGS;
  const groups = kind === 'text' ? TEXT_GROUPS : CONTAINER_GROUPS;
  const supportedSet = new Set<string>(supported);
  const grouped = new Set<string>();

  const result: SearchableSelectGroup[] = groups.map((group) => {
    const options = group.tags
      .filter((tag) => supportedSet.has(tag))
      .map((tag) => {
        grouped.add(tag);
        return { value: tag, label: `<${tag}>` };
      });
    return { label: group.label, options };
  });

  const ungrouped = supported
    .filter((tag) => !grouped.has(tag))
    .map((tag) => ({ value: tag, label: `<${tag}>` }));
  if (ungrouped.length > 0) {
    const fallbackIndex = result.findIndex((group) => group.label === 'Other');
    if (fallbackIndex >= 0) {
      const fallback = result[fallbackIndex]!;
      result[fallbackIndex] = { ...fallback, options: [...fallback.options, ...ungrouped] };
    } else {
      result.push({ label: 'Other', options: ungrouped });
    }
  }

  return result.filter((group) => group.options.length > 0);
}
