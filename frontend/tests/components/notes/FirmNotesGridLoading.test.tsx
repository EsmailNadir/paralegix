jest.unmock('@/services/matters.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@/hooks/useFirmMembers', () => ({ useFirmMembers: () => [] }));

import React from 'react';
import { screen } from '@testing-library/react';
import FirmNotesGrid from '@/components/notesComp/FirmNotesGrid';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
});

it('holds a list placeholder until firm notes arrive', async () => {
  api.get('/api/lawfirms/firm-1/notes', {
    body: {
      notes: [{
        id: 'note-1',
        matterId: 'matter-1',
        matterName: 'Smith matter',
        content: 'Call summary',
        noteDate: '2026-09-01',
        createdAt: '2026-09-01T10:00:00.000Z',
      }],
      totalNotes: 1,
      counts: { all: 1, withTime: 0, withoutTime: 1 },
      tags: [],
    },
    delayMs: 100,
  });

  renderWithProviders(<FirmNotesGrid lawFirmId="firm-1" />);

  expect(screen.getByRole('status', { name: 'Loading notes' })).toBeInTheDocument();
  expect(screen.queryByText('No notes yet')).not.toBeInTheDocument();
  expect(await screen.findByText('Smith matter')).toBeInTheDocument();
});
