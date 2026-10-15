import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { installWarningLogger } from '../../src/shared/utils/processWarnings';

/**
 * Node prints process warnings to stderr as one line with no stack, which is
 * all the staging logs showed for a MaxListenersExceededWarning during a load
 * test. The logger exists to record WHERE the warning came from.
 */
describe('installWarningLogger', () => {
  test('logs the stack and the emitter details of a MaxListenersExceededWarning', () => {
    const proc = new EventEmitter();
    const warn = jest.fn();
    installWarningLogger(proc, { warn });

    // Built the way Node's events module builds it (lib/events.js): an Error
    // named MaxListenersExceededWarning carrying emitter, type and count. Jest's
    // sandboxed process never receives the real one, so it is constructed here.
    const stream = new PassThrough();
    const warning: any = new Error(
      'Possible EventEmitter memory leak detected. 11 close listeners added to [PassThrough]. MaxListeners is 10.',
    );
    warning.name = 'MaxListenersExceededWarning';
    warning.emitter = stream;
    warning.type = 'close';
    warning.count = 11;
    proc.emit('warning', warning);

    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0];
    expect(fields).toMatchObject({
      event: 'process.warning',
      warningName: 'MaxListenersExceededWarning',
      emitter: 'PassThrough',
      eventName: 'close',
      listenerCount: 11,
    });
    expect(fields.stack).toContain('processWarnings.test.ts');
    expect(message).toContain('Possible EventEmitter memory leak');
  });

  test('logs any other warning with its name and stack', () => {
    const proc = new EventEmitter();
    const warn = jest.fn();
    installWarningLogger(proc, { warn });

    const warning = new Error('something is deprecated');
    warning.name = 'DeprecationWarning';
    proc.emit('warning', warning);

    const [fields] = warn.mock.calls[0];
    expect(fields).toMatchObject({ event: 'process.warning', warningName: 'DeprecationWarning' });
    expect(fields.stack).toContain('processWarnings.test.ts');
    expect(fields).not.toHaveProperty('emitter');
  });
});
