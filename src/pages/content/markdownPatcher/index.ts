import { LoggerService, LogLevel } from '@/core/services/LoggerService';

const logger = LoggerService.getInstance().createChild('MarkdownPatcher');
// Force debug level to ensure logs are visible in production for this debugging session
logger.setLevel(LogLevel.DEBUG);

/**
 * Scans a container for broken bold markdown syntax caused by injected HTML tags
 * and fixes them by wrapping the content in <strong> tags.
 *
 * Specific target pattern:
 * TextNode containing "**" -> ElementNode(b[data-path-to-node]) -> TextNode containing "**"
 */
// Export for testing
export function fixBrokenBoldTags(root: HTMLElement) {
  // Use a TreeWalker to safely iterate text nodes
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const textNodes: Text[] = [];
  let node: Node | null;

  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    // Skip if inside code block, pre tags, or math/formula containers
    if (
      parent &&
      (parent.tagName === 'CODE' ||
        parent.tagName === 'PRE' ||
        parent.tagName === 'MATH-BLOCK' || // Gemini custom element
        parent.tagName === 'MATH-INLINE' || // Gemini custom element
        parent.classList.contains('math-block') ||
        parent.classList.contains('math-inline') ||
        parent.closest('code') ||
        parent.closest('pre') ||
        parent.closest('code-block') ||
        parent.closest('.math-block') ||
        parent.closest('.math-inline'))
    ) {
      continue;
    }

    if (node.textContent?.includes('**')) {
      textNodes.push(node as Text);
    }
  }

  for (const startNode of textNodes) {
    if (!startNode.isConnected) continue;

    let currentNode = startNode;
    const originalText = currentNode.textContent || '';

    // Phase 1: Fix intra-node bolds (e.g., "start **bold** end")
    // We match all complete pairs of **...** within the node
    // Improved Regex: require non-whitespace immediately inside the asterisks
    // and prevent matching across long distances if not intended.
    // However, maintaining the basic structure, let's enforce:
    // **(non-space...non-space)** to be safer.
    // Updated regex: \*\*([^\s].*?[^\s]|[^\s])\*\* OR \*\*([^\s])\*\*
    // This prevents matching "** " or " **"
    const matches = Array.from(originalText.matchAll(/\*\*([^\s].*?[^\s]|[^\s])\*\*/g));

    if (matches.length > 0) {
      const fragment = document.createDocumentFragment();
      let lastCursor = 0;
      let lastTextNode: Text | null = null;

      matches.forEach((m) => {
        const matchStart = m.index!;
        const matchEnd = matchStart + m[0].length;
        const content = m[1];

        // Text before
        if (matchStart > lastCursor) {
          fragment.appendChild(document.createTextNode(originalText.slice(lastCursor, matchStart)));
        }

        // Bold content
        const strong = document.createElement('strong');
        strong.textContent = content;
        fragment.appendChild(strong);

        lastCursor = matchEnd;
      });

      // Text after (this might contain a trailing unmatched '**' for Phase 2)
      if (lastCursor < originalText.length) {
        lastTextNode = document.createTextNode(originalText.slice(lastCursor));
        fragment.appendChild(lastTextNode);
      }

      // Replace the original node with our processed fragment
      if (currentNode.parentNode) {
        currentNode.parentNode.replaceChild(fragment, currentNode);
      }

      // Prepare for Phase 2:
      // If we created a trailing text node, that is now the candidate for the "split" check.
      // If we didn't (node ended with bold), there's no dangling start marker, so we're done with this node.
      if (lastTextNode) {
        currentNode = lastTextNode;
      } else {
        continue;
      }
    }

    // Phase 2: Fix split-node bolds (e.g., "text**" -> element -> "text**")
    // This logic handles cases where the bold marker is interrupted by an injected element
    const startText = currentNode.textContent || '';
    const startIdx = startText.lastIndexOf('**');

    if (startIdx === -1) continue;

    const nextNode = currentNode.nextSibling;

    // Check if the next sibling is the interfering element
    if (
      nextNode &&
      nextNode.nodeType === Node.ELEMENT_NODE &&
      (nextNode as HTMLElement).hasAttribute('data-path-to-node')
    ) {
      const middleElement = nextNode as HTMLElement;
      const endNode = nextNode.nextSibling;

      // Check if the node after the element is text and has the closing delimiter
      if (endNode && endNode.nodeType === Node.TEXT_NODE && endNode.textContent?.includes('**')) {
        const endText = endNode.textContent || '';
        const endIdx = endText.indexOf('**'); // Find first occurrence

        if (endIdx !== -1) {
          try {
            logger.info('Found broken markdown pattern due to injected node, applying fix...');

            // 1. Create wrapper
            const strong = document.createElement('strong');

            // 2. Insert the strong tag into the DOM first
            if (currentNode.parentNode) {
              currentNode.parentNode.insertBefore(strong, nextNode);
            }

            // 3. Extract and move content INTO the strong tag
            // Content from start node (after the **)
            const afterStart = startText.substring(startIdx + 2);
            if (afterStart) {
              strong.appendChild(document.createTextNode(afterStart));
            }

            // The middle element
            strong.appendChild(middleElement);

            // Content from end node (before the **)
            const beforeEnd = endText.substring(0, endIdx);
            if (beforeEnd) {
              strong.appendChild(document.createTextNode(beforeEnd));
            }

            // 4. Cleanup original text nodes
            currentNode.textContent = startText.substring(0, startIdx);
            endNode.textContent = endText.substring(endIdx + 2);
          } catch (e) {
            logger.error('Failed to apply markdown fix', { error: e });
          }
        }
      }
    }
  }
}

