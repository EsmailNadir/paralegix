/**
 * "Next up": the first task still ahead of now.
 */
jest.mock('@/services/tasks.service', () => ({
  __esModule: true,
  default: { listLawFirmTasksPaged: jest.fn() },
}));

import React from 'react';
import dayjs from 'dayjs';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import TasksService from '@/services/tasks.service';
import useNextUpTask from '@/hooks/calendarHooks/useNextUpTask';
import { makeTestQueryClient } from '../support/renderWithProviders';

const listPaged = (TasksService as any).listLawFirmTasksPaged as jest.Mock;

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={makeTestQueryClient()}>{children}</QueryClientProvider>;
}

afterEach(() => {
  jest.useRealTimers();
  listPaged.mockReset();
});

describe('useNextUpTask', () => {
  /**
   * An all-day task is due for its whole day. Goes red if its placeholder time
   * is compared with now: it dropped out of "next up" at noon (earlier, before
   * the placeholder moved) while it was still due today.
   */
  test('keeps an all-day task due today through the evening', async () => {
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'setInterval', 'queueMicrotask', 'nextTick', 'setImmediate'] });
    jest.setSystemTime(dayjs().hour(20).minute(0).second(0).toDate());
    const today = dayjs().format('YYYY-MM-DD');
    listPaged.mockResolvedValue({ tasks: [
      { id: 't-1', title: 'Filing deadline', allDay: true, dueDate: `${today}T12:00:00.000Z`, dueDateLocalInput: `${today}T12:00` },
    ] });

    const { result } = renderHook(() => useNextUpTask('firm-1'), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.nextUpTask?.id).toBe('t-1');
  });

  test('drops a timed task once its time has passed, and keeps a later one', async () => {
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'setInterval', 'queueMicrotask', 'nextTick', 'setImmediate'] });
    jest.setSystemTime(dayjs().hour(15).minute(0).second(0).toDate());
    const today = dayjs().format('YYYY-MM-DD');
    listPaged.mockResolvedValue({ tasks: [
      { id: 'morning', title: 'Call', allDay: false, dueDateLocalInput: `${today}T09:00` },
      { id: 'evening', title: 'Review', allDay: false, dueDateLocalInput: `${today}T18:00` },
    ] });

    const { result } = renderHook(() => useNextUpTask('firm-1'), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.nextUpTask?.id).toBe('evening');
  });
});
