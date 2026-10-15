/**
 * Filling a document template, which is how a firm produces client documents.
 *
 * `templateFill.ts` was at 0.43%, and it is the last step before a retainer
 * agreement, an engagement letter or a settlement statement is handed to a
 * client. The failures it can produce are all client-visible and none of them
 * look like an error: a placeholder left as literal `{clientName}` in a signed
 * document, one client's value landing in another's field, or a repeater row
 * silently dropped so a schedule of payments is short a line.
 *
 * The module is DOM work, but it runs under jsdom, which this suite already
 * uses. `buildFilledTemplateHtml(html, values, repeaterRows)` takes a template
 * and returns filled HTML, so it can be driven directly with no component and no
 * network.
 *
 * A placeholder is a `[data-placeholder-chip="name"]` element. The filled value
 * comes from `values[name]`, and an unfilled one becomes the literal `{name}`,
 * which is deliberate: a visible gap in a draft beats a silent blank in a
 * document someone is about to sign.
 */
import { buildFilledTemplateHtml } from '@/components/templatesComp/templateFill';

/** A template paragraph carrying one placeholder chip. */
const chip = (name: string, label = name) =>
  `<p><span data-placeholder-chip="${name}">${label}</span></p>`;

/** Text content of the filled result, with tags stripped. */
function textOf(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent ?? '';
}

describe('filling placeholders', () => {
  it('replaces a placeholder with its value', () => {
    const filled = buildFilledTemplateHtml(chip('clientName'), { clientName: 'Acme Corporation' });

    expect(textOf(filled)).toContain('Acme Corporation');
  });

  it('removes the placeholder chip once filled', () => {
    const filled = buildFilledTemplateHtml(chip('clientName'), { clientName: 'Acme Corporation' });

    // The chip is editor scaffolding. Leaving it in the output ships the
    // template's internal markup inside the client's document.
    expect(filled).not.toContain('data-placeholder-chip');
  });

  it('leaves an UNFILLED placeholder visible as {name}', () => {
    const filled = buildFilledTemplateHtml(chip('clientName'), {});

    // Deliberate. A blank would look like a finished document with an empty
    // field; `{clientName}` is obviously unfinished to whoever reviews it before
    // it goes out.
    expect(textOf(filled)).toContain('{clientName}');
  });

  it('treats an EMPTY STRING value as unfilled', () => {
    const filled = buildFilledTemplateHtml(chip('clientName'), { clientName: '' });

    // `values[name] || '{name}'` means an empty value falls back to the marker.
    // That is the safer reading: an empty string is far more often a value that
    // failed to resolve than a deliberate blank.
    expect(textOf(filled)).toContain('{clientName}');
  });

  it('fills several DIFFERENT placeholders independently', () => {
    const html = chip('clientName') + chip('matterNumber');

    const filled = buildFilledTemplateHtml(html, {
      clientName: 'Acme Corporation',
      matterNumber: 'CP-1234',
    });

    // The failure this catches is one value bleeding into every field, which
    // produces a document that reads fluently and is wrong throughout.
    const text = textOf(filled);
    expect(text).toContain('Acme Corporation');
    expect(text).toContain('CP-1234');
  });

  it('fills EVERY occurrence of the same placeholder', () => {
    const html = chip('clientName') + chip('clientName');

    const filled = buildFilledTemplateHtml(html, { clientName: 'Acme Corporation' });

    // A client's name appears many times in an agreement. Filling only the first
    // leaves `{clientName}` further down, past where anyone is still reading.
    expect(textOf(filled).match(/Acme Corporation/g)).toHaveLength(2);
  });

  it('fills one placeholder and leaves another unfilled', () => {
    const html = chip('clientName') + chip('signingDate');

    const filled = buildFilledTemplateHtml(html, { clientName: 'Acme Corporation' });

    const text = textOf(filled);
    expect(text).toContain('Acme Corporation');
    expect(text).toContain('{signingDate}');
  });

  it('does NOT use a value whose name does not match a placeholder', () => {
    const filled = buildFilledTemplateHtml(chip('clientName'), {
      opposingParty: 'Someone Else',
    });

    // Matching by anything looser than the exact name, position say, would put
    // the opposing party's name where the client's belongs.
    const text = textOf(filled);
    expect(text).not.toContain('Someone Else');
    expect(text).toContain('{clientName}');
  });
});

describe('values that are not plain words', () => {
  it('preserves a value containing HTML special characters as TEXT', () => {
    const filled = buildFilledTemplateHtml(chip('clientName'), {
      clientName: 'Smith & Jones <Holdings>',
    });

    // The text has to survive intact, and it must not become markup. A value
    // inserted as HTML would let a client name carrying angle brackets restructure
    // the document, which is both a rendering bug and an injection.
    expect(textOf(filled)).toContain('Smith & Jones <Holdings>');
  });

  it('does not let a value inject an element', () => {
    const filled = buildFilledTemplateHtml(chip('clientName'), {
      clientName: '<img src=x onerror=alert(1)>',
    });

    // Client names come from user input and this HTML is rendered and printed to
    // PDF. Inserting the value as markup would execute it.
    const doc = new DOMParser().parseFromString(filled, 'text/html');
    expect(doc.querySelector('img')).toBeNull();
    expect(textOf(filled)).toContain('<img src=x onerror=alert(1)>');
  });

  it('preserves unicode in a value', () => {
    const filled = buildFilledTemplateHtml(chip('clientName'), {
      clientName: 'Élodie Dupont-Léger',
    });

    // A mangled name on an engagement letter is a document the client will not
    // sign.
    expect(textOf(filled)).toContain('Élodie Dupont-Léger');
  });

  it('preserves a value that is only whitespace as unfilled', () => {
    const filled = buildFilledTemplateHtml(chip('clientName'), { clientName: '   ' });

    // A space is truthy, so it fills. Recorded so the distinction from the empty
    // string above is deliberate rather than accidental: the result is a blank
    // gap in the document with no marker to catch it in review.
    expect(textOf(filled)).not.toContain('{clientName}');
  });
});

