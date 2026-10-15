import {
  stripSourceMarker,
  isParalegixOriginated,
  stripCalendarHeader,
} from '../../src/modules/calendar/shared/calendarHelpers';

describe('Calendar Shared Helpers & Synchronization Ops', () => {
  describe('stripSourceMarker', () => {
    it('returns empty string for nullish or empty inputs', () => {
      expect(stripSourceMarker(null)).toBe('');
      expect(stripSourceMarker(undefined)).toBe('');
      expect(stripSourceMarker('')).toBe('');
    });

    it('strips Task from Paralegix marker', () => {
      const input = 'Review case law\n\n— Task from Paralegix';
      expect(stripSourceMarker(input)).toBe('Review case law');
    });

    it('strips Matter event from Paralegix marker', () => {
      const input = 'Preliminary hearing\nMatter event from Paralegix';
      expect(stripSourceMarker(input)).toBe('Preliminary hearing');
    });

    it('strips Client event, External event, and Billing item markers', () => {
      expect(stripSourceMarker('Client meeting\nClient event from Paralegix')).toBe('Client meeting');
      expect(stripSourceMarker('Deposition\nExternal event from Paralegix')).toBe('Deposition');
      expect(stripSourceMarker('Draft contract\nBilling item from Paralegix')).toBe('Draft contract');
    });
  });

  describe('isParalegixOriginated', () => {
    it('detects events originated from Paralegix sync', () => {
      expect(isParalegixOriginated('Meeting details\n— Task from Paralegix')).toBe(true);
      expect(isParalegixOriginated('Matter event from Paralegix')).toBe(true);
      expect(isParalegixOriginated('Random third party invite from external client')).toBe(false);
      expect(isParalegixOriginated('')).toBe(false);
      expect(isParalegixOriginated(null)).toBe(false);
    });
  });

  describe('stripCalendarHeader', () => {
    it('strips client info, location lines, and event type labels from event description', () => {
      const rawDescription = `Client: Acme Corp
Hearing: Motion to Compel
Location: Courtroom 302
Please bring the signed affidavit and deposition exhibits.
— Matter event from Paralegix`;

      const cleaned = stripCalendarHeader(rawDescription);
      expect(cleaned).toBe('Please bring the signed affidavit and deposition exhibits.');
    });

    it('strips a multi-client section and the Google Task notice', () => {
      // Sections are separated by a BLANK LINE, because that is how
      // `calendarDescriptionBuilder` joins them (`.join('\n\n')`). The blank
      // line is load-bearing, not cosmetic: see the case below.
      const rawDescription = `Clients:
John Doe - 555-1234
Jane Doe

Review discovery materials.

Changes made to the title, description, or attachments will not be saved. To make edits, please go to: https://tasks.google.com/task/12345
— Task from Paralegix`;

      const cleaned = stripCalendarHeader(rawDescription);
      expect(cleaned).toBe('Review discovery materials.');
    });

    it('keeps a clients section with no source marker, since Paralegix did not write it', () => {
      // The header is stripped only under a Paralegix marker. Before that, the
      // unterminated `Clients:` pattern consumed this whole description.
      const editedByHand = `Clients:
John Doe - 555-1234
Review discovery materials.`;

      expect(stripCalendarHeader(editedByHand)).toBe(editedByHand);
    });

    it('preserves clean descriptions without headers untouched', () => {
      const cleanText = 'Standard internal meeting with team members.';
      expect(stripCalendarHeader(cleanText)).toBe(cleanText);
    });

    it('empties a description that is nothing but the Google Tasks notice', () => {
      const description = [
        'Changes made to the title, description, or attachments will not be saved. To make edits, please go to:',
        'https://tasks.google.com/task/5ehvRlbW6HjS44SF',
      ].join('\n');

      expect(stripCalendarHeader(description)).toBe('');
    });

    it('keeps the real notes that follow the Google Tasks notice', () => {
      const description = [
        'Changes made to the title, description, or attachments will not be saved. To make edits, please go to:',
        'https://tasks.google.com/task/5ehvRlbW6HjS44SF',
        '',
        'Follow up with client about intake packet.',
      ].join('\n');

      expect(stripCalendarHeader(description)).toBe('Follow up with client about intake packet.');
    });

    it('keeps a note that merely mentions tasks.google.com', () => {
      const description = 'Reference doc: https://tasks.google.com/task/example but keep this note.';

      expect(stripCalendarHeader(description)).toBe(description);
    });
  });
});
