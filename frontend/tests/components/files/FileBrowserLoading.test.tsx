jest.unmock('@/services/files.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import FileBrowser from '@/components/filesComp/FileBrowser';
import { FIRM_SCOPE } from '@/lib/files/fileScope';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => api.restore());

it('keeps an empty file search in a loading state until its answer arrives', async () => {
  let releaseSearch: ((value: unknown) => void) | undefined;
  api.get('/files/list-folder', { files: [] });
  api.get('/files/search', () => new Promise((resolve) => { releaseSearch = resolve; }));

  renderWithProviders(<FileBrowser lawFirmId="firm-1" scope={FIRM_SCOPE} />);
  expect(screen.getByRole('status', { name: 'Loading files' })).toBeInTheDocument();
  expect(await screen.findByText('No law firm files')).toBeInTheDocument();

  fireEvent.change(screen.getByPlaceholderText('Search files…'), { target: { value: 'contract' } });
  expect(screen.getByRole('status', { name: 'Loading files' })).toBeInTheDocument();
  expect(screen.queryByText('No files found')).not.toBeInTheDocument();

  await waitFor(() => expect(releaseSearch).toBeDefined());
  expect(screen.getByRole('status', { name: 'Loading files' })).toBeInTheDocument();
  expect(screen.queryByText('No files found')).not.toBeInTheDocument();

  releaseSearch?.({ files: [] });
  expect(await screen.findByText('No files found')).toBeInTheDocument();
});
