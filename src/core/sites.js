'use strict';
/**
 * Per-site configuration. Everything that depends on the markup of a web app
 * lives here, so adapting to a UI change is a one-file edit.
 */

const DEFAULT_RESPONSE_COLOR = '#7c3aed';

function colorRule(selectors, color) {
  const sel = selectors.flatMap((s) => [s, `${s} *`]).join(',\n');
  return `${sel} { color: ${color} !important; -webkit-text-fill-color: ${color} !important; }`;
}

function sites(responseColor = DEFAULT_RESPONSE_COLOR) {
  return [
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      url: 'https://chatgpt.com/',
      hosts: ['chatgpt.com', 'chat.openai.com'],
      // Prompt editors: ProseMirror (#prompt-textarea, signed in) and the
      // plain textarea used by the signed-out UI. Also message-edit boxes.
      editorSelector: '#prompt-textarea, textarea, [contenteditable="true"]',
      sendSelector: [
        'button[data-testid="send-button"]',
        '#composer-submit-button',
        'button[data-composer-submit]',
        'button[aria-label="Send message"]',
        'button[aria-label="Send prompt"]',
      ].join(','),
      // Assistant messages: signed-in UI and signed-out ("octane") UI.
      responseCss: colorRule([
        '[data-message-author-role="assistant"] .markdown',
        '[data-message-author-role="assistant"] [data-message-content]',
        'li[data-message-role="assistant"] [data-assistant-markdown]',
      ], responseColor),
      // Network backstop: requests that carry the prompt.
      networkPatterns: ['*://chatgpt.com/*conversation*', '*://chat.openai.com/*conversation*'],
    },
    {
      id: 'perplexity',
      name: 'Perplexity',
      url: 'https://www.perplexity.ai/',
      hosts: ['perplexity.ai'],
      editorSelector: '#ask-input, textarea, [contenteditable="true"]',
      sendSelector: [
        'button[aria-label="Submit"]',
        'button[data-testid="submit-button"]',
      ].join(','),
      // Answers are rendered in a .prose container; user bubbles are not.
      responseCss: colorRule([
        '.prose',
        '[id^="markdown-content"]',
      ], responseColor),
      networkPatterns: ['*://www.perplexity.ai/rest/sse/*', '*://perplexity.ai/rest/sse/*', '*://suggest.perplexity.ai/*'],
    },
  ];
}

function siteForUrl(list, url) {
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  return list.find((s) => s.hosts.some((h) => host === h || host.endsWith('.' + h))) || null;
}

module.exports = { sites, siteForUrl, DEFAULT_RESPONSE_COLOR };
