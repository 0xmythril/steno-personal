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
        does. Leave it off and no chat of yours leaves this machine — the usage counts below carry
        no archive content at all.
      </p>

      {s.hasOpenrouterKey ? (
        <form action={clearOpenrouterKeyAction} className="token">
          <code>OpenRouter key: saved</code>
          <button type="submit" className="small danger">Clear key</button>
        </form>
      ) : (
        <form action={saveOpenrouterKeyAction} className="stack" style={{ gap: 8 }}>
          <div className="row">
            <label className="field">
              <span>OpenRouter key</span>
              <input
                type="password" name="openrouterKey" autoComplete="off" spellCheck={false}
                placeholder="sk-or-…" required
              />
            </label>
            <button type="submit" className="primary">Save key</button>
          </div>
          <p className="help">Stored encrypted on this volume. It is never shown again.</p>
        </form>
      )}
      {s.hasOpenrouterKey && <p className="help">Clearing the key also turns both toggles off.</p>}

      <form action={updateEnrichmentAction} className="stack" style={{ gap: 10 }}>
        <label className="check">
          <input type="checkbox" name="analyzeImages" defaultChecked={s.analyzeImages} disabled={!s.hasOpenrouterKey} />
          Read text from images
        </label>
        <label className="check">
          <input type="checkbox" name="analyzeAudio" defaultChecked={s.analyzeAudio} disabled={!s.hasOpenrouterKey} />
          Transcribe voice notes
        </label>
        <div className="two-up">
          <label className="field">
            <span>Vision model</span>
            <select name="visionModel" defaultValue={s.visionModel}>
              {VISION_CATALOG.map(e => (
                <option key={e.id} value={e.id}>{e.label} — {e.provider}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Transcription model</span>
            <select name="transcriptionModel" defaultValue={s.transcriptionModel}>
              {TRANSCRIPTION_CATALOG.map(e => (
                <option key={e.id} value={e.id}>{e.label} — {e.provider}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="actions"><button type="submit" className="small">Save enrichment settings</button></div>
      </form>
    </section>
  )
}