/**
 * Scans for broken nested code blocks where an inner "```" is treated as the closing tag.
 * Moves orphaned content back into the code block.
 */
export function fixNestedCodeBlocks(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const potentialNodes: Text[] = [];
  let node: Node | null;

  while ((node = walker.nextNode())) {
    if (node.textContent?.includes('```')) {
      const parent = node.parentElement;
      // Skip if already inside a code block structure
      if (
        parent &&
        (parent.tagName === 'CODE' ||
          parent.tagName === 'PRE' ||
          parent.closest('code-block') ||
          parent.closest('pre'))
      ) {
        continue;
      }
      potentialNodes.push(node as Text);
    }
  }

  if (potentialNodes.length === 0) return;
  logger.debug(`[fixNestedCodeBlocks] Found ${potentialNodes.length} potential orphaned backticks`);

  // Batch DOM updates using requestAnimationFrame (simulated debounce)
  requestAnimationFrame(() => {
    potentialNodes.forEach((textNode, idx) => {
      logger.debug(`[fixNestedCodeBlocks] Processing node ${idx}: textContent=${JSON.stringify(textNode.textContent)}`);
      if (!textNode.isConnected) return;

      // Identify the container element (usually a <p> or the text node's parent)
      let currentElement: Node = textNode.parentElement || textNode;
      // If parent is body (unlikely for text node but possible), stay at text node
      if (currentElement === document.body) currentElement = textNode;

      // 1. Find the preceding <code-block> using document order instead of strict sibling traversal
      // This is necessary because Gemini's UI wrapper might deeply nest the code block
      // or the orphaned nodes in disconnected sibling branches (e.g., div -> p, div -> ul -> li)
      const allCodeBlocks = Array.from(document.querySelectorAll('code-block'));
      let targetCodeBlock: HTMLElement | null = null;

      // Iterate backwards to find the *closest* preceding code-block
      for (let i = allCodeBlocks.length - 1; i >= 0; i--) {
        const cb = allCodeBlocks[i];
        // If the text node FOLLOWS the code block in the DOM
        if (cb.compareDocumentPosition(textNode) & Node.DOCUMENT_POSITION_FOLLOWING) {
          targetCodeBlock = cb as HTMLElement;
          break;
        }
      }

      if (targetCodeBlock) {
        logger.debug(`[fixNestedCodeBlocks] Found preceding <code-block> using document order.`);

        // 2. We need to collect all "top-level" nodes between the targetCodeBlock and the textNode.
        // The easiest way is to find the common ancestor.
        let commonAncestor: Node | null = null;

        // Walk up from code block
        const cbAncestors = [];
        let cur: Node | null = targetCodeBlock;
        while (cur && cur !== document.body && cur !== document.documentElement) {
            cbAncestors.push(cur);
            cur = cur.parentNode;
        }

        // Walk up from text node and find intersection
        cur = textNode;
        let textNodeAncestorInCommon: Node | null = null;
        let codeBlockAncestorInCommon: Node | null = null;

        while (cur && cur !== document.body && cur !== document.documentElement) {
            if (!cur.parentNode) break;
            const matchIdx = cbAncestors.indexOf(cur.parentNode);
            if (matchIdx !== -1) {
                commonAncestor = cur.parentNode;
                textNodeAncestorInCommon = cur;
                codeBlockAncestorInCommon = cbAncestors[matchIdx - 1]; // The child of the common ancestor that contains the code-block
                break;
            }
            cur = cur.parentNode;
        }

        const nodesToMove: Node[] = [];

        if (commonAncestor && textNodeAncestorInCommon && codeBlockAncestorInCommon) {
            // The code block and the orphaned text share a common container.
            // We want to extract everything *after* the code block's branch up to and including the text node's branch.
            let siblingToMove = codeBlockAncestorInCommon.nextSibling;

            while (siblingToMove && siblingToMove !== textNodeAncestorInCommon) {
                nodesToMove.push(siblingToMove);
                siblingToMove = siblingToMove.nextSibling;
            }
            // Include the branch containing the text node itself
            nodesToMove.push(textNodeAncestorInCommon);
        } else {
            // Fallback if no common ancestor found (e.g., very broken DOM, maybe disconnected)
            // Just move the element containing the text node
            nodesToMove.push(currentElement);
        }

        moveNodesToCodeBlock(targetCodeBlock, nodesToMove);
      } else {
        logger.debug(`[fixNestedCodeBlocks] Did not find any preceding <code-block> in the document.`);
      }
    });
  });
}

