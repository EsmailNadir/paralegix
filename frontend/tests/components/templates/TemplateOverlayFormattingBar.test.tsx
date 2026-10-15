import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import TemplateOverlayFormattingBar from '@/components/templatesComp/TemplateOverlayFormattingBar';
import type { PlacementStyleDraft } from '@/components/templatesComp/templateOverlayTypes';

const style: PlacementStyleDraft = {
  fontSize: 14,
  fontFamily: 'times',
  bold: false,
  italic: false,
  color: '#000000',
  textAlign: 'left',
  bulletList: false,
};

const sample = { familyLabel: 'Calibri', family: 'calibri' as const, sizePt: 11, bold: true, italic: false };

describe('TemplateOverlayFormattingBar', () => {
  it('shows the size the text really renders at when it is smaller than the chosen one', () => {
    render(<TemplateOverlayFormattingBar style={style} onChange={jest.fn()} fittedSize={9} />);
    expect(screen.getByTestId('fitted-size')).toHaveTextContent('fits at 9');
  });

  it('says nothing about fit when the text renders at the chosen size', () => {
    render(<TemplateOverlayFormattingBar style={style} onChange={jest.fn()} fittedSize={14} />);
    expect(screen.queryByTestId('fitted-size')).toBeNull();
  });

  it('always shows what an automatic size resolved to', () => {
    render(<TemplateOverlayFormattingBar style={{ ...style, fontSize: null }} onChange={jest.fn()} fittedSize={12} />);
    expect(screen.getByTestId('fitted-size')).toHaveTextContent('fits at 12');
  });

  it('keeps a matched, non-preset size visible in the size control', () => {
    render(<TemplateOverlayFormattingBar style={{ ...style, fontSize: 10.5 }} onChange={jest.fn()} />);
    expect(screen.getByRole('button', { name: /font size/i })).toHaveTextContent('10.5');
  });

  it('offers Match while a sample and a styleable box exist, and applies it on click', () => {
    const onMatchSample = jest.fn();
    render(<TemplateOverlayFormattingBar style={style} onChange={jest.fn()} sample={sample} onMatchSample={onMatchSample} />);

    fireEvent.click(screen.getByRole('button', { name: /match selected text/i }));
    expect(onMatchSample).toHaveBeenCalledTimes(1);
  });

  it('disables Match when nothing styleable is selected', () => {
    render(<TemplateOverlayFormattingBar style={null} onChange={jest.fn()} sample={sample} onMatchSample={jest.fn()} />);
    expect(screen.getByRole('button', { name: /match selected text/i })).toBeDisabled();
  });

  it('tells the reader how to sample when nothing is sampled yet', () => {
    render(<TemplateOverlayFormattingBar style={null} onChange={jest.fn()} sampleHint />);
    expect(screen.getByText(/click or select text in the document/i)).toBeInTheDocument();
  });

  it('routes the undo and redo buttons and disables them when there is nothing to step', () => {
    const onUndo = jest.fn();
    const { rerender } = render(<TemplateOverlayFormattingBar style={null} onChange={jest.fn()} onUndo={onUndo} canUndo />);
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /redo/i })).toBeDisabled();

    rerender(<TemplateOverlayFormattingBar style={null} onChange={jest.fn()} onUndo={onUndo} canUndo={false} />);
    expect(screen.getByRole('button', { name: /undo/i })).toBeDisabled();
  });
});
