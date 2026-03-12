import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixNestedCodeBlocks } from '../index';

describe('fixNestedCodeBlocks', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    // Mock requestAnimationFrame for debouncing if implemented
    vi.useFakeTimers();
  });

  afterEach(() => {
    document.body.removeChild(container);
    vi.useRealTimers();
  });

  it('should detect orphaned backticks and merge content back into preceding code-block', () => {
    // Setup broken DOM:
    // <code-block><pre>outer start</pre></code-block>
    // <p>inner content</p>
    // <p>```</p> (orphaned closer of inner block)

    const codeBlock = document.createElement('code-block');
    const pre = document.createElement('pre');
    pre.textContent = 'outer start';
    codeBlock.appendChild(pre);
    container.appendChild(codeBlock);

    const p1 = document.createElement('p');
    p1.textContent = 'inner content';
    container.appendChild(p1);

    const p2 = document.createElement('p');
    p2.textContent = '```';
    container.appendChild(p2);

    // Run the fixer
    fixNestedCodeBlocks(container);

    // Advance timers for debounce
    vi.advanceTimersByTime(100);

    // Expectation:
    // 1. code-block should now contain the merged content.
    // 2. The orphaned <p> tags should be gone.
    // 3. The inner opener "\n```\n" should be inserted.

    expect(container.querySelector('p')).toBeNull();
    const resultText = codeBlock.textContent || '';

    // Check for the inserted opener
    expect(resultText).toContain('outer start');
    expect(resultText).toContain('\n```\n');
    expect(resultText).toContain('inner content');
    expect(resultText).toContain('```'); // The closer from p2
  });

  it('should handle intervening text nodes', () => {
    // Setup:
    // <code-block>...</code-block>
    // "some text" (TextNode)
    // <p>```</p>

    const codeBlock = document.createElement('code-block');
    codeBlock.textContent = 'start';
    container.appendChild(codeBlock);

    const textNode = document.createTextNode('intervening text');
    container.appendChild(textNode);

    const p = document.createElement('p');
    p.textContent = '```';
    container.appendChild(p);

    fixNestedCodeBlocks(container);
    vi.advanceTimersByTime(100);

    expect(container.childNodes.length).toBe(1); // Only code-block remains
    const resultText = codeBlock.textContent || '';
    expect(resultText).toContain('start');
    expect(resultText).toContain('\n```\n');
    expect(resultText).toContain('intervening text');
    expect(resultText).toContain('```');
  });

  it('should mark code-block with data-gv-patching-code attribute', () => {
    const codeBlock = document.createElement('code-block');
    codeBlock.textContent = 'start';
    container.appendChild(codeBlock);

    const p = document.createElement('p');
    p.textContent = '```';
    container.appendChild(p);

    fixNestedCodeBlocks(container);
    vi.advanceTimersByTime(100);

    // It should have the attribute while patching (though depending on implementation,
    // it might remove it if it thinks it's done. But here we have 1 closer, expecting 2.
    // So it should still be patching waiting for the outer closer).
    expect(codeBlock.hasAttribute('data-gv-patching-code')).toBe(true);
  });

  it('should handle deeply nested orphaned backticks', () => {
    // Setup:
    // <code-block>start</code-block>
    // <div>
    //   <ul>
    //     <li>
    //       <p>```</p>
    //     </li>
    //   </ul>
    // </div>

    const codeBlock = document.createElement('code-block');
    codeBlock.textContent = 'start';
    container.appendChild(codeBlock);

    const div = document.createElement('div');
    const ul = document.createElement('ul');
    const li = document.createElement('li');
    const p = document.createElement('p');
    p.textContent = '```';

    li.appendChild(p);
    ul.appendChild(li);
    div.appendChild(ul);
    container.appendChild(div);

    fixNestedCodeBlocks(container);
    vi.advanceTimersByTime(100);

    expect(container.childNodes.length).toBe(1); // Only code-block remains
    expect(container.querySelector('div')).toBeNull();
    const resultText = codeBlock.textContent || '';
    expect(resultText).toContain('start');
    expect(resultText).toContain('\n```\n'); // injected opener
    expect(resultText).toContain('```'); // original closer
  });
});
