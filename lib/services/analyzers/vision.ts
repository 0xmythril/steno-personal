import { z } from 'zod'
import { MEDIA_KINDS, extractJson, usdToMicroUsd, type AnalysisResult, type VisionAnalyzer } from './types'
import { OPENROUTER_BASE_URL, type VisionCatalogEntry } from '../analysis-catalog'

// Real photos, flyers, and screenshots only. messages.type = 'image' at
// enqueue time already excludes stickers, which are also image/webp but cost
// money to analyze for near-zero search value.
export const ANALYZABLE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']

// Providers cap base64 image payloads around 10 MB and base64 inflates by 4/3,
// so 7 MiB of raw bytes stays safely under. A phone photo is far below this;
// the cap exists for documents shared as images.
export const MAX_ANALYSIS_BYTES = 7 * 1024 * 1024

// A hung provider must not wedge the drain: bound every call.
const REQUEST_TIMEOUT_MS = 120_000

const PROMPT = `You are indexing an image from a personal chat archive so it can be found by text search. Respond with a single JSON object with exactly these fields:
- "ocr_text": all legible text in the image transcribed verbatim in reading order (preserve line breaks), or null if the image contains no text
- "description": one factual sentence describing what the image is
- "kind": one of "screenshot" | "event" | "photo" | "document" | "meme" | "chart" | "other" — use "event" for a flyer, poster, or invitation for an event
- "confidence": how confident you are in "kind", 0 to 1
Respond with only the JSON object.`

// Lenient where budget models are sloppy (casing, empty strings), strict on
// the fields search depends on. A parse failure throws and burns an attempt —
// the attempts machinery IS the retry.
const resultSchema = z.object({
  ocr_text: z.string().nullish().transform(v => (v ? v : null)),
  description: z.string().nullish().transform(v => (v ? v : null)),
  kind: z.string().transform(s => s.trim().toLowerCase()).pipe(z.enum(MEDIA_KINDS)),
  confidence: z.coerce.number().transform(n => Math.min(1, Math.max(0, n))),
})

// Plain fetch against OpenRouter's OpenAI-compatible chat-completions shape.
// No vendor SDK anywhere in this directory — a structural test enforces it.
export function openRouterVisionAnalyzer(entry: VisionCatalogEntry, apiKey: string): VisionAnalyzer {
  return {
    async analyze(image, mime): Promise<AnalysisResult> {
      const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        body: JSON.stringify({
          model: entry.model,
          max_tokens: 1024,
          response_format: { type: 'json_object' },
          // OpenRouter returns usage.cost (its own billed figure) only when asked.
          usage: { include: true },
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${mime};base64,${image.toString('base64')}` } },
              { type: 'text', text: PROMPT },
            ],
          }],
        }),
      })
      // Error bodies are provider diagnostics — status codes and model names,
      // never image content — so a short slice is safe to surface upward.
      if (!res.ok) throw new Error(`vision provider responded ${res.status}: ${(await res.text()).slice(0, 300)}`)
      const body = await res.json() as {
        choices?: { message?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
      }
      const parsed = resultSchema.parse(extractJson(body.choices?.[0]?.message?.content ?? ''))
      return {
        ocrText: parsed.ocr_text,
        description: parsed.description,
        kind: parsed.kind,
        confidence: parsed.confidence,
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
        providerCostMicroUsd: usdToMicroUsd(body.usage?.cost),
      }
    },
  }
}