function moveNodesToCodeBlock(codeBlock: HTMLElement, nodesToMove: Node[]) {
  // 1. Mark the code block
  if (!codeBlock.hasAttribute('data-gv-patching-code')) {
    codeBlock.setAttribute('data-gv-patching-code', 'true');
    codeBlock.setAttribute('data-gv-closers', '2'); // Initialize expecting 2 closers (inner + outer)

    // 2. Append missing inner opener
    const targetContainer = codeBlock.querySelector('pre') || codeBlock;
    targetContainer.appendChild(document.createTextNode('\n```\n'));
    logger.info('[moveNodesToCodeBlock] Started patching broken nested code block. Marked as active and added missing inner opener.');
  }

  // 3. Extract and move content
  const targetContainer = codeBlock.querySelector('pre') || codeBlock;
  let accumulatedText = '';

  nodesToMove.forEach((node) => {
    let text = node.textContent || '';
    if (node.nodeType === Node.ELEMENT_NODE) {
      const tagName = (node as HTMLElement).tagName;
      if (['P', 'DIV', 'LI', 'BR'].includes(tagName)) {
        text += '\n';
      }
    }
    accumulatedText += text;

    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
  });

  if (accumulatedText) {
    logger.debug(`[moveNodesToCodeBlock] Absorbed ${nodesToMove.length} nodes. Extracted text: ${JSON.stringify(accumulatedText)}`);
    targetContainer.appendChild(document.createTextNode(accumulatedText));
  } else {
    logger.debug(`[moveNodesToCodeBlock] Absorbed ${nodesToMove.length} nodes but no text to append.`);
  }

  // 4. Update state (check for closers)
  updatePatchState(codeBlock, accumulatedText);
}

