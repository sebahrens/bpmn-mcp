const NC_NAME_START_CHARACTERS = String.raw`A-Z_a-z\xC0-\xD6\xD8-\xF6\xF8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}`;
const NC_NAME_CHARACTERS = `${NC_NAME_START_CHARACTERS}\\-.0-9\\xB7\\u0300-\\u036F\\u203F-\\u2040`;

// These ranges implement the XML 1.0 NCName productions. The Unicode flag is
// required so supplementary code points are matched as code points while lone
// surrogate code units remain invalid.
// eslint-disable-next-line no-misleading-character-class
export const BPMN_ID_PATTERN = new RegExp(
  `^[${NC_NAME_START_CHARACTERS}][${NC_NAME_CHARACTERS}]*$`,
  'u'
);

// QName-valued BPMN references may contain one namespace separator; xsd:ID
// values use BPMN_ID_PATTERN and never permit that separator.
// eslint-disable-next-line no-misleading-character-class
const BPMN_QNAME_PATTERN = new RegExp(
  `^[${NC_NAME_START_CHARACTERS}][${NC_NAME_CHARACTERS}]*(?::[${NC_NAME_START_CHARACTERS}][${NC_NAME_CHARACTERS}]*)?$`,
  'u'
);

export function isBpmnId(value: unknown): value is string {
  return typeof value === 'string' && BPMN_ID_PATTERN.test(value);
}

export function isBpmnQName(value: unknown): value is string {
  return typeof value === 'string' && BPMN_QNAME_PATTERN.test(value);
}

export function invalidBpmnIdMessage(value: unknown, path: string): string {
  const rendered = typeof value === 'string' ? JSON.stringify(value) : String(value);
  return `Invalid BPMN xsd:ID at ${path}: ${rendered} is not an XML NCName`;
}

export function assertBpmnId(value: unknown, path: string): asserts value is string {
  if (!isBpmnId(value)) throw new Error(invalidBpmnIdMessage(value, path));
}

export function bpmnModdleIdPath(element: any): string {
  const segments: string[] = [];
  let current = element;

  while (current?.$parent) {
    const parent = current.$parent;
    let relation = current.$type || 'element';
    for (const [property, value] of Object.entries(parent)) {
      if (property.startsWith('$') && property !== '$attrs' && property !== '$children') continue;
      if (value === current) {
        relation = `${property}(${current.$type || 'element'})`;
        break;
      }
      if (Array.isArray(value)) {
        const index = value.indexOf(current);
        if (index >= 0) {
          relation = `${property}[${index}](${current.$type || 'element'})`;
          break;
        }
      }
    }
    segments.unshift(relation);
    current = parent;
  }

  const root = current?.$type || 'document';
  return `${[root, ...segments].join('.')}.id`;
}

export interface BpmnXmlIdentifierProblem {
  code: 'BPMN_INVALID_ID' | 'BPMN_DUPLICATE_ID';
  value: string;
  path: string;
  previousPath?: string;
}

const BPMN_MODEL_NAMESPACE = 'http://www.omg.org/spec/BPMN/20100524/MODEL';
const BPMN_DI_NAMESPACE = 'http://www.omg.org/spec/BPMN/20100524/DI';
const BPMN_NAMESPACES = new Set([BPMN_MODEL_NAMESPACE, BPMN_DI_NAMESPACE]);
const BPMN_ID_REFERENCE_ATTRIBUTES = new Set([
  'attachedToRef',
  'bpmnElement',
  'default',
  'itemSubjectRef',
  'processRef',
  'sourceRef',
  'targetRef'
]);

function decodeXmlCharacterReferences(value: string): string {
  return value
    .replace(/&#(?:x([0-9A-Fa-f]+)|([0-9]+));/gu, (match, hexadecimal, decimal) => {
      const codePoint = Number.parseInt(hexadecimal || decimal, hexadecimal ? 16 : 10);
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    })
    .replace(/&(amp|apos|gt|lt|quot);/gu, (_match, name: string) => ({
      amp: '&', apos: "'", gt: '>', lt: '<', quot: '"'
    })[name]!);
}

/**
 * Inspect authored ID and local ID-reference attributes before moddle gets a
 * chance to discard empty values. Namespace filtering avoids treating
 * extension attributes named `id` as BPMN xsd:ID values.
 */
