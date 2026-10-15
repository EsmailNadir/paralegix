/**
 * Stand-ins for the court directory widgets the matter and task court fields
 * embed, so a spec drives the field's own quick-create flow without the court
 * catalogue lookup behind them.
 *
 * `jest.mock` factories, reached through `require` because `jest.mock` is
 * hoisted above the file's imports:
 *
 *   jest.mock('@/components/courtsComp/CourtNameAutocomplete', () =>
 *     require('../../support/fixtures/courtFieldMocks').courtNameAutocompleteModule());
 */
import React from 'react';

/** `CourtDirectoryLink` as an inert marker. */
export function courtDirectoryLinkModule() {
  return function CourtDirectoryLinkMock() {
    return <span data-testid="court-dir-link" />;
  };
}

/** `CourtNameAutocomplete` as a plain text input carrying the typed name. */
export function courtNameAutocompleteModule() {
  return {
    __esModule: true,
    default: function CourtNameAutocompleteMock({
      value,
      onChange,
    }: {
      value: string;
      onChange: (v: string) => void;
    }) {
      return (
        <input
          data-testid="court-autocomplete"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Court Name"
        />
      );
    },
    formatCourtCatalogValue: (v: string) => v,
  };
}
