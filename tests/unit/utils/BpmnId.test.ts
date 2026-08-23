import BpmnModdle from 'bpmn-moddle';
import { isBpmnId, isBpmnQName, parseBpmnXml } from '../../../src/utils/BpmnId.js';

describe('BPMN XML names', () => {
  it.each([
    ['ASCII', 'Task_1'],
    ['non-ASCII start', 'Ångström'],
    ['CJK start', '任务_一'],
    ['combining continuation', `A\u0301`],
    ['supplementary start', `\u{10000}_Task`],
    ['last XML NCName supplementary code point', `\u{EFFFF}_Task`]
  ])('accepts the valid %s NCName', (_caseName, value) => {
    expect(isBpmnId(value)).toBe(true);
  });

  it.each([
    ['colon', 'a:b'],
    ['space', 'a b'],
    ['leading digit', '1Task'],
    ['leading dash', '-Task'],
    ['leading dot', '.Task'],
    ['empty string', ''],
    ['leading combining mark', `\u0301Task`],
    ['code point above the NCName range', `\u{F0000}Task`],
    ['lone high surrogate', `\uD800Task`],
    ['lone low surrogate', `\uDC00Task`]
  ])('rejects the invalid %s NCName', (_caseName, value) => {
    expect(isBpmnId(value)).toBe(false);
  });

  it('keeps QName colons separate from xsd:ID validation', () => {
    expect(isBpmnQName('external:Process')).toBe(true);
    expect(isBpmnId('external:Process')).toBe(false);
  });

  it('restores Unicode ID aliases in retained unknown attributes', async () => {
    const unicodeId = 'Å_Task';
    const xml = `<?xml version="1.0"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:custom="urn:custom" id="Definitions_A" targetNamespace="urn:test">
  <bpmn:process id="Process_A">
    <bpmn:task id="${unicodeId}" custom:mirror="${unicodeId}" />
  </bpmn:process>
</bpmn:definitions>`;
    const moddle = new BpmnModdle();
    const parsed = await parseBpmnXml(moddle, xml);
    const serialized = await moddle.toXML(parsed.rootElement);

    expect(parsed.elementsById[unicodeId].$attrs['custom:mirror']).toBe(unicodeId);
    expect(serialized.xml).toContain(`custom:mirror="${unicodeId}"`);
    expect(serialized.xml).not.toContain('__mcp_bpmn_unicode_id_');
  });
});