export function inspectBpmnXmlIdentifiers(xml: string): BpmnXmlIdentifierProblem[] {
  const markup = xml.replace(
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>/gu,
    ''
  );
  const problems: BpmnXmlIdentifierProblem[] = [];
  const seen = new Map<string, string>();
  const occurrences = new Map<string, number>();
  let namespaces = new Map<string, string>();
  const namespaceStack: Array<Map<string, string>> = [];
  const tagPattern = /<(\/)?([^\s/>]+)([^<>]*?)(\/?)>/gu;
  for (const tag of markup.matchAll(tagPattern)) {
    if (tag[1]) {
      namespaces = namespaceStack.pop() || new Map<string, string>();
      continue;
    }

    const attributes = tag[3];
    const scopedNamespaces = new Map(namespaces);
    const namespacePattern = /\sxmlns(?::([^\s=]+))?\s*=\s*(["'])([^"']*)\2/gu;
    for (const namespace of attributes.matchAll(namespacePattern)) {
      scopedNamespaces.set(
        namespace[1] || '',
        decodeXmlCharacterReferences(namespace[3])
      );
    }

    const actualQualifiedName = tag[2];
    const separator = actualQualifiedName.indexOf(':');
    const prefix = separator >= 0 ? actualQualifiedName.slice(0, separator) : '';
    const isBpmnElement = BPMN_NAMESPACES.has(scopedNamespaces.get(prefix) || '');

    if (isBpmnElement) {
      const occurrence = occurrences.get(actualQualifiedName) || 0;
      occurrences.set(actualQualifiedName, occurrence + 1);
      const attributePattern = /\s([^\s=]+)\s*=\s*(["'])([^"']*)\2/gu;
      for (const attribute of attributes.matchAll(attributePattern)) {
        const attributeName = attribute[1];
        if (attributeName.includes(':')) continue;
        if (attributeName !== 'id' && !BPMN_ID_REFERENCE_ATTRIBUTES.has(attributeName)) continue;

        const value = decodeXmlCharacterReferences(attribute[3]);
        const path = `${actualQualifiedName}[${occurrence}].${attributeName}`;
        if (!isBpmnId(value)) {
          problems.push({ code: 'BPMN_INVALID_ID', value, path });
        } else if (attributeName === 'id') {
          const previousPath = seen.get(value);
          if (previousPath) {
            problems.push({ code: 'BPMN_DUPLICATE_ID', value, path, previousPath });
          } else {
            seen.set(value, path);
          }
        }
      }
    }

    if (!tag[4]) {
      namespaceStack.push(namespaces);
      namespaces = scopedNamespaces;
    }
  }
  return problems;
}

export function assertBpmnXmlIdentifiers(xml: string): void {
  const problem = inspectBpmnXmlIdentifiers(xml)[0];
  if (!problem) return;
  if (problem.code === 'BPMN_INVALID_ID') {
    throw new Error(invalidBpmnIdMessage(problem.value, problem.path));
  }
  throw new Error(
    `Duplicate BPMN xsd:ID at ${problem.path}: ${JSON.stringify(problem.value)}`
    + ` is already used at ${problem.previousPath}`
  );
}

/**
 * moddle-xml currently validates IDs with an ASCII-only regular expression.
 * Alias only standards-valid Unicode NCNames while it constructs and resolves
 * the object graph, then restore the authored values on every returned view.
 * Invalid IDs are deliberately left untouched for the caller to reject.
 */
interface BpmnXmlParseResult {
  rootElement: any;
  elementsById: Record<string, any>;
  references: Array<{ id: string; element: any; property: string }>;
  warnings: Error[];
}

export async function parseBpmnXml(
  moddle: { fromXML(xml: string): Promise<BpmnXmlParseResult> },
  xml: string
): Promise<BpmnXmlParseResult> {
  const authoredIds: string[] = [];
  const idAttributePattern = /(\sid\s*=\s*)(["'])([^"']*)\2/g;
  for (const match of xml.matchAll(idAttributePattern)) {
    const id = decodeXmlCharacterReferences(match[3]);
    const hasNonAsciiCodePoint = Array.from(id)
      .some(character => character.codePointAt(0)! > 0x7f);
    if (isBpmnId(id) && hasNonAsciiCodePoint && !authoredIds.includes(id)) {
      authoredIds.push(id);
    }
  }
  if (authoredIds.length === 0) return moddle.fromXML(xml);

  const allIds = new Set(Array.from(
    xml.matchAll(idAttributePattern),
    match => decodeXmlCharacterReferences(match[3])
  ));
  const aliases = new Map<string, string>();
  authoredIds.forEach((id, index) => {
    let alias = `__mcp_bpmn_unicode_id_${index + 1}`;
    while (allIds.has(alias) || xml.includes(alias)) alias = `_${alias}`;
    aliases.set(id, alias);
    allIds.add(alias);
  });
  const originals = new Map(Array.from(aliases, ([original, alias]) => [alias, original]));
  const replaceTokens = (value: string, replacements: Map<string, string>): string =>
    value.split(/(\s+)/u).map(token => replacements.get(token) || token).join('');
  const aliasTokens = (value: string): string => value.split(/(\s+)/u)
    .map(token => aliases.get(decodeXmlCharacterReferences(token)) || token)
    .join('');

  const transformedXml = xml
    .replace(/(\s[^\s=<>]+\s*=\s*)(["'])([^"']*)\2/g, (_match, prefix, quote, value) =>
      `${prefix}${quote}${aliasTokens(value)}${quote}`)
    .replace(/>([^<]+)</g, (_match, body) => `>${aliasTokens(body)}<`);

  const result = await moddle.fromXML(transformedXml);
  const parsed = result;
  const visited = new Set<object>();
  const restore = (value: unknown): void => {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    const attributes = (value as Record<string, unknown>).$attrs;
    if (attributes && typeof attributes === 'object') {
      for (const [name, attributeValue] of Object.entries(attributes)) {
        if (typeof attributeValue === 'string') {
          (attributes as Record<string, unknown>)[name] = replaceTokens(attributeValue, originals);
        }
      }
    }
    for (const [property, child] of Object.entries(value)) {
      if (property.startsWith('$') && property !== '$children') continue;
      if (typeof child === 'string') {
        (value as Record<string, unknown>)[property] = replaceTokens(child, originals);
      } else if (Array.isArray(child)) {
        child.forEach((item, index) => {
          if (typeof item === 'string') child[index] = replaceTokens(item, originals);
          else restore(item);
        });
      } else {
        restore(child);
      }
    }
  };
  restore(parsed.rootElement);

  parsed.elementsById = Object.fromEntries(
    Object.entries(parsed.elementsById).map(([id, element]) => [originals.get(id) || id, element])
  );
  for (const reference of parsed.references) {
    reference.id = replaceTokens(reference.id, originals);
  }
  for (const warning of parsed.warnings) {
    for (const [alias, original] of originals) {
      warning.message = warning.message.split(alias).join(original);
    }
  }
  return parsed;
}