function updatePatchState(codeBlock: HTMLElement, addedText: string) {
  let expectedClosers = parseInt(codeBlock.getAttribute('data-gv-closers') || '0', 10);
  logger.debug(`[updatePatchState] State before parsing text: closers=${expectedClosers}`);

  const regex = /```(\S*)/g;
  let match;

  while ((match = regex.exec(addedText)) !== null) {
    const lang = match[1];
    if (lang && lang.length > 0) {
      expectedClosers++;
      logger.debug(`[updatePatchState] Found opener with lang: "${lang}". Increased expected closers to ${expectedClosers}`);
    } else {
      expectedClosers--;
      logger.debug(`[updatePatchState] Found closer (no lang). Decreased expected closers to ${expectedClosers}`);
    }
  }

  codeBlock.setAttribute('data-gv-closers', expectedClosers.toString());

  if (expectedClosers <= 0) {
    codeBlock.removeAttribute('data-gv-patching-code');
    codeBlock.removeAttribute('data-gv-closers');
    const existingTimeout = (codeBlock as any)._patchTimeout;
    if (existingTimeout) clearTimeout(existingTimeout);
    logger.info('[updatePatchState] Finished patching nested code block. Removed active state.');
  } else {
      const existingTimeout = (codeBlock as any)._patchTimeout;
      if (existingTimeout) clearTimeout(existingTimeout);

      (codeBlock as any)._patchTimeout = setTimeout(() => {
          if (codeBlock.hasAttribute('data-gv-patching-code')) {
            codeBlock.removeAttribute('data-gv-patching-code');
            codeBlock.removeAttribute('data-gv-closers');
            logger.warn('[updatePatchState] Force stopped patching due to safety timeout (1000ms). Expected more closers but stream stalled.');
          }
      }, 1000);
      logger.debug('[updatePatchState] Resetted safety timeout (1000ms) for streaming patcher.');
  }
}

/**
 * Starts the observer to patch broken markdown rendering in Gemini
 */
export function startMarkdownPatcher() {
  logger.info('Starting Markdown Patcher');

  // Initial fix
  fixBrokenBoldTags(document.body);
  fixNestedCodeBlocks(document.body);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const DEBOUNCE_MS = 50;

  // Queue for nodes to be absorbed
  let absorptionQueue: { block: HTMLElement, nodes: Node[] }[] = [];

  const observer = new MutationObserver((mutations) => {
    // Clear queue reference on new batch? No, debounce handles it.

    // Scan logic
    const nodesToScan: HTMLElement[] = [];

    for (const m of mutations) {
      for (const node of Array.from(m.addedNodes)) {
          // Check for active absorption
          let prev = node.previousSibling;

          // Skip whitespace
          while (prev && prev.nodeType === Node.TEXT_NODE && !prev.textContent?.trim()) {
              prev = prev.previousSibling;
          }

          let targetBlock: HTMLElement | null = null;

          if (prev && prev.nodeType === Node.ELEMENT_NODE) {
              const el = prev as HTMLElement;
              if (el.tagName === 'CODE-BLOCK' && el.hasAttribute('data-gv-patching-code')) {
                  targetBlock = el;
              } else {
                  // Check if prev is in absorption queue
                  const queued = absorptionQueue.find(e => e.nodes.includes(prev as Node));
                  if (queued) {
                      targetBlock = queued.block;
                  }
              }
          }

          if (targetBlock) {
              // Add to absorption queue
              let entry = absorptionQueue.find(e => e.block === targetBlock);
              if (!entry) {
                  entry = { block: targetBlock, nodes: [] };
                  absorptionQueue.push(entry);
              }
              entry.nodes.push(node);
              logger.debug(`[MutationObserver] Queued node for absorption: tag=${(node as HTMLElement).tagName || 'TEXT'}, content=${JSON.stringify(node.textContent)}`);
          } else {
              // Not absorbed, mark for scanning
              if (node.nodeType === Node.ELEMENT_NODE) {
                  nodesToScan.push(node as HTMLElement);
              }
          }
      }
    }

    // Process Absorption Queue (Debounced)
    if (absorptionQueue.length > 0) {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            logger.debug(`[MutationObserver] Processing absorption queue of ${absorptionQueue.length} blocks...`);
            absorptionQueue.forEach(entry => {
                if (entry.block.isConnected && entry.block.hasAttribute('data-gv-patching-code')) {
                    moveNodesToCodeBlock(entry.block, entry.nodes);
                } else {
                    logger.debug(`[MutationObserver] Block is no longer connected or active. Skipping absorption.`);
                }
            });
            absorptionQueue = []; // Clear queue
        }, DEBOUNCE_MS);
    }

    // Process Scanning
    if (nodesToScan.length > 0) {
      nodesToScan.forEach((node) => {
        fixBrokenBoldTags(node);
        fixNestedCodeBlocks(node);
      });
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  return () => observer.disconnect();
}
