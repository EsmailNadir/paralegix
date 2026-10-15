import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { FlatFeeEditorRow, FlatFeeSavedRow, type FlatFeeDraft } from '@/components/billingComp/FlatFeeEditor';

describe('FlatFeeEditor Components', () => {
  const sampleFee: FlatFeeDraft = {
    id: 'fee-1',
    description: 'Document Drafting Fee',
    amount: 450.0,
    date: '2026-08-25',
  };

  describe('FlatFeeSavedRow', () => {
    it('renders the fee and confirms before removing it', async () => {
      const handleEdit = jest.fn();
      const handleDelete = jest.fn();

      render(
        <FlatFeeSavedRow
          fee={sampleFee}
          onEdit={handleEdit}
          onDelete={handleDelete}
        />,
      );

      expect(screen.getByText('Document Drafting Fee')).toBeInTheDocument();
      expect(screen.getByText('$450.00')).toBeInTheDocument();
      expect(screen.getByText('Unbilled')).toBeInTheDocument();
      expect(screen.getByText('Aug 25, 2026')).toBeInTheDocument();

      const editBtn = screen.getByRole('button', { name: 'Edit' });
      fireEvent.click(editBtn);
      expect(handleEdit).toHaveBeenCalledTimes(1);

      const deleteBtn = screen.getByRole('button', { name: 'Remove flat fee' });
      fireEvent.click(deleteBtn);
      expect(handleDelete).not.toHaveBeenCalled();
      const dialog = await screen.findByRole("dialog", { name: "Remove Flat Fee" });
      expect(dialog).toHaveTextContent("Document Drafting Fee");
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
      await waitFor(() => expect(handleDelete).toHaveBeenCalledTimes(1));
    });
  });

  describe('FlatFeeEditorRow', () => {
    it('renders inputs and triggers onChange and onSave', () => {
      const handleChange = jest.fn();
      const handleSave = jest.fn();
      const handleDiscard = jest.fn();

      render(
        <FlatFeeEditorRow
          fee={sampleFee}
          onChange={handleChange}
          onSave={handleSave}
          onDiscard={handleDiscard}
          saveLabel="Save"
        />,
      );

      const descInput = screen.getByDisplayValue('Document Drafting Fee');
      fireEvent.change(descInput, { target: { value: 'Updated Drafting Fee' } });
      expect(handleChange).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Updated Drafting Fee' }),
      );

      const saveBtn = screen.getByRole('button', { name: 'Save' });
      expect(saveBtn).toBeEnabled();
      fireEvent.click(saveBtn);
      expect(handleSave).toHaveBeenCalledTimes(1);

      const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
      fireEvent.click(cancelBtn);
      expect(handleDiscard).toHaveBeenCalledTimes(1);
    });

    it('disables save button when description is blank or amount is zero', () => {
      const invalidFee: FlatFeeDraft = {
        id: 'fee-invalid',
        description: '',
        amount: 0,
      };

      render(
        <FlatFeeEditorRow
          fee={invalidFee}
          onChange={jest.fn()}
          onSave={jest.fn()}
          onDiscard={jest.fn()}
        />,
      );

      const saveBtn = screen.getByRole('button', { name: 'Save' });
      expect(saveBtn).toBeDisabled();
    });

    /**
     * The generate-invoice surfaces pick which fees go on the invoice they are
     * building, so the row carries a checkbox there. The billing tabs only list
     * fees, so it must not appear for them.
     */
    it('renders a checkbox only where the caller passes select', () => {
      const { unmount } = render(
        <FlatFeeEditorRow
          fee={sampleFee}
          onChange={jest.fn()}
          onSave={jest.fn()}
          onDiscard={jest.fn()}
        />,
      );
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      unmount();

      const handleSelect = jest.fn();
      render(
        <FlatFeeEditorRow
          fee={sampleFee}
          onChange={jest.fn()}
          onSave={jest.fn()}
          onDiscard={jest.fn()}
          select={{ checked: true, onChange: handleSelect }}
        />,
      );

      const box = screen.getByRole('checkbox');
      expect(box).toBeChecked();
      fireEvent.click(box);
      expect(handleSelect).toHaveBeenCalledWith(false);
    });

    /**
     * Discarding a SAVED fee deletes it on the server. A second click during
     * that round trip sends a second delete for a row that is already going.
     */
    it('takes no second discard while the first is in flight', () => {
      const handleDiscard = jest.fn();

      render(
        <FlatFeeEditorRow
          fee={sampleFee}
          onChange={jest.fn()}
          onSave={jest.fn()}
          onDiscard={handleDiscard}
          discardAs="trash"
          deleting
        />,
      );

      const trash = screen.getByRole('button', { name: 'Remove flat fee' });
      expect(trash).toBeDisabled();
      fireEvent.click(trash);
      expect(handleDiscard).not.toHaveBeenCalled();
    });
  });
});
