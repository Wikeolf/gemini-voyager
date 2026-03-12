import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startMarkdownPatcher } from '../index';

describe('startMarkdownPatcher Streaming', () => {
  let container: HTMLDivElement;
  let disconnect: () => void;

  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0); // Run synchronously
      return 0;
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.useFakeTimers();
    disconnect = startMarkdownPatcher();
  });

  afterEach(() => {
    disconnect();
    document.body.removeChild(container);
    vi.useRealTimers();
  });

  it('should absorb streaming nodes into active patching code block', async () => {
    // 1. Setup initial broken state
    const codeBlock = document.createElement('code-block');
    codeBlock.textContent = 'start';
    container.appendChild(codeBlock);

    const trigger = document.createElement('p');
    trigger.textContent = '```';
    container.appendChild(trigger);

    // Wait for MutationObserver
    await Promise.resolve();

    // Advance timers for any debouncing (and RAF stub)
    vi.advanceTimersByTime(100);

    // Check if patching started
    expect(codeBlock.hasAttribute('data-gv-patching-code')).toBe(true);

    // 2. Simulate streaming (add new node)
    const streamNode = document.createElement('p');
    streamNode.textContent = 'streamed content';
    container.appendChild(streamNode);

    // MutationObserver should catch this.
    // It's async.
    await Promise.resolve(); // flush microtasks

    // Advance timers for debounce (50ms)
    vi.advanceTimersByTime(100);

    // 3. Verify absorption
    expect(container.contains(streamNode)).toBe(false); // Should be removed
    expect(codeBlock.textContent).toContain('streamed content');
  });

  it('should stop patching when closer is found', async () => {
    // Setup active patching block
    const codeBlock = document.createElement('code-block');
    codeBlock.setAttribute('data-gv-patching-code', 'true');
    codeBlock.setAttribute('data-gv-closers', '1'); // Expecting 1 more
    container.appendChild(codeBlock);

    // Stream the closer
    const closer = document.createElement('p');
    closer.textContent = '```';
    container.appendChild(closer);

    await Promise.resolve();
    vi.advanceTimersByTime(100);

    expect(codeBlock.hasAttribute('data-gv-patching-code')).toBe(false);
    expect(codeBlock.textContent).toContain('```');
  });
});
