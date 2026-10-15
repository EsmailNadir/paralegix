/**
 * The send guard on the message composer.
 *
 * `handleSend` decides whether a keystroke becomes a message. Every rule in it
 * has a visible consequence for a client: a blank bubble in their portal, a
 * message sent twice while the first is still uploading, or a message whose
 * attachment was dropped. None of it had a test.
 *
 * The backend refuses an empty message too (`tests/messaging/messagingCore.test.ts`),
 * and that is the real boundary. This spec covers the other half: the composer
 * must not ASK, so the user never sees a message appear and then fail.
 */
import React from 'react';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '../../support/renderWithProviders';
import MessageInput from '@/components/messagesComp/MessageInput';

const onSend = jest.fn();

function renderInput(props: Partial<React.ComponentProps<typeof MessageInput>> = {}) {
  return renderWithProviders(
    <MessageInput
      onSend={onSend}
      lawFirmId="firm-1"
      clientId="client-1"
      {...props}
    />,
  );
}

const sendButton = () => screen.getByRole('button', { name: /^Send$/i });
const textbox = () => screen.getByRole('textbox');

beforeEach(() => {
  onSend.mockClear();
});

describe('what the composer refuses to send', () => {
  it('does not send an empty message', async () => {
    renderInput();

    fireEvent.click(sendButton());

    // A blank bubble in the client's portal, which they cannot tell from a
    // failed delivery.
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not send a message that is only whitespace', async () => {
    const user = userEvent.setup();
    renderInput();

    await user.type(textbox(), '     ');
    fireEvent.click(sendButton());

    // `trim()` before the length check is what makes this pass. Checking
    // `content.length` instead would send five spaces.
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does not send while a send is already in flight', async () => {
    const user = userEvent.setup();
    renderInput({ disabled: true });

    await user.type(textbox(), 'Real content');
    // The button reads "Sending..." while disabled, which is itself the signal
    // the parent send has not come back yet.
    fireEvent.click(screen.getByRole('button', { name: /Sending/i }));

    // `disabled` is the parent saying "the previous send has not returned".
    // Sending anyway is how one message becomes two.
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('what the composer does send', () => {
  it('sends trimmed content', async () => {
    const user = userEvent.setup();
    renderInput();

    await user.type(textbox(), '  Hello there  ');
    fireEvent.click(sendButton());

    // Trimmed, so the stored message does not carry the user's stray spaces into
    // every later render and search.
    expect(onSend).toHaveBeenCalledWith('Hello there', [], []);
  });

  it('preserves unicode exactly', async () => {
    const user = userEvent.setup();
    renderInput();

    const content = 'Prêt pour lundi ? 👍';
    await user.type(textbox(), content);
    fireEvent.click(sendButton());

    // The composer half of the backend's unicode assertion. A message mangled
    // here is mangled before it is ever stored.
    expect(onSend).toHaveBeenCalledWith(content, [], []);
  });

  it('keeps internal newlines while trimming the ends', async () => {
    renderInput();

    // A multi-line message is normal. Collapsing the newline would run two
    // paragraphs together in the client's portal.
    fireEvent.change(textbox(), { target: { value: '\n First line\nSecond line \n' } });
    fireEvent.click(sendButton());

    expect(onSend).toHaveBeenCalledWith('First line\nSecond line', [], []);
  });
});

describe('the composer after a send', () => {
  it('clears the box so the next message does not repeat the last', async () => {
    const user = userEvent.setup();
    renderInput();

    await user.type(textbox(), 'First message');
    fireEvent.click(sendButton());

    // Not cosmetic. A box that keeps its text sends the same content again on
    // the next click, and the client sees it twice.
    expect(textbox()).toHaveValue('');
  });

  it('disables the send button again once the box is empty', async () => {
    const user = userEvent.setup();
    renderInput();

    await user.type(textbox(), 'Something');
    expect(sendButton()).not.toBeDisabled();

    fireEvent.click(sendButton());

    expect(sendButton()).toBeDisabled();
  });
});

describe('the send button state', () => {
  it('starts disabled', () => {
    renderInput();

    // The guard the user can SEE. `handleSend` refuses an empty message anyway,
    // but a live-looking button that silently does nothing reads as broken.
    expect(sendButton()).toBeDisabled();
  });

  it('enables once there is real content', async () => {
    const user = userEvent.setup();
    renderInput();

    await user.type(textbox(), 'x');

    expect(sendButton()).not.toBeDisabled();
  });

  it('stays disabled for whitespace-only content', async () => {
    const user = userEvent.setup();
    renderInput();

    await user.type(textbox(), '   ');

    // The button and `handleSend` must agree. If the button enabled here, the
    // user would click a live button and watch nothing happen.
    expect(sendButton()).toBeDisabled();
  });

  it('reads "Sending..." while the parent has it disabled', async () => {
    renderInput({ disabled: true });

    // Distinct from the idle state, so the user knows the message is on its way
    // rather than that the composer is broken.
    expect(screen.getByRole('button', { name: /Sending/i })).toBeInTheDocument();
  });
});
