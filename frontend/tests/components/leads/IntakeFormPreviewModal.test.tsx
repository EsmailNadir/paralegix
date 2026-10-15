import React from 'react';
import { render, screen } from '@testing-library/react';
import IntakeFormPreviewModal from '@/components/leadComp/IntakeFormPreviewModal';

describe('IntakeFormPreviewModal', () => {
  it('has one header and one close button above the preview', () => {
    render(
      <IntakeFormPreviewModal open url="https://example.test/intake/tok" name="General Intake" onClose={jest.fn()} />,
    );

    expect(screen.getAllByRole('heading', { name: 'General Intake Preview' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /close/i })).toHaveLength(1);
    expect(screen.getByTitle('Intake Form Preview')).toHaveAttribute('src', 'https://example.test/intake/tok');
  });
});
