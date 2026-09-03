import { getSettings } from '@/lib/services/settings'
import { TRANSCRIPTION_CATALOG, VISION_CATALOG } from '@/lib/services/analysis-catalog'
import { clearOpenrouterKeyAction, saveOpenrouterKeyAction, updateEnrichmentAction } from './actions'

// Off by default and off without a key: the toggles are disabled until one is
// saved, so the page can never claim a feature it cannot run.
export async function EnrichmentSection() {
  const s = await getSettings()
  return (
    <section className="card">
      <h2>Enrichment</h2>
      <p className="muted">
        With an OpenRouter key saved, images are read for the text in them and voice notes are
        transcribed, and both become searchable. This is the only thing that ever sends your archive
        anywhere: the file goes to the provider named beside the model you pick, and nothing else
        does. Leave it off and nothing leaves this machine.
      </p>

      {s.hasOpenrouterKey ? (
        <div>
          <p>OpenRouter key: <strong>key saved</strong></p>
          <form action={clearOpenrouterKeyAction}>
            <button type="submit" className="danger">Clear key</button>
          </form>
          <p className="muted">Clearing the key also turns both toggles off.</p>
        </div>
      ) : (
        <form action={saveOpenrouterKeyAction}>
          <label>
            OpenRouter key{' '}
            <input
              type="password" name="openrouterKey" autoComplete="off" spellCheck={false}
              placeholder="sk-or-…" required
            />
          </label>{' '}
          <button type="submit">Save key</button>
          <p className="muted">Stored encrypted on this volume. It is never shown again.</p>
        </form>
      )}

      <form action={updateEnrichmentAction}>
        <p>
          <label>
            <input type="checkbox" name="analyzeImages" defaultChecked={s.analyzeImages} disabled={!s.hasOpenrouterKey} />
            {' '}Read text from images
          </label>
        </p>
        <p>
          <label>
            <input type="checkbox" name="analyzeAudio" defaultChecked={s.analyzeAudio} disabled={!s.hasOpenrouterKey} />
            {' '}Transcribe voice notes
          </label>
        </p>
        <p>
          <label>
            Vision model{' '}
            <select name="visionModel" defaultValue={s.visionModel}>
              {VISION_CATALOG.map(e => (
                <option key={e.id} value={e.id}>{e.label} — {e.provider}</option>
              ))}
            </select>
          </label>
        </p>
        <p>
          <label>
            Transcription model{' '}
            <select name="transcriptionModel" defaultValue={s.transcriptionModel}>
              {TRANSCRIPTION_CATALOG.map(e => (
                <option key={e.id} value={e.id}>{e.label} — {e.provider}</option>
              ))}
            </select>
          </label>
        </p>
        <button type="submit">Save enrichment settings</button>
      </form>
    </section>
  )
}
