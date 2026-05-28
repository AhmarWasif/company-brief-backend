const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const MAX_BODY_TEXT = 15000;
const MAX_LINKS = 40;

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function extractTextFromResponse(data) {
  if (!data?.content || !Array.isArray(data.content)) {
    return '';
  }
  return data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function buildUserMessage(url, title, links, bodyText) {
  return `You are a research analyst preparing a company brief for someone investigating this company — likely a candidate considering applying for a role there, or an operator evaluating it as a partner/competitor. Use the page content provided, fetch any relevant internal pages whose links are included (e.g. /about, /product, /careers), and use web search ONLY when essential information is missing from the page itself (e.g. recent funding, leadership news). Be efficient — don't over-search.

PAGE URL: ${url}
PAGE TITLE: ${title}
INTERNAL LINKS AVAILABLE: ${JSON.stringify(links)}
PAGE CONTENT (truncated):
${bodyText}

Produce a structured brief with these sections, in this exact order. Use Markdown headers (## for each section). If information for a section is genuinely unavailable after reasonable research, write 'Not found in available sources' rather than speculating.

## What they do
A 2-3 sentence factual description of the product and target market.

## Funding signal  
What you can determine about funding stage, recent rounds, total raised, key investors. Cite years if possible. If nothing public, say so.

## Market thesis
Why this company exists and what bet they're making. 2-3 sentences.

## Likely operating pains
Inferred from stage, team size signals, market — 3-4 short bullets of what an operator joining now would likely encounter (scaling X, formalizing Y, building Z).

## Smart questions to ask
4-5 sharp questions a candidate could ask in an interview that would (a) demonstrate real research and (b) surface useful information. Avoid generic questions ('what's the culture like') — make these specific to this company's situation.

Keep total length under 600 words. Write in tight prose. Cite specific facts where possible (e.g. 'raised $6.3M led by 645 Ventures in 2024').`;
}

module.exports = async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server misconfiguration: ANTHROPIC_API_KEY is not set.',
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body.' });
    }
  }

  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Request body must be JSON.' });
  }

  const { url, title, bodyText, links } = body;

  if (
    url == null ||
    title == null ||
    bodyText == null ||
    links == null ||
    url === '' ||
    title === '' ||
    bodyText === ''
  ) {
    return res.status(400).json({
      error: 'Missing required fields: url, title, bodyText, and links are all required.',
    });
  }

  if (!Array.isArray(links)) {
    return res.status(400).json({ error: 'links must be an array.' });
  }

  const trimmedBodyText =
    typeof bodyText === 'string'
      ? bodyText.slice(0, MAX_BODY_TEXT)
      : String(bodyText).slice(0, MAX_BODY_TEXT);
  const cappedLinks = links.slice(0, MAX_LINKS);

  const userMessage = buildUserMessage(url, title, cappedLinks, trimmedBodyText);

  try {
    const anthropicResponse = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-beta': 'web-fetch-2025-09-10',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 2500,
        messages: [{ role: 'user', content: userMessage }],
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 4,
          },
          {
            type: 'web_fetch_20250910',
            name: 'web_fetch',
            max_uses: 6,
          },
        ],
      }),
    });

    const data = await anthropicResponse.json();

    if (!anthropicResponse.ok) {
      const message =
        data?.error?.message ||
        data?.message ||
        `Anthropic API error (${anthropicResponse.status})`;
      return res.status(502).json({ error: message });
    }

    const brief = extractTextFromResponse(data);
    if (!brief) {
      return res.status(502).json({
        error: 'No text content returned from Claude.',
      });
    }

    return res.status(200).json({ brief });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return res.status(500).json({ error: message });
  }
};
