import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

type Signature = { kind: string; cls: string };

function extract(source: string): Signature[] {
  const script = fs.readFileSync(path.join(process.cwd(), 'scripts/check-class-migration.mjs'), 'utf8');
  const resolverStart = script.indexOf('/* ── resolvers');
  const comparisonStart = script.indexOf('/* ── comparison');
  const context = { source, createHash, result: [] as Signature[] };
  vm.runInNewContext(
    `${script.slice(resolverStart, comparisonStart)}\nresult = signatures(source, true);`,
    context,
  );
  return context.result.map(({ kind, cls }) => ({ kind, cls }));
}

describe('organization input class migration', () => {
  it('tracks the existing start label after extraction into date range fields', () => {
    expect(extract('<DateTimeRangeFields startLabel="Due" />'))
      .toEqual(extract('<FieldLabel>Due</FieldLabel>'));
  });
  it('recognizes the autocomplete as the same rendered input as TextInput', () => {
    expect(extract('<ClientOrganizationAutocomplete value={name} onChange={setName} />'))
      .toEqual(extract('<TextInput value={name} onChange={setName} />'));
    expect(extract('<ClientOrganizationAutocomplete />')).toHaveLength(1);
  });

  it('detects input class changes passed through the autocomplete', () => {
    expect(extract('<ClientOrganizationAutocomplete className="text-xs" />'))
      .not.toEqual(extract('<TextInput />'));
    expect(extract('<ClientOrganizationAutocomplete className="text-xs" />')[0].cls)
      .toContain('text-xs');
  });
});

describe('shared modal fields', () => {
  it('tracks the two credit-note labels after extraction', () => {
    expect(extract('<CreditNoteFields />')).toEqual(extract('<FieldLabel>Amount *</FieldLabel><FieldLabel>Description</FieldLabel>'));
    expect(extract('<CreditNoteFields />')).toHaveLength(2);
  });

  it('tracks the client controls and each preferred-contact label presentation', () => {
    const fields = '<FieldLabel /><TextInput /><FieldLabel /><TextInput /><FieldLabel /><TextInput />'
      + '<FieldLabel /><ClientOrganizationAutocomplete /><FieldLabel /><TextInput />';
    expect(extract('<ClientFields preferredOwnLabel />')).toEqual(extract(fields));
    expect(extract('<ClientFields />')).toEqual(extract(`${fields}<FieldLabel />`));
    expect(extract('<ClientFields />')).toHaveLength(11);
  });

  it('tracks the task body and both billing layouts after extraction', () => {
    expect(extract('<TaskFormBody />')).toEqual(extract('<FieldLabel /><TextInput /><FieldLabel /><Textarea /><DateTimeRangeFields />'));
    expect(extract('<MatterBillingFields layout="grid" />')).toEqual(extract('<FieldLabel /><TextInput /><FieldLabel /><TextInput /><FieldLabel /><TextInput />'));
    expect(extract('<MatterBillingFields layout="stack" />')).toEqual(extract('<FieldLabel /><FieldLabel />'));
    expect(extract('<CreditNoteModal />')).toEqual(extract('<CreditNoteFields />'));
  });

  it('retains the reason label size and tone after extraction', () => {
    expect(extract('<ReasonField />')).toEqual(extract('<FieldLabel>Reason</FieldLabel>'));
    expect(extract('<ReasonField labelSize="xs" labelTone="secondary" />'))
      .toEqual(extract('<FieldLabel size="xs" tone="secondary">Reason for Voiding *</FieldLabel>'));
    expect(extract('<ReasonField labelSize="xs" />')).not.toEqual(extract('<ReasonField />'));
  });

  it('allows an exact reviewed signature change but rejects any later class change', () => {
    const script = fs.readFileSync(path.join(process.cwd(), 'scripts/check-class-migration.mjs'), 'utf8');
    const context = { createHash, result: [] as boolean[] };
    vm.runInNewContext(`${script.slice(script.indexOf('/* ── resolvers'), script.indexOf('/* ── comparison'))}
      const before = [{kind: 'label', cls: 'text-xs'}];
      const after = [{kind: 'label', cls: 'text-sm'}];
      REVIEWED_SIGNATURE_CHANGES.set('example.tsx', {before: signatureHash(before), after: signatureHash(after)});
      result = [
        isReviewedSignatureChange('example.tsx', before, after),
        isReviewedSignatureChange('example.tsx', before, [{kind: 'label', cls: 'text-lg'}]),
        isReviewedSignatureChange('example.tsx', [{kind: 'label', cls: 'text-base'}], after),
        isReviewedSignatureChange('other.tsx', before, after),
      ];`, context);
    expect(Array.from(context.result)).toEqual([true, false, false, false]);
  });
});
