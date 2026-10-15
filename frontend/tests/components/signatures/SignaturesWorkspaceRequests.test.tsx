/**
 * The signatures page opens with ONE `signature-links/workspace` request.
 *
 * It used to open with four: a page of sessions, the per-status summary, the
 * member's pending documents and the template list. The workspace response
 * carries all four bodies unchanged, and the page writes each into the cache
 * entry its own hook reads, so everything that invalidates those entries (a
 * voided session, a saved template) still re-reads only that section from its
 * own endpoint.
 *
 * What has to break for these to go red: the page reading the four endpoints
 * again on open, the workspace body not reaching the screen, an invalidated
 * section no longer re-reading its endpoint, or a failed workspace request
 * leaving the page empty instead of falling back to the four reads.
 */
jest.unmock('@/services/signatures.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import SignaturesWorkspace from '@/components/signaturesComp/SignaturesWorkspace';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';

const FIRM = 'firm-1';
const BASE = `/api/lawfirms/${FIRM}/signature-links`;
const SESSIONS = `${BASE}/sessions`;
const SUMMARY = `${BASE}/sessions/summary`;
const PENDING = `${BASE}/pending-for-user`;
const TEMPLATES = `/api/lawfirms/${FIRM}/signing-templates`;
const WORKSPACE = `${BASE}/workspace`;

let api: ApiMock;

function session(overrides: Record<string, unknown> = {}) {
  return {
    token: 'sess-1',
    fileName: 'Engagement letter.pdf',
    status: 'pending',
    signerName: 'Pat Client',
    recipientEmail: 'pat@example.test',
    createdAt: '2026-09-01T10:00:00.000Z',
    completedAt: null,
    ...overrides,
  };
}

function workspaceBody() {
  return {
    sessions: { sessions: [session()], totalItems: 1 },
    summary: { counts: { pending: 1 }, total: 7, notCompleted: 1 },
    pendingForUser: { needsMySignature: [], createdByMe: [] },
    templates: { templates: [{ id: 'tpl-1', name: 'NDA' }, { id: 'tpl-2', name: 'Retainer' }] },
  };
}

function seedSectionEndpoints() {
  api.getExact(SUMMARY, { counts: {}, total: 0, notCompleted: 0 });
  api.getExact(`${SESSIONS}?page=1&limit=10`, { sessions: [], totalItems: 0 });
  api.getExact(PENDING, { needsMySignature: [], createdByMe: [] });
  api.getExact(TEMPLATES, { templates: [] });
}

function sectionCalls() {
  return api.calls().filter((call) => [SESSIONS, SUMMARY, PENDING, TEMPLATES].includes(call.pathname));
}

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
});

it('opens with one workspace request and draws its sessions and counts', async () => {
  api.get(WORKSPACE, workspaceBody());
  seedSectionEndpoints();

  renderWithProviders(<SignaturesWorkspace lawFirmId={FIRM} initialTab="activity" />);

  expect(await screen.findByText('Engagement letter.pdf')).toBeInTheDocument();
  expect(api.callsTo('/workspace')).toHaveLength(1);
  expect(api.callsTo('/workspace')[0].query).toEqual(expect.objectContaining({ page: ['1'], limit: ['10'] }));
  // The tab counts come from the summary and the template list in that response.
  expect(screen.getByRole('button', { name: /Signing activity\s*7/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Templates\s*2/ })).toBeInTheDocument();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(sectionCalls()).toHaveLength(0);
});

it('keeps the activity loading placeholder until the workspace data arrives', async () => {
  api.get(WORKSPACE, { body: workspaceBody(), delayMs: 100 });
  seedSectionEndpoints();

  renderWithProviders(<SignaturesWorkspace lawFirmId={FIRM} initialTab="activity" />);

  expect(screen.getByRole('status', { name: 'Loading signing sessions' })).toBeInTheDocument();
  expect(screen.queryByText('No documents sent for signature yet')).not.toBeInTheDocument();
  expect(await screen.findByText('Engagement letter.pdf')).toBeInTheDocument();
  expect(screen.queryByRole('status', { name: 'Loading signing sessions' })).not.toBeInTheDocument();
});

it('re-reads only the summary from its own endpoint when it is invalidated', async () => {
  api.get(WORKSPACE, workspaceBody());
  seedSectionEndpoints();
  api.getExact(SUMMARY, { counts: {}, total: 9, notCompleted: 0 });

  const { queryClient } = renderWithProviders(<SignaturesWorkspace lawFirmId={FIRM} initialTab="activity" />);
  await screen.findByRole('button', { name: /Signing activity\s*7/ });

  await queryClient.invalidateQueries({ queryKey: ['signingSessionSummary', FIRM] });

  expect(await screen.findByRole('button', { name: /Signing activity\s*9/ })).toBeInTheDocument();
  expect(api.callsTo('/sessions/summary')).toHaveLength(1);
  expect(sectionCalls()).toHaveLength(1);
  expect(api.callsTo('/workspace')).toHaveLength(1);
});

it('falls back to the four section reads when the workspace request fails', async () => {
  api.get(WORKSPACE, { status: 500, body: { error: 'workspace unavailable' } });
  seedSectionEndpoints();
  api.getExact(`${SESSIONS}?page=1&limit=10`, { sessions: [session({ fileName: 'Fallback.pdf' })], totalItems: 1 });

  renderWithProviders(<SignaturesWorkspace lawFirmId={FIRM} initialTab="activity" />);

  expect(await screen.findByText('Fallback.pdf')).toBeInTheDocument();
  await waitFor(() => expect(sectionCalls()).toHaveLength(4));
});