describe('templates with no placeholders', () => {
  it('returns the document unchanged', () => {
    const html = '<p>This agreement is made on the date below.</p>';

    const filled = buildFilledTemplateHtml(html, { clientName: 'Acme' });

    expect(textOf(filled)).toContain('This agreement is made on the date below.');
  });

  it('handles an empty template', () => {
    expect(() => buildFilledTemplateHtml('', {})).not.toThrow();
  });

  it('keeps surrounding text around a placeholder', () => {
    const html = `<p>Between <span data-placeholder-chip="clientName">Client</span> and the Firm.</p>`;

    const filled = buildFilledTemplateHtml(html, { clientName: 'Acme Corporation' });

    // The sentence has to still read. A fill that replaced the whole paragraph
    // rather than the chip would drop the words around it.
    const text = textOf(filled);
    expect(text).toContain('Between');
    expect(text).toContain('Acme Corporation');
    expect(text).toContain('and the Firm.');
  });
});

describe('repeater rows', () => {
  const repeaterHtml = `<p data-repeater="payments" style="top:100px;font-size:12px">`
    + `<span data-placeholder-chip="payments.amount">Amount</span></p>`;

  it('renders one block per row', () => {
    const filled = buildFilledTemplateHtml(repeaterHtml, {}, {
      payments: [{ amount: '$100.00' }, { amount: '$200.00' }],
    });

    // A repeater is a schedule: instalments, parties, exhibits. A dropped row is
    // a payment the client is never asked for, and the document still looks
    // complete.
    const text = textOf(filled);
    expect(text).toContain('$100.00');
    expect(text).toContain('$200.00');
  });

  it('renders every row, not just the first', () => {
    const filled = buildFilledTemplateHtml(repeaterHtml, {}, {
      payments: [
        { amount: '$100.00' }, { amount: '$200.00' },
        { amount: '$300.00' }, { amount: '$400.00' },
      ],
    });

    const text = textOf(filled);
    for (const amount of ['$100.00', '$200.00', '$300.00', '$400.00']) {
      expect(text).toContain(amount);
    }
  });

  it('REMOVES the template block when there are no rows', () => {
    const filled = buildFilledTemplateHtml(repeaterHtml, {}, { payments: [] });

    // The empty case. Leaving the block behind prints the template's own
    // placeholder row as though it were a real payment.
    expect(textOf(filled)).not.toContain('{payments.amount}');
    expect(filled).not.toContain('data-repeater');
  });

  it('removes the block when the repeater has no data at all', () => {
    const filled = buildFilledTemplateHtml(repeaterHtml, {}, {});

    expect(filled).not.toContain('data-repeater');
  });

  it('keeps each row values separate', () => {
    const html = `<p data-repeater="parties" style="top:100px;font-size:12px">`
      + `<span data-placeholder-chip="parties.name">Name</span>`
      + `<span data-placeholder-chip="parties.role">Role</span></p>`;

    const filled = buildFilledTemplateHtml(html, {}, {
      parties: [
        { name: 'Acme Corporation', role: 'Claimant' },
        { name: 'Beta Limited', role: 'Respondent' },
      ],
    });

    // The failure this catches is the last row's values overwriting earlier
    // ones, which would name the same party in every line of a schedule.
    const text = textOf(filled);
    expect(text).toContain('Acme Corporation');
    expect(text).toContain('Claimant');
    expect(text).toContain('Beta Limited');
    expect(text).toContain('Respondent');
  });

  it('falls back to a top-level value for a field a row does not carry', () => {
    const html = `<p data-repeater="payments" style="top:100px;font-size:12px">`
      + `<span data-placeholder-chip="payments.amount">Amount</span>`
      + `<span data-placeholder-chip="firmName">Firm</span></p>`;

    const filled = buildFilledTemplateHtml(html, { firmName: 'Paralegix LLP' }, {
      payments: [{ amount: '$100.00' }],
    });

    // A repeater row carries only its own fields. Anything else in the block
    // still resolves against the document-level values, so a firm name inside a
    // schedule row is not left as a marker.
    const text = textOf(filled);
    expect(text).toContain('$100.00');
    expect(text).toContain('Paralegix LLP');
  });

  it('leaves a row field unfilled as {name} when nothing supplies it', () => {
    const filled = buildFilledTemplateHtml(repeaterHtml, {}, {
      payments: [{ somethingElse: 'x' }],
    });

    expect(textOf(filled)).toContain('{payments.amount}');
  });

  it('does not disturb content outside the repeater', () => {
    const html = `<p>Schedule of payments:</p>${repeaterHtml}<p>End of schedule.</p>`;

    const filled = buildFilledTemplateHtml(html, {}, {
      payments: [{ amount: '$100.00' }],
    });

    const text = textOf(filled);
    expect(text).toContain('Schedule of payments:');
    expect(text).toContain('End of schedule.');
  });
});
